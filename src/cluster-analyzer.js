'use strict';

const config = require('./config');
const {
  extractCounterparties,
  extractWalletTradeEvents,
  shortAddress
} = require('./analyzer');

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

function edgeKey(a, b) {
  return [a, b].sort().join('::');
}

function bucketTs(timestamp, windowSec) {
  if (!timestamp || !windowSec) return 0;
  return Math.floor(timestamp / windowSec) * windowSec;
}

function numberOrZero(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function confidenceLabel(score) {
  if (score >= 80) return 'high';
  if (score >= 55) return 'medium';
  return 'low';
}

function relationWeight(relation) {
  if (relation === 'direct_native_transfer') return 18;
  if (relation === 'direct_token_transfer') return 14;
  return 8;
}

function mergeEdge(edgeMap, a, b, patch) {
  if (!a || !b || a === b) return;
  const key = edgeKey(a, b);
  const current = edgeMap.get(key) || {
    key,
    a,
    b,
    reasons: [],
    confidence: 0,
    stats: {
      transferCount: 0,
      transferVolumeUsdApprox: 0,
      sharedFunders: [],
      coordinatedTrades: 0,
      interactionCount: 0
    }
  };

  if (patch.reason) current.reasons.push(patch.reason);
  current.confidence = clamp(current.confidence + (patch.confidence || 0), 0, 100);
  current.stats.transferCount += patch.stats?.transferCount || 0;
  current.stats.transferVolumeUsdApprox += patch.stats?.transferVolumeUsdApprox || 0;
  current.stats.coordinatedTrades += patch.stats?.coordinatedTrades || 0;
  current.stats.interactionCount += patch.stats?.interactionCount || 0;
  if (patch.stats?.sharedFunders?.length) {
    current.stats.sharedFunders = uniq([
      ...current.stats.sharedFunders,
      ...patch.stats.sharedFunders
    ]);
  }
  edgeMap.set(key, current);
}

class ClusterAnalyzer {
  constructor({ helius, walletAnalyzer, storage, appConfig = config } = {}) {
    this.helius = helius;
    this.walletAnalyzer = walletAnalyzer;
    this.storage = storage;
    this.config = appConfig;
  }

  async loadWalletHistory(address, sinceTs) {
    return this.helius.fetchAddressTransactionsWindow(address, {
      sinceTs,
      maxPages: Math.max(2, Math.min(8, this.config.analysis.recentHistoryMaxPages)),
      limit: 100,
      sortOrder: 'desc',
      tokenAccounts: 'all'
    });
  }

  estimateTransferUsd(item) {
    if (!item) return 0;
    if (item.mint === this.config.constants.SOL_MINT) {
      // Very rough, enough for cluster prioritization only.
      return (numberOrZero(item.amount) || 0) * 100;
    }
    return numberOrZero(item.amount);
  }

  async analyze(seedAddress, options = {}) {
    this.helius.validateAddress(seedAddress);

    const maxDepth = Number.isFinite(Number(options.maxDepth))
      ? Number(options.maxDepth)
      : this.config.thresholds.maxClusterDepth;
    const lookbackDays = Number.isFinite(Number(options.lookbackDays))
      ? Number(options.lookbackDays)
      : this.config.thresholds.clusterLookbackDays;
    const maxNeighbors = Number.isFinite(Number(options.maxNeighbors))
      ? Number(options.maxNeighbors)
      : this.config.thresholds.clusterMaxNeighbors;
    const coordinationWindow = Number.isFinite(Number(options.coordinationWindowSeconds))
      ? Number(options.coordinationWindowSeconds)
      : this.config.thresholds.clusterCoordinationWindowSeconds;

    const sinceTs = Math.floor(Date.now() / 1000) - lookbackDays * 86400;
    const visited = new Set();
    const queue = [{ address: seedAddress, depth: 0 }];

    const nodes = new Map();
    const directInteractions = new Map();
    const fundingMap = new Map();
    const tradeFingerprintMap = new Map();
    const edgeMap = new Map();

    while (queue.length) {
      const { address, depth } = queue.shift();
      if (visited.has(address)) continue;
      visited.add(address);

      const history = await this.loadWalletHistory(address, sinceTs);
      const transactions = history.transactions || [];

      const node = nodes.get(address) || {
        address,
        depth,
        txCount: 0,
        transferCounterparties: new Map(),
        inboundFunders: new Map(),
        tradeFingerprints: new Map(),
        exampleSignatures: [],
        partialHistory: Boolean(history.partial)
      };

      node.txCount = transactions.length;
      node.partialHistory = node.partialHistory || Boolean(history.partial);

      for (const tx of transactions) {
        if (tx.signature && node.exampleSignatures.length < 5) {
          node.exampleSignatures.push(tx.signature);
        }

        const counterparties = extractCounterparties(tx, address);
        for (const item of counterparties) {
          if (!item.address || item.address === address) continue;
          const bucket = node.transferCounterparties.get(item.address) || {
            address: item.address,
            relationTypes: new Set(),
            count: 0,
            volumeUsdApprox: 0,
            lastSeenTs: item.timestamp || 0,
            firstSeenTs: item.timestamp || 0,
            sampleSignatures: []
          };
          bucket.relationTypes.add(item.relation);
          bucket.count += 1;
          bucket.volumeUsdApprox += this.estimateTransferUsd(item);
          bucket.lastSeenTs = Math.max(bucket.lastSeenTs, item.timestamp || 0);
          bucket.firstSeenTs = Math.min(bucket.firstSeenTs, item.timestamp || 0);
          if (item.signature && bucket.sampleSignatures.length < 3) bucket.sampleSignatures.push(item.signature);
          node.transferCounterparties.set(item.address, bucket);

          const interactionKey = edgeKey(address, item.address);
          const direct = directInteractions.get(interactionKey) || {
            a: address,
            b: item.address,
            count: 0,
            volumeUsdApprox: 0,
            relationTypes: new Set(),
            signatures: []
          };
          direct.count += 1;
          direct.volumeUsdApprox += this.estimateTransferUsd(item);
          direct.relationTypes.add(item.relation);
          if (item.signature && direct.signatures.length < 5) direct.signatures.push(item.signature);
          directInteractions.set(interactionKey, direct);
        }

        for (const transfer of tx.nativeTransfers || []) {
          if (transfer?.toUserAccount === address && transfer?.fromUserAccount) {
            const funder = node.inboundFunders.get(transfer.fromUserAccount) || {
              address: transfer.fromUserAccount,
              count: 0,
              volumeUsdApprox: 0,
              signatures: []
            };
            funder.count += 1;
            funder.volumeUsdApprox += ((numberOrZero(transfer.amount) || 0) / 1e9) * 100;
            if (tx.signature && funder.signatures.length < 3) funder.signatures.push(tx.signature);
            node.inboundFunders.set(transfer.fromUserAccount, funder);
          }
        }

        const tradeEvents = extractWalletTradeEvents(tx, address);
        for (const trade of tradeEvents) {
          const fingerprintKey = `${trade.mint}:${trade.type}:${bucketTs(trade.timestamp || 0, coordinationWindow)}`;
          const fingerprint = node.tradeFingerprints.get(fingerprintKey) || {
            mint: trade.mint,
            type: trade.type,
            bucket: bucketTs(trade.timestamp || 0, coordinationWindow),
            count: 0,
            signatures: []
          };
          fingerprint.count += 1;
          if (trade.signature && fingerprint.signatures.length < 3) fingerprint.signatures.push(trade.signature);
          node.tradeFingerprints.set(fingerprintKey, fingerprint);

          const clusterFingerprint = tradeFingerprintMap.get(fingerprintKey) || [];
          clusterFingerprint.push({ address, signature: trade.signature, timestamp: trade.timestamp || 0 });
          tradeFingerprintMap.set(fingerprintKey, clusterFingerprint);
        }
      }

      nodes.set(address, node);

      if (depth < maxDepth) {
        const strongest = Array.from(node.transferCounterparties.values())
          .sort((a, b) => {
            const left = b.count * 5 + Math.log10(1 + b.volumeUsdApprox) * 6;
            const right = a.count * 5 + Math.log10(1 + a.volumeUsdApprox) * 6;
            return left - right;
          })
          .slice(0, maxNeighbors);

        for (const candidate of strongest) {
          if (!visited.has(candidate.address)) {
            queue.push({ address: candidate.address, depth: depth + 1 });
          }
        }
      }
    }

    for (const [address, node] of nodes.entries()) {
      for (const funder of node.inboundFunders.values()) {
        const list = fundingMap.get(funder.address) || [];
        list.push({ wallet: address, ...funder });
        fundingMap.set(funder.address, list);
      }
    }

    for (const direct of directInteractions.values()) {
      const transferConfidence = clamp(
        direct.count * 8 + Math.log10(1 + direct.volumeUsdApprox) * 10,
        0,
        45
      );
      const relationTypes = Array.from(direct.relationTypes);
      mergeEdge(edgeMap, direct.a, direct.b, {
        reason: `direct transfers (${relationTypes.join(', ')})`,
        confidence: transferConfidence,
        stats: {
          transferCount: direct.count,
          transferVolumeUsdApprox: round(direct.volumeUsdApprox, 2),
          interactionCount: direct.count
        }
      });

      if (direct.count >= 3) {
        mergeEdge(edgeMap, direct.a, direct.b, {
          reason: 'repeated interaction pattern',
          confidence: 8,
          stats: { interactionCount: direct.count }
        });
      }
    }

    for (const [funderAddress, fundedWallets] of fundingMap.entries()) {
      if (fundedWallets.length < 2) continue;
      for (let i = 0; i < fundedWallets.length; i += 1) {
        for (let j = i + 1; j < fundedWallets.length; j += 1) {
          const left = fundedWallets[i];
          const right = fundedWallets[j];
          const sharedConfidence = clamp(
            Math.min(left.count, right.count) * 10
              + Math.log10(1 + Math.min(left.volumeUsdApprox, right.volumeUsdApprox)) * 6,
            0,
            28
          );

          mergeEdge(edgeMap, left.wallet, right.wallet, {
            reason: `shared funder ${shortAddress(funderAddress)}`,
            confidence: sharedConfidence,
            stats: {
              sharedFunders: [funderAddress]
            }
          });
        }
      }
    }

    for (const [fingerprintKey, records] of tradeFingerprintMap.entries()) {
      if (records.length < 2) continue;
      const [mint, side] = fingerprintKey.split(':');
      for (let i = 0; i < records.length; i += 1) {
        for (let j = i + 1; j < records.length; j += 1) {
          const left = records[i];
          const right = records[j];
          if (left.address === right.address) continue;
          mergeEdge(edgeMap, left.address, right.address, {
            reason: `coordinated ${side} ${shortAddress(mint, 4, 4)}`,
            confidence: 10,
            stats: {
              coordinatedTrades: 1
            }
          });
        }
      }
    }

    const nodeAnalyses = await Promise.all(
      Array.from(nodes.keys()).slice(0, 8).map(async (address) => {
        try {
          const analysis = await this.walletAnalyzer.analyzeWallet(address);
          return [address, {
            score: analysis.summary.score,
            profiles: analysis.summary.profiles,
            pnlUsd: analysis.summary.allTimePnlUsd,
            winRate: analysis.summary.winRate
          }];
        } catch (error) {
          return [address, null];
        }
      })
    );
    const analysisIndex = new Map(nodeAnalyses);

    const edges = Array.from(edgeMap.values())
      .map((edge) => ({
        ...edge,
        reasons: uniq(edge.reasons),
        confidence: round(edge.confidence, 1),
        confidenceLabel: confidenceLabel(edge.confidence)
      }))
      .filter((edge) => edge.confidence >= this.config.thresholds.clusterMinConfidence)
      .sort((a, b) => b.confidence - a.confidence);

    const nodeList = Array.from(nodes.values())
      .map((node) => {
        const strongestEdge = edges
          .filter((edge) => edge.a === node.address || edge.b === node.address)
          .sort((a, b) => b.confidence - a.confidence)[0] || null;
        return {
          address: node.address,
          depth: node.depth,
          txCount: node.txCount,
          partialHistory: node.partialHistory,
          strongestRelation: strongestEdge ? strongestEdge.reasons[0] : null,
          strongestConfidence: strongestEdge ? strongestEdge.confidence : 0,
          walletAnalysis: analysisIndex.get(node.address) || null,
          exampleSignatures: node.exampleSignatures
        };
      })
      .sort((a, b) => {
        if (a.address === seedAddress) return -1;
        if (b.address === seedAddress) return 1;
        return b.strongestConfidence - a.strongestConfidence;
      });

    const suspicionScore = round(
      clamp(
        (edges.length ? edges.slice(0, 5).reduce((acc, edge) => acc + edge.confidence, 0) / Math.min(edges.length, 5) : 0)
          * 0.7
          + Math.min(25, (nodeList.length - 1) * 4)
          + Math.min(15, edges.filter((edge) => edge.reasons.some((reason) => reason.includes('shared funder'))).length * 5)
          + Math.min(15, edges.filter((edge) => edge.stats.coordinatedTrades > 0).length * 3),
        0,
        100
      ),
      1
    );

    const suspicionLabel = suspicionScore >= 75
      ? 'high chance of common control / bot net'
      : suspicionScore >= 50
        ? 'medium chance of coordinated cluster'
        : 'weak/unclear cluster';

    return {
      seed: seedAddress,
      lookbackDays,
      maxDepth,
      nodeCount: nodeList.length,
      edgeCount: edges.length,
      suspicionScore,
      suspicionLabel,
      nodes: nodeList,
      edges,
      summary: [
        `${nodeList.length} wallets in cluster graph`,
        `${edges.length} relations above confidence threshold`,
        `${edges.filter((edge) => edge.reasons.some((reason) => reason.includes('shared funder'))).length} shared-funder links`,
        `${edges.filter((edge) => edge.stats.coordinatedTrades > 0).length} coordinated-trade links`
      ]
    };
  }
}

module.exports = ClusterAnalyzer;
