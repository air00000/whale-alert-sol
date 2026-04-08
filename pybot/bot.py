from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from datetime import datetime, timezone

from telegram import ReplyKeyboardMarkup, Update
from telegram.constants import ParseMode
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters

from .cluster_analyzer import ClusterAnalyzer
from .helius import HeliusClient
from .wallet_analyzer import WalletAnalyzer
from .whale_finder import WhaleFinder
from .whale_tracker import WhaleTracker

ADDRESS_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,48}$")

MENU = {
    "help": "ℹ️ Помощь",
    "status": "📊 Статус",
    "list": "📋 Вотчлист",
    "watch": "👀 Отслеживать",
    "unwatch": "🗑️ Убрать",
    "score": "🧠 Скор",
    "holdings": "💼 Холдинги",
    "cluster": "🕸️ Кластер",
    "findwhales": "🐋 Найти китов",
    "findbytoken": "🪙 Киты по токену",
    "stop": "⏹️ Стоп поиск",
    "cancel": "❌ Отмена",
}


@dataclass
class PendingInput:
    action: str


@dataclass
class Services:
    helius: HeliusClient
    wallet_analyzer: WalletAnalyzer
    whale_finder: WhaleFinder
    cluster_analyzer: ClusterAnalyzer
    tracker: WhaleTracker
    scan_interval_sec: int


class WhaleBot:
    def __init__(self, services: Services) -> None:
        self.services = services
        self.search_tasks: dict[int, asyncio.Task] = {}

    @staticmethod
    def main_menu() -> ReplyKeyboardMarkup:
        return ReplyKeyboardMarkup(
            [
                [MENU["help"], MENU["status"], MENU["list"]],
                [MENU["watch"], MENU["unwatch"]],
                [MENU["score"], MENU["holdings"], MENU["cluster"]],
                [MENU["findwhales"], MENU["findbytoken"], MENU["stop"]],
            ],
            resize_keyboard=True,
        )

    @staticmethod
    def cancel_menu() -> ReplyKeyboardMarkup:
        return ReplyKeyboardMarkup([[MENU["cancel"]]], resize_keyboard=True, one_time_keyboard=True)

    async def start(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await update.effective_message.reply_text(self.help_text(), parse_mode=ParseMode.HTML, reply_markup=self.main_menu())

    async def help(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self.start(update, context)

    async def ping(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await update.effective_message.reply_text("✅ Pong", reply_markup=self.main_menu())

    async def status(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        health = self.services.helius.health_check()
        watch_count = len(self.services.tracker.list_watchlist(update.effective_chat.id))
        now = datetime.now(timezone.utc).isoformat()
        text = (
            "<b>Runtime status</b>\n"
            f"Helius configured: <b>{'yes' if self.services.helius.is_configured else 'no'}</b>\n"
            f"Helius health: <b>{'ok' if health.get('ok') else 'degraded'}</b>\n"
            f"Watched wallets: <b>{watch_count}</b>\n"
            f"Time (UTC): <code>{now}</code>"
        )
        await update.effective_message.reply_text(text, parse_mode=ParseMode.HTML, reply_markup=self.main_menu())

    async def watch(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if context.args:
            address = context.args[0]
            name = " ".join(context.args[1:]).strip() or address
            await self._add_watch(update, address, name)
            return
        context.chat_data["pending"] = PendingInput("watch")
        await update.effective_message.reply_text("Отправь: <code>address name</code>", parse_mode=ParseMode.HTML, reply_markup=self.cancel_menu())

    async def unwatch(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if context.args:
            await self._remove_watch(update, context.args[0])
            return
        context.chat_data["pending"] = PendingInput("unwatch")
        await update.effective_message.reply_text("Отправь адрес кошелька для удаления.", reply_markup=self.cancel_menu())

    async def list_watch(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        items = self.services.tracker.list_watchlist(update.effective_chat.id)
        if not items:
            await update.effective_message.reply_text("Вотчлист пуст.", reply_markup=self.main_menu())
            return
        lines = ["<b>Вотчлист</b>"]
        for idx, item in enumerate(items, start=1):
            lines.append(f"{idx}. <code>{item['address']}</code> — {item['name']}")
        await update.effective_message.reply_text("\n".join(lines), parse_mode=ParseMode.HTML, reply_markup=self.main_menu())

    async def score(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if context.args:
            await self._show_score(update, context.args[0])
            return
        context.chat_data["pending"] = PendingInput("score")
        await update.effective_message.reply_text("Отправь адрес кошелька для score.", reply_markup=self.cancel_menu())

    async def holdings(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if context.args:
            await self._show_holdings(update, context.args[0])
            return
        context.chat_data["pending"] = PendingInput("holdings")
        await update.effective_message.reply_text("Отправь адрес кошелька для holdings.", reply_markup=self.cancel_menu())

    async def cluster(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if context.args:
            await self._show_cluster(update, context.args[0])
            return
        context.chat_data["pending"] = PendingInput("cluster")
        await update.effective_message.reply_text("Отправь seed-адрес для cluster анализа.", reply_markup=self.cancel_menu())

    async def findbytoken(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if context.args:
            await self._start_token_search(update, context.args[0])
            return
        context.chat_data["pending"] = PendingInput("findbytoken")
        await update.effective_message.reply_text("Отправь mint токена.", reply_markup=self.cancel_menu())

    async def findwhales(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self._start_global_search(update)

    async def stopsearch(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        chat_id = update.effective_chat.id
        if self._cancel_search(chat_id):
            await update.effective_message.reply_text("Поиск остановлен.", reply_markup=self.main_menu())
        else:
            await update.effective_message.reply_text("Активного поиска нет.", reply_markup=self.main_menu())

    async def text_router(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        text = (update.effective_message.text or "").strip()

        pending: PendingInput | None = context.chat_data.get("pending")
        if pending:
            if text == MENU["cancel"]:
                context.chat_data.pop("pending", None)
                await update.effective_message.reply_text("Действие отменено.", reply_markup=self.main_menu())
                return

            if pending.action == "watch":
                parts = text.split()
                if not parts:
                    await update.effective_message.reply_text("Нужен адрес.")
                    return
                await self._add_watch(update, parts[0], " ".join(parts[1:]).strip() or parts[0])
            elif pending.action == "unwatch":
                await self._remove_watch(update, text)
            elif pending.action == "score":
                await self._show_score(update, text)
            elif pending.action == "holdings":
                await self._show_holdings(update, text)
            elif pending.action == "cluster":
                await self._show_cluster(update, text)
            elif pending.action == "findbytoken":
                await self._start_token_search(update, text)

            context.chat_data.pop("pending", None)
            return

        direct = {
            MENU["help"]: self.help,
            MENU["status"]: self.status,
            MENU["list"]: self.list_watch,
            MENU["findwhales"]: self.findwhales,
            MENU["stop"]: self.stopsearch,
        }
        if text in direct:
            await direct[text](update, context)
            return

        ask = {
            MENU["watch"]: "watch",
            MENU["unwatch"]: "unwatch",
            MENU["score"]: "score",
            MENU["holdings"]: "holdings",
            MENU["cluster"]: "cluster",
            MENU["findbytoken"]: "findbytoken",
            MENU["stop"]: "stopsearch",
        }
        if text in ask:
            if ask[text] == "stopsearch":
                await self.stopsearch(update, context)
                return
            context.chat_data["pending"] = PendingInput(ask[text])
            prompt = {
                "watch": "Отправь: <code>address name</code>",
                "unwatch": "Отправь адрес для удаления.",
                "score": "Отправь адрес кошелька для score.",
                "holdings": "Отправь адрес кошелька для holdings.",
                "cluster": "Отправь seed-адрес для cluster.",
                "findbytoken": "Отправь mint токена.",
            }[ask[text]]
            await update.effective_message.reply_text(prompt, parse_mode=ParseMode.HTML, reply_markup=self.cancel_menu())
            return

        await update.effective_message.reply_text("Используй меню или /help", reply_markup=self.main_menu())

    async def _show_score(self, update: Update, address: str) -> None:
        if not self._is_address(address):
            await update.effective_message.reply_text("Невалидный Solana-адрес.")
            return
        report = self.services.wallet_analyzer.analyze_wallet(address)
        lines = [
            "<b>Wallet score</b>",
            f"Address: <code>{address}</code>",
            f"Score: <b>{report['score']}/100</b>",
            f"WinRate: {report['win_rate']}%",
            f"All-time PnL: ${report['all_time_pnl_usd']}",
            f"Trades: {report['trade_count']}",
            f"Profiles: {', '.join(report['profiles'])}",
        ]
        await update.effective_message.reply_text("\n".join(lines), parse_mode=ParseMode.HTML, reply_markup=self.main_menu())

    async def _show_holdings(self, update: Update, address: str) -> None:
        if not self._is_address(address):
            await update.effective_message.reply_text("Невалидный Solana-адрес.")
            return
        holdings = self.services.wallet_analyzer.get_current_holdings(address)
        lines = [f"<b>Holdings</b> <code>{address}</code>"]
        for item in holdings:
            lines.append(f"• {item['symbol']} — ${item['usd_value']} ({item['amount']})")
        await update.effective_message.reply_text("\n".join(lines), parse_mode=ParseMode.HTML, reply_markup=self.main_menu())

    async def _show_cluster(self, update: Update, address: str) -> None:
        if not self._is_address(address):
            await update.effective_message.reply_text("Невалидный Solana-адрес.")
            return
        cluster = self.services.cluster_analyzer.analyze(address)
        text = (
            "<b>Cluster</b>\n"
            f"Seed: <code>{cluster['seed']}</code>\n"
            f"Suspicion: <b>{cluster['suspicion_score']}/100</b>\n"
            f"Nodes: {cluster['node_count']} | Edges: {cluster['edge_count']}"
        )
        await update.effective_message.reply_text(text, parse_mode=ParseMode.HTML, reply_markup=self.main_menu())

    async def _show_token_whales(self, update: Update, mint: str) -> None:
        if not self._is_address(mint):
            await update.effective_message.reply_text("Невалидный mint-адрес.")
            return
        result = self.services.whale_finder.find_whales_by_token(mint)
        lines = [
            "<b>Whales by token</b>",
            f"Mint: <code>{mint}</code>",
            f"Scanned: {result['scanned_wallets']}",
        ]
        for i, w in enumerate(result["whales"][:10], start=1):
            lines.append(f"{i}. <code>{w['address']}</code> score {w['score']} pnl ${w['all_time_pnl_usd']}")
        for note in result.get("notes", []):
            lines.append(f"• {note}")
        await update.effective_message.reply_text("\n".join(lines), parse_mode=ParseMode.HTML, reply_markup=self.main_menu())

    async def _start_global_search(self, update: Update) -> None:
        chat_id = update.effective_chat.id
        self._cancel_search(chat_id)
        await update.effective_message.reply_text(
            f"Запустил непрерывный поиск китов. Интервал: {self.services.scan_interval_sec} сек.\nОстановить: /stopsearch или кнопка «{MENU['stop']}».",
            reply_markup=self.main_menu(),
        )

        async def runner() -> None:
            while True:
                result = self.services.whale_finder.find_whales()
                lines = [f"<b>Whale scan update</b> | scanned: {result['scanned_wallets']}"]
                whales = result.get("whales", [])
                if whales:
                    for i, w in enumerate(whales[:10], start=1):
                        lines.append(f"{i}. <code>{w['address']}</code> score {w['score']} pnl ${w['all_time_pnl_usd']}")
                else:
                    lines.append("Пока нет валидных кандидатов.")
                for note in result.get("notes", []):
                    lines.append(f"• {note}")
                await update.get_bot().send_message(chat_id, "\n".join(lines), parse_mode=ParseMode.HTML)
                await asyncio.sleep(self.services.scan_interval_sec)

        self.search_tasks[chat_id] = asyncio.create_task(runner())

    async def _start_token_search(self, update: Update, mint: str) -> None:
        if not self._is_address(mint):
            await update.effective_message.reply_text("Невалидный mint-адрес.")
            return
        chat_id = update.effective_chat.id
        self._cancel_search(chat_id)
        await update.effective_message.reply_text(
            f"Запустил непрерывный поиск китов по токену <code>{mint}</code>. Интервал: {self.services.scan_interval_sec} сек.\nОстановить: /stopsearch или кнопка «{MENU['stop']}».",
            parse_mode=ParseMode.HTML,
            reply_markup=self.main_menu(),
        )

        async def runner() -> None:
            while True:
                result = self.services.whale_finder.find_whales_by_token(mint)
                lines = [f"<b>Token whale update</b> <code>{mint}</code> | scanned: {result['scanned_wallets']}"]
                for i, w in enumerate(result.get("whales", [])[:10], start=1):
                    lines.append(f"{i}. <code>{w['address']}</code> score {w['score']} pnl ${w['all_time_pnl_usd']}")
                if not result.get("whales"):
                    lines.append("Пока нет валидных кандидатов.")
                for note in result.get("notes", []):
                    lines.append(f"• {note}")
                await update.get_bot().send_message(chat_id, "\n".join(lines), parse_mode=ParseMode.HTML)
                await asyncio.sleep(self.services.scan_interval_sec)

        self.search_tasks[chat_id] = asyncio.create_task(runner())

    async def _add_watch(self, update: Update, address: str, name: str) -> None:
        if not self._is_address(address):
            await update.effective_message.reply_text("Невалидный Solana-адрес.")
            return
        entry = self.services.tracker.add_watch(update.effective_chat.id, address, name)
        await update.effective_message.reply_text(f"Добавлено: <code>{entry['address']}</code> ({entry['name']})", parse_mode=ParseMode.HTML, reply_markup=self.main_menu())

    async def _remove_watch(self, update: Update, address: str) -> None:
        if not self._is_address(address):
            await update.effective_message.reply_text("Невалидный Solana-адрес.")
            return
        ok = self.services.tracker.remove_watch(update.effective_chat.id, address)
        await update.effective_message.reply_text("Удалено из вотчлиста." if ok else "Адрес не найден.", reply_markup=self.main_menu())

    @staticmethod
    def _is_address(value: str) -> bool:
        return bool(ADDRESS_RE.match((value or "").strip()))

    def _cancel_search(self, chat_id: int) -> bool:
        task = self.search_tasks.pop(chat_id, None)
        if not task:
            return False
        task.cancel()
        return True

    @staticmethod
    def help_text() -> str:
        return (
            "<b>Whale Alert Sol (Python)</b>\n"
            "/start, /help, /ping, /status\n"
            "/watch &lt;address&gt; &lt;name&gt;\n"
            "/unwatch &lt;address&gt;\n"
            "/list\n"
            "/score &lt;address&gt;\n"
            "/holdings &lt;address&gt;\n"
            "/cluster &lt;address&gt;\n"
            "/findwhales\n"
            "/findbytoken &lt;mint&gt;\n\n"
            "/stopsearch\n\n"
            "Можно работать полностью кнопками в Telegram."
        )


def build_application(services: Services, token: str) -> Application:
    bot = WhaleBot(services)
    app = Application.builder().token(token).build()

    app.add_handler(CommandHandler("start", bot.start))
    app.add_handler(CommandHandler("help", bot.help))
    app.add_handler(CommandHandler("ping", bot.ping))
    app.add_handler(CommandHandler("status", bot.status))
    app.add_handler(CommandHandler("watch", bot.watch))
    app.add_handler(CommandHandler("unwatch", bot.unwatch))
    app.add_handler(CommandHandler("list", bot.list_watch))
    app.add_handler(CommandHandler("score", bot.score))
    app.add_handler(CommandHandler("holdings", bot.holdings))
    app.add_handler(CommandHandler("cluster", bot.cluster))
    app.add_handler(CommandHandler("findwhales", bot.findwhales))
    app.add_handler(CommandHandler("findbytoken", bot.findbytoken))
    app.add_handler(CommandHandler("stopsearch", bot.stopsearch))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, bot.text_router))
    return app
