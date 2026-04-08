'use strict';

const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

function intEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function floatEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function listEnv(name, fallback = []) {
  const value = process.env[name];
  if (!value) return fallback;
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(PROJECT_ROOT, 'data');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const STABLE_MINTS = [USDC_MINT, USDT_MINT];
const PUMP_PROGRAM_IDS = listEnv('PUMPFUN_PROGRAM_IDS', [
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
]);

const EXCLUDED_MINTS = new Set(
  listEnv('EXCLUDED_MINTS', [SOL_MINT, USDC_MINT, USDT_MINT])
);

const EXCLUDED_SYMBOLS = new Set(
  listEnv('EXCLUDED_SYMBOLS', [
    'SOL',
    'WSOL',
    'USDC',
    'USDT',
    'JUP',
    'JLP',
    'JTO',
    'MSOL',
    'BNSOL',
    'JITOSOL',
    'PYUSD',
    'WBTC',
    'WETH',
    'RAY',
    'ORCA',
    'BONKBTC'
  ]).map((item) => item.toUpperCase())
);

const MEME_KEYWORDS = listEnv('MEME_KEYWORDS', [
  'dog',
  'doge',
  'wif',
  'pepe',
  'bonk',
  'cat',
  'frog',
  'meme',
  'degen',
  'moon',
  'pump',
  'ape',
  'shib',
  'inu',
  'jeet',
  'trump',
  'biden',
  'mog',
  'giga',
  'chad',
  'retardio',
  'goat',
  'pnut',
  'popcat',
  'fart',
  'ai16z',
  'sigma',
  'wojak'
]).map((item) => item.toLowerCase());

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';

const config = {
  app: {
    name: 'whale-alert-sol',
    env: process.env.NODE_ENV || 'development',
    projectRoot: PROJECT_ROOT,
    startTrackerOnBoot: boolEnv('START_TRACKER_ON_BOOT', true),
    failOnTrackerBootError: boolEnv('FAIL_ON_TRACKER_BOOT_ERROR', false)
  },
  paths: {
    dataDir: DATA_DIR,
    stateFile: process.env.STATE_FILE
      ? path.resolve(process.env.STATE_FILE)
      : path.join(DATA_DIR, 'state.json')
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    parseMode: 'HTML',
    debugUpdates: boolEnv('TELEGRAM_DEBUG_UPDATES', process.env.NODE_ENV !== 'production'),
    dropPendingUpdates: boolEnv('TELEGRAM_DROP_PENDING_UPDATES', false),
    startupNotifyChatId: process.env.TELEGRAM_STARTUP_NOTIFY_CHAT_ID || ''
  },
  helius: {
    apiKey: HELIUS_API_KEY,
    rpcUrl:
      process.env.HELIUS_RPC_URL ||
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
    wsUrl:
      process.env.HELIUS_WS_URL ||
      `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
    enhancedBaseUrl:
      process.env.HELIUS_ENHANCED_BASE_URL || 'https://api-mainnet.helius-rpc.com',
    useEnhancedWs: boolEnv('WATCH_USE_WS', true),
    requestTimeoutMs: intEnv('HELIUS_REQUEST_TIMEOUT_MS', 20000),
    maxRetries: intEnv('HELIUS_MAX_RETRIES', 4)
  },
  jupiter: {
    apiKey: process.env.JUPITER_API_KEY || '',
    baseUrl: process.env.JUPITER_BASE_URL || 'https://api.jup.ag',
    tokensBaseUrl:
      process.env.JUPITER_TOKENS_BASE_URL || 'https://api.jup.ag/tokens/v2',
    priceUrl: process.env.JUPITER_PRICE_URL || 'https://api.jup.ag/price/v3'
  },
  analysis: {
    windowDays: intEnv('ANALYSIS_WINDOW_DAYS', 60),
    recentHistoryMaxPages: intEnv('RECENT_HISTORY_MAX_PAGES', 12),
    allTimeHistoryMaxPages: intEnv('ALLTIME_HISTORY_MAX_PAGES', 40),
    tokenHistoryMaxPages: intEnv('TOKEN_HISTORY_MAX_PAGES', 6),
    trackerPollIntervalMs: intEnv('TRACKER_POLL_INTERVAL_MS', 25000),
    holdAlertIntervalMinutes: intEnv('HOLD_ALERT_INTERVAL_MINUTES', 360),
    minHoldingUsd: floatEnv('MIN_HOLDING_USD', 1000),
    tokenInfoCacheTtlMs: intEnv('TOKEN_INFO_CACHE_TTL_MS', 6 * 60 * 60 * 1000),
    priceCacheTtlMs: intEnv('PRICE_CACHE_TTL_MS', 45 * 1000),
    walletAnalysisCacheTtlMs: intEnv('WALLET_ANALYSIS_CACHE_TTL_MS', 2 * 60 * 1000),
    whaleSearchCacheTtlMs: intEnv('WHALE_SEARCH_CACHE_TTL_MS', 5 * 60 * 1000),
    batchWalletConcurrency: intEnv('BATCH_WALLET_CONCURRENCY', 2),
    popularTokensLimit: intEnv('POPULAR_TOKENS_LIMIT', 10),
    tokenCandidateWalletLimit: intEnv('TOKEN_CANDIDATE_WALLET_LIMIT', 10),
    topHoldersLimit: intEnv('TOP_HOLDERS_LIMIT', 20),
    maxAlertHistory: intEnv('MAX_ALERT_HISTORY', 1000),
    scoreRecentBoostThresholdTrades: intEnv('SCORE_RECENT_BOOST_THRESHOLD_TRADES', 3)
  },
  thresholds: {
    largeTransferUsd: floatEnv('LARGE_TRANSFER_USD', 2500),
    largeTransferSol: floatEnv('LARGE_TRANSFER_SOL', 15),
    minWhaleScore: floatEnv('MIN_WHALE_SCORE', 65),
    minWinRate: floatEnv('MIN_WIN_RATE', 45),
    minPnlUsd: floatEnv('MIN_PNL_USD', 1000),
    minClosedTrades: intEnv('MIN_CLOSED_TRADES', 3),
    minTokenLiquidityUsd: floatEnv('MIN_TOKEN_LIQUIDITY_USD', 25000),
    minTokenOrganicScore: floatEnv('MIN_TOKEN_ORGANIC_SCORE', 20),
    maxMemecoinMcapUsd: floatEnv('MAX_MEMECOIN_MCAP_USD', 750000000),
    maxClusterDepth: intEnv('CLUSTER_MAX_DEPTH', 2),
    clusterMaxNeighbors: intEnv('CLUSTER_MAX_NEIGHBORS', 8),
    clusterLookbackDays: intEnv('CLUSTER_LOOKBACK_DAYS', 60),
    clusterCoordinationWindowSeconds: intEnv('CLUSTER_COORDINATION_WINDOW_SECONDS', 180),
    clusterMinConfidence: floatEnv('CLUSTER_MIN_CONFIDENCE', 35)
  },
  constants: {
    SOL_MINT,
    USDC_MINT,
    USDT_MINT,
    STABLE_MINTS,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    PUMP_PROGRAM_IDS,
    EXCLUDED_MINTS,
    EXCLUDED_SYMBOLS,
    MEME_KEYWORDS,
    SOLSCAN_BASE_URL: process.env.SOLSCAN_BASE_URL || 'https://solscan.io'
  }
};

config.isSolMint = (mint) => mint === SOL_MINT;
config.isStableMint = (mint) => STABLE_MINTS.includes(mint);
config.isBaseQuoteMint = (mint) => config.isSolMint(mint) || config.isStableMint(mint);
config.isExcludedMint = (mint) => EXCLUDED_MINTS.has(mint);
config.isExcludedSymbol = (symbol) => EXCLUDED_SYMBOLS.has(String(symbol || '').toUpperCase());
config.hasHelius = () => Boolean(config.helius.apiKey);
config.hasTelegram = () => Boolean(config.telegram.botToken);

module.exports = config;
