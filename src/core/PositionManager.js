'use strict';

/**
 * PositionManager
 * ===============
 * 维护当前持仓。每次 PriceTracker 更新价格时，检查是否止盈或超时。
 * 100ms tick 兜底，防止价格不更新时超时无法触发。
 *
 * 关键性质：
 * - registerOpen 接受外部 positionId（与 BUY trade 配对）
 * - SELL 失败时按指数退避重试，直到成功；不会永久卡住
 * - restoreFromDb 启动时恢复未平仓持仓，并立即给到时的仓位发起 SELL
 */

const EventEmitter = require('events');
const crypto = require('crypto');
const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');

const monitor = getMonitor();
monitor.registerModule('PositionManager', { staleMs: 10_000, label: 'Position Manager' });

const SELL_RETRY_DELAYS_MS = [500, 1500, 3000, 5000, 10_000, 20_000]; // 之后保持 30s

class PositionManager extends EventEmitter {
  constructor({ tradeLogger, executor, priceTracker, tokenRegistry }) {
    super();
    this.tradeLogger = tradeLogger;
    this.executor = executor;
    this.priceTracker = priceTracker;
    this.tokenRegistry = tokenRegistry;

    this.positions = new Map(); // positionId → position obj
    this.byMint = new Map();    // mint → positionId

    this.tickTimer = setInterval(() => {
      monitor.beat('PositionManager', 'tick');
      monitor.inc('PositionManager.ticks', 1, 'PositionManager');
      this._tick();
    }, 100);

    this.priceTracker.on('update', ({ mint, price }) => {
      const pid = this.byMint.get(mint);
      if (!pid) return;
      this._checkExit(pid, price);
    });
  }

  stop() {
    clearInterval(this.tickTimer);
  }

  hasOpenPosition(mint) {
    return this.byMint.has(mint);
  }

  openPositionCount() {
    return this.positions.size;
  }

  listOpen() {
    return Array.from(this.positions.values());
  }

  /**
   * 启动时从 DB 恢复未平仓的持仓。
   * 对每个恢复的持仓：
   *   - 如果 openedAt + maxHoldMs 已过：立即触发 SELL（exitReason=TIMEOUT）
   *   - 否则：正常进入 _tick 循环，等止盈或超时
   */
  restoreFromDb() {
    const open = this.tradeLogger.getOpenPositions();
    if (open.length === 0) return [];

    const restored = [];
    for (const row of open) {
      const pos = {
        positionId: row.position_id,
        mint: row.mint,
        symbol: row.symbol,
        entrySol: row.entry_sol,
        entryPrice: row.entry_price,
        tokenAmount: row.token_amount,
        openedAt: row.opened_at,
        dryRun: !!row.dry_run,
        buySignature: row.buy_signature,
        exiting: false,
        sellAttempts: row.sell_attempts || 0,
      };
      this.positions.set(pos.positionId, pos);
      this.byMint.set(pos.mint, pos.positionId);
      restored.push(pos);
      console.log(
        `[PositionManager] 🔄 RESTORED ${pos.symbol || pos.mint.slice(0, 6)} ` +
          `opened ${Math.round((Date.now() - pos.openedAt) / 1000)}s ago, ` +
          `${pos.tokenAmount?.toFixed(2)} tokens`,
      );
    }
    return restored;
  }

  /**
   * 由 main 流程在 buy 成功后调用。
   * 如果 externalPositionId 提供则用它，否则生成。
   */
  registerOpen({ positionId, mint, symbol, entrySol, entryPrice, tokenAmount, dryRun, signature }) {
    const pid = positionId || crypto.randomUUID();
    const pos = {
      positionId: pid,
      mint,
      symbol,
      entrySol,
      entryPrice,
      tokenAmount,
      openedAt: Date.now(),
      dryRun: !!dryRun,
      buySignature: signature,
      exiting: false,
      sellAttempts: 0,
    };
    this.positions.set(pid, pos);
    this.byMint.set(mint, pid);

    this.tradeLogger.openPosition({
      positionId: pid,
      mint,
      symbol,
      openedAt: pos.openedAt,
      entrySol,
      entryPrice,
      tokenAmount,
      dryRun: !!dryRun,
      buySignature: signature,
    });

    console.log(
      `[PositionManager] 📈 OPEN ${symbol || mint.slice(0, 6)} @ ${entryPrice.toExponential(4)}, ` +
        `${tokenAmount.toFixed(2)} tokens, ${entrySol} SOL`,
    );

    monitor.inc('PositionManager.opened', 1, 'PositionManager');
    monitor.set('PositionManager.openCount', this.positions.size, 'PositionManager');
    this.emit('opened', pos);
    return pos;
  }

  _tick() {
    const now = Date.now();
    for (const pos of this.positions.values()) {
      if (pos.exiting) continue;
      const age = now - pos.openedAt;
      if (age >= config.strategy.maxHoldMs) {
        const lastPrice = this.priceTracker.getPrice(pos.mint) || pos.entryPrice;
        this._exit(pos, lastPrice, 'TIMEOUT');
        continue;
      }
    }
  }

  _checkExit(positionId, price) {
    const pos = this.positions.get(positionId);
    if (!pos || pos.exiting) return;
    const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    if (pnlPct >= config.strategy.takeProfitPct) {
      this._exit(pos, price, 'TAKE_PROFIT');
    }
  }

  async _exit(pos, exitPrice, reason) {
    if (pos.exiting) return;
    pos.exiting = true;
    pos.exitReason = reason; // 记录退出意图，重试时复用

    monitor.inc(`PositionManager.exitsBy_${reason}`, 1, 'PositionManager');

    console.log(
      `[PositionManager] 📉 EXIT ${pos.symbol || pos.mint.slice(0, 6)} reason=${reason} ` +
        `pnl=${(((exitPrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2)}%`,
    );

    await this._attemptSell(pos, exitPrice);
  }

  async _attemptSell(pos, exitPrice) {
    const tokenInfo = this.tokenRegistry.getToken(pos.mint);

    const sellResult = await this.executor.sell({
      mint: pos.mint,
      symbol: pos.symbol,
      poolAddress: tokenInfo?.pool_address,
      poolBaseVault: tokenInfo?.pool_base_vault,
      poolQuoteVault: tokenInfo?.pool_quote_vault,
      tokenAmount: pos.tokenAmount,
      baseDecimals: tokenInfo?.decimals ?? 6,
      currentPrice: exitPrice,
    });

    pos.sellAttempts = (pos.sellAttempts || 0) + 1;

    // 记录 SELL trade（无论成功/失败都记一笔，方便审计）
    this.tradeLogger.logTrade({
      positionId: pos.positionId,
      ts: Date.now(),
      mint: pos.mint,
      symbol: pos.symbol,
      side: 'SELL',
      solAmount: sellResult.solOut ?? null,
      tokenAmount: pos.tokenAmount,
      price: sellResult.price ?? exitPrice,
      signature: sellResult.signature,
      success: sellResult.success,
      dryRun: pos.dryRun,
      reason: pos.exitReason + (pos.sellAttempts > 1 ? `_retry_${pos.sellAttempts}` : ''),
      latencyMs: sellResult.latencyMs,
      error: sellResult.error,
    });

    if (sellResult.success) {
      const exitSol = sellResult.solOut ?? pos.tokenAmount * exitPrice;
      const pnlSol = exitSol - pos.entrySol;
      const pnlPct = ((exitSol - pos.entrySol) / pos.entrySol) * 100;

      this.tradeLogger.closePosition(pos.positionId, {
        closedAt: Date.now(),
        exitPrice: sellResult.price ?? exitPrice,
        exitSol,
        pnlSol,
        pnlPct,
        exitReason: pos.exitReason,
        sellSignature: sellResult.signature,
      });

      this.positions.delete(pos.positionId);
      this.byMint.delete(pos.mint);
      monitor.inc('PositionManager.closed', 1, 'PositionManager');
      monitor.set('PositionManager.openCount', this.positions.size, 'PositionManager');
      if (pnlSol > 0) monitor.inc('PositionManager.winners', 1, 'PositionManager');
      else monitor.inc('PositionManager.losers', 1, 'PositionManager');

      this.emit('closed', {
        ...pos,
        exitPrice,
        exitSol,
        pnlSol,
        pnlPct,
        exitReason: pos.exitReason,
      });
    } else {
      monitor.inc('PositionManager.sellRetries', 1, 'PositionManager');
      // SELL 失败：记录 attempt，按退避计划重试
      this.tradeLogger.recordSellAttempt(pos.positionId, sellResult.error);

      // DRY_RUN 不应该失败；如果 DRY_RUN 也失败，记一次就放弃
      if (pos.dryRun) {
        monitor.recordError('PositionManager', new Error('DRY_RUN sell unexpectedly failed'), {
          mint: pos.mint,
          symbol: pos.symbol,
          error: sellResult.error,
        });
        console.error(
          `[PositionManager] DRY_RUN sell unexpectedly failed for ${pos.mint}; abandoning`,
        );
        this.positions.delete(pos.positionId);
        this.byMint.delete(pos.mint);
        monitor.set('PositionManager.openCount', this.positions.size, 'PositionManager');
        return;
      }

      const delayIdx = Math.min(pos.sellAttempts - 1, SELL_RETRY_DELAYS_MS.length - 1);
      const delay = SELL_RETRY_DELAYS_MS[delayIdx] || 30_000;

      console.warn(
        `[PositionManager] SELL failed (attempt ${pos.sellAttempts}): ${sellResult.error}; ` +
          `retrying in ${delay}ms`,
      );

      setTimeout(() => {
        if (!this.positions.has(pos.positionId)) return; // 可能已被外部关掉
        const latestPrice = this.priceTracker.getPrice(pos.mint) || exitPrice;
        // 重试时不要再次设 exiting=true（已经是了），直接调 _attemptSell
        this._attemptSell(pos, latestPrice).catch((err) => {
          monitor.recordError('PositionManager', err, { phase: 'sell_retry', mint: pos.mint });
          console.error(`[PositionManager] sell retry crashed: ${err.message}`);
        });
      }, delay);
    }
  }
}

module.exports = PositionManager;
