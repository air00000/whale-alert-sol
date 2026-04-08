'use strict';

const fs = require('fs/promises');
const path = require('path');
const config = require('./config');

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createDefaultState() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    watchlist: {},
    tracker: {
      cursors: {},
      holdAlerts: {}
    },
    alerts: [],
    caches: {
      tokenInfo: {},
      prices: {},
      walletAnalysis: {},
      whaleSearch: {},
      misc: {}
    }
  };
}

class JsonStorage {
  constructor(filePath = config.paths.stateFile) {
    this.filePath = filePath;
    this.state = null;
    this.loaded = false;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await this.load();
    return this;
  }

  async load() {
    if (this.loaded && this.state) return this.state;

    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.state = Object.assign(createDefaultState(), JSON.parse(raw));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('[storage] Failed to read state file:', error.message);
      }
      this.state = createDefaultState();
      await this.save();
    }

    this.loaded = true;
    return this.state;
  }

  async ensureLoaded() {
    if (!this.loaded || !this.state) {
      await this.load();
    }
  }

  async save() {
    await this.ensureLoaded();
    this.state.updatedAt = new Date().toISOString();

    const tempPath = `${this.filePath}.tmp`;
    const payload = JSON.stringify(this.state, null, 2);

    this.writeQueue = this.writeQueue.then(async () => {
      await fs.writeFile(tempPath, payload, 'utf8');
      await fs.rename(tempPath, this.filePath);
    });

    return this.writeQueue;
  }

  async getState() {
    await this.ensureLoaded();
    return deepClone(this.state);
  }

  async listWatchlist(chatId = null) {
    await this.ensureLoaded();
    const entries = Object.values(this.state.watchlist);
    if (chatId === null || chatId === undefined) {
      return deepClone(entries);
    }
    return deepClone(entries.filter((entry) => entry.chatIds.includes(String(chatId))));
  }

  async getWatch(address) {
    await this.ensureLoaded();
    return this.state.watchlist[address] ? deepClone(this.state.watchlist[address]) : null;
  }

  async addWatch(address, name, chatId) {
    await this.ensureLoaded();
    const chatIdString = String(chatId);
    const current = this.state.watchlist[address] || {
      address,
      name: name || address,
      chatIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (name) current.name = name;
    if (!current.chatIds.includes(chatIdString)) {
      current.chatIds.push(chatIdString);
    }
    current.updatedAt = new Date().toISOString();

    this.state.watchlist[address] = current;
    await this.save();
    return deepClone(current);
  }

  async removeWatch(address, chatId = null) {
    await this.ensureLoaded();
    const existing = this.state.watchlist[address];
    if (!existing) return null;

    if (chatId === null || chatId === undefined) {
      delete this.state.watchlist[address];
      delete this.state.tracker.cursors[address];
      await this.save();
      return null;
    }

    const chatIdString = String(chatId);
    existing.chatIds = existing.chatIds.filter((id) => id !== chatIdString);

    if (!existing.chatIds.length) {
      delete this.state.watchlist[address];
      delete this.state.tracker.cursors[address];
      await this.save();
      return null;
    }

    existing.updatedAt = new Date().toISOString();
    this.state.watchlist[address] = existing;
    await this.save();
    return deepClone(existing);
  }

  async getWatchedAddresses() {
    await this.ensureLoaded();
    return Object.keys(this.state.watchlist);
  }

  async getCursor(address) {
    await this.ensureLoaded();
    return this.state.tracker.cursors[address]
      ? deepClone(this.state.tracker.cursors[address])
      : null;
  }

  async setCursor(address, cursor) {
    await this.ensureLoaded();
    this.state.tracker.cursors[address] = {
      ...(this.state.tracker.cursors[address] || {}),
      ...cursor,
      updatedAt: new Date().toISOString()
    };
    await this.save();
    return deepClone(this.state.tracker.cursors[address]);
  }

  async getLastHoldAlert(address, mint) {
    await this.ensureLoaded();
    const key = `${address}:${mint}`;
    return this.state.tracker.holdAlerts[key] || 0;
  }

  async setLastHoldAlert(address, mint, timestamp) {
    await this.ensureLoaded();
    const key = `${address}:${mint}`;
    this.state.tracker.holdAlerts[key] = timestamp;
    await this.save();
    return timestamp;
  }

  async appendAlert(alert) {
    await this.ensureLoaded();
    this.state.alerts.unshift({
      ...alert,
      createdAt: new Date().toISOString()
    });
    if (this.state.alerts.length > config.analysis.maxAlertHistory) {
      this.state.alerts = this.state.alerts.slice(0, config.analysis.maxAlertHistory);
    }
    await this.save();
  }

  async getRecentAlerts(limit = 50) {
    await this.ensureLoaded();
    return deepClone(this.state.alerts.slice(0, limit));
  }

  async getCache(namespace, key, ttlMs) {
    await this.ensureLoaded();
    const bucket = this.state.caches[namespace] || {};
    const entry = bucket[key];
    if (!entry) return null;
    if (ttlMs && Date.now() - entry.cachedAt > ttlMs) return null;
    return deepClone(entry.value);
  }

  async setCache(namespace, key, value) {
    await this.ensureLoaded();
    if (!this.state.caches[namespace]) {
      this.state.caches[namespace] = {};
    }
    this.state.caches[namespace][key] = {
      cachedAt: Date.now(),
      value: deepClone(value)
    };
    await this.save();
    return value;
  }

  async deleteCache(namespace, key) {
    await this.ensureLoaded();
    if (this.state.caches[namespace]) {
      delete this.state.caches[namespace][key];
      await this.save();
    }
  }
}

module.exports = JsonStorage;
