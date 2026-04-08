from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone

from telegram import ReplyKeyboardMarkup, Update
from telegram.constants import ParseMode
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from .config import Settings
from .storage import JsonStorage

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
    "cancel": "❌ Отмена",
}


@dataclass
class PendingInput:
    action: str


class WhaleBot:
    def __init__(self, settings: Settings, storage: JsonStorage) -> None:
        self.settings = settings
        self.storage = storage

    @staticmethod
    def main_menu() -> ReplyKeyboardMarkup:
        return ReplyKeyboardMarkup(
            [
                [MENU["help"], MENU["status"], MENU["list"]],
                [MENU["watch"], MENU["unwatch"]],
                [MENU["score"], MENU["holdings"], MENU["cluster"]],
                [MENU["findwhales"], MENU["findbytoken"]],
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
        await update.effective_message.reply_text("✅ Pong")

    async def status(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        helius = "yes" if self.settings.helius_api_key else "no"
        watch_count = len(self.storage.list_watchlist(update.effective_chat.id))
        now = datetime.now(timezone.utc).isoformat()
        text = (
            "<b>Runtime status</b>\n"
            f"Helius configured: <b>{helius}</b>\n"
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
        await update.effective_message.reply_text(
            "Отправь: <code>address name</code>",
            parse_mode=ParseMode.HTML,
            reply_markup=self.cancel_menu(),
        )

    async def unwatch(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if context.args:
            await self._remove_watch(update, context.args[0])
            return
        context.chat_data["pending"] = PendingInput("unwatch")
        await update.effective_message.reply_text(
            "Отправь адрес кошелька для удаления.",
            reply_markup=self.cancel_menu(),
        )

    async def list_watch(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        items = self.storage.list_watchlist(update.effective_chat.id)
        if not items:
            await update.effective_message.reply_text("Вотчлист пуст.", reply_markup=self.main_menu())
            return
        lines = ["<b>Вотчлист</b>"]
        for idx, item in enumerate(items, start=1):
            lines.append(f"{idx}. <code>{item['address']}</code> — {item['name']}")
        await update.effective_message.reply_text("\n".join(lines), parse_mode=ParseMode.HTML, reply_markup=self.main_menu())

    async def score(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self._address_stub(update, context, "score")

    async def holdings(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self._address_stub(update, context, "holdings")

    async def cluster(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self._address_stub(update, context, "cluster")

    async def findbytoken(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self._address_stub(update, context, "findbytoken")

    async def findwhales(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await update.effective_message.reply_text(
            "Сканирование китов включено в Python-версии как следующий шаг. Базовый Telegram UX уже работает.",
            reply_markup=self.main_menu(),
        )

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
                address = parts[0]
                name = " ".join(parts[1:]).strip() or address
                await self._add_watch(update, address, name)
            elif pending.action == "unwatch":
                await self._remove_watch(update, text)
            else:
                await self._handle_stub_action(update, pending.action, text)

            context.chat_data.pop("pending", None)
            return

        by_text = {
            MENU["help"]: self.help,
            MENU["status"]: self.status,
            MENU["list"]: self.list_watch,
            MENU["watch"]: None,
            MENU["unwatch"]: None,
            MENU["score"]: None,
            MENU["holdings"]: None,
            MENU["cluster"]: None,
            MENU["findwhales"]: self.findwhales,
            MENU["findbytoken"]: None,
        }

        if text in by_text and by_text[text] is not None:
            await by_text[text](update, context)
            return

        if text == MENU["watch"]:
            context.chat_data["pending"] = PendingInput("watch")
            await update.effective_message.reply_text("Отправь: <code>address name</code>", parse_mode=ParseMode.HTML, reply_markup=self.cancel_menu())
            return
        if text == MENU["unwatch"]:
            context.chat_data["pending"] = PendingInput("unwatch")
            await update.effective_message.reply_text("Отправь адрес кошелька для удаления.", reply_markup=self.cancel_menu())
            return

        if text in {MENU["score"], MENU["holdings"], MENU["cluster"], MENU["findbytoken"]}:
            action = {
                MENU["score"]: "score",
                MENU["holdings"]: "holdings",
                MENU["cluster"]: "cluster",
                MENU["findbytoken"]: "findbytoken",
            }[text]
            context.chat_data["pending"] = PendingInput(action)
            await update.effective_message.reply_text("Отправь Solana-адрес.", reply_markup=self.cancel_menu())
            return

        if text.startswith("/"):
            return

        await update.effective_message.reply_text("Используй меню или /help", reply_markup=self.main_menu())

    async def _handle_stub_action(self, update: Update, action: str, value: str) -> None:
        if not self._is_address(value):
            await update.effective_message.reply_text("Это не похоже на валидный Solana-адрес.")
            return
        await update.effective_message.reply_text(
            f"Команда {action} получена для <code>{value}</code>.",
            parse_mode=ParseMode.HTML,
            reply_markup=self.main_menu(),
        )

    async def _address_stub(self, update: Update, context: ContextTypes.DEFAULT_TYPE, action: str) -> None:
        if context.args:
            await self._handle_stub_action(update, action, context.args[0])
            return
        context.chat_data["pending"] = PendingInput(action)
        await update.effective_message.reply_text("Отправь Solana-адрес.", reply_markup=self.cancel_menu())

    async def _add_watch(self, update: Update, address: str, name: str) -> None:
        if not self._is_address(address):
            await update.effective_message.reply_text("Невалидный Solana-адрес.")
            return
        entry = self.storage.add_watch(update.effective_chat.id, address, name)
        await update.effective_message.reply_text(
            f"Добавлено: <code>{entry['address']}</code> ({entry['name']})",
            parse_mode=ParseMode.HTML,
            reply_markup=self.main_menu(),
        )

    async def _remove_watch(self, update: Update, address: str) -> None:
        if not self._is_address(address):
            await update.effective_message.reply_text("Невалидный Solana-адрес.")
            return
        ok = self.storage.remove_watch(update.effective_chat.id, address)
        text = "Удалено из вотчлиста." if ok else "Адрес не найден в вотчлисте."
        await update.effective_message.reply_text(text, reply_markup=self.main_menu())

    @staticmethod
    def _is_address(value: str) -> bool:
        return bool(ADDRESS_RE.match((value or "").strip()))

    @staticmethod
    def help_text() -> str:
        return (
            "<b>Whale Alert Sol (Python)</b>\n"
            "/start, /help, /ping, /status\n"
            "/watch &lt;address&gt; &lt;name&gt;\n"
            "/unwatch &lt;address&gt;\n"
            "/list\n"
            "/score &lt;address&gt;, /holdings &lt;address&gt;, /cluster &lt;address&gt;\n"
            "/findwhales, /findbytoken &lt;mint&gt;\n\n"
            "Можно работать полностью кнопками в Telegram."
        )


def build_application(settings: Settings, storage: JsonStorage) -> Application:
    bot = WhaleBot(settings, storage)
    app = Application.builder().token(settings.telegram_token).build()

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
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, bot.text_router))

    return app
