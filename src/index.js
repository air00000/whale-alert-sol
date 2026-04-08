'use strict';

const config = require('./config');
const JsonStorage = require('./storage');
const HeliusClient = require('./helius');
const WalletAnalyzer = require('./wallet-analyzer');
const WhaleFinder = require('./whale-finder');
const ClusterAnalyzer = require('./cluster-analyzer');
const WhaleTracker = require('./whale-tracker');
const TelegramBotApp = require('./telegram-bot');

async function main() {
  if (!config.telegram.botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  if (!config.helius.apiKey) {
    console.warn('[app] HELIUS_API_KEY is missing. Telegram bot will still start, but analytics/monitoring commands will reply with a configuration error.');
  }

  const storage = await new JsonStorage().init();
  const helius = new HeliusClient({ storage });
  const walletAnalyzer = new WalletAnalyzer({ helius, storage });
  const whaleFinder = new WhaleFinder({ helius, walletAnalyzer, storage });
  const clusterAnalyzer = new ClusterAnalyzer({ helius, walletAnalyzer, storage });

  const heliusHealth = await helius.healthCheck();

  let telegramBot;
  const tracker = new WhaleTracker({
    storage,
    helius,
    walletAnalyzer,
    onAlert: async (payload) => {
      if (telegramBot) {
        await telegramBot.sendAlert(payload);
      }
    }
  });

  telegramBot = new TelegramBotApp({
    storage,
    tracker,
    walletAnalyzer,
    whaleFinder,
    clusterAnalyzer,
    runtimeState: {
      trackerStatus: config.helius.apiKey ? 'starting' : 'disabled',
      heliusConfigured: Boolean(config.helius.apiKey),
      heliusHealth: heliusHealth.ok ? 'ok' : (config.helius.apiKey ? 'degraded' : 'missing'),
      heliusVersion: heliusHealth.version || null,
      heliusLastError: heliusHealth.ok ? null : heliusHealth.message
    }
  });

  process.on('unhandledRejection', (error) => {
    console.error('[app] Unhandled rejection:', error);
  });

  process.on('uncaughtException', (error) => {
    console.error('[app] Uncaught exception:', error);
  });

  await telegramBot.start();

  if (!config.helius.apiKey) {
    telegramBot.setRuntimeStatus({
      trackerStarted: false,
      trackerStatus: 'disabled',
      trackerStartError: 'HELIUS_API_KEY missing'
    });
  } else {
    try {
      telegramBot.setRuntimeStatus({ trackerStatus: 'starting' });
      await tracker.start();
      telegramBot.setRuntimeStatus({
        trackerStarted: true,
        trackerStatus: 'running',
        trackerStartError: null
      });
    } catch (error) {
      telegramBot.setRuntimeStatus({
        trackerStarted: false,
        trackerStatus: 'failed',
        trackerStartError: error.message
      });
      console.error('[app] Tracker failed to start. Telegram bot stays online:', error);
    }
  }

  console.log(`[app] whale-alert-sol started (helius=${config.helius.apiKey ? 'configured' : 'missing'}, tracker=${telegramBot.runtime.trackerStatus})`);

  const shutdown = async (signal) => {
    console.log(`[app] ${signal} received, shutting down...`);
    try {
      await tracker.stop();
      await telegramBot.stop();
    } catch (error) {
      console.error('[app] Shutdown error:', error.message);
    } finally {
      process.exit(0);
    }
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[app] Fatal:', error);
  process.exit(1);
});
