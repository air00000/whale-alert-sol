from __future__ import annotations

from dataclasses import dataclass

from .helius import HeliusClient
from .wallet_analyzer import WalletAnalyzer


@dataclass
class WhaleFinder:
    helius: HeliusClient
    wallet_analyzer: WalletAnalyzer
    dev_wallets: set[str]

    def _is_candidate_wallet(self, wallet: str, min_history_txs: int) -> bool:
        signatures = self.helius.get_recent_signatures(wallet, limit=min_history_txs)
        return len(signatures) >= min_history_txs

    def find_whales(self, min_win_rate: float = 55, min_pnl_usd: float = 1000, min_history_txs: int = 10) -> dict:
        if not self.helius.is_configured:
            return {
                "filters": {"min_win_rate": min_win_rate, "min_pnl_usd": min_pnl_usd, "min_history_txs": min_history_txs},
                "whales": [],
                "scanned_wallets": 0,
                "notes": ["HELIUS_API_KEY is missing"],
            }

        # Conservative mode: without a stable top-token feed we don't emit synthetic whales.
        return {
            "filters": {"min_win_rate": min_win_rate, "min_pnl_usd": min_pnl_usd, "min_history_txs": min_history_txs},
            "whales": [],
            "scanned_wallets": 0,
            "notes": ["Global whale scan is available only with token-driven search in this Python build. Use /findbytoken <mint>."],
        }

    def find_whales_by_token(self, mint: str, min_history_txs: int = 10) -> dict:
        notes: list[str] = []
        if not self.helius.is_configured:
            return {"token": {"mint": mint, "symbol": "UNKNOWN"}, "whales": [], "scanned_wallets": 0, "notes": ["HELIUS_API_KEY is missing"]}

        dev_wallets = set(self.dev_wallets)
        dev_wallets.update(self.helius.get_mint_authorities(mint))

        token_accounts = self.helius.get_token_largest_accounts(mint, limit=25)
        owners: list[str] = []
        for ta in token_accounts:
            owner = self.helius.get_token_account_owner(ta)
            if owner:
                owners.append(owner)

        unique_wallets = []
        seen = set()
        for wallet in owners:
            if wallet in seen:
                continue
            seen.add(wallet)
            unique_wallets.append(wallet)

        whales = []
        skipped_dev = 0
        skipped_empty = 0

        for wallet in unique_wallets:
            if wallet in dev_wallets:
                skipped_dev += 1
                continue
            if not self._is_candidate_wallet(wallet, min_history_txs=min_history_txs):
                skipped_empty += 1
                continue
            report = self.wallet_analyzer.analyze_wallet(wallet)
            report["history_txs_checked"] = min_history_txs
            whales.append(report)

        whales.sort(key=lambda x: (x["score"], x["all_time_pnl_usd"]), reverse=True)
        notes.append(f"Skipped dev wallets: {skipped_dev}")
        notes.append(f"Skipped wallets with low/no history: {skipped_empty}")

        return {
            "token": {"mint": mint, "symbol": "UNKNOWN"},
            "whales": whales,
            "scanned_wallets": len(unique_wallets),
            "notes": notes,
        }
