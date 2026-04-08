from __future__ import annotations

from dataclasses import dataclass

from .wallet_analyzer import WalletAnalyzer


@dataclass
class ClusterAnalyzer:
    wallet_analyzer: WalletAnalyzer

    def analyze(self, seed: str) -> dict:
        a = self.wallet_analyzer.analyze_wallet(seed)
        return {
            "seed": seed,
            "suspicion_score": min(99, max(1, int(a["score"] * 0.9))),
            "node_count": 1,
            "edge_count": 0,
            "nodes": [{"address": seed, "score": a["score"], "pnl_usd": a["all_time_pnl_usd"], "win_rate": a["win_rate"]}],
            "edges": [],
        }
