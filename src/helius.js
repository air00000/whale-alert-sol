'use strict';

const { Connection, PublicKey } = require('@solana/web3.js');
const WebSocket = require('ws');
const config = require('./config');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function uniq(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function sortByTimestampAsc(items) {
  return [...items].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

class HeliusClient {
  constructor({ storage, appConfig = config } = {}) {
    this.storage = storage;
    this.config = appConfig;
    this.connection = new Connection(this.config.helius.rpcUrl, 'confirmed');
  }

  isConfigured() {
    return Boolean(this.config?.helius?.apiKey);
  }

  async healthCheck() {
    if (!this.isConfigured()) {
      return { ok: false, message: 'HELIUS_API_KEY is missing' };
    }

    try {
      const version = await this.rpcCall('getVersion', []);
      return {
        ok: true,
        version: version?.['solana-core'] || version?.solana_core || 'unknown'
      };
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  }

  validateAddress(address) {
    try {
      return new PublicKey(address);
    } catch (error) {
      throw new Error(`Invalid Solana address: ${address}`);
    }
  }

  getJupiterHeaders() {
    const headers = {};
    if (this.config.jupiter.apiKey) {
      headers['x-api-key'] = this.config.jupiter.apiKey;
    }
    return headers;
  }

  async fetchJson(url, options = {}, retries = this.config.helius.maxRetries) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.helius.requestTimeoutMs
    );

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(options.headers || {})
        }
      });

      if (response.status === 429 || response.status >= 500) {
        if (retries > 0) {
          await sleep((this.config.helius.maxRetries - retries + 1) * 700);
          return this.fetchJson(url, options, retries - 1);
        }
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status} for ${url}: ${body.slice(0, 300)}`);
      }

      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async rpcCall(method, params) {
    const payload = {
      jsonrpc: '2.0',
      id: 'whale-alert-sol',
      method,
      params
    };

    const response = await this.fetchJson(this.config.helius.rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (response.error) {
      throw new Error(`[helius.rpc] ${response.error.message || 'Unknown RPC error'}`);
    }

    return response.result;
  }

  buildEnhancedHistoryUrl(address, options = {}) {
    const params = new URLSearchParams();
    params.set('api-key', this.config.helius.apiKey);
    params.set('limit', String(options.limit || 100));

    if (options.beforeSignature) params.set('before-signature', options.beforeSignature);
    if (options.afterSignature) params.set('after-signature', options.afterSignature);
    if (options.commitment) params.set('commitment', options.commitment);
    if (options.tokenAccounts) params.set('token-accounts', options.tokenAccounts);
    if (options.sortOrder) params.set('sort-order', options.sortOrder);
    if (options.gtSlot !== undefined) params.set('gt-slot', String(options.gtSlot));
    if (options.gteSlot !== undefined) params.set('gte-slot', String(options.gteSlot));
    if (options.ltSlot !== undefined) params.set('lt-slot', String(options.ltSlot));
    if (options.lteSlot !== undefined) params.set('lte-slot', String(options.lteSlot));
    if (options.gtTime !== undefined) params.set('gt-time', String(options.gtTime));
    if (options.gteTime !== undefined) params.set('gte-time', String(options.gteTime));
    if (options.ltTime !== undefined) params.set('lt-time', String(options.ltTime));
    if (options.lteTime !== undefined) params.set('lte-time', String(options.lteTime));
    if (options.type) params.set('type', options.type);
    if (options.source) params.set('source', options.source);

    return `${this.config.helius.enhancedBaseUrl}/v0/addresses/${address}/transactions?${params.toString()}`;
  }

  async getEnhancedHistoryPage(address, options = {}) {
    const url = this.buildEnhancedHistoryUrl(address, options);
    return this.fetchJson(url, { method: 'GET' });
  }

  async fetchAddressTransactionsWindow(address, options = {}) {
    this.validateAddress(address);

    const sortOrder = options.sortOrder || 'desc';
    const limit = Math.min(options.limit || 100, 100);
    const maxPages = options.maxPages || 1;
    const tokenAccounts = options.tokenAccounts || 'all';
    const gteTime = options.gteTime || options.sinceTs;
    const lteTime = options.lteTime || options.untilTs;

    let beforeSignature = options.beforeSignature;
    let afterSignature = options.afterSignature;
    const transactions = [];
    let partial = false;

    for (let page = 0; page < maxPages; page += 1) {
      const batch = await this.getEnhancedHistoryPage(address, {
        limit,
        beforeSignature,
        afterSignature,
        tokenAccounts,
        sortOrder,
        gteTime,
        lteTime,
        type: options.type,
        source: options.source,
        commitment: options.commitment || 'confirmed'
      });

      if (!Array.isArray(batch) || !batch.length) break;

      transactions.push(...batch);

      if (sortOrder === 'asc') {
        afterSignature = batch[batch.length - 1]?.signature;
      } else {
        beforeSignature = batch[batch.length - 1]?.signature;
      }

      if (batch.length < limit) break;
      if (page === maxPages - 1) partial = true;
    }

    const deduped = uniq(transactions.map((tx) => tx.signature)).map((signature) =>
      transactions.find((tx) => tx.signature === signature)
    );

    return {
      transactions: sortOrder === 'asc' ? sortByTimestampAsc(deduped) : deduped,
      partial
    };
  }

  async getEnhancedTransactions(signatures = []) {
    const deduped = uniq(signatures);
    if (!deduped.length) return [];

    const url = `${this.config.helius.enhancedBaseUrl}/v0/transactions?api-key=${this.config.helius.apiKey}`;
    return this.fetchJson(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        transactions: deduped
      })
    });
  }

  async getTokenInfo(mint) {
    const [result] = await this.getTokenInfosByMints([mint]);
    return result || null;
  }

  async getTokenInfosByMints(mints = []) {
    const uniqueMints = uniq(mints);
    if (!uniqueMints.length) return [];

    const results = [];
    const missing = [];

    for (const mint of uniqueMints) {
      const cached = this.storage
        ? await this.storage.getCache('tokenInfo', mint, this.config.analysis.tokenInfoCacheTtlMs)
        : null;
      if (cached) {
        results.push(cached);
      } else {
        missing.push(mint);
      }
    }

    for (const chunk of chunkArray(missing, 100)) {
      const query = encodeURIComponent(chunk.join(','));
      const url = `${this.config.jupiter.tokensBaseUrl}/search?query=${query}`;
      const response = await this.fetchJson(url, {
        method: 'GET',
        headers: this.getJupiterHeaders()
      });

      for (const token of Array.isArray(response) ? response : []) {
        results.push(token);
        if (this.storage && token?.id) {
          await this.storage.setCache('tokenInfo', token.id, token);
        }
      }
    }

    const index = new Map(results.map((item) => [item.id, item]));
    return uniqueMints.map((mint) => index.get(mint) || null);
  }

  async getTokenPricesByMints(mints = []) {
    const uniqueMints = uniq(mints);
    if (!uniqueMints.length) return {};

    const result = {};
    const missing = [];

    for (const mint of uniqueMints) {
      const cached = this.storage
        ? await this.storage.getCache('prices', mint, this.config.analysis.priceCacheTtlMs)
        : null;
      if (cached) {
        result[mint] = cached;
      } else {
        missing.push(mint);
      }
    }

    for (const chunk of chunkArray(missing, 50)) {
      const ids = encodeURIComponent(chunk.join(','));
      const url = `${this.config.jupiter.priceUrl}?ids=${ids}`;
      const response = await this.fetchJson(url, {
        method: 'GET',
        headers: this.getJupiterHeaders()
      });

      for (const mint of chunk) {
        if (response && response[mint]) {
          result[mint] = response[mint];
          if (this.storage) {
            await this.storage.setCache('prices', mint, response[mint]);
          }
        }
      }
    }

    return result;
  }

  async getPopularTokens(category = 'toptrending', interval = '24h', limit = 50) {
    const url = `${this.config.jupiter.tokensBaseUrl}/${category}/${interval}?limit=${limit}`;
    return this.fetchJson(url, {
      method: 'GET',
      headers: this.getJupiterHeaders()
    });
  }

  async getRecentTokens(limit = 30) {
    const url = `${this.config.jupiter.tokensBaseUrl}/recent`;
    const response = await this.fetchJson(url, {
      method: 'GET',
      headers: this.getJupiterHeaders()
    });

    return Array.isArray(response) ? response.slice(0, limit) : [];
  }

  async getSOLBalance(address) {
    const pubkey = this.validateAddress(address);
    const lamports = await this.connection.getBalance(pubkey, 'confirmed');
    return lamports / 1e9;
  }

  async getWalletTokenBalances(address) {
    const owner = this.validateAddress(address);
    const aggregated = new Map();

    const programIds = [
      this.config.constants.TOKEN_PROGRAM_ID,
      this.config.constants.TOKEN_2022_PROGRAM_ID
    ];

    for (const programId of programIds) {
      try {
        const response = await this.connection.getParsedTokenAccountsByOwner(
          owner,
          { programId: new PublicKey(programId) },
          'confirmed'
        );

        for (const account of response.value || []) {
          const info = account?.account?.data?.parsed?.info;
          if (!info?.mint || !info?.tokenAmount) continue;

          const uiAmount = Number.parseFloat(info.tokenAmount.uiAmountString || '0');
          if (!uiAmount || uiAmount <= 0) continue;

          const current = aggregated.get(info.mint) || {
            mint: info.mint,
            amount: 0,
            decimals: Number.parseInt(info.tokenAmount.decimals, 10) || 0,
            rawAmount: 0,
            tokenAccounts: []
          };

          current.amount += uiAmount;
          current.rawAmount += Number.parseFloat(info.tokenAmount.amount || '0');
          current.tokenAccounts.push(account.pubkey.toBase58());
          aggregated.set(info.mint, current);
        }
      } catch (error) {
        console.error(`[helius] getParsedTokenAccountsByOwner failed for ${programId}:`, error.message);
      }
    }

    return Array.from(aggregated.values()).sort((a, b) => b.amount - a.amount);
  }

  async getTokenLargestAccountOwners(mint, { limit = config.analysis.topHoldersLimit } = {}) {
    const mintPubkey = this.validateAddress(mint);
    const [largestAccounts, tokenSupply] = await Promise.all([
      this.connection.getTokenLargestAccounts(mintPubkey, 'confirmed'),
      this.connection.getTokenSupply(mintPubkey, 'confirmed')
    ]);

    const topAccounts = (largestAccounts?.value || []).slice(0, limit);
    const totalSupply = Number.parseFloat(tokenSupply?.value?.uiAmountString || '0') || 0;

    const owners = await Promise.all(
      topAccounts.map(async (item) => {
        const accountPubkey = new PublicKey(item.address);
        const info = await this.connection.getParsedAccountInfo(accountPubkey, 'confirmed');
        const parsed = info?.value?.data?.parsed?.info;
        return {
          owner: parsed?.owner || null,
          tokenAccount: item.address,
          uiAmount: Number.parseFloat(item.uiAmountString || '0') || 0,
          rawAmount: item.amount,
          decimals: item.decimals || 0,
          pctOfSupply: totalSupply > 0 ? ((Number.parseFloat(item.uiAmountString || '0') || 0) / totalSupply) * 100 : 0
        };
      })
    );

    return owners.filter((entry) => entry.owner);
  }

  createEnhancedWsClient({ accountInclude = [], onTransaction, onOpen, onError, onClose } = {}) {
    if (!this.config.helius.useEnhancedWs) return null;
    if (!this.config.helius.apiKey) return null;
    if (!accountInclude.length) return null;

    const ws = new WebSocket(this.config.helius.wsUrl);

    ws.on('open', () => {
      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'transactionSubscribe',
        params: [
          {
            vote: false,
            failed: false,
            accountInclude
          },
          {
            commitment: 'confirmed',
            encoding: 'jsonParsed',
            transactionDetails: 'full',
            maxSupportedTransactionVersion: 0
          }
        ]
      };

      ws.send(JSON.stringify(request));
      if (typeof onOpen === 'function') onOpen();
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString('utf8'));
        if (message?.error) {
          const error = new Error(`[helius.ws] ${message.error.message || 'Unknown WS error'}`);
          if (typeof onError === 'function') onError(error);
          return;
        }
        if (message?.params?.result && typeof onTransaction === 'function') {
          onTransaction(message.params.result);
        }
      } catch (error) {
        if (typeof onError === 'function') onError(error);
      }
    });

    ws.on('error', (error) => {
      if (typeof onError === 'function') onError(error);
    });

    ws.on('close', (code, reason) => {
      if (typeof onClose === 'function') onClose(code, reason.toString('utf8'));
    });

    return ws;
  }
}

module.exports = HeliusClient;
