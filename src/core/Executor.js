'use strict';

/**
 * Executor
 * ========
 * 构造 Pump AMM buy/sell 交易，发送至 Helius staked RPC。
 * DRY_RUN 模式下不实际发送，仅返回模拟结果。
 *
 * 关键性质：
 * - blockhash 后台预热（每 800ms 刷一次缓存），避免买入时同步等 RPC
 * - priorityFee 后台预热（每 5s 刷一次），同上
 * - BUY 完成后保留 WSOL ATA，由 SELL 完成后统一关闭，避免残留 WSOL 被销毁
 */

const {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  SystemProgram,
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  NATIVE_MINT,
} = require('@solana/spl-token');
const bs58Lib = require('bs58');
const bs58 = bs58Lib.default || bs58Lib;
const BN = require('bn.js');

const { config } = require('../config');
const { buildPumpBuyIx, buildPumpSellIx } = require('../utils/pumpAmm');
const { getPriorityFee } = require('../utils/priorityFee');
const { getMonitor } = require('../monitor/HealthMonitor');

const monitor = getMonitor();
monitor.registerModule('Executor', { staleMs: 24 * 60 * 60_000, label: 'Trade Executor' });

const BLOCKHASH_REFRESH_MS = 800;
const PRIORITY_FEE_REFRESH_MS = 5000;

class Executor {
  constructor() {
    this.dryRun = config.DRY_RUN;
    this.rpc = new Connection(config.helius.rpcUrl, 'processed');
    this.stakedRpc = config.helius.stakedRpcUrl
      ? new Connection(config.helius.stakedRpcUrl, 'processed')
      : this.rpc;

    if (!this.dryRun && config.wallet.privateKeyBs58) {
      const secret = bs58.decode(config.wallet.privateKeyBs58);
      this.keypair = Keypair.fromSecretKey(secret);
      console.log(`[Executor] wallet loaded: ${this.keypair.publicKey.toBase58()}`);
    } else {
      this.keypair = null;
    }

    // 后台预热的 blockhash 和 priority fee
    this.cachedBlockhash = null;       // { blockhash, lastValidBlockHeight, fetchedAt }
    this.cachedPriorityFee = { microLamports: 200_000 }; // 默认值，启动时 fallback

    if (!this.dryRun) {
      this._startPrewarmLoops();
    }
  }

  _startPrewarmLoops() {
    // Blockhash 预热
    const refreshBlockhash = async () => {
      try {
        const { blockhash, lastValidBlockHeight } = await this.rpc.getLatestBlockhash('processed');
        this.cachedBlockhash = { blockhash, lastValidBlockHeight, fetchedAt: Date.now() };
        monitor.inc('Executor.blockhashRefreshOk', 1, 'Executor');
      } catch (err) {
        monitor.inc('Executor.blockhashRefreshFail', 1, 'Executor');
        monitor.recordError('Executor', err, { phase: 'blockhash_refresh' });
        console.warn(`[Executor] blockhash refresh failed: ${err.message}`);
      }
    };
    refreshBlockhash();
    this.blockhashTimer = setInterval(refreshBlockhash, BLOCKHASH_REFRESH_MS);

    // Priority fee 预热
    const refreshFee = async () => {
      try {
        const fee = await getPriorityFee([], 'High');
        this.cachedPriorityFee = fee;
        monitor.inc('Executor.priorityFeeRefreshOk', 1, 'Executor');
      } catch (err) {
        monitor.inc('Executor.priorityFeeRefreshFail', 1, 'Executor');
        monitor.recordError('Executor', err, { phase: 'priority_fee_refresh' });
        console.warn(`[Executor] priorityFee refresh failed: ${err.message}`);
      }
    };
    refreshFee();
    this.feeTimer = setInterval(refreshFee, PRIORITY_FEE_REFRESH_MS);
  }

  stop() {
    clearInterval(this.blockhashTimer);
    clearInterval(this.feeTimer);
  }

  _getBlockhashSyncOrFetch() {
    // 优先用缓存（必须新鲜，<2s）
    if (
      this.cachedBlockhash &&
      Date.now() - this.cachedBlockhash.fetchedAt < 2000
    ) {
      return Promise.resolve(this.cachedBlockhash);
    }
    return this.rpc.getLatestBlockhash('processed').then((bh) => {
      this.cachedBlockhash = { ...bh, fetchedAt: Date.now() };
      return this.cachedBlockhash;
    });
  }

  /**
   * 买入。
   * @param {object} order
   * @returns {Promise<{success, signature, tokenAmount, price, error, latencyMs}>}
   */
  async buy(order) {
    const t0 = Date.now();
    monitor.inc('Executor.buyAttempts', 1, 'Executor');
    monitor.beat('Executor', `buy:${order.mint?.slice(0, 6)}`);
    const sizeSol = order.sizeSol || config.strategy.positionSizeSol;
    const sizeLamports = Math.floor(sizeSol * 1e9);

    const baseDecimals = order.baseDecimals ?? 6;
    const priceAfter = order.priceAfter;
    if (!priceAfter || priceAfter <= 0) {
      monitor.inc('Executor.buyFail', 1, 'Executor');
      monitor.recordError('Executor', new Error('invalid priceAfter'), {
        side: 'BUY',
        mint: order.mint,
        priceAfter,
      });
      return { success: false, error: 'invalid priceAfter', latencyMs: Date.now() - t0 };
    }
    const expectedBaseUi = sizeSol / priceAfter;
    const baseAmountOutUi = expectedBaseUi * (1 - config.strategy.buySlippageBps / 10_000);
    const baseAmountOutRaw = Math.floor(baseAmountOutUi * Math.pow(10, baseDecimals));
    const maxQuoteIn = sizeLamports;

    if (this.dryRun) {
      const fillPrice = priceAfter * 1.005;
      const tokenAmount = sizeSol / fillPrice;
      console.log(
        `[Executor:DRY_RUN] BUY ${order.symbol || order.mint.slice(0, 6)}: ` +
          `${sizeSol} SOL → ${tokenAmount.toFixed(2)} tokens @ ${fillPrice.toExponential(4)}`,
      );
      monitor.inc('Executor.buySuccess', 1, 'Executor');
      return {
        success: true,
        signature: `DRYRUN_BUY_${Date.now()}`,
        tokenAmount,
        price: fillPrice,
        latencyMs: Date.now() - t0,
        dryRun: true,
      };
    }

    if (!this.keypair) {
      monitor.inc('Executor.buyFail', 1, 'Executor');
      monitor.recordError('Executor', new Error('wallet not loaded'), { side: 'BUY', mint: order.mint });
      return { success: false, error: 'wallet not loaded', latencyMs: Date.now() - t0 };
    }
    if (!order.poolAddress || !order.poolBaseVault || !order.poolQuoteVault) {
      monitor.inc('Executor.buyFail', 1, 'Executor');
      monitor.recordError('Executor', new Error('pool info missing'), {
        side: 'BUY',
        mint: order.mint,
        hasPool: !!order.poolAddress,
        hasBaseVault: !!order.poolBaseVault,
        hasQuoteVault: !!order.poolQuoteVault,
      });
      return {
        success: false,
        error: 'pool info missing (need first observation)',
        latencyMs: Date.now() - t0,
      };
    }

    try {
      const user = this.keypair.publicKey;
      const baseMint = new PublicKey(order.mint);
      const wsol = NATIVE_MINT;

      const userBaseAta = getAssociatedTokenAddressSync(baseMint, user);
      const userWsolAta = getAssociatedTokenAddressSync(wsol, user);

      const ixs = [];
      const microLamports = this.cachedPriorityFee.microLamports;
      ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }));
      ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));

      ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, userBaseAta, user, baseMint));
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, userWsolAta, user, wsol));

      // 包 SOL → WSOL
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: user,
          toPubkey: userWsolAta,
          lamports: sizeLamports,
        }),
      );
      ixs.push(createSyncNativeInstruction(userWsolAta));

      // Pump AMM Buy
      ixs.push(
        buildPumpBuyIx({
          pool: new PublicKey(order.poolAddress),
          user,
          baseMint,
          quoteMint: wsol,
          poolBaseTokenAccount: new PublicKey(order.poolBaseVault),
          poolQuoteTokenAccount: new PublicKey(order.poolQuoteVault),
          baseAmountOut: new BN(Math.max(1, baseAmountOutRaw)),
          maxQuoteAmountIn: new BN(maxQuoteIn),
        }),
      );

      // ⚠️ 注意：买入后 *不* 立即关闭 WSOL ATA。
      // 原因：如果 maxQuoteIn 超过实际成交需要，WSOL ATA 中会有残留 WSOL。
      // 此时 closeAccount 会把这些 WSOL 一并销毁（不是退还 SOL）。
      // 改由 SELL 完成后再关闭，确保资金不丢。

      // blockhash 走缓存
      const bh = await this._getBlockhashSyncOrFetch();
      const msg = new TransactionMessage({
        payerKey: user,
        recentBlockhash: bh.blockhash,
        instructions: ixs,
      }).compileToV0Message();

      const tx = new VersionedTransaction(msg);
      tx.sign([this.keypair]);

      const sig = await this.stakedRpc.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 0,
      });

      console.log(`[Executor:LIVE] BUY submitted: ${sig} (latency ${Date.now() - t0}ms)`);
      monitor.inc('Executor.buySuccess', 1, 'Executor');

      return {
        success: true,
        signature: sig,
        tokenAmount: expectedBaseUi,
        price: priceAfter,
        latencyMs: Date.now() - t0,
      };
    } catch (err) {
      monitor.inc('Executor.buyFail', 1, 'Executor');
      monitor.recordError('Executor', err, {
        side: 'BUY',
        mint: order.mint,
        symbol: order.symbol,
        sizeSol,
      });
      console.error(`[Executor:LIVE] BUY failed: ${err.message}`);
      return { success: false, error: err.message, latencyMs: Date.now() - t0 };
    }
  }

  /**
   * 卖出。每次调用都会构造新的交易（含新 blockhash），失败由调用方决定是否重试。
   */
  async sell(order) {
    const t0 = Date.now();
    monitor.inc('Executor.sellAttempts', 1, 'Executor');
    monitor.beat('Executor', `sell:${order.mint?.slice(0, 6)}`);
    const baseDecimals = order.baseDecimals ?? 6;
    const tokenAmount = order.tokenAmount;
    const currentPrice = order.currentPrice;

    if (this.dryRun) {
      const fillPrice = currentPrice * 0.995;
      const solOut = tokenAmount * fillPrice;
      console.log(
        `[Executor:DRY_RUN] SELL ${order.symbol || order.mint.slice(0, 6)}: ` +
          `${tokenAmount.toFixed(2)} tokens → ${solOut.toFixed(4)} SOL @ ${fillPrice.toExponential(4)}`,
      );
      monitor.inc('Executor.sellSuccess', 1, 'Executor');
      return {
        success: true,
        signature: `DRYRUN_SELL_${Date.now()}`,
        solOut,
        price: fillPrice,
        latencyMs: Date.now() - t0,
        dryRun: true,
      };
    }

    if (!this.keypair) {
      monitor.inc('Executor.sellFail', 1, 'Executor');
      monitor.recordError('Executor', new Error('wallet not loaded'), { side: 'SELL', mint: order.mint });
      return { success: false, error: 'wallet not loaded', latencyMs: Date.now() - t0 };
    }
    if (!order.poolAddress || !order.poolBaseVault || !order.poolQuoteVault) {
      monitor.inc('Executor.sellFail', 1, 'Executor');
      monitor.recordError('Executor', new Error('pool info missing'), { side: 'SELL', mint: order.mint });
      return { success: false, error: 'pool info missing', latencyMs: Date.now() - t0 };
    }
    if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) {
      monitor.inc('Executor.sellFail', 1, 'Executor');
      monitor.recordError('Executor', new Error('invalid tokenAmount'), {
        side: 'SELL',
        mint: order.mint,
        tokenAmount,
      });
      return { success: false, error: 'invalid tokenAmount', latencyMs: Date.now() - t0 };
    }

    try {
      const user = this.keypair.publicKey;
      const baseMint = new PublicKey(order.mint);
      const wsol = NATIVE_MINT;

      const userWsolAta = getAssociatedTokenAddressSync(wsol, user);
      const baseAmountInRaw = Math.floor(tokenAmount * Math.pow(10, baseDecimals));
      const expectedSolOut = tokenAmount * currentPrice;
      const minSolOutLamports = Math.floor(
        expectedSolOut * (1 - config.strategy.sellSlippageBps / 10_000) * 1e9,
      );

      const ixs = [];
      const microLamports = this.cachedPriorityFee.microLamports;
      ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }));
      ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));

      // 确保 WSOL ATA 存在（用于接收卖出所得）
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, userWsolAta, user, wsol));

      ixs.push(
        buildPumpSellIx({
          pool: new PublicKey(order.poolAddress),
          user,
          baseMint,
          quoteMint: wsol,
          poolBaseTokenAccount: new PublicKey(order.poolBaseVault),
          poolQuoteTokenAccount: new PublicKey(order.poolQuoteVault),
          baseAmountIn: new BN(Math.max(1, baseAmountInRaw)),
          minQuoteAmountOut: new BN(Math.max(0, minSolOutLamports)),
        }),
      );

      // 卖完后关闭 WSOL ATA：unwrap 全部 WSOL 为 SOL
      // 此时 ATA 内是卖出所得 + 上次 BUY 残留（如有），全部 unwrap
      ixs.push(createCloseAccountInstruction(userWsolAta, user, user));

      const bh = await this._getBlockhashSyncOrFetch();
      const msg = new TransactionMessage({
        payerKey: user,
        recentBlockhash: bh.blockhash,
        instructions: ixs,
      }).compileToV0Message();

      const tx = new VersionedTransaction(msg);
      tx.sign([this.keypair]);

      const sig = await this.stakedRpc.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 0,
      });

      console.log(`[Executor:LIVE] SELL submitted: ${sig} (latency ${Date.now() - t0}ms)`);
      monitor.inc('Executor.sellSuccess', 1, 'Executor');
      return {
        success: true,
        signature: sig,
        solOut: expectedSolOut,
        price: currentPrice,
        latencyMs: Date.now() - t0,
      };
    } catch (err) {
      monitor.inc('Executor.sellFail', 1, 'Executor');
      monitor.recordError('Executor', err, {
        side: 'SELL',
        mint: order.mint,
        symbol: order.symbol,
        tokenAmount,
      });
      console.error(`[Executor:LIVE] SELL failed: ${err.message}`);
      return { success: false, error: err.message, latencyMs: Date.now() - t0 };
    }
  }
}

module.exports = Executor;
