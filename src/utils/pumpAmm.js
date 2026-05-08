'use strict';

/**
 * ============================================================================
 * Pump.fun AMM 指令构造
 * ============================================================================
 *
 * ⚠️ 重要警告 ⚠️
 *
 * Pump.fun AMM 程序 (pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA) 的指令布局和
 * 账户顺序基于公开 IDL 和实测交易反推得到。在投入实盘前 **必须**：
 *
 * 1. 用 DRY_RUN 模式跑至少 24h 验证信号准确性
 * 2. 用极小金额（如 0.01 SOL）做实盘验证至少 5 笔成功交易
 * 3. 对比 Solscan 上一笔成功的 Pump AMM swap 交易，校验账户顺序与本代码一致
 *
 * Pump 程序未来可能升级，account layout 可能变化。本模块基于 2025-2026 期间
 * 通用版本编写。
 *
 * 如果不确定，建议改用 Jupiter 路径作为 fallback。
 * ============================================================================
 */

const {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  NATIVE_MINT,
} = require('@solana/spl-token');
const BN = require('bn.js');

const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const PUMP_GLOBAL_CONFIG = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
const PUMP_EVENT_AUTHORITY = new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
const PUMP_PROTOCOL_FEE_RECIPIENT = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');

// Discriminators (Anchor sighash of "global:buy" / "global:sell")
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

/**
 * 推导 Pump AMM pool PDA。
 * Pump AMM 用 ["pool", index, creator, base_mint, quote_mint] 作为种子。
 * 但因为我们用监控的实际 pool 地址（从交易解析得到），通常不需要重新推导。
 */
function derivePoolPda(creator, baseMint, quoteMint, index = 0) {
  const indexBuf = Buffer.alloc(2);
  indexBuf.writeUInt16LE(index, 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), indexBuf, creator.toBuffer(), baseMint.toBuffer(), quoteMint.toBuffer()],
    PUMP_AMM_PROGRAM_ID,
  );
  return pda;
}

/**
 * 构造 Pump AMM Buy 指令。
 *
 * @param {object} params
 * @param {PublicKey} params.pool                 - 池子地址
 * @param {PublicKey} params.user                 - 用户钱包
 * @param {PublicKey} params.baseMint             - meme 代币 mint
 * @param {PublicKey} params.quoteMint            - 通常是 WSOL
 * @param {PublicKey} params.poolBaseTokenAccount - 池子的 base token vault
 * @param {PublicKey} params.poolQuoteTokenAccount- 池子的 quote (WSOL) vault
 * @param {BN} params.baseAmountOut               - 期望买到的 base 数量（最小值）
 * @param {BN} params.maxQuoteAmountIn            - 最大付出的 quote 数量（含滑点）
 * @returns {TransactionInstruction}
 */
function buildPumpBuyIx(params) {
  const {
    pool,
    user,
    baseMint,
    quoteMint,
    poolBaseTokenAccount,
    poolQuoteTokenAccount,
    baseAmountOut,
    maxQuoteAmountIn,
  } = params;

  const userBaseAta = getAssociatedTokenAddressSync(baseMint, user);
  const userQuoteAta = getAssociatedTokenAddressSync(quoteMint, user);
  const protocolFeeRecipientTokenAccount = getAssociatedTokenAddressSync(
    quoteMint,
    PUMP_PROTOCOL_FEE_RECIPIENT,
    true, // allowOwnerOffCurve
  );

  // 数据：discriminator (8) + base_amount_out (u64) + max_quote_amount_in (u64)
  const data = Buffer.concat([
    BUY_DISCRIMINATOR,
    new BN(baseAmountOut).toArrayLike(Buffer, 'le', 8),
    new BN(maxQuoteAmountIn).toArrayLike(Buffer, 'le', 8),
  ]);

  const keys = [
    { pubkey: pool, isSigner: false, isWritable: true },
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: PUMP_GLOBAL_CONFIG, isSigner: false, isWritable: false },
    { pubkey: baseMint, isSigner: false, isWritable: false },
    { pubkey: quoteMint, isSigner: false, isWritable: false },
    { pubkey: userBaseAta, isSigner: false, isWritable: true },
    { pubkey: userQuoteAta, isSigner: false, isWritable: true },
    { pubkey: poolBaseTokenAccount, isSigner: false, isWritable: true },
    { pubkey: poolQuoteTokenAccount, isSigner: false, isWritable: true },
    { pubkey: PUMP_PROTOCOL_FEE_RECIPIENT, isSigner: false, isWritable: false },
    { pubkey: protocolFeeRecipientTokenAccount, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: PUMP_AMM_PROGRAM_ID,
    data,
  });
}

/**
 * 构造 Pump AMM Sell 指令。
 */
function buildPumpSellIx(params) {
  const {
    pool,
    user,
    baseMint,
    quoteMint,
    poolBaseTokenAccount,
    poolQuoteTokenAccount,
    baseAmountIn,
    minQuoteAmountOut,
  } = params;

  const userBaseAta = getAssociatedTokenAddressSync(baseMint, user);
  const userQuoteAta = getAssociatedTokenAddressSync(quoteMint, user);
  const protocolFeeRecipientTokenAccount = getAssociatedTokenAddressSync(
    quoteMint,
    PUMP_PROTOCOL_FEE_RECIPIENT,
    true,
  );

  const data = Buffer.concat([
    SELL_DISCRIMINATOR,
    new BN(baseAmountIn).toArrayLike(Buffer, 'le', 8),
    new BN(minQuoteAmountOut).toArrayLike(Buffer, 'le', 8),
  ]);

  const keys = [
    { pubkey: pool, isSigner: false, isWritable: true },
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: PUMP_GLOBAL_CONFIG, isSigner: false, isWritable: false },
    { pubkey: baseMint, isSigner: false, isWritable: false },
    { pubkey: quoteMint, isSigner: false, isWritable: false },
    { pubkey: userBaseAta, isSigner: false, isWritable: true },
    { pubkey: userQuoteAta, isSigner: false, isWritable: true },
    { pubkey: poolBaseTokenAccount, isSigner: false, isWritable: true },
    { pubkey: poolQuoteTokenAccount, isSigner: false, isWritable: true },
    { pubkey: PUMP_PROTOCOL_FEE_RECIPIENT, isSigner: false, isWritable: false },
    { pubkey: protocolFeeRecipientTokenAccount, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: PUMP_AMM_PROGRAM_ID,
    data,
  });
}

module.exports = {
  PUMP_AMM_PROGRAM_ID,
  PUMP_GLOBAL_CONFIG,
  PUMP_EVENT_AUTHORITY,
  PUMP_PROTOCOL_FEE_RECIPIENT,
  BUY_DISCRIMINATOR,
  SELL_DISCRIMINATOR,
  buildPumpBuyIx,
  buildPumpSellIx,
  derivePoolPda,
};
