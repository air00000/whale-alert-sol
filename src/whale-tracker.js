'use strict';

const config = require('./config');
const {
  buildExplorerUrl,
  classifyTransaction,
  shortAddress,
  transactionInvolvesAddress
} = require('./analyzer');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function uniq(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function round(value, decimals = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = 10 ** decimals;
  return Math.round(num * factor) / factor;
}

function numberOrZero(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function extractUsdPrice(priceEntry) {
  if (priceEntry === null || priceEntry === undefined) return 0;
  if (typeof priceEntry === 'number') return Number.isFinite(priceEntry) ? priceEntry : 0;
  for (const key of ['usdPrice', 'price', 'value', 'usdValue']) {
    const candidate = Number(priceEntry?.[key]);
    if (Number.isFinite(candidate) && candidate > 0) return candidate;
  }
  return 0;
}

function currentUsdPriceForMint(mint, prices = {}) {
  if (!mint) return 0;
  if (config.isStableMint(mint)) return 1;
  return extractUsdPrice(prices[mint]);
}

function formatUsd(value) {
  const num = Number(value) || 0;
  return `$${num.toLocaleString('en-US', {
    maximumFractionDigits: num >= 1000 ? 0 : 2
  })}`;
}

function formatTokenAmount(amount) {
  const num = Number(amount) || 0;
  return num.toLocaleString('en-US', {
    maximumFractionDigits: num >= 1000 ? 2 : 6
  });
}

function looksLikeMemecoin(meta, mint) {
  if (!mint || config.isExcludedMint(mint)) return false;
  const symbol = String(meta?.symbol || '').toUpperCase();
  if (config.isExcludedSymbol(symbol)) return false;
  const tags = Array.isArray(meta?.tags) ? meta.tags.map((item) => String(item).toLowerCase()) : [];
  const launchpad = String(meta?.launchpad || '').toLowerCase();
  const text = `${String(meta?.symbol || '').toLowerCase()} ${String(meta?.name || '').toLowerCase()}`;

  return config.constants.MEME_KEYWORDS.some((keyword) => text.includes(keyword))
    || tags.includes('meme')
    || launchpad.includes('pump')
    || launchpad.includes('moonshot');
}

function extractSignatureFromWsResult(result) {
  if (!result) return null;
  if (result.signature) return result.signature;
  if (Array.isArray(result?.transaction?.transaction?.signatures) && result.transaction.transaction.signatures[0]) {
    return result.transaction.transaction.signatures[0];
  }
  if (Array.isArray(result?.transaction?.signatures) && result.transaction.signatures[0]) {
    return result.transaction.signatures[0];
  }
  return null;
}

class WhaleTracker {
  constructor({ storage, helius, walletAnalyzer, onAlert, appConfig = config } = {}) {
    this.storage = storage;
    this.helius = helius;
    this.walletAnalyzer = walletAnalyzer;
    this.onAlert = onAlert;
    this.config = appConfig;

    this.started = false;
    this.startedAt = null;
    this.pollLoopPromise = null;
    this.ws = null;
    this.processedSignatures = new Map();
    this.lastHoldScans = new Map();
    this.refreshingWs = false;
    this.lastError = null;
    this.lastPollAt = 0;
    this.lastSuccessfulPollAt = 0;
    this.lastWsEventAt = 0;
  }

  getDedupeKey(address, signature) {
    return `${address}:${signature}`;
  }

  hasProcessed(address, signature) {
    if (!signature) return false;
    const key = this.getDedupeKey(address, signature);
    const ts = this.processedSignatures.get(key);
    if (!ts) return false;
    if (Date.now() - ts > 30 * 60 * 1000) {
      this.processedSignatures.delete(key);
      return false;
    }
    return true;
  }

  markProcessed(address, signature) {
    if (!signature) return;
    const key = this.getDedupeKey(address, signature);
    this.processedSignatures.set(key, Date.now());
    if (this.processedSignatures.size > 5000) {
      const entries = Array.from(this.processedSignatures.entries())
        .sort((a, b) => a[1] - b[1])
        .slice(0, 1000);
      for (const [oldKey] of entries) {
        this.processedSignatures.delete(oldKey);
      }
    }
  }

  setLastError(stage, error) {
    this.lastError = {
      stage,
      message: error?.message || String(error),
      at: new Date().toISOString()
    };
  }

  getStatus() {
    return {
      started: this.started,
      startedAt: this.startedAt,
      wsConnected: Boolean(this.ws && this.ws.readyState === 1),
      refreshingWs: this.refreshingWs,
      processedSignatureCount: this.processedSignatures.size,
      lastPollAt: this.lastPollAt || null,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt || null,
      lastWsEventAt: this.lastWsEventAt || null,
      lastError: this.lastError
    };
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.startedAt = new Date().toISOString();

    const watchlist = await this.storage.listWatchlist();
    for (const entry of watchlist) {
      try {
        await this.primeCursor(entry.address);
      } catch (error) {
        console.error(`[tracker] primeCursor failed for ${entry.address}:`, error.message);
      }
    }

    this.pollLoopPromise = this.startPollingLoop();

    try {
      await this.refreshWebSocket();
    } catch (error) {
      console.error('[tracker] refreshWebSocket failed during start:', error.message);
    }

    console.log(`[tracker] started with ${watchlist.length} watched wallets`);
  }

  async stop() {
    this.started = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch (error) {
        console.error('[tracker] Failed to close ws:', error.message);
      }
      this.ws = null;
    }
    if (this.pollLoopPromise) {
      try {
        await this.pollLoopPromise;
      } catch (error) {
        // ignore during shutdown
      }
      this.pollLoopPromise = null;
    }
  }

  async addWatch(address, name, chatId) {
    this.helius.validateAddress(address);
    const entry = await this.storage.addWatch(address, name, chatId);
    await this.primeCursor(address);
    try {
      await this.refreshWebSocket();
    } catch (error) {
      console.error('[tracker] refreshWebSocket failed after addWatch:', error.message);
    }
    return entry;
  }

  async removeWatch(address, chatId) {
    const entry = await this.storage.removeWatch(address, chatId);
    try {
      await this.refreshWebSocket();
    } catch (error) {
      console.error('[tracker] refreshWebSocket failed after removeWatch:', error.message);
    }
    return entry;
  }

  async listWatchlist(chatId = null) {
    return this.storage.listWatchlist(chatId);
  }

  async primeCursor(address) {
    const existing = await this.storage.getCursor(address);
    if (existing?.lastSignature) return existing;

    const history = await this.helius.fetchAddressTransactionsWindow(address, {
      maxPages: 1,
      limit: 1,
      sortOrder: 'desc',
      tokenAccounts: 'all'
    });

    const latest = history.transactions?.[0];
    const cursor = {
      lastSignature: latest?.signature || null,
      lastTimestamp: latest?.timestamp || 0,
      primedAt: Date.now()
    };

    await this.storage.setCursor(address, cursor);
    return cursor;
  }

  async startPollingLoop() {
    while (this.started) {
      try {
        await this.pollOnce();
      } catch (error) {
        this.setLastError('pollOnce', error);
        console.error('[tracker] pollOnce failed:', error.message);
      }
      await sleep(this.config.analysis.trackerPollIntervalMs);
    }
  }

  async pollOnce() {
    this.lastPollAt = Date.now();
    const watchlist = await this.storage.listWatchlist();

    for (const entry of watchlist) {
      const cursor = await this.storage.getCursor(entry.address);
      if (!cursor?.lastSignature) {
        await this.primeCursor(entry.address);
        continue;
      }

      const history = await this.helius.fetchAddressTransactionsWindow(entry.address, {
        afterSignature: cursor.lastSignature,
        maxPages: 4,
        limit: 100,
        sortOrder: 'asc',
        tokenAccounts: 'all'
      });

      const transactions = history.transactions || [];
      for (const tx of transactions) {
        await this.processTransactionForWatch(entry, tx);
      }

      const latest = transactions[transactions.length - 1];
      if (latest?.signature) {
        await this.storage.setCursor(entry.address, {
          lastSignature: latest.signature,
          lastTimestamp: latest.timestamp || 0
        });
      }

      await this.emitHoldSnapshot(entry);
    }

    this.lastSuccessfulPollAt = Date.now();
  }

  async refreshWebSocket() {
    if (this.refreshingWs) return;
    this.refreshingWs = true;

    try {
      const watchlist = await this.storage.listWatchlist();
      const addresses = uniq(watchlist.map((entry) => entry.address));

      if (this.ws) {
        try {
          this.ws.close();
        } catch (error) {
          console.error('[tracker] close ws before refresh failed:', error.message);
        }
        this.ws = null;
      }

      if (!this.config.helius.useEnhancedWs || !addresses.length) {
        return;
      }

      this.ws = this.helius.createEnhancedWsClient({
        accountInclude: addresses,
        onOpen: () => {
          console.log(`[tracker] WebSocket subscribed for ${addresses.length} watched wallets`);
        },
        onError: (error) => {
          this.setLastError('websocket', error);
          console.error('[tracker] ws error:', error.message);
        },
        onClose: (code, reason) => {
          console.warn(`[tracker] ws closed (${code}): ${reason || 'no reason'}`);
          this.ws = null;
        },
        onTransaction: async (result) => {
          try {
            this.lastWsEventAt = Date.now();
            await this.handleWebSocketResult(result);
          } catch (error) {
            this.setLastError('handleWebSocketResult', error);
            console.error('[tracker] handleWebSocketResult failed:', error.message);
          }
        }
      });
    } finally {
      this.refreshingWs = false;
    }
  }

  async handleWebSocketResult(result) {
    const signature = extractSignatureFromWsResult(result);
    if (!signature) return;

    const parsed = await this.helius.getEnhancedTransactions([signature]);
    const tx = Array.isArray(parsed) ? parsed[0] : null;
    if (!tx) return;

    const watchlist = await this.storage.listWatchlist();
    for (const entry of watchlist) {
      if (!transactionInvolvesAddress(tx, entry.address)) continue;
      await this.processTransactionForWatch(entry, tx);
      await this.storage.setCursor(entry.address, {
        lastSignature: tx.signature,
        lastTimestamp: tx.timestamp || 0
      });
    }
  }

  async getEventContext(events) {
    const mints = uniq([
      ...events.map((event) => event.mint),
      ...events.map((event) => event.quoteMint),
      this.config.constants.SOL_MINT
    ]);

    const [tokenInfos, prices] = await Promise.all([
      this.helius.getTokenInfosByMints(mints.filter((mint) => mint && !config.isBaseQuoteMint(mint))),
      this.helius.getTokenPricesByMints(mints)
    ]);

    const tokenInfoIndex = new Map(
      tokenInfos
        .filter(Boolean)
        .map((item) => [item.id, item])
    );

    return { tokenInfoIndex, prices };
  }

  estimateEventUsd(event, prices) {
    if (!event) return 0;
    if (event.quoteAmount && event.quoteMint) {
      if (config.isStableMint(event.quoteMint)) return numberOrZero(event.quoteAmount);
      const quotePrice = currentUsdPriceForMint(event.quoteMint, prices);
      if (quotePrice > 0) return quotePrice * numberOrZero(event.quoteAmount);
    }
    const price = currentUsdPriceForMint(event.mint, prices);
    if (price > 0) return price * numberOrZero(event.amount);
    return 0;
  }

  shouldAlertEvent(event, tokenMeta, prices) {
    const usdValue = this.estimateEventUsd(event, prices);

    if (event.type === 'BUY' || event.type === 'SELL') {
      if (config.isBaseQuoteMint(event.mint)) return false;
      return true;
    }

    if (event.type === 'ADD_LIQ' || event.type === 'REMOVE_LIQ') {
      return true;
    }

    if (event.type === 'TRANSFER') {
      if (event.mint === config.constants.SOL_MINT) {
        return numberOrZero(event.amount) >= this.config.thresholds.largeTransferSol
          || usdValue >= this.config.thresholds.largeTransferUsd;
      }
      if (usdValue >= this.config.thresholds.largeTransferUsd) return true;
      return looksLikeMemecoin(tokenMeta, event.mint);
    }

    if (event.type === 'HOLD') {
      return usdValue >= this.config.analysis.minHoldingUsd && looksLikeMemecoin(tokenMeta, event.mint);
    }

    return false;
  }

  buildEventTitle(type, isPumpFun = false) {
    const prefix = isPumpFun ? 'pump.fun ' : '';
    if (type === 'BUY') return `🟢 ${prefix}BUY`;
    if (type === 'SELL') return `🔴 ${prefix}SELL`;
    if (type === 'TRANSFER') return '📤 TRANSFER';
    if (type === 'ADD_LIQ') return '💧 ADD_LIQ';
    if (type === 'REMOVE_LIQ') return '💸 REMOVE_LIQ';
    if (type === 'HOLD') return '🪙 HOLD';
    return `📡 ${type}`;
  }

  formatAlert(entry, event, tokenMeta, prices) {
    const symbol = tokenMeta?.symbol || (event.mint === config.constants.SOL_MINT ? 'SOL' : shortAddress(event.mint));
    const tokenLabel = tokenMeta?.name
      ? `${escapeHtml(tokenMeta.name)} (${escapeHtml(symbol)})`
      : escapeHtml(symbol);
    const usdValue = this.estimateEventUsd(event, prices);
    const quoteSymbol = event.quoteMint === config.constants.SOL_MINT
      ? 'SOL'
      : (event.quoteMint ? (event.quoteMint === config.constants.USDC_MINT ? 'USDC' : event.quoteMint === config.constants.USDT_MINT ? 'USDT' : shortAddress(event.quoteMint)) : null);
    const quoteText = event.quoteAmount && quoteSymbol
      ? `${formatTokenAmount(event.quoteAmount)} ${escapeHtml(quoteSymbol)}`
      : null;

    const lines = [
      `<b>${this.buildEventTitle(event.type, event.isPumpFun)}</b> ${tokenLabel}`,
      `<b>Wallet:</b> <code>${escapeHtml(entry.address)}</code>${entry.name && entry.name !== entry.address ? ` (${escapeHtml(entry.name)})` : ''}`,
      `<b>Amount:</b> ${formatTokenAmount(event.amount)} ${escapeHtml(symbol)}`
    ];

    if (usdValue > 0) {
      lines.push(`<b>Approx value:</b> ${formatUsd(usdValue)}`);
    }
    if (quoteText) {
      lines.push(`<b>Quote:</b> ${quoteText}`);
    }
    if (event.direction) {
      lines.push(`<b>Direction:</b> ${escapeHtml(event.direction)}`);
    }
    if (event.counterparty) {
      lines.push(`<b>Counterparty:</b> <code>${escapeHtml(event.counterparty)}</code>`);
    }
    if (event.dex) {
      lines.push(`<b>Source:</b> ${escapeHtml(event.dex)}`);
    }
    if (event.description) {
      lines.push(`<b>Parsed:</b> ${escapeHtml(event.description).slice(0, 180)}`);
    }

    const links = [];
    if (event.txUrl) links.push(`<a href="${event.txUrl}">Solscan tx</a>`);
    if (event.walletUrl) links.push(`<a href="${event.walletUrl}">wallet</a>`);
    const tokenUrl = buildExplorerUrl(event.mint, 'token');
    if (tokenUrl) links.push(`<a href="${tokenUrl}">token</a>`);
    if (links.length) {
      lines.push(links.join(' | '));
    }

    return lines.join('\n');
  }

  async sendAlertToWatch(entry, payload) {
    if (typeof this.onAlert !== 'function') return;
    for (const chatId of entry.chatIds || []) {
      try {
        await this.onAlert({
          chatId,
          text: payload.text,
          parseMode: this.config.telegram.parseMode,
          disableWebPagePreview: true
        });
      } catch (error) {
        console.error(`[tracker] Failed to send alert to chat ${chatId}:`, error.message);
      }
    }
  }

  async processTransactionForWatch(entry, tx) {
    if (!tx?.signature) return;
    if (this.hasProcessed(entry.address, tx.signature)) return;

    const events = classifyTransaction(tx, entry.address);
    if (!events.length) {
      this.markProcessed(entry.address, tx.signature);
      return;
    }

    const { tokenInfoIndex, prices } = await this.getEventContext(events);

    for (const event of events) {
      const tokenMeta = tokenInfoIndex.get(event.mint) || null;
      if (!this.shouldAlertEvent(event, tokenMeta, prices)) continue;
      const text = this.formatAlert(entry, event, tokenMeta, prices);
      await this.sendAlertToWatch(entry, { text });
      await this.storage.appendAlert({
        address: entry.address,
        chatIds: entry.chatIds,
        signature: tx.signature,
        eventType: event.type,
        mint: event.mint,
        amount: event.amount,
        timestamp: tx.timestamp || 0,
        text
      });
    }

    this.markProcessed(entry.address, tx.signature);
  }

  async emitHoldSnapshot(entry) {
    const now = Date.now();
    const minIntervalMs = this.config.analysis.holdAlertIntervalMinutes * 60 * 1000;
    const lastScan = this.lastHoldScans.get(entry.address) || 0;
    const minScanGapMs = Math.min(minIntervalMs, 15 * 60 * 1000);
    if (now - lastScan < minScanGapMs) return;
    this.lastHoldScans.set(entry.address, now);

    const holdings = await this.walletAnalyzer.getCurrentHoldings(entry.address);
    for (const holding of holdings) {
      if (!holding?.mint || config.isBaseQuoteMint(holding.mint)) continue;
      if ((holding.usdValue || 0) < this.config.analysis.minHoldingUsd) continue;

      const lastAlertTs = await this.storage.getLastHoldAlert(entry.address, holding.mint);
      if (lastAlertTs && now - lastAlertTs < minIntervalMs) continue;

      const event = {
        type: 'HOLD',
        wallet: entry.address,
        mint: holding.mint,
        amount: holding.amount,
        quoteMint: null,
        quoteAmount: null,
        dex: 'BALANCE_SNAPSHOT',
        source: 'BALANCE_SNAPSHOT',
        signature: null,
        slot: null,
        timestamp: Math.floor(now / 1000),
        txUrl: null,
        walletUrl: buildExplorerUrl(entry.address, 'account'),
        rawType: 'HOLD',
        description: `Open holding valued around ${formatUsd(holding.usdValue)}`,
        isPumpFun: false
      };

      const tokenMeta = {
        symbol: holding.symbol,
        name: holding.name,
        tags: holding.tags,
        launchpad: null
      };
      const prices = {
        [holding.mint]: { usdPrice: holding.currentPriceUsd }
      };

      if (this.shouldAlertEvent(event, tokenMeta, prices)) {
        const text = this.formatAlert(entry, event, tokenMeta, prices);
        await this.sendAlertToWatch(entry, { text });
        await this.storage.appendAlert({
          address: entry.address,
          chatIds: entry.chatIds,
          signature: null,
          eventType: 'HOLD',
          mint: holding.mint,
          amount: holding.amount,
          timestamp: event.timestamp,
          text
        });
      }

      await this.storage.setLastHoldAlert(entry.address, holding.mint, now);
    }
  }
}

module.exports = WhaleTracker;
