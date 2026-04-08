from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv


load_dotenv()


@dataclass(frozen=True)
class Settings:
    telegram_token: str
    helius_api_key: str
    data_dir: str
    scan_interval_sec: int
    dev_wallets: tuple[str, ...]



def get_settings() -> Settings:
    dev_wallets = tuple(
        x.strip() for x in os.getenv("DEV_WALLETS", "").split(",") if x.strip()
    )
    return Settings(
        telegram_token=os.getenv("TELEGRAM_BOT_TOKEN", "").strip(),
        helius_api_key=os.getenv("HELIUS_API_KEY", "").strip(),
        data_dir=os.getenv("DATA_DIR", "data").strip() or "data",
        scan_interval_sec=max(15, int(os.getenv("SCAN_INTERVAL_SEC", "60"))),
        dev_wallets=dev_wallets,
    )
