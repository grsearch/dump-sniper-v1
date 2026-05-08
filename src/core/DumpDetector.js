'use strict';

/**
 * DumpDetector
 * ============
 * 接收 LaserStream 推送的交易，解析其是否为：
 *   - 涉及监控代币的 Pump AMM swap
 *   - 方向为 sell（base → quote/SOL）
 *   - 卖出 SOL >= 阈值（默认 10 SOL）
 *   - 单笔自身造成 priceImpact <= -10%（即跌幅 >= 10%）
 *
 * 解析方式：
 * 通过交易 meta 的 preTokenBalances / postTokenBalances 计算池子 base/quote
 * 储备变化。priceImpact = (priceAfter - priceBefore) / priceBefore。
 *
 * 同时发出 PRICE_TICK 事件供 PriceTracker 更新最新价格。
 */

const EventEmitter = require('events');
const bs58Lib = require('bs58');
const bs58 = bs58Lib.default || bs58Lib;
const { config } = require('../config');
const { PUMP_AMM_PROGRAM_ID } = require('../utils/pumpAmm');
const { getMonitor } = require('../monitor/HealthMonitor');

const monitor = getMonitor();
monitor.registerModule('DumpDetector', { staleMs: 120_000, label: 'Dump Detector' });

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

function encodeBase58(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return bs58.encode(value);
  if (value instanceof Uint8Array) return bs58.encode(Buffer.from(value));
  return null;
}

class DumpDetector extends EventEmitter {
  constructor(tokenRegistry) {
    super();
    this.tokenRegistry = tokenRegistry;
    this.cache = new Map(); // mint → cached pool info
  }

  /**
   * 处理 LaserStream 推送的交易消息。
   * @param {object} txMessage - yellowstone-grpc transaction message
   */
  handleTransaction(txMessage) {
    monitor.inc('DumpDetector.txParsed', 1, 'DumpDetector');
    monitor.beat('DumpDetector', 'parse');
    try {
      const parsed = this._parseTx(txMessage);
      if (!parsed) {
        monitor.inc('DumpDetector.parsedNull', 1, 'DumpDetector');
        return;
      }

      // 发出价格更新（无论是买是卖都更新）
      monitor.inc('DumpDetector.priceTicks', 1, 'DumpDetector');
      this.emit('priceTick', {
        mint: parsed.baseMint,
        price: parsed.priceAfter,
        ts: parsed.ts,
        poolAddress: parsed.poolAddress,
      });

      // 仅卖单进入下游判定
      if (parsed.side !== 'SELL') return;

      const sellSol = parsed.quoteAmount; // 用户得到的 quote (SOL)
      const priceImpactPct = -parsed.priceChangePct; // 转为正数表示跌幅

      const passSize = sellSol >= config.strategy.minSellSol;
      const passImpact = priceImpactPct >= config.strategy.minPriceImpactPct;

      this.emit('sellAnalyzed', {
        mint: parsed.baseMint,
        symbol: parsed.symbol,
        sellSol,
        priceImpactPct,
        passSize,
        passImpact,
        seller: parsed.signer,
        signature: parsed.signature,
        ts: parsed.ts,
        poolAddress: parsed.poolAddress,
        priceAfter: parsed.priceAfter,
        priceBefore: parsed.priceBefore,
      });

      if (passSize && passImpact) {
        monitor.inc('DumpDetector.dumpSignals', 1, 'DumpDetector');
        this.emit('dumpSignal', {
          mint: parsed.baseMint,
          symbol: parsed.symbol,
          sellSol,
          priceImpactPct,
          seller: parsed.signer,
          signature: parsed.signature,
          ts: parsed.ts,
          poolAddress: parsed.poolAddress,
          poolBaseVault: parsed.poolBaseVault,
          poolQuoteVault: parsed.poolQuoteVault,
          priceAfter: parsed.priceAfter,
          priceBefore: parsed.priceBefore,
          baseDecimals: parsed.baseDecimals,
          quoteDecimals: parsed.quoteDecimals,
        });
      }
    } catch (err) {
      monitor.inc('DumpDetector.parseErrors', 1, 'DumpDetector');
      monitor.recordError('DumpDetector', err, {
        signature: this._extractSignature(txMessage?.transaction),
      });
      console.error(`[DumpDetector] parse error: ${err.message}`);
    }
  }

  /**
   * 解析交易，返回 { side, baseMint, quoteAmount, priceChangePct, ... } 或 null。
   */
  _parseTx(txMessage) {
    const tx = txMessage.transaction;
    if (!tx) return null;
    const meta = tx.meta;
    if (!meta || meta.err) return null;

    // 提取签名（base58）
    const signature = this._extractSignature(tx);
    const signer = this._extractSigner(tx);

    // 用 token balance changes 推断池子
    // preTokenBalances / postTokenBalances 是数组，每项含 accountIndex / mint / uiTokenAmount
    const preBalances = meta.preTokenBalances || [];
    const postBalances = meta.postTokenBalances || [];

    if (preBalances.length === 0 || postBalances.length === 0) return null;

    // 找到属于监控代币的 mint（走内存 set，避免每 tx 查 DB）
    let baseMint = null;
    let baseDecimals = 6;
    for (const b of preBalances) {
      if (this.tokenRegistry.isActive(b.mint)) {
        baseMint = b.mint;
        baseDecimals = b.uiTokenAmount?.decimals ?? 6;
        break;
      }
    }
    if (!baseMint) return null;

    // 找池子的 base vault 和 quote vault：
    // base vault = 持有 baseMint 的非 user 账户（owner 是 pool authority 而不是签名者）
    // 通过 owner 字段判断；或者用 tokenRegistry 里缓存的 pool 信息
    const tokenInfo = this.tokenRegistry.getToken(baseMint);

    // 计算 base 储备变化
    const baseChanges = this._aggregateMintChange(preBalances, postBalances, baseMint);
    const quoteChanges = this._aggregateMintChange(preBalances, postBalances, WSOL_MINT);

    // 池子的变化 = 用户变化的相反数（守恒）
    // poolBaseDelta = -userBaseDelta；poolQuoteDelta = -userQuoteDelta
    // 但更可靠的方式是直接看池子账户的变化。我们用启发式：取绝对值最大的两个
    // 反向变化作为池子。

    const poolBaseDelta = baseChanges.poolDelta;
    const poolQuoteDelta = quoteChanges.poolDelta;
    if (poolBaseDelta === null || poolQuoteDelta === null) return null;

    // 池子状态
    const baseAfter = baseChanges.poolAfter;
    const baseBefore = baseChanges.poolBefore;
    const quoteAfter = quoteChanges.poolAfter;
    const quoteBefore = quoteChanges.poolBefore;

    if (!baseAfter || !baseBefore || !quoteAfter || !quoteBefore) return null;

    // 价格 = quote / base（每个 base 多少 SOL）
    const priceBefore = quoteBefore / baseBefore;
    const priceAfter = quoteAfter / baseAfter;
    const priceChangePct = ((priceAfter - priceBefore) / priceBefore) * 100;

    // 方向判定：
    // SELL（用户卖代币换 SOL）：池子 base 增加（poolBaseDelta > 0），quote 减少（poolQuoteDelta < 0）
    // BUY：相反
    let side;
    if (poolBaseDelta > 0 && poolQuoteDelta < 0) side = 'SELL';
    else if (poolBaseDelta < 0 && poolQuoteDelta > 0) side = 'BUY';
    else return null;

    // 用户实际得到/付出的 quote（取绝对值，已是 ui 数额）
    const quoteAmount = Math.abs(poolQuoteDelta);

    // pool vault 地址（用于后续构造交易）
    const poolBaseVault = baseChanges.poolAccount || tokenInfo?.pool_base_vault || null;
    const poolQuoteVault = quoteChanges.poolAccount || tokenInfo?.pool_quote_vault || null;

    // pool 地址：在指令的 accountKeys 中找 owner 是 PUMP_AMM_PROGRAM_ID 且既不是 base vault 也不是 quote vault 的账户
    // 简化：从 tokenRegistry 查；若没有则留空，第一次解析后由调用方写入
    const poolAddress = tokenInfo?.pool_address || this._extractPoolAddress(tx, poolBaseVault, poolQuoteVault) || null;

    return {
      signature,
      signer,
      ts: txMessage.slot ? Date.now() : Date.now(), // LaserStream 不直接给 wallclock，用本地时间
      side,
      baseMint,
      baseDecimals,
      quoteDecimals: 9,
      symbol: tokenInfo?.symbol || null,
      quoteAmount,
      priceBefore,
      priceAfter,
      priceChangePct,
      poolAddress,
      poolBaseVault,
      poolQuoteVault,
    };
  }

  _aggregateMintChange(preBalances, postBalances, mint) {
    // 找 mint 对应的所有账户的变化，识别"池子账户"（最大持仓的非用户账户）
    const preMap = new Map();
    for (const b of preBalances) {
      if (b.mint === mint) {
        preMap.set(b.accountIndex, parseFloat(b.uiTokenAmount?.uiAmountString || '0'));
      }
    }
    const postMap = new Map();
    for (const b of postBalances) {
      if (b.mint === mint) {
        postMap.set(b.accountIndex, parseFloat(b.uiTokenAmount?.uiAmountString || '0'));
      }
    }

    // 合并所有账户索引
    const allIdx = new Set([...preMap.keys(), ...postMap.keys()]);
    let poolIdx = null;
    let poolBefore = null;
    let poolAfter = null;
    let poolDelta = null;

    // 启发式：池子账户余额最大
    let maxAmount = -1;
    for (const idx of allIdx) {
      const before = preMap.get(idx) || 0;
      const after = postMap.get(idx) || 0;
      const peak = Math.max(before, after);
      if (peak > maxAmount) {
        maxAmount = peak;
        poolIdx = idx;
        poolBefore = before;
        poolAfter = after;
        poolDelta = after - before;
      }
    }

    return {
      poolIdx,
      poolBefore,
      poolAfter,
      poolDelta,
      poolAccount: null, // 暂不解析具体地址，由 pool_address 字段从 registry 拿
    };
  }

  _extractSignature(tx) {
    try {
      const sig = tx.transaction?.signatures?.[0];
      return encodeBase58(sig);
    } catch (_) {
      return null;
    }
  }

  _extractSigner(tx) {
    try {
      const accountKeys = tx.transaction?.message?.accountKeys || [];
      return encodeBase58(accountKeys[0]);
    } catch (_) {
      return null;
    }
  }

  _extractPoolAddress(tx, baseVault, quoteVault) {
    // TODO: 解析 instruction，找到 Pump AMM 指令的 accountKeys[0]（pool）
    // 这里留作未来增强；目前依赖第一次手动绑定或从交易日志解析。
    return null;
  }
}

module.exports = DumpDetector;
