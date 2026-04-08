from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class JsonStorage:
    def __init__(self, data_dir: str) -> None:
        self.base = Path(data_dir)
        self.base.mkdir(parents=True, exist_ok=True)
        self.watchlist_file = self.base / "watchlist.json"
        if not self.watchlist_file.exists():
            self.watchlist_file.write_text("{}", encoding="utf-8")

    def _load(self) -> dict[str, list[dict[str, Any]]]:
        try:
            return json.loads(self.watchlist_file.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _save(self, payload: dict[str, list[dict[str, Any]]]) -> None:
        self.watchlist_file.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def list_watchlist(self, chat_id: int) -> list[dict[str, Any]]:
        data = self._load()
        return data.get(str(chat_id), [])

    def add_watch(self, chat_id: int, address: str, name: str) -> dict[str, Any]:
        data = self._load()
        key = str(chat_id)
        items = data.get(key, [])

        normalized = address.strip()
        for item in items:
            if item.get("address") == normalized:
                item["name"] = name
                data[key] = items
                self._save(data)
                return item

        entry = {"address": normalized, "name": name.strip() or normalized}
        items.append(entry)
        data[key] = items
        self._save(data)
        return entry

    def remove_watch(self, chat_id: int, address: str) -> bool:
        data = self._load()
        key = str(chat_id)
        items = data.get(key, [])
        next_items = [x for x in items if x.get("address") != address.strip()]
        changed = len(next_items) != len(items)
        data[key] = next_items
        self._save(data)
        return changed
