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

    def _rpc_call(self, method: str, params: list[Any]) -> Any:
        payload = {"jsonrpc": "2.0", "id": "whale-alert-sol-py", "method": method, "params": params}
        req = request.Request(
            self.rpc_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with request.urlopen(req, timeout=12) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        if body.get("error"):
            raise RuntimeError(body["error"].get("message", "RPC error"))
        return body.get("result")

    def health_check(self) -> dict[str, Any]:
        if not self.is_configured:
            return {"ok": False, "message": "HELIUS_API_KEY missing"}
        try:
            version = self._rpc_call("getVersion", [])
            return {"ok": True, "version": (version or {}).get("solana-core", "unknown")}
        except Exception as exc:
            return {"ok": False, "message": str(exc)}

    def get_recent_signatures(self, address: str, limit: int = 25) -> list[dict[str, Any]]:
        try:
            result = self._rpc_call("getSignaturesForAddress", [address, {"limit": int(limit)}])
            return result if isinstance(result, list) else []
        except Exception:
            return []

    def get_token_largest_accounts(self, mint: str, limit: int = 20) -> list[str]:
        result = self._rpc_call("getTokenLargestAccounts", [mint])
        value = (result or {}).get("value") or []
        return [x.get("address") for x in value[:limit] if x.get("address")]

    def get_token_account_owner(self, token_account: str) -> str | None:
        result = self._rpc_call("getParsedAccountInfo", [token_account, {"encoding": "jsonParsed"}])
        info = (((result or {}).get("value") or {}).get("data") or {}).get("parsed") or {}
        return (((info.get("info") or {}).get("owner")) or None)

    def get_mint_authorities(self, mint: str) -> set[str]:
        result = self._rpc_call("getParsedAccountInfo", [mint, {"encoding": "jsonParsed"}])
        info = (((result or {}).get("value") or {}).get("data") or {}).get("parsed") or {}
        mint_info = info.get("info") or {}
        out: set[str] = set()
        for k in ("mintAuthority", "freezeAuthority"):
            v = mint_info.get(k)
            if isinstance(v, str) and v:
                out.add(v)
        return out
