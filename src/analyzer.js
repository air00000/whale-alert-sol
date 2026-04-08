'use strict';

const config = require('./config');

const ADD_LIQUIDITY_TYPES = new Set([
  'ADD_LIQUIDITY',
  'ADD_BALANCE_LIQUIDITY',
  'ADD_IMBALANCE_LIQUIDITY',
  'ADD_LIQUIDITY_BY_STRATEGY',
  'ADD_LIQUIDITY_BY_STRATEGY_ONE_SIDE'
]);

const REMOVE_LIQUIDITY_TYPES = new Set([
  'REMOVE_ALL_LIQUIDITY',
  'REMOVE_BALANCE_LIQUIDITY',
  'REMOVE_LIQUIDITY',
  'REMOVE_LIQUIDITY_BY_RANGE',
  'REMOVE_LIQUIDITY_SINGLE_SIDE'
]);

function shortAddress(address, left = 4, right = 4) {
  if (!address || address.length <= left + right) return address || '';
  return `${address.slice(0, left)}…${address.slice(-right)}`;
}

function buildExplorerUrl(value, kind = 'tx') {
  if (!value) return null;
  const base = config.constants.SOLSCAN_BASE_URL;
  if (kind === 'account') return `${base}/account/${value}`;
  if (kind === 'token') return `${base}/token/${value}`;
  return `${base}/tx/${value}`;
}

function safeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeRawTokenAmount(rawTokenAmount) {
  if (!rawTokenAmount) return null;
  const decimals = safeNumber(rawTokenAmount.decimals, 0);
  const raw = safeNumber(rawTokenAmount.tokenAmount, 0);
  return {
    decimals,
    amount: decimals >= 0 ? raw / (10 ** decimals) : raw
  };
}

function normalizeSwapEntry(entry) {
  if (!entry) return null;

  if (entry.rawTokenAmount) {
    const normalized = normalizeRawTokenAmount(entry.rawTokenAmount);
    return {
      mint: entry.mint,
      amount: normalized ? normalized.amount : 0,
      decimals: normalized ? normalized.decimals : 0,
      tokenAccount: entry.tokenAccount || entry.fromTokenAccount || entry.toTokenAccount,
      userAccount: entry.userAccount || entry.fromUserAccount || entry.toUserAccount,
      fromUserAccount: entry.fromUserAccount || entry.userAccount,
      toUserAccount: entry.toUserAccount || entry.userAccount
    };
  }

  return {
    mint: entry.mint,
    amount: safeNumber(entry.tokenAmount, 0),
    decimals: safeNumber(entry.decimals, 0),
    tokenAccount: entry.tokenAccount || entry.fromTokenAccount || entry.toTokenAccount,
    userAccount: entry.userAccount || entry.fromUserAccount || entry.toUserAccount,
    fromUserAccount: entry.fromUserAccount || entry.userAccount,
    toUserAccount: entry.toUserAccount || entry.userAccount
  };
}

function normalizeNativeAmount(lamports) {
  return safeNumber(lamports, 0) / 1e9;
}

function txTypeContains(tx, needle) {
  return String(tx?.type || '').toUpperCase().includes(String(needle || '').toUpperCase());
}

function detectPumpFun(tx) {
  const upperSource = String(tx?.source || '').toUpperCase();
  const upperDescription = String(tx?.description || '').toUpperCase();
  if (upperSource.includes('PUMP') || upperDescription.includes('PUMP.FUN')) {
    return true;
  }

  const accounts = new Set([
    ...(tx?.accountData || []).map((item) => item?.account).filter(Boolean),
    ...(tx?.instructions || []).map((item) => item?.programId).filter(Boolean)
  ]);

  return config.constants.PUMP_PROGRAM_IDS.some((programId) => accounts.has(programId));
}

function collectSwapLegsForWallet(swap, walletAddress) {
  const inputs = [];
  const outputs = [];

  if (!swap) return { inputs, outputs };

  const outerInputs = Array.isArray(swap.tokenInputs) ? swap.tokenInputs : [];
  const outerOutputs = Array.isArray(swap.tokenOutputs) ? swap.tokenOutputs : [];
  const useOuter = Boolean(
    outerInputs.length || outerOutputs.length || swap.nativeInput || swap.nativeOutput
  );

  if (useOuter) {
    for (const entry of outerInputs) {
      const normalized = normalizeSwapEntry(entry);
      if (!normalized) continue;
      const owners = [entry.userAccount, entry.fromUserAccount].filter(Boolean);
      if (owners.includes(walletAddress)) inputs.push(normalized);
    }
    for (const entry of outerOutputs) {
      const normalized = normalizeSwapEntry(entry);
      if (!normalized) continue;
      const owners = [entry.userAccount, entry.toUserAccount].filter(Boolean);
      if (owners.includes(walletAddress)) outputs.push(normalized);
    }

    if (swap.nativeInput?.account === walletAddress) {
      inputs.push({
        mint: config.constants.SOL_MINT,
        amount: normalizeNativeAmount(swap.nativeInput.amount),
        decimals: 9,
        userAccount: walletAddress
      });
    }

    if (swap.nativeOutput?.account === walletAddress) {
      outputs.push({
        mint: config.constants.SOL_MINT,
        amount: normalizeNativeAmount(swap.nativeOutput.amount),
        decimals: 9,
        userAccount: walletAddress
      });
    }

    return { inputs, outputs };
  }

  for (const inner of swap.innerSwaps || []) {
    for (const entry of inner.tokenInputs || []) {
      const normalized = normalizeSwapEntry(entry);
      if (!normalized) continue;
      if ([entry.fromUserAccount, entry.userAccount].filter(Boolean).includes(walletAddress)) {
        inputs.push(normalized);
      }
    }
    for (const entry of inner.tokenOutputs || []) {
      const normalized = normalizeSwapEntry(entry);
      if (!normalized) continue;
      if ([entry.toUserAccount, entry.userAccount].filter(Boolean).includes(walletAddress)) {
        outputs.push(normalized);
      }
    }
  }

  return { inputs, outputs };
}

function makeBaseQuoteFromLeg(leg, totalAmount, dominantQuote) {
  if (!dominantQuote) return { quoteMint: null, quoteAmount: null };
  if (!totalAmount || totalAmount <= 0) {
    return {
      quoteMint: dominantQuote.mint,
      quoteAmount: dominantQuote.amount
    };
  }
  return {
    quoteMint: dominantQuote.mint,
    quoteAmount: dominantQuote.amount * (leg.amount / totalAmount)
  };
}

function extractWalletTradeEvents(tx, walletAddress) {
  const swap = tx?.events?.swap;
  if (!swap) return [];

  const { inputs, outputs } = collectSwapLegsForWallet(swap, walletAddress);
  if (!inputs.length && !outputs.length) return [];

  const dominantInputBase = inputs.find((leg) => config.isBaseQuoteMint(leg.mint));
  const dominantOutputBase = outputs.find((leg) => config.isBaseQuoteMint(leg.mint));

  const tokenInputs = inputs.filter((leg) => !config.isBaseQuoteMint(leg.mint) && leg.amount > 0);
  const tokenOutputs = outputs.filter((leg) => !config.isBaseQuoteMint(leg.mint) && leg.amount > 0);
  const totalTokenInputAmount = tokenInputs.reduce((sum, leg) => sum + leg.amount, 0);
  const totalTokenOutputAmount = tokenOutputs.reduce((sum, leg) => sum + leg.amount, 0);

  const baseEvent = {
    wallet: walletAddress,
    dex: swap.programInfo?.source || tx?.source || 'UNKNOWN',
    source: tx?.source || swap.programInfo?.source || 'UNKNOWN',
    signature: tx?.signature,
    slot: tx?.slot,
    timestamp: tx?.timestamp,
    txUrl: buildExplorerUrl(tx?.signature, 'tx'),
    walletUrl: buildExplorerUrl(walletAddress, 'account'),
    rawType: tx?.type,
    description: tx?.description,
    isPumpFun: detectPumpFun(tx)
  };

  const events = [];

  if (dominantInputBase && tokenOutputs.length) {
    for (const leg of tokenOutputs) {
      const quote = makeBaseQuoteFromLeg(leg, totalTokenOutputAmount, dominantInputBase);
      events.push({
        ...baseEvent,
        type: 'BUY',
        mint: leg.mint,
        amount: leg.amount,
        decimals: leg.decimals,
        ...quote
      });
    }
    return events;
  }

  if (dominantOutputBase && tokenInputs.length) {
    for (const leg of tokenInputs) {
      const quote = makeBaseQuoteFromLeg(leg, totalTokenInputAmount, dominantOutputBase);
      events.push({
        ...baseEvent,
        type: 'SELL',
        mint: leg.mint,
        amount: leg.amount,
        decimals: leg.decimals,
        ...quote
      });
    }
    return events;
  }

  if (tokenInputs.length && tokenOutputs.length) {
    const dominantOutput = tokenOutputs[0];
    const dominantInput = tokenInputs[0];

    for (const leg of tokenInputs) {
      events.push({
        ...baseEvent,
        type: 'SELL',
        mint: leg.mint,
        amount: leg.amount,
        decimals: leg.decimals,
        quoteMint: dominantOutput.mint,
        quoteAmount: dominantOutput.amount,
        crossSwap: true
      });
    }

    for (const leg of tokenOutputs) {
      events.push({
        ...baseEvent,
        type: 'BUY',
        mint: leg.mint,
        amount: leg.amount,
        decimals: leg.decimals,
        quoteMint: dominantInput.mint,
        quoteAmount: dominantInput.amount,
        crossSwap: true
      });
    }
  }

  return events;
}

function extractWalletLiquidityEvents(tx, walletAddress) {
  const upperType = String(tx?.type || '').toUpperCase();
  const isAdd = ADD_LIQUIDITY_TYPES.has(upperType);
  const isRemove = REMOVE_LIQUIDITY_TYPES.has(upperType);

  if (!isAdd && !isRemove) return [];

  const transfers = [
    ...(tx?.tokenTransfers || []),
    ...(tx?.nativeTransfers || [])
  ];

  const mints = new Set();
  for (const transfer of tx?.tokenTransfers || []) {
    if (
      transfer?.fromUserAccount === walletAddress ||
      transfer?.toUserAccount === walletAddress
    ) {
      if (transfer.mint) mints.add(transfer.mint);
    }
  }

  if (!mints.size && transfers.length) {
    mints.add(config.constants.SOL_MINT);
  }

  return Array.from(mints).map((mint) => ({
    type: isAdd ? 'ADD_LIQ' : 'REMOVE_LIQ',
    wallet: walletAddress,
    mint,
    amount: null,
    quoteMint: null,
    quoteAmount: null,
    dex: tx?.source || 'UNKNOWN',
    source: tx?.source || 'UNKNOWN',
    signature: tx?.signature,
    slot: tx?.slot,
    timestamp: tx?.timestamp,
    txUrl: buildExplorerUrl(tx?.signature, 'tx'),
    walletUrl: buildExplorerUrl(walletAddress, 'account'),
    rawType: tx?.type,
    description: tx?.description,
    isPumpFun: detectPumpFun(tx)
  }));
}

function extractWalletTransferEvents(tx, walletAddress) {
  const events = [];

  for (const transfer of tx?.nativeTransfers || []) {
    if (
      transfer?.fromUserAccount !== walletAddress &&
      transfer?.toUserAccount !== walletAddress
    ) {
      continue;
    }

    events.push({
      type: 'TRANSFER',
      wallet: walletAddress,
      mint: config.constants.SOL_MINT,
      amount: normalizeNativeAmount(transfer.amount),
      decimals: 9,
      direction: transfer.fromUserAccount === walletAddress ? 'OUT' : 'IN',
      counterparty:
        transfer.fromUserAccount === walletAddress
          ? transfer.toUserAccount
          : transfer.fromUserAccount,
      dex: tx?.source || 'SYSTEM',
      source: tx?.source || 'SYSTEM',
      signature: tx?.signature,
      slot: tx?.slot,
      timestamp: tx?.timestamp,
      txUrl: buildExplorerUrl(tx?.signature, 'tx'),
      walletUrl: buildExplorerUrl(walletAddress, 'account'),
      rawType: tx?.type,
      description: tx?.description,
      isPumpFun: detectPumpFun(tx)
    });
  }

  for (const transfer of tx?.tokenTransfers || []) {
    if (
      transfer?.fromUserAccount !== walletAddress &&
      transfer?.toUserAccount !== walletAddress
    ) {
      continue;
    }

    events.push({
      type: 'TRANSFER',
      wallet: walletAddress,
      mint: transfer.mint,
      amount: safeNumber(transfer.tokenAmount, 0),
      decimals: null,
      direction: transfer.fromUserAccount === walletAddress ? 'OUT' : 'IN',
      counterparty:
        transfer.fromUserAccount === walletAddress
          ? transfer.toUserAccount
          : transfer.fromUserAccount,
      dex: tx?.source || 'SPL',
      source: tx?.source || 'SPL',
      signature: tx?.signature,
      slot: tx?.slot,
      timestamp: tx?.timestamp,
      txUrl: buildExplorerUrl(tx?.signature, 'tx'),
      walletUrl: buildExplorerUrl(walletAddress, 'account'),
      rawType: tx?.type,
      description: tx?.description,
      isPumpFun: detectPumpFun(tx)
    });
  }

  return events;
}

function classifyTransaction(tx, walletAddress) {
  const tradeEvents = extractWalletTradeEvents(tx, walletAddress);
  const liqEvents = extractWalletLiquidityEvents(tx, walletAddress);

  if (tradeEvents.length || liqEvents.length) {
    return [...tradeEvents, ...liqEvents];
  }

  return extractWalletTransferEvents(tx, walletAddress);
}

function extractParticipantsForMint(tx, mint) {
  const participants = new Set();

  for (const transfer of tx?.tokenTransfers || []) {
    if (transfer?.mint !== mint) continue;
    if (transfer?.fromUserAccount) participants.add(transfer.fromUserAccount);
    if (transfer?.toUserAccount) participants.add(transfer.toUserAccount);
  }

  const swap = tx?.events?.swap;
  if (swap) {
    const allEntries = [
      ...(swap.tokenInputs || []),
      ...(swap.tokenOutputs || []),
      ...((swap.innerSwaps || []).flatMap((inner) => [
        ...(inner.tokenInputs || []),
        ...(inner.tokenOutputs || [])
      ]))
    ];

    for (const entry of allEntries) {
      if (entry?.mint !== mint) continue;
      for (const maybeWallet of [
        entry.userAccount,
        entry.fromUserAccount,
        entry.toUserAccount
      ]) {
        if (maybeWallet) participants.add(maybeWallet);
      }
    }
  }

  return Array.from(participants);
}

function extractCounterparties(tx, walletAddress) {
  const results = [];

  for (const transfer of tx?.nativeTransfers || []) {
    if (transfer?.fromUserAccount === walletAddress && transfer?.toUserAccount) {
      results.push({
        address: transfer.toUserAccount,
        relation: 'direct_native_transfer',
        mint: config.constants.SOL_MINT,
        amount: normalizeNativeAmount(transfer.amount),
        signature: tx?.signature,
        timestamp: tx?.timestamp
      });
    }

    if (transfer?.toUserAccount === walletAddress && transfer?.fromUserAccount) {
      results.push({
        address: transfer.fromUserAccount,
        relation: 'direct_native_transfer',
        mint: config.constants.SOL_MINT,
        amount: normalizeNativeAmount(transfer.amount),
        signature: tx?.signature,
        timestamp: tx?.timestamp
      });
    }
  }

  for (const transfer of tx?.tokenTransfers || []) {
    if (transfer?.fromUserAccount === walletAddress && transfer?.toUserAccount) {
      results.push({
        address: transfer.toUserAccount,
        relation: 'direct_token_transfer',
        mint: transfer.mint,
        amount: safeNumber(transfer.tokenAmount, 0),
        signature: tx?.signature,
        timestamp: tx?.timestamp
      });
    }

    if (transfer?.toUserAccount === walletAddress && transfer?.fromUserAccount) {
      results.push({
        address: transfer.fromUserAccount,
        relation: 'direct_token_transfer',
        mint: transfer.mint,
        amount: safeNumber(transfer.tokenAmount, 0),
        signature: tx?.signature,
        timestamp: tx?.timestamp
      });
    }
  }

  return results;
}

function transactionInvolvesAddress(tx, walletAddress) {
  if (!walletAddress || !tx) return false;
  if (tx.feePayer === walletAddress) return true;

  for (const nativeTransfer of tx.nativeTransfers || []) {
    if (
      nativeTransfer?.fromUserAccount === walletAddress ||
      nativeTransfer?.toUserAccount === walletAddress
    ) {
      return true;
    }
  }

  for (const tokenTransfer of tx.tokenTransfers || []) {
    if (
      tokenTransfer?.fromUserAccount === walletAddress ||
      tokenTransfer?.toUserAccount === walletAddress
    ) {
      return true;
    }
  }

  const swap = tx?.events?.swap;
  if (swap) {
    const { inputs, outputs } = collectSwapLegsForWallet(swap, walletAddress);
    if (inputs.length || outputs.length) return true;
  }

  return false;
}

module.exports = {
  ADD_LIQUIDITY_TYPES,
  REMOVE_LIQUIDITY_TYPES,
  buildExplorerUrl,
  classifyTransaction,
  collectSwapLegsForWallet,
  detectPumpFun,
  extractCounterparties,
  extractParticipantsForMint,
  extractWalletLiquidityEvents,
  extractWalletTradeEvents,
  extractWalletTransferEvents,
  normalizeNativeAmount,
  shortAddress,
  transactionInvolvesAddress
};
