# whale-alert-sol

MVP Telegram-бот для поиска, анализа и мониторинга китов в мемкоинах на Solana.

Бот умеет:
- находить потенциальных китов по популярным мемкоинам через Jupiter;
- искать китов по конкретному mint-адресу токена;
- анализировать кошельки по PnL / WinRate / ROI / стилю торговли / холдингам;
- отслеживать BUY / SELL / TRANSFER / ADD_LIQ / REMOVE_LIQ / HOLD;
- строить кластер связанных кошельков по переводам, фондированию и координированной торговле.

## Архитектура

```text
[Helius/Jupiter/Solana RPC]
          ↓
       [Parser]
          ↓
      [Analyzer]
          ↓
       [Scoring]
          ↓
 [Cluster Detection / Whale Finder]
          ↓
    [Telegram Alerts / Commands]
```

### Поток данных

1. `helius.js` получает транзакции, balances, top holders, токен-мету и цены.
2. `analyzer.js` превращает parsed-транзакции в события `BUY / SELL / TRANSFER / ADD_LIQ / REMOVE_LIQ`.
3. `wallet-analyzer.js` собирает историю сделок за окно времени, восстанавливает FIFO lots и считает метрики.
4. `whale-finder.js` сканирует мемкоины и ищет сильные кошельки.
5. `cluster-analyzer.js` строит граф связей от seed-кошелька.
6. `whale-tracker.js` следит за watchlist через Helius WebSocket и fallback polling.
7. `telegram-bot.js` отдаёт команды и алерты в Telegram.

## Структура проекта

```text
whale-alert-sol/
├── package.json
├── .env.example
├── .gitignore
├── README.md
├── data/
└── src/
    ├── index.js
    ├── config.js
    ├── storage.js
    ├── helius.js
    ├── analyzer.js
    ├── wallet-analyzer.js
    ├── whale-finder.js
    ├── whale-tracker.js
    ├── cluster-analyzer.js
    └── telegram-bot.js
```

## Быстрый старт

### 1) Установка

```bash
npm install
```

### 2) Конфиг

```bash
cp .env.example .env
```

Заполни минимум:

```env
TELEGRAM_BOT_TOKEN=...
HELIUS_API_KEY=...
```

Опционально:

```env
JUPITER_API_KEY=...
```

### 3) Запуск

```bash
npm start
```

Для разработки:

```bash
npm run dev
```

## Команды Telegram

Бот можно использовать полностью внутри Telegram без ручного ввода slash-команд: после `/start` появляется reply-клавиатура с действиями (Help/Status/Watchlist/Find whales и т.д.), а бот сам запрашивает нужные адреса/mint в диалоге.

```text
/watch <address> <name>
/unwatch <address>
/list
/score <address>
/findwhales
/findwhales <minWinRate> <minPnL>
/findbytoken <mint>
/cluster <address>
/holdings <address>
/help
```

### Примеры

```text
/watch 7hYttnq9q4j6... MemeWhale01
/score 7hYttnq9q4j6...
/findwhales
/findwhales 55 5000
/findbytoken DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
/cluster 7hYttnq9q4j6...
/holdings 7hYttnq9q4j6...
```

## Что делает каждый модуль

### `src/config.js`
- загрузка `.env`;
- лимиты, пороги, список исключённых токенов;
- constants: SOL / USDC / USDT / Token-2022 / pump.fun program ids.

### `src/helius.js`
- Helius Enhanced Transactions history;
- Helius parse transactions endpoint;
- Solana RPC balances / token accounts / top holders;
- Jupiter token metadata + price;
- Helius transaction WebSocket subscription.

### `src/analyzer.js`
- классификация parsed-транзакций;
- парсинг swap legs;
- BUY / SELL / TRANSFER / ADD_LIQ / REMOVE_LIQ;
- детект pump.fun через parser/source/program ids.

### `src/wallet-analyzer.js`
- анализ транзакций за последние `ANALYSIS_WINDOW_DAYS`;
- all-time анализ с ограничением по page budget;
- FIFO lots для realised / unrealised PnL;
- WinRate / ROI / trade counts / avg position / active weeks / styles;
- whale score 0–100.

### `src/whale-finder.js`
- получает toptrending / toptraded / toporganicscore / recent токены через Jupiter;
- фильтрует вероятные мемкоины;
- ищет кандидатов среди top holders и active token participants;
- анализирует кошельки и строит рейтинг китов.

### `src/whale-tracker.js`
- watchlist;
- Helius WS + polling fallback;
- алерты по BUY / SELL / TRANSFER / ADD_LIQ / REMOVE_LIQ / HOLD;
- dedupe сигнатур и hold snapshot alerts.

### `src/cluster-analyzer.js`
- BFS от seed-кошелька;
- direct transfer edges;
- shared funder edges;
- coordinated trading edges через time buckets;
- confidence score по рёбрам и suspicion score по кластеру.

### `src/telegram-bot.js`
- grammy bot;
- команды;
- форматирование алертов и аналитики.

### `src/index.js`
- сборка всех модулей;
- старт бота;
- graceful shutdown.

## Whale score

Итоговый score = 0–100.

Базовая логика:
- 30% — WinRate
- 20% — total PnL
- 20% — количество и качество сделок
- 15% — average ROI
- 15% — consistency

Дополнительно:
- небольшой boost за недавнюю активность;
- штраф за отрицательный total PnL;
- штраф за слишком малое количество закрытых сделок.

`wallet-analyzer.js` возвращает breakdown по каждому компоненту.

## Примеры Telegram-алертов

### BUY

```text
🟢 BUY PEPE
Wallet: 7hYt...9kLm (MemeWhale01)
Amount: 4,250,000 PEPE
Approx value: ~$8,430
Quote: 52.1 SOL
Source: JUPITER
Solscan tx | wallet | token
```

### SELL

```text
🔴 SELL BONK
Wallet: 7hYt...9kLm (MemeWhale01)
Amount: 19,500,000 BONK
Approx value: ~$12,110
Quote: 12,110 USDC
Source: ORCA
Solscan tx | wallet | token
```

### TRANSFER

```text
📤 TRANSFER SOL
Wallet: 7hYt...9kLm
Amount: 75 SOL
Approx value: ~$7,500
Direction: OUT
Counterparty: 4Jsa...2QpE
Source: SYSTEM
Solscan tx | wallet | token
```

### HOLD

```text
🪙 HOLD WIF
Wallet: 7hYt...9kLm
Amount: 18,500 WIF
Approx value: ~$24,000
Source: BALANCE_SNAPSHOT
wallet | token
```

## Практические ограничения и где логика приближённая

### 1) Исторический USD PnL не может быть идеальным без historical prices
Для точного USD PnL по каждому трейду нужен исторический price snapshot.

В этом MVP:
- если quote = USDC/USDT, оценка почти нормальная;
- если quote = SOL, стоимость считается по текущей цене SOL из Jupiter;
- если swap token→token, используется текущая цена quote token.

Это значит:
- ROI и relative trade quality полезны;
- абсолютный USD PnL для старых SOL-trades приближённый.

### 2) All-time история ограничена page budget
Чтобы не убить rate limits Helius, all-time анализ ограничен `ALLTIME_HISTORY_MAX_PAGES`.

Следствие:
- для очень старых/активных кошельков all-time метрики могут быть частичными;
- флаг `historyCoverage.allTimePageCapped` это показывает.

### 3) pump.fun / liquidity detection не всегда 100%
Логика детекта держится на:
- parsed `type`;
- `source`;
- program ids;
- description.

Если Helius parser не распарсил редкий маршрут или кастомный AMM path, событие может уйти в `TRANSFER` или не определиться как LP/pump.

### 4) Кластеризация — это heuristic, не proof
`cluster-analyzer.js` выдаёт confidence, а не математически доказанную связь.

Особенно:
- shared funder не всегда = один владелец;
- coordinated trading может возникать у публичных alpha-сигналов;
- нужен ручной review сильных кластеров.

## Как получать ключи

### Helius API key
1. Зарегистрируйся в Helius.
2. Создай API key в dashboard.
3. Подставь его в `.env` как `HELIUS_API_KEY`.

### Telegram Bot token
1. Открой Telegram.
2. Найди `@BotFather`.
3. Выполни `/newbot`.
4. Получи токен и подставь его в `.env` как `TELEGRAM_BOT_TOKEN`.

## Как улучшать в production

1. Перейти с JSON на SQLite/Postgres.
2. Добавить queue + worker для тяжёлых /findwhales.
3. Подключить historical price source для точного USD PnL.
4. Добавить webhooks / отдельный alerting worker.
5. Нормализовать DEX/program mapping.
6. Хранить собственный индекс wallet-token positions.
7. Поддержать multi-chat subscriptions и per-chat filters.
