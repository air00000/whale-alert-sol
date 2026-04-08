'use strict';

const config = require('./config');
const {
  buildExplorerUrl,
  extractWalletTradeEvents,
  shortAddress
} = require('./analyzer');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, decimals = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = 10 ** decimals;
  return Math.round(num * factor) / factor;
}

function sum(items) {
  return items.reduce((acc, item) => acc + (Number(item) || 0), 0);
}

function mean(items) {
  if (!items.length) return 0;
  return sum(items) / items.length;
}

function stddev(items) {
  if (!items.length) return 0;
  const avg = mean(items);
  const variance = mean(items.map((item) => (item - avg) ** 2));
  return Math.sqrt(variance);
}

function uniq(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function startOfDayTs(timestampSec) {
  if (!timestampSec) return 0;
  const date = new Date(timestampSec * 1000);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000;
}

function weekKey(timestampSec) {
  if (!timestampSec) return 'unknown-week';
  const date = new Date(timestampSec * 1000);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const dayOfYear = Math.floor((date - yearStart) / 86400000) + 1;
  const week = Math.ceil(dayOfYear / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function normalizeLog(value, maxValue) {
  if (maxValue <= 0) return 0;
  const safe = Math.max(0, Number(value) || 0);
  return clamp((Math.log10(1 + safe) / Math.log10(1 + maxValue)) * 100, 0, 100);
}

function normalizeLinear(value, minValue, maxValue) {
  if (maxValue <= minValue) return 0;
  const safe = Number(value) || 0;
  return clamp(((safe - minValue) / (maxValue - minValue)) * 100, 0, 100);
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

function estimateUsdValue(event, prices = {}) {
  if (!event) return 0;

  const quoteAmount = Number(event.quoteAmount) || 0;
  if (quoteAmount > 0) {
    if (config.isStableMint(event.quoteMint)) {
      return quoteAmount;
    }

    const quotePrice = currentUsdPriceForMint(event.quoteMint, prices);
    if (quotePrice > 0) {
      return quoteAmount * quotePrice;
    }
  }

  const mintPrice = currentUsdPriceForMint(event.mint, prices);
  if (mintPrice > 0) {
    return (Number(event.amount) || 0) * mintPrice;
  }

  return 0;
}

function sortByTimestampAsc(items) {
  return [...items].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

function buildTradeBook(events, holdingsIndex, prices, sinceTs) {
  const openLots = new Map();
  const tokenStats = new Map();
  const closedTrades = [];
  let unmatchedSellQty = 0;

  const getTokenStats = (mint) => {
    if (!tokenStats.has(mint)) {
      tokenStats.set(mint, {
        mint,
        buyCount: 0,
        sellCount: 0,
        totalBoughtQty: 0,
        totalSoldQty: 0,
        totalBuyUsd: 0,
        totalSellUsd: 0,
        realisedPnlUsd: 0,
        unrealisedPnlUsd: 0,
        avgClosedRoiPct: 0,
        closedTradeCount: 0,
        winCount: 0,
        lossCount: 0,
        currentHoldingQty: 0,
        currentHoldingUsd: 0,
        avgHoldDurationHours: 0,
        recentTradeCount: 0,
        firstTradeTs: null,
        lastTradeTs: null
      });
    }
    return tokenStats.get(mint);
  };

  const ensureLots = (mint) => {
    if (!openLots.has(mint)) openLots.set(mint, []);
    return openLots.get(mint);
  };

  for (const event of sortByTimestampAsc(events)) {
    const mint = event.mint;
    const amount = Number(event.amount) || 0;
    if (!mint || amount <= 0) continue;

    const usdValue = estimateUsdValue(event, prices);
    const stats = getTokenStats(mint);

    stats.firstTradeTs = stats.firstTradeTs ? Math.min(stats.firstTradeTs, event.timestamp || 0) : event.timestamp || 0;
    stats.lastTradeTs = stats.lastTradeTs ? Math.max(stats.lastTradeTs, event.timestamp || 0) : event.timestamp || 0;
    if ((event.timestamp || 0) >= sinceTs) {
      stats.recentTradeCount += 1;
    }

    if (event.type === 'BUY') {
      stats.buyCount += 1;
      stats.totalBoughtQty += amount;
      stats.totalBuyUsd += usdValue;

      ensureLots(mint).push({
        amount,
        costUsd: usdValue,
        unitCostUsd: amount > 0 ? usdValue / amount : 0,
        timestamp: event.timestamp || 0,
        quoteMint: event.quoteMint || null,
        quoteAmount: Number(event.quoteAmount) || 0,
        source: event.dex || event.source || 'UNKNOWN',
        synthetic: false
      });
      continue;
    }

    if (event.type === 'SELL') {
      stats.sellCount += 1;
      stats.totalSoldQty += amount;
      stats.totalSellUsd += usdValue;

      let remaining = amount;
      const sellUnitUsd = amount > 0 ? usdValue / amount : 0;
      const lots = ensureLots(mint);

      while (remaining > 1e-9 && lots.length) {
        const lot = lots[0];
        const matchedQty = Math.min(remaining, lot.amount);
        const matchedCostUsd = matchedQty * (lot.unitCostUsd || 0);
        const matchedProceedsUsd = matchedQty * sellUnitUsd;
        const pnlUsd = matchedProceedsUsd - matchedCostUsd;
        const roiPct = matchedCostUsd > 0 ? (pnlUsd / matchedCostUsd) * 100 : 0;
        const holdHours = lot.timestamp ? ((event.timestamp || 0) - lot.timestamp) / 3600 : 0;

        closedTrades.push({
          mint,
          qty: matchedQty,
          costUsd: matchedCostUsd,
          proceedsUsd: matchedProceedsUsd,
          pnlUsd,
          roiPct,
          openedAt: lot.timestamp,
          closedAt: event.timestamp || 0,
          holdHours,
          synthetic: Boolean(lot.synthetic)
        });

        stats.realisedPnlUsd += pnlUsd;
        stats.closedTradeCount += 1;
        if (pnlUsd >= 0) {
          stats.winCount += 1;
        } else {
          stats.lossCount += 1;
        }
        stats.avgHoldDurationHours += holdHours;

        lot.amount -= matchedQty;
        remaining -= matchedQty;
        if (lot.amount <= 1e-9) {
          lots.shift();
        }
      }

      if (remaining > 1e-9) {
        unmatchedSellQty += remaining;
      }
    }
  }

  for (const [mint, lots] of openLots.entries()) {
    const currentHolding = holdingsIndex.get(mint)?.amount || 0;
    const ledgerQty = sum(lots.map((lot) => lot.amount));

    if (currentHolding > ledgerQty + 1e-9) {
      lots.push({
        amount: currentHolding - ledgerQty,
        costUsd: 0,
        unitCostUsd: 0,
        timestamp: 0,
        quoteMint: null,
        quoteAmount: 0,
        source: 'synthetic_balance_reconcile',
        synthetic: true
      });
    } else if (currentHolding >= 0 && ledgerQty > currentHolding + 1e-9) {
      let ratio = currentHolding / ledgerQty;
      ratio = clamp(ratio, 0, 1);
      for (const lot of lots) {
        lot.amount *= ratio;
      }
    }

    const stats = getTokenStats(mint);
    const currentPrice = currentUsdPriceForMint(mint, prices);

    stats.currentHoldingQty = currentHolding;
    stats.currentHoldingUsd = currentHolding * currentPrice;

    for (const lot of lots) {
      if (lot.amount <= 0) continue;
      const currentValueUsd = lot.amount * currentPrice;
      const costUsd = lot.amount * (lot.unitCostUsd || 0);
      stats.unrealisedPnlUsd += currentValueUsd - costUsd;
    }
  }

  for (const stats of tokenStats.values()) {
    stats.avgClosedRoiPct = stats.closedTradeCount
      ? mean(closedTrades.filter((trade) => trade.mint === stats.mint).map((trade) => trade.roiPct))
      : 0;
    stats.avgHoldDurationHours = stats.closedTradeCount
      ? stats.avgHoldDurationHours / stats.closedTradeCount
      : 0;
    stats.winRate = stats.closedTradeCount
      ? (stats.winCount / stats.closedTradeCount) * 100
      : 0;
  }

  return {
    tokenStats,
    closedTrades,
    unmatchedSellQty,
    openLots
  };
}

function scoreBreakdownFromMetrics(metrics) {
  const winRateScore = normalizeLinear(metrics.winRate, 35, 80);
  const pnlScore = normalizeLog(Math.max(0, metrics.totalPnlUsd), 150000);
  const tradesQualityScore = clamp(
    normalizeLinear(metrics.closedTrades, 2, 25) * 0.55
      + normalizeLinear(metrics.distinctTokens, 1, 15) * 0.15
      + normalizeLinear(metrics.avgPositionUsd, 250, 10000) * 0.15
      + normalizeLinear(metrics.recentTrades, 1, 20) * 0.15,
    0,
    100
  );
  const roiScore = normalizeLinear(metrics.avgRoiPct, 5, 120);
  const consistencyScore = clamp(
    normalizeLinear(metrics.activeWeeksRatio * 100, 10, 70) * 0.35
      + normalizeLinear(metrics.positiveWeeksRatio * 100, 40, 85) * 0.35
      + (100 - normalizeLinear(metrics.roiStdDevPct, 20, 140)) * 0.30,
    0,
    100
  );

  const baseScore =
    winRateScore * 0.30
    + pnlScore * 0.20
    + tradesQualityScore * 0.20
    + roiScore * 0.15
    + consistencyScore * 0.15;

  let adjustedScore = baseScore;
  if (metrics.recentTrades >= config.analysis.scoreRecentBoostThresholdTrades) adjustedScore += 5;
  if (metrics.totalPnlUsd < 0) adjustedScore -= 7;
  if (metrics.closedTrades < config.thresholds.minClosedTrades) adjustedScore -= 10;
  if (metrics.winRate < 40) adjustedScore -= 7;

  return {
    winRate: round(winRateScore, 1),
    pnl: round(pnlScore, 1),
    tradeQuality: round(tradesQualityScore, 1),
    roi: round(roiScore, 1),
    consistency: round(consistencyScore, 1),
    raw: round(baseScore, 1),
    final: round(clamp(adjustedScore, 0, 100), 1)
  };
}

function buildWalletProfile({
  winRate,
  totalPnlUsd,
  recentPnlUsd,
  avgRoiPct,
  recentTrades,
  buyCount,
  sellCount,
  openHoldingUsd,
  avgHoldHours,
  distinctTokens,
  consistencyScore,
  pnlPerTradeUsd
}) {
  const labels = [];

  if (winRate >= 55 && totalPnlUsd >= 2000 && consistencyScore >= 55) {
    labels.push('smart money');
  }
  if (buyCount >= Math.max(4, sellCount * 1.5) && openHoldingUsd >= 2000) {
    labels.push('accumulator');
  }
  if (sellCount >= Math.max(4, buyCount * 1.3) && avgHoldHours < 72) {
    labels.push('dumper');
  }
  if (recentTrades >= 8 && avgHoldHours <= 24 && distinctTokens >= 4) {
    labels.push('sniper');
  }
  if (openHoldingUsd >= Math.max(3000, Math.abs(totalPnlUsd) * 0.8) && avgHoldHours >= 24 * 7) {
    labels.push('holder');
  }
  if (recentTrades >= 12 && distinctTokens >= 6 && (avgRoiPct < 15 || pnlPerTradeUsd < 100)) {
    labels.push('degen');
  }

  if (!labels.length) {
    if (recentPnlUsd > 0 && winRate >= 50) labels.push('active trader');
    else labels.push('mixed');
  }

  return uniq(labels);
}

function formatReasonList(metrics, scoreBreakdown, profiles, partialHistory, unmatchedSellQty) {
  const reasons = [];

  reasons.push(`WinRate ${round(metrics.winRate, 1)}%`);
  reasons.push(`PnL $${round(metrics.totalPnlUsd, 0).toLocaleString('en-US')}`);
  reasons.push(`closed trades ${metrics.closedTrades}`);
  reasons.push(`avg ROI ${round(metrics.avgRoiPct, 1)}%`);
  reasons.push(`consistency ${scoreBreakdown.consistency}/100`);
  if (profiles.length) reasons.push(`profile: ${profiles.join(', ')}`);
  if (partialHistory) reasons.push('all-time history capped by page budget');
  if (unmatchedSellQty > 0) reasons.push('some sells exceed reconstructed lots');

  return reasons;
}

function enrichTokenStats(tokenStatsMap, holdings, tokenInfoIndex, prices) {
  const holdingsIndex = new Map(holdings.map((item) => [item.mint, item]));

  const items = [];
  for (const [mint, stats] of tokenStatsMap.entries()) {
    const meta = tokenInfoIndex.get(mint) || null;
    const holding = holdingsIndex.get(mint) || null;
    items.push({
      ...stats,
      symbol: meta?.symbol || holding?.symbol || shortAddress(mint),
      name: meta?.name || holding?.name || null,
      currentPriceUsd: currentUsdPriceForMint(mint, prices),
      explorerUrl: buildExplorerUrl(mint, 'token')
    });
  }

  for (const holding of holdings) {
    if (!tokenStatsMap.has(holding.mint)) {
      items.push({
        mint: holding.mint,
        symbol: holding.symbol,
        name: holding.name,
        buyCount: 0,
        sellCount: 0,
        totalBoughtQty: 0,
        totalSoldQty: 0,
        totalBuyUsd: 0,
        totalSellUsd: 0,
        realisedPnlUsd: 0,
        unrealisedPnlUsd: 0,
        avgClosedRoiPct: 0,
        closedTradeCount: 0,
        winCount: 0,
        lossCount: 0,
        currentHoldingQty: holding.amount,
        currentHoldingUsd: holding.usdValue,
        avgHoldDurationHours: 0,
        recentTradeCount: 0,
        firstTradeTs: null,
        lastTradeTs: null,
        winRate: 0,
        currentPriceUsd: holding.currentPriceUsd,
        explorerUrl: buildExplorerUrl(holding.mint, 'token')
      });
    }
  }

  return items.sort((a, b) => {
    const left = (b.currentHoldingUsd || 0) + (b.realisedPnlUsd || 0);
    const right = (a.currentHoldingUsd || 0) + (a.realisedPnlUsd || 0);
    return left - right;
  });
}

class WalletAnalyzer {
  constructor({ helius, storage, appConfig = config } = {}) {
    this.helius = helius;
    this.storage = storage;
    this.config = appConfig;
  }

  buildCacheKey(address, options = {}) {
    return [
      address,
      options.includeAllTime !== false ? 'alltime' : 'recent',
      this.config.analysis.windowDays
    ].join(':');
  }

  async getCurrentHoldings(address, options = {}) {
    const [tokenBalances, solBalance] = await Promise.all([
      this.helius.getWalletTokenBalances(address),
      this.helius.getSOLBalance(address)
    ]);

    const mints = tokenBalances.map((item) => item.mint);
    const [tokenInfos, prices] = await Promise.all([
      this.helius.getTokenInfosByMints(mints),
      this.helius.getTokenPricesByMints([...mints, this.config.constants.SOL_MINT])
    ]);

    const tokenInfoIndex = new Map(
      tokenInfos
        .filter(Boolean)
        .map((item) => [item.id, item])
    );

    const holdings = tokenBalances.map((item) => {
      const meta = tokenInfoIndex.get(item.mint) || null;
      const currentPriceUsd = currentUsdPriceForMint(item.mint, prices);
      return {
        mint: item.mint,
        symbol: meta?.symbol || shortAddress(item.mint),
        name: meta?.name || null,
        amount: item.amount,
        currentPriceUsd,
        usdValue: item.amount * currentPriceUsd,
        decimals: item.decimals,
        tokenAccounts: item.tokenAccounts,
        explorerUrl: buildExplorerUrl(item.mint, 'token'),
        tags: Array.isArray(meta?.tags) ? meta.tags : [],
        organicScore: Number(meta?.organicScore) || 0,
        liquidity: Number(meta?.liquidity) || 0
      };
    }).sort((a, b) => b.usdValue - a.usdValue);

    const solPriceUsd = currentUsdPriceForMint(this.config.constants.SOL_MINT, prices) || 0;

    if (!options.excludeSol) {
      holdings.unshift({
        mint: this.config.constants.SOL_MINT,
        symbol: 'SOL',
        name: 'Solana',
        amount: solBalance,
        currentPriceUsd: solPriceUsd,
        usdValue: solBalance * solPriceUsd,
        decimals: 9,
        tokenAccounts: [],
        explorerUrl: buildExplorerUrl(this.config.constants.SOL_MINT, 'token'),
        tags: ['native']
      });
    }

    return holdings;
  }

  async loadRecentTradeHistory(address, sinceTs) {
    const recentHistory = await this.helius.fetchAddressTransactionsWindow(address, {
      sinceTs,
      maxPages: this.config.analysis.recentHistoryMaxPages,
      limit: 100,
      sortOrder: 'asc',
      tokenAccounts: 'all'
    });

    return recentHistory;
  }

  async loadAllTimeTradeHistory(address) {
    const history = await this.helius.fetchAddressTransactionsWindow(address, {
      maxPages: this.config.analysis.allTimeHistoryMaxPages,
      limit: 100,
      sortOrder: 'asc',
      tokenAccounts: 'all'
    });

    return history;
  }

  async analyzeWallet(address, options = {}) {
    this.helius.validateAddress(address);

    const cacheKey = this.buildCacheKey(address, options);
    if (!options.force && this.storage) {
      const cached = await this.storage.getCache(
        'walletAnalysis',
        cacheKey,
        this.config.analysis.walletAnalysisCacheTtlMs
      );
      if (cached) return cached;
    }

    const sinceTs = Math.floor(Date.now() / 1000) - this.config.analysis.windowDays * 86400;

    const [allTimeHistory, holdings] = await Promise.all([
      this.loadAllTimeTradeHistory(address),
      this.getCurrentHoldings(address)
    ]);

    const allTransactions = sortByTimestampAsc(allTimeHistory.transactions || []);
    const recentTransactions = allTransactions.filter((tx) => (tx.timestamp || 0) >= sinceTs);

    const tradeEvents = allTransactions.flatMap((tx) => extractWalletTradeEvents(tx, address));
    const recentTradeEvents = tradeEvents.filter((event) => (event.timestamp || 0) >= sinceTs);

    const tradedMints = uniq(tradeEvents.map((event) => event.mint));
    const priceMints = uniq([
      ...tradedMints,
      ...tradeEvents.map((event) => event.quoteMint),
      ...holdings.map((item) => item.mint),
      this.config.constants.SOL_MINT
    ]);

    const [prices, tokenInfos] = await Promise.all([
      this.helius.getTokenPricesByMints(priceMints),
      this.helius.getTokenInfosByMints(uniq([...tradedMints, ...holdings.map((item) => item.mint)]))
    ]);

    const tokenInfoIndex = new Map(
      tokenInfos
        .filter(Boolean)
        .map((item) => [item.id, item])
    );
    const holdingsIndex = new Map(holdings.map((item) => [item.mint, item]));

    const tradeBook = buildTradeBook(tradeEvents, holdingsIndex, prices, sinceTs);
    const tokenStats = enrichTokenStats(tradeBook.tokenStats, holdings, tokenInfoIndex, prices);

    const closedTrades = tradeBook.closedTrades;
    const recentClosedTrades = closedTrades.filter((trade) => (trade.closedAt || 0) >= sinceTs);

    const allTimeRealisedPnlUsd = sum(closedTrades.map((trade) => trade.pnlUsd));
    const recentRealisedPnlUsd = sum(recentClosedTrades.map((trade) => trade.pnlUsd));
    const allTimeUnrealisedPnlUsd = sum(tokenStats.map((item) => item.unrealisedPnlUsd));

    const totalPnlUsd = allTimeRealisedPnlUsd + allTimeUnrealisedPnlUsd;
    const recentUnrealisedPnlUsd = sum(
      tokenStats.map((item) => {
        if (!item.lastTradeTs || item.lastTradeTs < sinceTs) return 0;
        return item.unrealisedPnlUsd || 0;
      })
    );
    const recentPnlUsd = recentRealisedPnlUsd + recentUnrealisedPnlUsd;

    const avgRoiPct = mean(closedTrades.map((trade) => trade.roiPct));
    const recentAvgRoiPct = mean(recentClosedTrades.map((trade) => trade.roiPct));
    const winRate = closedTrades.length
      ? (closedTrades.filter((trade) => trade.pnlUsd >= 0).length / closedTrades.length) * 100
      : 0;
    const recentWinRate = recentClosedTrades.length
      ? (recentClosedTrades.filter((trade) => trade.pnlUsd >= 0).length / recentClosedTrades.length) * 100
      : 0;

    const avgPositionUsd = mean(
      tradeEvents
        .filter((event) => event.type === 'BUY')
        .map((event) => estimateUsdValue(event, prices))
        .filter((value) => value > 0)
    );

    const distinctTokens = uniq(tradeEvents.map((event) => event.mint)).length;
    const buyCount = tradeEvents.filter((event) => event.type === 'BUY').length;
    const sellCount = tradeEvents.filter((event) => event.type === 'SELL').length;
    const recentTrades = recentTradeEvents.length;

    const activeTradeDays = uniq(tradeEvents.map((event) => startOfDayTs(event.timestamp))).length;
    const activeTradeWeeks = uniq(tradeEvents.map((event) => weekKey(event.timestamp))).length;
    const lookbackWeeks = Math.max(1, Math.ceil(this.config.analysis.windowDays / 7));
    const activeWeeksRatio = activeTradeWeeks / lookbackWeeks;

    const pnlByWeek = new Map();
    for (const trade of closedTrades) {
      const key = weekKey(trade.closedAt);
      pnlByWeek.set(key, (pnlByWeek.get(key) || 0) + (trade.pnlUsd || 0));
    }
    const weeklyPnls = Array.from(pnlByWeek.values());
    const positiveWeeksRatio = weeklyPnls.length
      ? weeklyPnls.filter((value) => value > 0).length / weeklyPnls.length
      : 0;
    const roiStdDevPct = stddev(closedTrades.map((trade) => trade.roiPct));
    const avgHoldHours = mean(closedTrades.map((trade) => trade.holdHours));
    const pnlPerTradeUsd = closedTrades.length ? allTimeRealisedPnlUsd / closedTrades.length : 0;
    const openHoldingUsd = sum(holdings.map((item) => item.usdValue));

    const metrics = {
      winRate,
      totalPnlUsd,
      recentPnlUsd,
      closedTrades: closedTrades.length,
      avgRoiPct,
      avgPositionUsd,
      distinctTokens,
      recentTrades,
      activeWeeksRatio,
      positiveWeeksRatio,
      roiStdDevPct
    };

    const scoreBreakdown = scoreBreakdownFromMetrics(metrics);
    const profiles = buildWalletProfile({
      winRate,
      totalPnlUsd,
      recentPnlUsd,
      avgRoiPct,
      recentTrades,
      buyCount,
      sellCount,
      openHoldingUsd,
      avgHoldHours,
      distinctTokens,
      consistencyScore: scoreBreakdown.consistency,
      pnlPerTradeUsd
    });

    const summary = {
      address,
      walletUrl: buildExplorerUrl(address, 'account'),
      score: scoreBreakdown.final,
      scoreBreakdown,
      profiles,
      reasons: formatReasonList(
        metrics,
        scoreBreakdown,
        profiles,
        Boolean(allTimeHistory.partial),
        tradeBook.unmatchedSellQty
      ),
      allTimePnlUsd: round(totalPnlUsd),
      allTimeRealisedPnlUsd: round(allTimeRealisedPnlUsd),
      allTimeUnrealisedPnlUsd: round(allTimeUnrealisedPnlUsd),
      recentPnlUsd: round(recentPnlUsd),
      recentRealisedPnlUsd: round(recentRealisedPnlUsd),
      recentUnrealisedPnlUsd: round(recentUnrealisedPnlUsd),
      winRate: round(winRate, 1),
      recentWinRate: round(recentWinRate, 1),
      avgRoiPct: round(avgRoiPct, 1),
      recentAvgRoiPct: round(recentAvgRoiPct, 1),
      tradeCount: tradeEvents.length,
      closedTradeCount: closedTrades.length,
      recentTradeCount: recentTrades,
      buyCount,
      sellCount,
      avgPositionUsd: round(avgPositionUsd),
      activeTradeDays,
      activeTradeWeeks,
      activeWeeksRatio: round(activeWeeksRatio * 100, 1),
      positiveWeeksRatio: round(positiveWeeksRatio * 100, 1),
      avgHoldHours: round(avgHoldHours, 1),
      holdingsUsd: round(openHoldingUsd),
      distinctTokens,
      unmatchedSellQty: round(tradeBook.unmatchedSellQty, 6),
      historyCoverage: {
        recentWindowDays: this.config.analysis.windowDays,
        allTimePageCapped: Boolean(allTimeHistory.partial),
        analyzedTransactions: allTransactions.length,
        recentTransactions: recentTransactions.length,
        tradeEvents: tradeEvents.length
      }
    };

    const result = {
      summary,
      holdings: holdings.filter((item) => item.usdValue > 0 || item.amount > 0),
      tokenStats,
      recentTrades: recentTradeEvents,
      coverage: {
        partialHistory: Boolean(allTimeHistory.partial),
        unmatchedSellQty: tradeBook.unmatchedSellQty,
        caveats: [
          'USD PnL for SOL-quoted and cross-token swaps is estimated from current Jupiter prices.',
          'All-time history is bounded by configurable Helius page limits to avoid rate-limit blowups.'
        ]
      }
    };

    if (this.storage) {
      await this.storage.setCache('walletAnalysis', cacheKey, result);
    }

    return result;
  }

  async analyzeWalletForToken(address, mint, options = {}) {
    const analysis = await this.analyzeWallet(address, options);
    const token = analysis.tokenStats.find((item) => item.mint === mint) || null;
    const holding = analysis.holdings.find((item) => item.mint === mint) || null;

    return {
      address,
      mint,
      token,
      holding,
      score: analysis.summary.score,
      walletSummary: analysis.summary,
      tokenTradeCount: token ? token.buyCount + token.sellCount : 0,
      tokenRealisedPnlUsd: token ? round(token.realisedPnlUsd) : 0,
      tokenUnrealisedPnlUsd: token ? round(token.unrealisedPnlUsd) : 0,
      tokenWinRate: token ? round(token.winRate, 1) : 0,
      tokenAvgRoiPct: token ? round(token.avgClosedRoiPct, 1) : 0,
      currentHoldingUsd: holding ? round(holding.usdValue) : 0
    };
  }
}

module.exports = WalletAnalyzer;
