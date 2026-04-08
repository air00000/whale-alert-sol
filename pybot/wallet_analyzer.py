from __future__ import annotations

import hashlib
from dataclasses import dataclass


@dataclass
class WalletAnalyzer:
    def _seed(self, address: str) -> int:
        return int(hashlib.sha256(address.encode("utf-8")).hexdigest()[:8], 16)

    def get_current_holdings(self, address: str) -> list[dict]:
        seed = self._seed(address)
        return [
            {"mint": "So11111111111111111111111111111111111111112", "symbol": "SOL", "amount": round((seed % 2500) / 100, 2), "usd_value": round((seed % 2500) / 100 * 180, 2)},
            {"mint": "Es9vMFrzaCERmJfrF4H4M2K6W2BeZ7FEfcYkgP6x53n", "symbol": "USDT", "amount": round((seed % 70000) / 10, 2), "usd_value": round((seed % 70000) / 10, 2)},
        ]

    def analyze_wallet(self, address: str) -> dict:
        seed = self._seed(address)
        score = 35 + (seed % 65)
        win_rate = 30 + (seed % 65)
        pnl = ((seed % 500000) - 250000) / 10
        return {
            "address": address,
            "score": score,
            "win_rate": round(win_rate, 1),
            "all_time_pnl_usd": round(pnl, 2),
            "trade_count": 20 + (seed % 300),
            "profiles": ["momentum", "swing"] if score > 60 else ["speculative"],
            "holdings": self.get_current_holdings(address),
        }
