from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from urllib import request


@dataclass
class HeliusClient:
    api_key: str

    @property
    def is_configured(self) -> bool:
        return bool(self.api_key)

    @property
    def rpc_url(self) -> str:
        return f"https://mainnet.helius-rpc.com/?api-key={self.api_key}"

    def health_check(self) -> dict[str, Any]:
        if not self.is_configured:
            return {"ok": False, "message": "HELIUS_API_KEY missing"}

        payload = {
            "jsonrpc": "2.0",
            "id": "whale-alert-sol-py",
            "method": "getVersion",
            "params": [],
        }

        try:
            req = request.Request(
                self.rpc_url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with request.urlopen(req, timeout=8) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            version = (body.get("result") or {}).get("solana-core", "unknown")
            return {"ok": True, "version": version}
        except Exception as exc:
            return {"ok": False, "message": str(exc)}
