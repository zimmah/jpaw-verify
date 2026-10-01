// The signing policy's public half: what a swap+burn transaction from the hot wallet may invoke and
// how much it may cost beyond the swap amount. The engine enforces it before signing (server/lib/buyback.ts);
// the verifier checks a published coin payout against the same numbers, so both read them from here.

import { PublicKey } from '@solana/web3.js'

export const JUPITER_V6_PROGRAM_ID = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')
export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
export const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111')
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
export const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey('ComputeBudget111111111111111111111111111111')
export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

/** Every program a swap+burn tx may invoke at the top level. Anything else is refused before signing for real. */
export const ALLOWED_PROGRAMS: readonly PublicKey[] = [
  JUPITER_V6_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID, MEMO_PROGRAM_ID, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID,
]

export const isAllowedProgram = (p: PublicKey) => ALLOWED_PROGRAMS.some((a) => a.equals(p))

/**
 * The programs a swap actually executes on: the router, or pump.fun's curve and PumpSwap directly. A coin payout
 * tx must invoke one of these at the top level, or no coin was bought in it (the verifier refuses a plain transfer
 * plus a burn of tokens held from before as proof of a payout).
 */
export const VENUE_PROGRAMS: readonly PublicKey[] = [JUPITER_V6_PROGRAM_ID, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID]

export const isVenueProgram = (p: PublicKey) => VENUE_PROGRAMS.some((a) => a.equals(p))

/**
 * Lamports the wallet may lose beyond the swap amount and the tx fee: rent for the token ATA and
 * pump's user volume accumulator (both once per mint/wallet; ~4.6M observed on PumpSwap), and on
 * the bonding curve pump's fees, which the curve charges on top of the quoted input.
 */
export const RENT_ALLOWANCE_LAMPORTS = 6_000_000
export const CURVE_FEE_ALLOWANCE_BPS = 300

/** The most a swap of `lamports` may cost the wallet beyond the amount and the tx fee, whatever the route. */
export const maxSwapOverspend = (lamports: number) => RENT_ALLOWANCE_LAMPORTS + Math.ceil((lamports * CURVE_FEE_ALLOWANCE_BPS) / 10_000)
