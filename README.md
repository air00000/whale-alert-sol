# whale-alert-sol (Python)

Telegram-бот для поиска и мониторинга Solana-кошельков, полностью на Python.

## Что уже работает

- стабильные Telegram-команды: `/start`, `/help`, `/ping`, `/status`;  
- watchlist-флоу: `/watch`, `/unwatch`, `/list`;  
- кнопочное меню внутри Telegram (reply keyboard) + пошаговый ввод с отменой;  
- аналитические команды в Python-рантайме: `/score`, `/holdings`, `/cluster`, `/findwhales`, `/findbytoken`;  
- JSON-хранилище watchlist в `data/watchlist.json`.

## Структура проекта

```text
whale-alert-sol/
├── .env.example
├── .gitignore
├── README.md
├── requirements.txt
├── data/
├── src/                  # legacy Node.js tree (transition only)
└── pybot/
    ├── __init__.py
    ├── main.py
    ├── config.py
    ├── storage.py
    ├── helius.py
    ├── wallet_analyzer.py
    ├── whale_finder.py
    ├── cluster_analyzer.py
    ├── whale_tracker.py
    └── bot.py
```

## Быстрый старт

### 1) Установка

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2) Конфиг

```bash
cp .env.example .env
```

Минимум:

```env
TELEGRAM_BOT_TOKEN=...
HELIUS_API_KEY=...
```

### 3) Запуск

```bash
python -m pybot.main
```

## Команды Telegram

```text
/start
/help
/ping
/status
/watch <address> <name>
/unwatch <address>
/list
/score <address>
/holdings <address>
/cluster <address>
/findwhales
/findbytoken <mint>
```

После `/start` можно работать полностью через кнопки в самом Telegram.

## Переходный режим для PR-совместимости

Чтобы избежать merge-конфликтов с ветками, где ещё идут изменения в `src/*.js`, legacy Node.js файлы временно оставлены в репозитории, но целевой рантайм проекта — Python (`pybot/*`).
