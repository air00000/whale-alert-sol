'use strict';

const { Bot } = require('grammy');
const config = require('./config');
const { buildExplorerUrl, shortAddress } = require('./analyzer');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function extractErrorMessage(error) {
  if (!error) return 'Unknown error';
  return String(
    error.description
    || error.message
    || error.error?.description
    || error.error?.message
    || error
  );
}

function round(value, decimals = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = 10 ** decimals;
  return Math.round(num * factor) / factor;
}

function formatUsd(value) {
  const num = Number(value) || 0;
  return `$${num.toLocaleString('en-US', {
    maximumFractionDigits: num >= 1000 ? 0 : 2
  })}`;
}

function formatPct(value) {
  return `${round(value, 1)}%`;
}

function formatInt(value) {
  return `${Math.round(Number(value) || 0).toLocaleString('en-US')}`;
}

function chunkText(text, maxLength = 3800) {
  if (!text || text.length <= maxLength) return [text];
  const lines = text.split('\n');
  const chunks = [];
  let current = '';

  for (const line of lines) {
    if ((current + line + '\n').length > maxLength) {
      if (current) chunks.push(current.trim());
      current = `${line}\n`;
    } else {
      current += `${line}\n`;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function formatTimestamp(ts) {
  if (!ts) return 'n/a';
  try {
    return new Date(ts).toISOString();
  } catch (error) {
    return 'n/a';
  }
}

function isLikelySolanaAddress(value) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(String(value || '').trim());
}

function parseCommand(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('/')) return null;

  const [head, ...args] = trimmed.split(/\s+/).filter(Boolean);
  const match = head.match(/^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?$/i);
  if (!match) return null;

  return {
    command: String(match[1] || '').toLowerCase(),
    mention: match[2] ? String(match[2]).toLowerCase() : null,
    args
  };
}

class TelegramBotApp {
  constructor({
    storage,
    tracker,
    walletAnalyzer,
    whaleFinder,
    clusterAnalyzer,
    runtimeState = {},
    appConfig = config
  } = {}) {
    this.storage = storage;
    this.tracker = tracker;
    this.walletAnalyzer = walletAnalyzer;
    this.whaleFinder = whaleFinder;
    this.clusterAnalyzer = clusterAnalyzer;
    this.config = appConfig;

    this.runtime = {
      appStartedAt: new Date().toISOString(),
      heliusConfigured: Boolean(this.config.helius.apiKey),
      telegramStarted: false,
      telegramPollingRunning: false,
      telegramPollingError: null,
      trackerStarted: false,
      trackerStartError: null,
      trackerStatus: 'unknown',
      botUsername: null,
      lastUpdateAt: null,
      lastCommand: null,
      lastCommandAt: null,
      ...runtimeState
    };

    this.pollingPromise = null;
    this.bot = new Bot(this.config.telegram.botToken);
    this.registerHandlers();
  }

  setRuntimeStatus(patch = {}) {
    Object.assign(this.runtime, patch);
  }

  isCommandForThisBot(parsed) {
    if (!parsed?.mention) return true;
    if (!this.runtime.botUsername) return true;
    return parsed.mention === String(this.runtime.botUsername).toLowerCase();
  }

  async safeReply(ctx, text, extra = {}) {
    return ctx.reply(text, {
      parse_mode: this.config.telegram.parseMode,
      disable_web_page_preview: true,
      ...extra
    });
  }

  async replyLong(ctx, text) {
    for (const chunk of chunkText(text)) {
      await this.safeReply(ctx, chunk);
    }
  }

  walletLink(address, label = null) {
    const url = buildExplorerUrl(address, 'account');
    const safeLabel = escapeHtml(label || shortAddress(address));
    return url ? `<a href="${url}">${safeLabel}</a>` : `<code>${escapeHtml(address)}</code>`;
  }

  tokenLink(mint, symbol = null) {
    const url = buildExplorerUrl(mint, 'token');
    const safeLabel = escapeHtml(symbol || shortAddress(mint));
    return url ? `<a href="${url}">${safeLabel}</a>` : `<code>${escapeHtml(mint)}</code>`;
  }

  async ensureBackendReady(ctx, actionLabel = 'This action') {
    if (this.config.helius.apiKey) return true;
    await this.safeReply(
      ctx,
      `${escapeHtml(actionLabel)} is unavailable because <b>HELIUS_API_KEY</b> is not configured.\n`
      + 'Add it to <code>.env</code>, restart the process, then try again.\n\n'
      + 'Use /status to verify runtime configuration.'
    );
    return false;
  }

  formatHelp() {
    return [
      '<b>Whale Alert Sol — команды</b>',
      '/start — быстрый старт',
      '/help — помощь',
      '/status — runtime status и diagnostics',
      '/ping — быстрый health-check Telegram polling',
      '/watch &lt;address&gt; &lt;name&gt; — добавить кошелёк в мониторинг',
      '/unwatch &lt;address&gt; — убрать из мониторинга',
      '/list — список отслеживаемых кошельков',
      '/score &lt;address&gt; — глубокий анализ кошелька и whale score',
      '/findwhales — полный поиск китов по популярным мемкоинам',
      '/findwhales &lt;minWinRate&gt; &lt;minPnL&gt; — фильтрованный поиск',
      '/findbytoken &lt;mint&gt; — киты и лучшие трейдеры конкретного токена',
      '/cluster &lt;address&gt; — кластерный анализ кошелька',
      '/holdings &lt;address&gt; — текущие холдинги кошелька',
      '',
      '<b>Важно:</b> бот работает через команды. Если отправить адрес без команды, он подскажет варианты.'
    ].join('\n');
  }

  formatWatchlist(items) {
    if (!items.length) {
      return 'Список наблюдения пуст. Используй /watch &lt;address&gt; &lt;name&gt;';
    }

    const lines = ['<b>Watched wallets</b>'];
    items.forEach((item, index) => {
      lines.push(
        `${index + 1}. ${this.walletLink(item.address, item.name || shortAddress(item.address))} `
        + `<code>${escapeHtml(item.address)}</code>`
      );
    });
    return lines.join('\n');
  }

  formatWalletScore(analysis) {
    const { summary, holdings, tokenStats } = analysis;
    const lines = [
      `<b>Wallet score</b> ${this.walletLink(summary.address, shortAddress(summary.address))}`,
      `<b>Whale score:</b> ${summary.score}/100`,
      `<b>Profiles:</b> ${escapeHtml((summary.profiles || []).join(', ') || 'n/a')}`,
      `<b>All-time PnL:</b> ${formatUsd(summary.allTimePnlUsd)} `
        + `(realised ${formatUsd(summary.allTimeRealisedPnlUsd)} / unrealised ${formatUsd(summary.allTimeUnrealisedPnlUsd)})`,
      `<b>2m PnL:</b> ${formatUsd(summary.recentPnlUsd)}`,
      `<b>WinRate:</b> ${formatPct(summary.winRate)} `
        + `(2m ${formatPct(summary.recentWinRate)})`,
      `<b>Avg ROI:</b> ${formatPct(summary.avgRoiPct)} `
        + `(2m ${formatPct(summary.recentAvgRoiPct)})`,
      `<b>Trades:</b> ${formatInt(summary.tradeCount)} total / ${formatInt(summary.closedTradeCount)} closed / ${formatInt(summary.recentTradeCount)} recent`,
      `<b>Avg position:</b> ${formatUsd(summary.avgPositionUsd)}`,
      `<b>Active weeks:</b> ${formatPct(summary.activeWeeksRatio)} | positive weeks ${formatPct(summary.positiveWeeksRatio)}`,
      `<b>Holdings value:</b> ${formatUsd(summary.holdingsUsd)}`,
      `<b>Scoring:</b> WinRate ${summary.scoreBreakdown.winRate}, PnL ${summary.scoreBreakdown.pnl}, `
        + `Trades ${summary.scoreBreakdown.tradeQuality}, ROI ${summary.scoreBreakdown.roi}, Consistency ${summary.scoreBreakdown.consistency}`,
      `<b>Why:</b> ${escapeHtml(summary.reasons.join('; '))}`
    ];

    const topHoldings = holdings
      .filter((item) => item.usdValue > 0)
      .slice(0, 6)
      .map((item) => `• ${this.tokenLink(item.mint, item.symbol)} — ${formatUsd(item.usdValue)} (${item.amount.toLocaleString('en-US', { maximumFractionDigits: 4 })})`);

    if (topHoldings.length) {
      lines.push('<b>Top holdings</b>');
      lines.push(...topHoldings);
    }

    const topTokens = tokenStats
      .filter((item) => item.buyCount + item.sellCount > 0)
      .sort((a, b) => (b.realisedPnlUsd + b.unrealisedPnlUsd) - (a.realisedPnlUsd + a.unrealisedPnlUsd))
      .slice(0, 6)
      .map((item) => (
        `• ${this.tokenLink(item.mint, item.symbol)} — PnL ${formatUsd((item.realisedPnlUsd || 0) + (item.unrealisedPnlUsd || 0))}, `
        + `WinRate ${formatPct(item.winRate || 0)}, trades ${formatInt((item.buyCount || 0) + (item.sellCount || 0))}`
      ));

    if (topTokens.length) {
      lines.push('<b>Best token exposures</b>');
      lines.push(...topTokens);
    }

    if (summary.historyCoverage.allTimePageCapped) {
      lines.push('<i>Note: all-time history capped by configured Helius page budget.</i>');
    }

    return lines.join('\n');
  }

  formatWhaleSearch(result) {
    const lines = [
      '<b>Whale scan complete</b>',
      `<b>Scanned tokens:</b> ${result.scannedTokens}`,
      `<b>Filters:</b> minWinRate ${result.filters.minWinRate}% / minPnL ${formatUsd(result.filters.minPnlUsd)} / minScore ${result.filters.minScore}`
    ];

    if (!result.whales.length) {
      lines.push('Китов по заданным фильтрам не найдено.');
      return lines.join('\n');
    }

    lines.push('<b>Top whales</b>');
    result.whales.slice(0, 15).forEach((item, index) => {
      lines.push(
        `${index + 1}. ${this.walletLink(item.address)} — <b>${item.aggregateScore}/100</b> | `
        + `WinRate ${formatPct(item.winRate)} | PnL ${formatUsd(item.allTimePnlUsd)} | `
        + `tokens: ${escapeHtml(item.tokenSymbols.join(', '))} | profiles: ${escapeHtml((item.profiles || []).join(', '))}`
      );
    });

    lines.push('<b>Tokens scanned</b>');
    result.tokens.slice(0, 10).forEach((token) => {
      lines.push(
        `• ${this.tokenLink(token.id, token.symbol)} — liquidity ${formatUsd(token.liquidity || 0)}, organic ${round(token.organicScore || 0, 1)}`
      );
    });

    return lines.join('\n');
  }

  formatTokenWhales(result) {
    const lines = [
      `<b>Whales by token</b> ${this.tokenLink(result.token.mint, result.token.symbol)}`,
      `<b>Name:</b> ${escapeHtml(result.token.name || result.token.symbol || result.token.mint)}`,
      `<b>Liquidity:</b> ${formatUsd(result.token.liquidity || 0)} | <b>Organic:</b> ${round(result.token.organicScore || 0, 1)} | <b>Holders:</b> ${formatInt(result.token.holderCount || 0)}`,
      `<b>Scanned wallets:</b> ${result.scannedWallets}`
    ];

    if (result.notes?.length) {
      lines.push(`<b>Notes:</b> ${escapeHtml(result.notes.join('; '))}`);
    }

    if (!result.whales.length) {
      lines.push('Подходящих китов для этого токена не найдено.');
      return lines.join('\n');
    }

    lines.push('<b>Top wallets</b>');
    result.whales.slice(0, 15).forEach((item, index) => {
      lines.push(
        `${index + 1}. ${this.walletLink(item.address)} — <b>${item.whaleScore}/100</b> | `
        + `wallet ${item.walletScore}/100 | token ${item.tokenScore}/100 | `
        + `PnL ${formatUsd(item.allTimePnlUsd)} | token hold ${formatUsd(item.token.holdingUsd)} | `
        + `${round(item.token.holdingPctSupply, 4)}% supply | `
        + `token trades ${item.token.tradeCount}`
      );
      if (item.reasons?.length) {
        lines.push(`   ↳ ${escapeHtml(item.reasons.join('; '))}`);
      }
    });

    return lines.join('\n');
  }

  formatHoldings(address, holdings) {
    const lines = [
      `<b>Holdings</b> ${this.walletLink(address, shortAddress(address))}`
    ];

    const filtered = holdings
      .filter((item) => item.amount > 0)
      .sort((a, b) => b.usdValue - a.usdValue)
      .slice(0, 20);

    if (!filtered.length) {
      lines.push('Активов не найдено.');
      return lines.join('\n');
    }

    filtered.forEach((item, index) => {
      lines.push(
        `${index + 1}. ${this.tokenLink(item.mint, item.symbol)} — ${formatUsd(item.usdValue)} | `
        + `${item.amount.toLocaleString('en-US', { maximumFractionDigits: 6 })}`
      );
    });

    return lines.join('\n');
  }

  formatCluster(result) {
    const lines = [
      `<b>Cluster analysis</b> ${this.walletLink(result.seed, shortAddress(result.seed))}`,
      `<b>Suspicion:</b> ${result.suspicionScore}/100 — ${escapeHtml(result.suspicionLabel)}`,
      `<b>Graph:</b> ${result.nodeCount} wallets / ${result.edgeCount} strong relations`,
      `<b>Summary:</b> ${escapeHtml(result.summary.join('; '))}`
    ];

    if (result.nodes.length) {
      lines.push('<b>Wallets</b>');
      result.nodes.slice(0, 15).forEach((node, index) => {
        const analysis = node.walletAnalysis;
        lines.push(
          `${index + 1}. ${this.walletLink(node.address)} | depth ${node.depth} | relation ${escapeHtml(node.strongestRelation || 'seed')} | conf ${round(node.strongestConfidence || 0, 1)}`
            + (analysis ? ` | score ${analysis.score}/100 | PnL ${formatUsd(analysis.pnlUsd)} | WinRate ${formatPct(analysis.winRate)}` : '')
        );
      });
    }

    if (result.edges.length) {
      lines.push('<b>Strongest relations</b>');
      result.edges.slice(0, 12).forEach((edge, index) => {
        lines.push(
          `${index + 1}. ${this.walletLink(edge.a)} ↔ ${this.walletLink(edge.b)} | `
          + `<b>${edge.confidence}/100</b> (${escapeHtml(edge.confidenceLabel)}) | ${escapeHtml(edge.reasons.join('; '))}`
        );
      });
    }

    return lines.join('\n');
  }

  formatRuntimeStatus({ watchCount = 0 } = {}) {
    const lines = [
      '<b>Runtime status</b>',
      `<b>Bot:</b> ${this.runtime.botUsername ? `@${escapeHtml(this.runtime.botUsername)}` : 'n/a'}`,
      `<b>Telegram initialized:</b> ${yesNo(this.runtime.telegramStarted)}`,
      `<b>Polling running:</b> ${yesNo(this.runtime.telegramPollingRunning)}`,
      `<b>Helius configured:</b> ${yesNo(this.runtime.heliusConfigured)}`,
      `<b>Helius health:</b> ${escapeHtml(this.runtime.heliusHealth || 'unknown')}`,
      `<b>Tracker:</b> ${escapeHtml(this.runtime.trackerStatus || 'unknown')}`,
      `<b>Watched wallets in this chat:</b> ${watchCount}`,
      `<b>Started at:</b> ${escapeHtml(formatTimestamp(this.runtime.appStartedAt))}`,
      `<b>Last update:</b> ${escapeHtml(formatTimestamp(this.runtime.lastUpdateAt))}`,
      `<b>Last command:</b> ${escapeHtml(this.runtime.lastCommand || 'n/a')} (${escapeHtml(formatTimestamp(this.runtime.lastCommandAt))})`
    ];

    if (this.runtime.heliusVersion) {
      lines.push(`<b>Helius version:</b> <code>${escapeHtml(this.runtime.heliusVersion)}</code>`);
    }
    if (this.runtime.heliusLastError) {
      lines.push(`<b>Helius error:</b> <code>${escapeHtml(this.runtime.heliusLastError)}</code>`);
    }
    if (this.runtime.telegramPollingError) {
      lines.push(`<b>Telegram polling error:</b> <code>${escapeHtml(this.runtime.telegramPollingError)}</code>`);
    }
    if (this.runtime.trackerStartError) {
      lines.push(`<b>Tracker error:</b> <code>${escapeHtml(this.runtime.trackerStartError)}</code>`);
    }

    lines.push('');
    lines.push('Проверь /ping. Если /ping отвечает, а аналитические команды нет — проблема уже в backend/API, а не в Telegram intake.');

    return lines.join('\n');
  }

  buildUnknownCommandText(command) {
    return [
      `Неизвестная команда <code>/${escapeHtml(command || '')}</code>.`,
      'Используй /help для списка поддерживаемых команд.'
    ].join('\n');
  }

  buildPlainTextHint(text) {
    const trimmed = String(text || '').trim();
    if (isLikelySolanaAddress(trimmed)) {
      return [
        'Похоже, это Solana address / mint.',
        'Попробуй одну из команд:',
        `<code>/findbytoken ${escapeHtml(trimmed)}</code>`,
        `<code>/score ${escapeHtml(trimmed)}</code>`,
        `<code>/holdings ${escapeHtml(trimmed)}</code>`,
        `<code>/watch ${escapeHtml(trimmed)} MyWhale</code>`
      ].join('\n');
    }

    return 'Я работаю через команды. Используй /help.';
  }

  async handleStart(ctx) {
    await this.replyLong(ctx, this.formatHelp());
  }

  async handleHelp(ctx) {
    await this.replyLong(ctx, this.formatHelp());
  }

  async handlePing(ctx) {
    await this.replyLong(ctx, [
      '<b>Pong</b>',
      `<b>Bot:</b> ${this.runtime.botUsername ? `@${escapeHtml(this.runtime.botUsername)}` : 'n/a'}`,
      `<b>Polling:</b> ${yesNo(this.runtime.telegramPollingRunning)}`,
      `<b>Helius configured:</b> ${yesNo(this.runtime.heliusConfigured)}`
    ].join('\n'));
  }

  async handleStatus(ctx) {
    const watchCount = (await this.storage.listWatchlist(ctx.chat?.id)).length;
    await this.replyLong(ctx, this.formatRuntimeStatus({ watchCount }));
  }

  async handleWatch(ctx, args) {
    if (!(await this.ensureBackendReady(ctx, 'Watch mode'))) return;

    const [address, ...nameParts] = args;
    if (!address) {
      await this.safeReply(ctx, 'Usage: /watch &lt;address&gt; &lt;name&gt;');
      return;
    }

    try {
      const name = nameParts.join(' ').trim() || address;
      const entry = await this.tracker.addWatch(address, name, ctx.chat.id);
      await this.safeReply(
        ctx,
        `Added to watchlist: <code>${escapeHtml(entry.address)}</code> (${escapeHtml(entry.name)})`
      );
    } catch (error) {
      await this.safeReply(ctx, `Failed to watch address: ${escapeHtml(extractErrorMessage(error))}`);
    }
  }

  async handleUnwatch(ctx, args) {
    const [address] = args;
    if (!address) {
      await this.safeReply(ctx, 'Usage: /unwatch &lt;address&gt;');
      return;
    }

    try {
      await this.tracker.removeWatch(address, ctx.chat.id);
      await this.safeReply(ctx, `Removed from watchlist: <code>${escapeHtml(address)}</code>`);
    } catch (error) {
      await this.safeReply(ctx, `Failed to unwatch address: ${escapeHtml(extractErrorMessage(error))}`);
    }
  }

  async handleList(ctx) {
    const items = await this.tracker.listWatchlist(ctx.chat.id);
    await this.replyLong(ctx, this.formatWatchlist(items));
  }

  async handleScore(ctx, args) {
    if (!(await this.ensureBackendReady(ctx, 'Wallet analysis'))) return;

    const [address] = args;
    if (!address) {
      await this.safeReply(ctx, 'Usage: /score &lt;address&gt;');
      return;
    }

    try {
      await this.safeReply(ctx, 'Analyzing wallet…');
      const analysis = await this.walletAnalyzer.analyzeWallet(address, { force: true });
      await this.replyLong(ctx, this.formatWalletScore(analysis));
    } catch (error) {
      await this.safeReply(ctx, `Score failed: ${escapeHtml(extractErrorMessage(error))}`);
    }
  }

  async handleFindWhales(ctx, args) {
    if (!(await this.ensureBackendReady(ctx, 'Whale search'))) return;

    const [minWinRate, minPnL] = args;
    try {
      await this.safeReply(ctx, 'Scanning popular memecoins and wallets…');
      const result = await this.whaleFinder.findWhales({
        minWinRate: minWinRate !== undefined ? Number(minWinRate) : undefined,
        minPnlUsd: minPnL !== undefined ? Number(minPnL) : undefined,
        force: true
      });
      await this.replyLong(ctx, this.formatWhaleSearch(result));
    } catch (error) {
      await this.safeReply(ctx, `findwhales failed: ${escapeHtml(extractErrorMessage(error))}`);
    }
  }

  async handleFindByToken(ctx, args) {
    if (!(await this.ensureBackendReady(ctx, 'Token whale search'))) return;

    const [mint] = args;
    if (!mint) {
      await this.safeReply(ctx, 'Usage: /findbytoken &lt;mint&gt;');
      return;
    }

    try {
      await this.safeReply(ctx, 'Scanning token holders and active traders…');
      const result = await this.whaleFinder.findWhalesByToken(mint, { force: true });
      await this.replyLong(ctx, this.formatTokenWhales(result));
    } catch (error) {
      await this.safeReply(ctx, `findbytoken failed: ${escapeHtml(extractErrorMessage(error))}`);
    }
  }

  async handleCluster(ctx, args) {
    if (!(await this.ensureBackendReady(ctx, 'Cluster analysis'))) return;

    const [address] = args;
    if (!address) {
      await this.safeReply(ctx, 'Usage: /cluster &lt;address&gt;');
      return;
    }

    try {
      await this.safeReply(ctx, 'Building wallet graph and relation scores…');
      const result = await this.clusterAnalyzer.analyze(address);
      await this.replyLong(ctx, this.formatCluster(result));
    } catch (error) {
      await this.safeReply(ctx, `cluster failed: ${escapeHtml(extractErrorMessage(error))}`);
    }
  }

  async handleHoldings(ctx, args) {
    if (!(await this.ensureBackendReady(ctx, 'Holdings lookup'))) return;

    const [address] = args;
    if (!address) {
      await this.safeReply(ctx, 'Usage: /holdings &lt;address&gt;');
      return;
    }

    try {
      await this.safeReply(ctx, 'Loading current holdings…');
      const holdings = await this.walletAnalyzer.getCurrentHoldings(address);
      await this.replyLong(ctx, this.formatHoldings(address, holdings));
    } catch (error) {
      await this.safeReply(ctx, `holdings failed: ${escapeHtml(extractErrorMessage(error))}`);
    }
  }

  getCommandHandlers() {
    return new Map([
      ['start', this.handleStart.bind(this)],
      ['help', this.handleHelp.bind(this)],
      ['status', this.handleStatus.bind(this)],
      ['ping', this.handlePing.bind(this)],
      ['watch', this.handleWatch.bind(this)],
      ['unwatch', this.handleUnwatch.bind(this)],
      ['list', this.handleList.bind(this)],
      ['score', this.handleScore.bind(this)],
      ['findwhales', this.handleFindWhales.bind(this)],
      ['findbytoken', this.handleFindByToken.bind(this)],
      ['cluster', this.handleCluster.bind(this)],
      ['holdings', this.handleHoldings.bind(this)]
    ]);
  }

  async sendAlert({ chatId, text, parseMode = this.config.telegram.parseMode, disableWebPagePreview = true }) {
    return this.bot.api.sendMessage(chatId, text, {
      parse_mode: parseMode,
      disable_web_page_preview: disableWebPagePreview
    });
  }

  registerHandlers() {
    const commandHandlers = this.getCommandHandlers();

    this.bot.catch((error) => {
      console.error('[telegram] update handling failed:', extractErrorMessage(error));
    });

    this.bot.use(async (ctx, next) => {
      ctx.state = ctx.state || {};
      if (ctx.state.commandHandled === undefined) {
        ctx.state.commandHandled = false;
      }

      const text = ctx.message?.text || ctx.editedMessage?.text || ctx.callbackQuery?.data || '';
      this.setRuntimeStatus({ lastUpdateAt: new Date().toISOString() });

      if (this.config.telegram.debugUpdates && text) {
        console.log('[telegram:update]', {
          chatId: ctx.chat?.id,
          chatType: ctx.chat?.type,
          from: ctx.from?.username || ctx.from?.id || 'unknown',
          updateId: ctx.update?.update_id,
          text
        });
      }

      await next();
    });

    this.bot.on('message:text', async (ctx) => {
      if (ctx.state?.commandHandled) return;

      const text = String(ctx.message?.text || '').trim();
      if (!text || ctx.from?.is_bot) return;

      const parsed = parseCommand(text);
      if (!parsed) {
        await this.safeReply(ctx, this.buildPlainTextHint(text));
        return;
      }

      if (!this.isCommandForThisBot(parsed)) {
        return;
      }

      this.setRuntimeStatus({
        lastCommand: `/${parsed.command}`,
        lastCommandAt: new Date().toISOString()
      });

      const handler = commandHandlers.get(parsed.command);
      if (!handler) {
        await this.safeReply(ctx, this.buildUnknownCommandText(parsed.command));
        return;
      }

      try {
        await handler(ctx, parsed.args);
      } catch (error) {
        console.error(`[telegram] command /${parsed.command} failed:`, error);
        await this.safeReply(ctx, `Command failed: ${escapeHtml(extractErrorMessage(error))}`);
      }
    });
  }

  async start() {
    if (!this.config.telegram.botToken) {
      throw new Error('TELEGRAM_BOT_TOKEN is required');
    }

    await this.bot.init();
    const botInfo = this.bot.botInfo || null;
    this.setRuntimeStatus({
      telegramStarted: true,
      telegramPollingRunning: true,
      botUsername: botInfo?.username || null
    });

    try {
      await this.bot.api.setMyCommands([
        { command: 'start', description: 'Show help' },
        { command: 'help', description: 'Help' },
        { command: 'status', description: 'Runtime status and diagnostics' },
        { command: 'ping', description: 'Check if bot responds' },
        { command: 'watch', description: 'Watch wallet' },
        { command: 'unwatch', description: 'Unwatch wallet' },
        { command: 'list', description: 'List watched wallets' },
        { command: 'score', description: 'Analyze wallet' },
        { command: 'findwhales', description: 'Find whales by popular memecoins' },
        { command: 'findbytoken', description: 'Find whales by token mint' },
        { command: 'cluster', description: 'Cluster analysis' },
        { command: 'holdings', description: 'Wallet holdings' }
      ]);
    } catch (error) {
      console.error('[telegram] setMyCommands failed:', extractErrorMessage(error));
    }

    try {
      await this.bot.api.deleteWebhook({
        drop_pending_updates: this.config.telegram.dropPendingUpdates
      });
      console.log('[telegram] Existing webhook cleared');
    } catch (error) {
      console.error('[telegram] deleteWebhook failed:', extractErrorMessage(error));
    }

    this.pollingPromise = this.bot.start({
      drop_pending_updates: this.config.telegram.dropPendingUpdates,
      allowed_updates: ['message'],
      onStart: (info) => {
        this.setRuntimeStatus({
          telegramStarted: true,
          telegramPollingRunning: true,
          botUsername: info?.username || this.runtime.botUsername || null
        });
        console.log(`[telegram] Long polling active as @${info?.username || 'unknown'}`);
      }
    }).catch((error) => {
      const message = extractErrorMessage(error);
      this.setRuntimeStatus({
        telegramPollingRunning: false,
        telegramPollingError: message
      });
      console.error('[telegram] polling crashed:', message);
      if (message.includes('409')) {
        console.error('[telegram] Hint: another process is already using getUpdates for this bot token. Stop the duplicate process or revoke the token in @BotFather.');
      }
    });

    await Promise.race([
      this.pollingPromise,
      sleep(750)
    ]);

    if (this.runtime.telegramPollingError) {
      throw new Error(`Telegram polling failed: ${this.runtime.telegramPollingError}`);
    }

    console.log(`[telegram] Bot initialized as @${this.runtime.botUsername || 'unknown'}`);
  }

  async stop() {
    try {
      await this.bot.stop();
    } catch (error) {
      console.error('[telegram] stop failed:', extractErrorMessage(error));
    }

    if (this.pollingPromise) {
      await Promise.race([
        this.pollingPromise.catch(() => undefined),
        sleep(1500)
      ]);
      this.pollingPromise = null;
    }

    this.setRuntimeStatus({ telegramPollingRunning: false });
  }
}

module.exports = TelegramBotApp;
