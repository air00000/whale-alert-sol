from __future__ import annotations

from dataclasses import dataclass

from .wallet_analyzer import WalletAnalyzer


@dataclass
class WhaleFinder:
    wallet_analyzer: WalletAnalyzer

    def find_whales(self, min_win_rate: float = 55, min_pnl_usd: float = 1000) -> dict:
        samples = [
            "7hYttnq9q4j6Q8Fh6W6XxR7Q3eP6QAx9mF8mAb4L9qQx",
            "B2v9pXpGx4pG2Uo6mV8rYwYQxkzVg2UsRhfYpttV2VvN",
            "9aJwGq8f2wK4sYw2WkN7QaR6vY8pVdXh3mM8dYcY8kRt",
        ]
        whales = []
        for address in samples:
            report = self.wallet_analyzer.analyze_wallet(address)
            if report["win_rate"] >= min_win_rate and report["all_time_pnl_usd"] >= min_pnl_usd:
                whales.append(report)

        return {
            "filters": {"min_win_rate": min_win_rate, "min_pnl_usd": min_pnl_usd},
            "whales": whales,
            "scanned_wallets": len(samples),
        }

    def find_whales_by_token(self, mint: str) -> dict:
        base = self.find_whales(45, -5000)
        return {"token": {"mint": mint, "symbol": "UNKNOWN"}, "whales": base["whales"], "scanned_wallets": base["scanned_wallets"]}
