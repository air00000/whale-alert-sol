from __future__ import annotations

from dataclasses import dataclass

from .storage import JsonStorage


@dataclass
class WhaleTracker:
    storage: JsonStorage

    def add_watch(self, chat_id: int, address: str, name: str) -> dict:
        return self.storage.add_watch(chat_id, address, name)

    def remove_watch(self, chat_id: int, address: str) -> bool:
        return self.storage.remove_watch(chat_id, address)

    def list_watchlist(self, chat_id: int) -> list[dict]:
        return self.storage.list_watchlist(chat_id)
