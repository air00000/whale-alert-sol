from __future__ import annotations

from .bot import build_application
from .config import get_settings
from .storage import JsonStorage


def main() -> None:
    settings = get_settings()
    if not settings.telegram_token:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is required")

    storage = JsonStorage(settings.data_dir)
    app = build_application(settings, storage)
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
