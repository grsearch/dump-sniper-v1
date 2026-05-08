'use strict';

require('dotenv').config();

const config = {
  // ============ Mode ============
  DRY_RUN: (process.env.DRY_RUN ?? 'true').toLowerCase() === 'true',

  // ============ Strategy ============
  strategy: {
    // 触发条件
    minSellSol: 10.0,            // 卖单 SOL 数量阈值
    minPriceImpactPct: 10.0,     // 单笔交易自身价格冲击阈值（%，正数表示跌幅）

    // 仓位
    positionSizeSol: 1.0,        // 每笔买入 SOL 数量

    // 退出
    takeProfitPct: 8.0,          // 止盈百分比
    maxHoldMs: 15_000,           // 最大持仓时间（毫秒）
    // 注：用户选择"硬扛到 15 秒上限"，无主动止损

    // 滑点
    buySlippageBps: 1500,        // 15%
    sellSlippageBps: 2000,       // 20%

    // 风控
    cooldownMsPerToken: 60_000,  // 同一代币冷却 60 秒
    maxConcurrentPositions: 3,   // 最多并发持仓数
  },

  // ============ Helius ============
  helius: {
    apiKey: process.env.HELIUS_API_KEY,
    rpcUrl: process.env.HELIUS_RPC_URL,
    stakedRpcUrl: process.env.HELIUS_STAKED_RPC_URL,
    laserstreamEndpoint: process.env.HELIUS_LASERSTREAM_ENDPOINT,
    laserstreamToken: process.env.HELIUS_LASERSTREAM_TOKEN,
  },

  // ============ Birdeye ============
  birdeye: {
    apiKey: process.env.BIRDEYE_API_KEY,
    baseUrl: 'https://public-api.birdeye.so',
  },

  // ============ Wallet ============
  wallet: {
    privateKeyBs58: process.env.WALLET_PRIVATE_KEY_BS58,
  },

  // ============ Programs ============
  programs: {
    pumpAmm: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    associatedTokenProgram: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    systemProgram: '11111111111111111111111111111111',
    wsol: 'So11111111111111111111111111111111111111112',
  },

  // ============ Server ============
  server: {
    port: parseInt(process.env.DASHBOARD_PORT || '3001', 10),
    bindHost: process.env.BIND_HOST || '0.0.0.0',
    webhookSecret: process.env.WEBHOOK_SECRET || null,    // 可选：webhook 共享密钥
    dashboardToken: process.env.DASHBOARD_TOKEN || null,  // 可选：dashboard 访问令牌
  },

  // ============ Storage ============
  storage: {
    dbPath: './data/sniper.db',
    reportsDir: './reports',
    logsDir: './logs',
  },

  // ============ Misc ============
  // Priority fee 上限（lamports）
  maxPriorityFeeLamports: 5_000_000, // 0.005 SOL
};

// 启动时校验关键配置
function validateConfig() {
  const errors = [];
  if (!config.helius.apiKey) errors.push('HELIUS_API_KEY missing');
  if (!config.helius.rpcUrl) errors.push('HELIUS_RPC_URL missing');
  if (!config.helius.laserstreamEndpoint) errors.push('HELIUS_LASERSTREAM_ENDPOINT missing');
  if (!config.helius.laserstreamToken) errors.push('HELIUS_LASERSTREAM_TOKEN missing');
  if (!config.birdeye.apiKey) errors.push('BIRDEYE_API_KEY missing');
  if (!config.DRY_RUN && !config.wallet.privateKeyBs58) {
    errors.push('WALLET_PRIVATE_KEY_BS58 required for LIVE mode');
  }
  return errors;
}

module.exports = { config, validateConfig };
