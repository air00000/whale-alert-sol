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



def get_settings() -> Settings:
    return Settings(
        telegram_token=os.getenv("TELEGRAM_BOT_TOKEN", "").strip(),
        helius_api_key=os.getenv("HELIUS_API_KEY", "").strip(),
        data_dir=os.getenv("DATA_DIR", "data").strip() or "data",
    )
