from __future__ import annotations

from .bot import Services, build_application
from .cluster_analyzer import ClusterAnalyzer
from .config import get_settings
from .helius import HeliusClient
from .storage import JsonStorage
from .wallet_analyzer import WalletAnalyzer
from .whale_finder import WhaleFinder
from .whale_tracker import WhaleTracker


def main() -> None:
    settings = get_settings()
    if not settings.telegram_token:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is required")

    storage = JsonStorage(settings.data_dir)
    helius = HeliusClient(settings.helius_api_key)
    wallet_analyzer = WalletAnalyzer()
    whale_finder = WhaleFinder(helius=helius, wallet_analyzer=wallet_analyzer, dev_wallets=set(settings.dev_wallets))
    cluster_analyzer = ClusterAnalyzer(wallet_analyzer)
    tracker = WhaleTracker(storage)

    services = Services(
        helius=helius,
        wallet_analyzer=wallet_analyzer,
        whale_finder=whale_finder,
        cluster_analyzer=cluster_analyzer,
        tracker=tracker,
        scan_interval_sec=settings.scan_interval_sec,
    )

    app = build_application(services, settings.telegram_token)
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
