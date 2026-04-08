'use strict';

const config = require('./config');
const { extractParticipantsForMint, shortAddress } = require('./analyzer');

function uniq(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function round(value, decimals = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = 10 ** decimals;
  return Math.round(num * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      try {
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      } catch (error) {
        results[currentIndex] = { error };
      }
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

function lower(value) {
  return String(value || '').toLowerCase();
}

function numberOrZero(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function tokenPopularityScore(token) {
  const liquidity = numberOrZero(token?.liquidity);
  const organicScore = numberOrZero(token?.organicScore);
  const holderCount = numberOrZero(token?.holderCount);
  const mcap = numberOrZero(token?.mcap);
  const volume24h = numberOrZero(token?.stats24h?.volume || token?.dailyVolume);
  const buy24h = numberOrZero(token?.stats24h?.buyVolume);
  const sell24h = numberOrZero(token?.stats24h?.sellVolume);

  return (
    Math.log10(1 + liquidity) * 10
    + organicScore * 1.1
    + Math.log10(1 + holderCount) * 8
    + Math.log10(1 + volume24h + buy24h + sell24h) * 8
    + (mcap > 0 && mcap <= config.thresholds.maxMemecoinMcapUsd ? 8 : 0)
  );
}

function looksLikeMemecoin(token) {
  if (!token?.id) return false;
  if (config.isExcludedMint(token.id)) return false;
  if (config.isExcludedSymbol(token.symbol)) return false;

  const symbol = lower(token.symbol);
  const name = lower(token.name);
  const text = `${symbol} ${name}`;
  const tags = (Array.isArray(token.tags) ? token.tags : []).map((item) => lower(item));
  const launchpad = lower(token.launchpad || '');
  const freezeAuthority = token.freezeAuthority;
  const organicScore = numberOrZero(token.organicScore);
  const liquidity = numberOrZero(token.liquidity);
  const mcap = numberOrZero(token.mcap);

  const keywordHit = config.constants.MEME_KEYWORDS.some((keyword) => text.includes(keyword));
  const launchpadHit = ['pump', 'moonshot', 'boop', 'meme'].some((keyword) => launchpad.includes(keyword));
  const tagHit = tags.some((tag) => ['meme', 'pump', 'moonshot', 'community'].includes(tag));
  const verifiedBlueChip = tags.some((tag) => ['lst', 'stable', 'defi', 'infra', 'governance'].includes(tag));

  if (verifiedBlueChip) return false;
  if (liquidity < config.thresholds.minTokenLiquidityUsd) return false;
  if (organicScore < config.thresholds.minTokenOrganicScore && !keywordHit && !launchpadHit) {
    return false;
  }
  if (mcap > config.thresholds.maxMemecoinMcapUsd && !(keywordHit || launchpadHit || tagHit)) {
    return false;
  }

  return keywordHit || launchpadHit || tagHit || Boolean(freezeAuthority === null && organicScore >= 35);
}

function holderActivityScore(holderInfo, tokenAnalysis) {
  const pctOfSupply = numberOrZero(holderInfo?.pctOfSupply);
  const holdingUsd = numberOrZero(tokenAnalysis?.currentHoldingUsd);
  const tradeCount = numberOrZero(tokenAnalysis?.tokenTradeCount);
  const winRate = numberOrZero(tokenAnalysis?.tokenWinRate);
  const pnlUsd = numberOrZero(tokenAnalysis?.tokenRealisedPnlUsd + tokenAnalysis?.tokenUnrealisedPnlUsd);

  return clamp(
    Math.min(35, pctOfSupply * 12)
      + Math.min(20, Math.log10(1 + holdingUsd) * 6)
      + Math.min(20, tradeCount * 2)
      + Math.min(15, winRate / 6)
      + Math.min(10, Math.log10(1 + Math.max(0, pnlUsd)) * 4),
    0,
    100
  );
}

class WhaleFinder {
  constructor({ helius, walletAnalyzer, storage, appConfig = config } = {}) {
    this.helius = helius;
    this.walletAnalyzer = walletAnalyzer;
    this.storage = storage;
    this.config = appConfig;
  }

  async getPopularMemeTokens(force = false) {
    const cacheKey = 'popular-meme-tokens';
    if (!force && this.storage) {
      const cached = await this.storage.getCache(
        'whaleSearch',
        cacheKey,
        this.config.analysis.whaleSearchCacheTtlMs
      );
      if (cached) return cached;
    }

    const requests = await Promise.allSettled([
      this.helius.getPopularTokens('toptrending', '24h', 40),
      this.helius.getPopularTokens('toptraded', '24h', 40),
      this.helius.getPopularTokens('toporganicscore', '24h', 40),
      this.helius.getRecentTokens(30)
    ]);

    const merged = new Map();
    const sourceNames = ['toptrending', 'toptraded', 'toporganicscore', 'recent'];

    requests.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      for (const token of result.value || []) {
        if (!token?.id) continue;
        const current = merged.get(token.id) || { ...token, sourceBuckets: [] };
        current.sourceBuckets = uniq([...(current.sourceBuckets || []), sourceNames[index]]);
        // Keep the richer numeric snapshot when available.
        for (const key of [
          'liquidity',
          'organicScore',
          'mcap',
          'fdv',
          'holderCount',
          'usdPrice',
          'createdAt',
          'mintedAt',
          'launchpad',
          'tags'
        ]) {
          if (token[key] !== undefined && token[key] !== null) current[key] = token[key];
        }
        merged.set(token.id, current);
      }
    });

    const filtered = Array.from(merged.values())
      .filter((token) => looksLikeMemecoin(token))
      .sort((a, b) => tokenPopularityScore(b) - tokenPopularityScore(a))
      .slice(0, this.config.analysis.popularTokensLimit);

    if (this.storage) {
      await this.storage.setCache('whaleSearch', cacheKey, filtered);
    }

    return filtered;
  }

  async collectActiveParticipantsForMint(mint, sinceTs) {
    const history = await this.helius.fetchAddressTransactionsWindow(mint, {
      sinceTs,
      maxPages: this.config.analysis.tokenHistoryMaxPages,
      limit: 100,
      sortOrder: 'desc',
      tokenAccounts: 'none'
    });

    const scoreByWallet = new Map();

    for (const tx of history.transactions || []) {
      const participants = extractParticipantsForMint(tx, mint);
      for (const wallet of participants) {
        const current = scoreByWallet.get(wallet) || {
          address: wallet,
          touches: 0,
          firstSeenTs: tx.timestamp || 0,
          lastSeenTs: tx.timestamp || 0,
          exampleSignatures: []
        };
        current.touches += 1;
        current.firstSeenTs = Math.min(current.firstSeenTs, tx.timestamp || 0);
        current.lastSeenTs = Math.max(current.lastSeenTs, tx.timestamp || 0);
        if (tx.signature && current.exampleSignatures.length < 3) {
          current.exampleSignatures.push(tx.signature);
        }
        scoreByWallet.set(wallet, current);
      }
    }

    return {
      partial: Boolean(history.partial),
      participants: Array.from(scoreByWallet.values())
        .sort((a, b) => b.touches - a.touches)
    };
  }

  normalizeFilters(filters = {}) {
    return {
      minWinRate: Number.isFinite(Number(filters.minWinRate))
        ? Number(filters.minWinRate)
        : this.config.thresholds.minWinRate,
      minPnlUsd: Number.isFinite(Number(filters.minPnlUsd))
        ? Number(filters.minPnlUsd)
        : this.config.thresholds.minPnlUsd,
      minScore: Number.isFinite(Number(filters.minScore))
        ? Number(filters.minScore)
        : this.config.thresholds.minWhaleScore,
      minClosedTrades: Number.isFinite(Number(filters.minClosedTrades))
        ? Number(filters.minClosedTrades)
        : this.config.thresholds.minClosedTrades
    };
  }

  buildWhaleRecord({ walletSummary, tokenAnalysis, holderInfo, participantInfo, tokenInfo }) {
    const tokenSpecificScore = holderActivityScore(holderInfo, tokenAnalysis);
    const overallScore = numberOrZero(walletSummary?.score);
    const compositeScore = round(clamp(overallScore * 0.7 + tokenSpecificScore * 0.3, 0, 100), 1);

    const reasons = [];
    if (walletSummary?.winRate >= 50) reasons.push(`WinRate ${walletSummary.winRate}%`);
    if (walletSummary?.allTimePnlUsd > 0) reasons.push(`PnL $${walletSummary.allTimePnlUsd.toLocaleString('en-US')}`);
    if (tokenAnalysis?.tokenTradeCount > 0) reasons.push(`${tokenAnalysis.tokenTradeCount} trades in token`);
    if (holderInfo?.pctOfSupply > 0) reasons.push(`${round(holderInfo.pctOfSupply, 2)}% supply`);
    if (tokenAnalysis?.currentHoldingUsd > 0) reasons.push(`holding ~$${round(tokenAnalysis.currentHoldingUsd, 0).toLocaleString('en-US')}`);
    if (participantInfo?.touches > 0) reasons.push(`${participantInfo.touches} on-chain touches`);

    return {
      address: walletSummary.address,
      walletUrl: walletSummary.walletUrl,
      walletScore: overallScore,
      tokenScore: tokenSpecificScore,
      whaleScore: compositeScore,
      winRate: walletSummary.winRate,
      recentWinRate: walletSummary.recentWinRate,
      allTimePnlUsd: walletSummary.allTimePnlUsd,
      recentPnlUsd: walletSummary.recentPnlUsd,
      closedTrades: walletSummary.closedTradeCount,
      recentTrades: walletSummary.recentTradeCount,
      avgRoiPct: walletSummary.avgRoiPct,
      profiles: walletSummary.profiles,
      token: {
        mint: tokenInfo?.id || tokenAnalysis?.mint,
        symbol: tokenInfo?.symbol || tokenAnalysis?.token?.symbol || shortAddress(tokenAnalysis?.mint),
        name: tokenInfo?.name || tokenAnalysis?.token?.name || null,
        tradeCount: tokenAnalysis?.tokenTradeCount || 0,
        realisedPnlUsd: tokenAnalysis?.tokenRealisedPnlUsd || 0,
        unrealisedPnlUsd: tokenAnalysis?.tokenUnrealisedPnlUsd || 0,
        winRate: tokenAnalysis?.tokenWinRate || 0,
        avgRoiPct: tokenAnalysis?.tokenAvgRoiPct || 0,
        holdingUsd: tokenAnalysis?.currentHoldingUsd || 0,
        holdingPctSupply: round(holderInfo?.pctOfSupply || 0, 4),
        touches: participantInfo?.touches || 0
      },
      holderInfo: holderInfo || null,
      participantInfo: participantInfo || null,
      reasons
    };
  }

  async findWhalesByToken(mint, filters = {}) {
    this.helius.validateAddress(mint);
    const normalized = this.normalizeFilters(filters);

    const tokenInfo = await this.helius.getTokenInfo(mint);
    if (!tokenInfo) {
      throw new Error(`Token metadata not found for mint ${mint}`);
    }

    const sinceTs = Math.floor(Date.now() / 1000) - this.config.analysis.windowDays * 86400;

    const [holders, activeParticipants] = await Promise.all([
      this.helius.getTokenLargestAccountOwners(mint, {
        limit: this.config.analysis.topHoldersLimit
      }),
      this.collectActiveParticipantsForMint(mint, sinceTs)
    ]);

    const holderIndex = new Map();
    for (const holder of holders) {
      if (!holder?.owner) continue;
      const existing = holderIndex.get(holder.owner);
      if (!existing || (holder.uiAmount || 0) > (existing.uiAmount || 0)) {
        holderIndex.set(holder.owner, holder);
      }
    }

    const participantIndex = new Map(
      activeParticipants.participants.map((item) => [item.address, item])
    );

    const candidates = uniq([
      ...holders.map((item) => item.owner),
      ...activeParticipants.participants.map((item) => item.address)
    ]).slice(0, this.config.analysis.tokenCandidateWalletLimit);

    const analyses = await mapWithConcurrency(
      candidates,
      this.config.analysis.batchWalletConcurrency,
      async (address) => {
        const walletAnalysis = await this.walletAnalyzer.analyzeWallet(address);
        const tokenEntry = walletAnalysis.tokenStats.find((item) => item.mint === mint) || null;
        const holdingEntry = walletAnalysis.holdings.find((item) => item.mint === mint) || null;
        const tokenAnalysis = {
          address,
          mint,
          token: tokenEntry,
          holding: holdingEntry,
          score: walletAnalysis.summary.score,
          walletSummary: walletAnalysis.summary,
          tokenTradeCount: tokenEntry ? (tokenEntry.buyCount || 0) + (tokenEntry.sellCount || 0) : 0,
          tokenRealisedPnlUsd: tokenEntry ? round(tokenEntry.realisedPnlUsd || 0) : 0,
          tokenUnrealisedPnlUsd: tokenEntry ? round(tokenEntry.unrealisedPnlUsd || 0) : 0,
          tokenWinRate: tokenEntry ? round(tokenEntry.winRate || 0, 1) : 0,
          tokenAvgRoiPct: tokenEntry ? round(tokenEntry.avgClosedRoiPct || 0, 1) : 0,
          currentHoldingUsd: holdingEntry ? round(holdingEntry.usdValue || 0) : 0
        };

        return this.buildWhaleRecord({
          walletSummary: walletAnalysis.summary,
          tokenAnalysis,
          holderInfo: holderIndex.get(address) || null,
          participantInfo: participantIndex.get(address) || null,
          tokenInfo
        });
      }
    );

    const whales = analyses
      .filter((item) => item && !item.error)
      .filter((item) => item.whaleScore >= normalized.minScore)
      .filter((item) => item.winRate >= normalized.minWinRate)
      .filter((item) => item.allTimePnlUsd >= normalized.minPnlUsd)
      .filter((item) => item.closedTrades >= normalized.minClosedTrades || item.token.tradeCount >= 2)
      .sort((a, b) => b.whaleScore - a.whaleScore);

    return {
      token: {
        mint,
        symbol: tokenInfo.symbol,
        name: tokenInfo.name,
        liquidity: numberOrZero(tokenInfo.liquidity),
        organicScore: numberOrZero(tokenInfo.organicScore),
        mcap: numberOrZero(tokenInfo.mcap),
        holderCount: numberOrZero(tokenInfo.holderCount),
        launchpad: tokenInfo.launchpad || null,
        sourceBuckets: tokenInfo.sourceBuckets || []
      },
      whales,
      scannedWallets: candidates.length,
      candidateWallets: candidates,
      notes: [
        activeParticipants.partial ? 'token activity scan hit page cap' : null,
        holders.length ? `scanned top ${holders.length} holders` : null,
        activeParticipants.participants.length
          ? `scanned ${activeParticipants.participants.length} active token participants`
          : 'no active participants found via token-address history'
      ].filter(Boolean)
    };
  }

  async findWhales(filters = {}) {
    const normalized = this.normalizeFilters(filters);
    const tokens = await this.getPopularMemeTokens(Boolean(filters.force));

    const tokenResults = [];
    const walletAggregate = new Map();

    for (const token of tokens) {
      try {
        const result = await this.findWhalesByToken(token.id, normalized);
        tokenResults.push(result);

        for (const whale of result.whales) {
          const current = walletAggregate.get(whale.address) || {
            address: whale.address,
            walletUrl: whale.walletUrl,
            appearances: 0,
            tokenSymbols: [],
            bestWhaleScore: 0,
            avgWhaleScore: 0,
            winRate: whale.winRate,
            allTimePnlUsd: whale.allTimePnlUsd,
            recentPnlUsd: whale.recentPnlUsd,
            profiles: whale.profiles,
            closedTrades: whale.closedTrades,
            reasons: []
          };

          current.appearances += 1;
          current.tokenSymbols = uniq([...current.tokenSymbols, whale.token.symbol]);
          current.bestWhaleScore = Math.max(current.bestWhaleScore, whale.whaleScore);
          current.avgWhaleScore = round(
            ((current.avgWhaleScore * (current.appearances - 1)) + whale.whaleScore) / current.appearances,
            1
          );
          current.winRate = Math.max(current.winRate, whale.winRate);
          current.allTimePnlUsd = Math.max(current.allTimePnlUsd, whale.allTimePnlUsd);
          current.recentPnlUsd = Math.max(current.recentPnlUsd, whale.recentPnlUsd);
          current.closedTrades = Math.max(current.closedTrades, whale.closedTrades);
          current.profiles = uniq([...(current.profiles || []), ...(whale.profiles || [])]);
          current.reasons = uniq([...(current.reasons || []), ...(whale.reasons || [])]);

          walletAggregate.set(whale.address, current);
        }
      } catch (error) {
        tokenResults.push({
          token: {
            mint: token.id,
            symbol: token.symbol,
            name: token.name
          },
          whales: [],
          scannedWallets: 0,
          notes: [`scan failed: ${error.message}`]
        });
      }
    }

    const whales = Array.from(walletAggregate.values())
      .map((item) => ({
        ...item,
        aggregateScore: round(clamp(item.bestWhaleScore * 0.75 + item.appearances * 6 + item.avgWhaleScore * 0.25, 0, 100), 1)
      }))
      .filter((item) => item.aggregateScore >= normalized.minScore)
      .sort((a, b) => b.aggregateScore - a.aggregateScore);

    return {
      scannedTokens: tokens.length,
      tokens,
      tokenResults,
      whales,
      filters: normalized,
      notes: [
        'Popular token scan uses Jupiter categories + recent listings and then filters likely memecoins.',
        'Wallet score combines global wallet quality with token-specific holder/trader activity.'
      ]
    };
  }
}

module.exports = WhaleFinder;
