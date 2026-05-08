'use strict';

const crypto = require('crypto');
const { config, validateConfig } = require('./config');
const TokenRegistry = require('./data/TokenRegistry');
const TradeLogger = require('./data/TradeLogger');
const TickStream = require('./core/TickStream');
const DumpDetector = require('./core/DumpDetector');
const PriceTracker = require('./core/PriceTracker');
const SignalEngine = require('./core/SignalEngine');
const Executor = require('./core/Executor');
const PositionManager = require('./core/PositionManager');
const DailyReport = require('./reports/DailyReport');
const Server = require('./server/server');
const { getMonitor } = require('./monitor/HealthMonitor');
const AlertChecker = require('./monitor/AlertChecker');

const monitor = getMonitor();

async function main() {
  console.log('================================================');
  console.log('🎯 Dump Sniper V1 starting...');
  console.log(`Mode: ${config.DRY_RUN ? 'DRY_RUN' : '⚠️  LIVE TRADING ⚠️'}`);
  console.log('================================================');

  const errors = validateConfig();
  if (errors.length) {
    console.error('Config errors:');
    errors.forEach((e) => console.error('  - ' + e));
    if (errors.some((e) => e.includes('LaserStream') || e.includes('HELIUS_API_KEY'))) {
      console.error('Critical config missing. Exiting.');
      process.exit(1);
    }
  }

  // 数据层（共用同一 db 连接）
  const tokenRegistry = new TokenRegistry();
  const tradeLogger = new TradeLogger(tokenRegistry.db);

  // 核心引擎
  const priceTracker = new PriceTracker();
  const dumpDetector = new DumpDetector(tokenRegistry);
  const executor = new Executor();
  const positionManager = new PositionManager({
    tradeLogger,
    executor,
    priceTracker,
    tokenRegistry,
  });
  const signalEngine = new SignalEngine({ tradeLogger, positionManager });
  const tickStream = new TickStream();

  // 报告
  const dailyReport = new DailyReport({ tradeLogger, tokenRegistry });
  dailyReport.start();

  // ============ 服务器（提前创建，事件回调会引用） ============
  const server = new Server({
    tokenRegistry,
    tradeLogger,
    positionManager,
    signalEngine,
    dailyReport,
    onTokenListChanged: () => {
      const mints = tokenRegistry.listActive().map((t) => t.mint);
      tickStream.updateSubscription(mints);
    },
  });

  // ============ 启动恢复未平仓持仓 ============
  const restored = positionManager.restoreFromDb();
  if (restored.length > 0) {
    console.log(`[main] restored ${restored.length} open position(s) from db`);
    monitor.inc('main.restoredPositions', restored.length, 'main');
  }

  // ============ 健康监控 / 告警检测 ============
  const alertChecker = new AlertChecker({
    monitor,
    tickStream,
    executor,
    positionManager,
    tokenRegistry,
    config,
  });
  alertChecker.start();

  monitor.on('alert', (alert) => {
    console.error(`[ALERT] [${alert.severity.toUpperCase()}] ${alert.name}: ${alert.message}`);
    server.broadcast({ type: 'alert', alert });
  });
  monitor.on('alertCleared', (alert) => {
    console.log(`[ALERT] cleared: ${alert.name}`);
    server.broadcast({ type: 'alertCleared', alert });
  });

  // ============ 事件连线 ============

  tickStream.on('transaction', (tx) => dumpDetector.handleTransaction(tx));

  dumpDetector.on('priceTick', ({ mint, price, ts, poolAddress }) => {
    priceTracker.update(mint, price, ts, poolAddress);
  });

  // sellAnalyzed 不再无条件落库（避免写入风暴）。
  // SignalEngine 会记录通过的；这里我们只记录"接近触发"的（部分通过）以备分析。
  // "接近"定义：sellSol >= 0.5 * threshold 且 priceImpact >= 0.5 * threshold
  dumpDetector.on('sellAnalyzed', (info) => {
    if (info.passSize && info.passImpact) return; // 已触发，由 SignalEngine 处理
    const halfSize = config.strategy.minSellSol * 0.5;
    const halfImpact = config.strategy.minPriceImpactPct * 0.5;
    if (info.sellSol < halfSize || info.priceImpactPct < halfImpact) return; // 太小，不记录
    tradeLogger.logSignal({
      ts: info.ts,
      mint: info.mint,
      symbol: info.symbol,
      kind: 'DUMP_DETECTED',
      sellSol: info.sellSol,
      priceImpactPct: info.priceImpactPct,
      seller: info.seller,
      sellerTx: info.signature,
      notes: `near-miss: passSize=${info.passSize}, passImpact=${info.passImpact}`,
      accepted: false,
      rejectReason: 'thresholds not met',
    });
  });

  dumpDetector.on('dumpSignal', (signal) => signalEngine.handleDumpSignal(signal));

  // SignalEngine 推送 buyOrder → Executor → 注册持仓
  signalEngine.on('buyOrder', async (order) => {
    const tokenInfo = tokenRegistry.getToken(order.mint);

    // 关键：用同一个 positionId 贯穿 BUY trade / position 表
    const positionId = crypto.randomUUID();

    const buyResult = await executor.buy({
      mint: order.mint,
      symbol: order.symbol,
      poolAddress: order.poolAddress || tokenInfo?.pool_address,
      poolBaseVault: order.poolBaseVault || tokenInfo?.pool_base_vault,
      poolQuoteVault: order.poolQuoteVault || tokenInfo?.pool_quote_vault,
      priceAfter: order.priceAfter,
      sizeSol: order.sizeSol,
      baseDecimals: order.baseDecimals ?? tokenInfo?.decimals ?? 6,
    });

    // 写入 pool 信息（如果之前没有）
    if (
      order.poolAddress &&
      (!tokenInfo?.pool_address || !tokenInfo?.pool_base_vault)
    ) {
      tokenRegistry.setPoolInfo(order.mint, {
        poolAddress: order.poolAddress,
        poolBaseVault: order.poolBaseVault,
        poolQuoteVault: order.poolQuoteVault,
      });
    }

    // 记录 BUY trade（用同一 positionId）
    tradeLogger.logTrade({
      positionId,
      ts: Date.now(),
      mint: order.mint,
      symbol: order.symbol,
      side: 'BUY',
      solAmount: order.sizeSol,
      tokenAmount: buyResult.tokenAmount,
      price: buyResult.price,
      signature: buyResult.signature,
      success: buyResult.success,
      dryRun: config.DRY_RUN,
      reason: order.reason,
      latencyMs: buyResult.latencyMs,
      error: buyResult.error,
    });

    if (buyResult.success) {
      positionManager.registerOpen({
        positionId, // 传入外部 ID
        mint: order.mint,
        symbol: order.symbol,
        entrySol: order.sizeSol,
        entryPrice: buyResult.price,
        tokenAmount: buyResult.tokenAmount,
        dryRun: config.DRY_RUN,
        signature: buyResult.signature,
      });

      if (buyResult.signature) signalEngine.registerOurSignature(buyResult.signature);
    } else {
      console.error(
        `[main] BUY failed for ${order.symbol || order.mint.slice(0, 6)}: ${buyResult.error}`,
      );
    }
  });

  positionManager.on('opened', (pos) =>
    server.broadcast({ type: 'positionOpened', position: pos }),
  );
  positionManager.on('closed', (pos) =>
    server.broadcast({ type: 'positionClosed', position: pos }),
  );

  // ============ 启动服务器 ============
  server.start();

  // ============ 启动数据流 ============
  const initialMints = tokenRegistry.listActive().map((t) => t.mint);
  console.log(`[main] starting LaserStream with ${initialMints.length} initial tokens`);
  await tickStream.start(initialMints);

  // ============ 优雅退出 ============
  const shutdown = async (signal) => {
    console.log(`\n[main] ${signal} received, shutting down gracefully...`);
    try {
      await tickStream.stop();
      positionManager.stop();
      alertChecker.stop();
      monitor.stop();
      executor.stop && executor.stop();
      // 给 SQLite WAL 一点时间 flush
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error(`[main] shutdown error: ${err.message}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 未捕获异常：记录但不立即退出（让 systemd 知道我们还活着）
  process.on('uncaughtException', (err) => {
    monitor.recordError('main', err, { phase: 'uncaughtException' });
    monitor.inc('main.uncaughtExceptions', 1, 'main');
    console.error('[main] uncaughtException:', err);
  });
  process.on('unhandledRejection', (reason) => {
    monitor.recordError('main', reason instanceof Error ? reason : new Error(String(reason)), {
      phase: 'unhandledRejection',
    });
    monitor.inc('main.unhandledRejections', 1, 'main');
    console.error('[main] unhandledRejection:', reason);
  });

  console.log('[main] startup complete');
}

main().catch((err) => {
  console.error('[main] fatal error:', err);
  process.exit(1);
});
