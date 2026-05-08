'use strict';

const EventEmitter = require('events');

/**
 * PriceTracker
 * ============
 * 接收 DumpDetector 推送的 priceTick，维护每个代币的最新价格。
 * PositionManager 用最新价格做止盈判定。
 */
class PriceTracker extends EventEmitter {
  constructor() {
    super();
    this.prices = new Map(); // mint → { price, ts, poolAddress }
  }

  update(mint, price, ts = Date.now(), poolAddress = null) {
    if (!Number.isFinite(price) || price <= 0) return;
    const prev = this.prices.get(mint);
    this.prices.set(mint, { price, ts, poolAddress });
    this.emit('update', { mint, price, ts, prev: prev?.price });
  }

  get(mint) {
    return this.prices.get(mint) || null;
  }

  getPrice(mint) {
    return this.prices.get(mint)?.price ?? null;
  }
}

module.exports = PriceTracker;
