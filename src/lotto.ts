// Pure, deterministic JPAW lotto logic.
// Shared by the draw worker, the public site, and the standalone verifier.
// Anything in here must be reproducible by anyone from public data.

import { createHash } from 'node:crypto'

export const BPS = 10_000

/** Hard cap on the operator cut. Can be lowered at runtime, never raised above this. */
export const MAX_OPERATOR_BPS = 1_000 // 10%
export const BURN_BPS = 4_500 // 45%
/** Share of the jackpot allocation that goes to the hourly pot (rest goes to mega). */
export const HOURLY_SHARE_BPS = 5_000 // 50/50
/** Hourly pot: the winner gets 20%, 80% rolls. */
export const HOURLY_PAYOUT_BPS = 2_000
/** Mega pot: the winner gets 50%, 50% seeds the next mega. */
export const MEGA_PAYOUT_BPS = 5_000
/** Mega pot hits with probability 1 / MEGA_ODDS per draw (the production default; a draw's record carries its own). */
export const MEGA_ODDS = 168
/** Round length in minutes: the draw is at every multiple of this from the top of the UTC hour (production default). */
export const ROUND_MINUTES = 60
/** Entries close this many minutes before the draw: the final re-read, the commit and the seed happen in this window. */
export const SETTLEMENT_MINUTES = 5
/** Per-round X API budget: this share of the hourly pot at draw open, topped up from the API buffer to a floor. */
export const API_POT_BPS = 200 // 2%
/** After each draw, up to this share of the hourly pot refills the API buffer until it reaches its target. */
export const API_BUFFER_REFILL_BPS = 50 // 0.5%
/** What a draw can move from the hourly pot to X reads and the buffer combined: the public claim. */
export const API_MAX_POT_BPS = API_POT_BPS + API_BUFFER_REFILL_BPS // 2.5%

/**
 * A drand round is only valid as a seed if it was emitted at least this long after the commit tx block time. Stored on
 * every draw (`params.seedDelayMs`) and read from the record by the verifier: a draw runs on the delay it opened with.
 * Solana's block time is the cluster's clock and can lag; a full minute keeps the seed unknowable when the list is locked.
 */
export const SEED_DELAY_MS = 60_000
/** The delay of draws from before it was stored on the record (they verify with this one). */
export const LEGACY_SEED_DELAY_MS = 30_000

/**
 * The rent-exempt minimum of an empty account (0 bytes, at Solana's rent rate of 3480 lamports per byte-year x 2
 * years, 128 bytes of overhead): a transfer that leaves a fresh wallet below it fails on-chain. No payout under this
 * is attempted; the round rolls over like a payout under the USD minimum (see minPayoutLamportsFor).
 */
export const RENT_EXEMPT_MIN_LAMPORTS = 890_880

/**
 * The payout floor of a draw in lamports: the USD minimum at the draw's price, never under the rent-exempt minimum
 * (a smaller payout could not reach a fresh wallet at all). Applied to every payout kind, mega and coin included, so
 * the rule is one number the record explains.
 */
export function minPayoutLamportsFor(minPayoutUsd: number, solUsd: number): number {
  if (!Number.isFinite(minPayoutUsd) || minPayoutUsd < 0) throw new Error(`bad minimum payout $${minPayoutUsd}`)
  if (!Number.isFinite(solUsd) || solUsd <= 0) throw new Error(`bad SOL price ${solUsd}`)
  return Math.max(solToLamports(minPayoutUsd / solUsd), RENT_EXEMPT_MIN_LAMPORTS)
}

/** Versions every hash, memo and randomness label. v3: the commit preimage carries each entry's address kind. */
export const PROTOCOL_VERSION = 'jpaw:v3'

export interface Buckets {
  burn: number // lamports
  operator: number
  hourly: number
  mega: number
  apiReserve: number
  /** Operator-seeded SOL that tops up the per-round X API budget. Spent parts move to apiReserve. */
  apiBuffer: number
  /** Network fees of draw steps and sweeps the wallet has already paid, not yet deducted from the hourly pot. */
  pendingCost: number
  /** X API charges (post, reads) the hourly pot could not cover yet. Owed to X (paid in credits, not lamports); moves to apiReserve when the pot can. */
  pendingApi: number
  /** Burn-cycle costs already paid by the wallet beyond what the burn bucket had reserved. Repaid from future burn credits. */
  burnDebt: number
}

export const emptyBuckets = (): Buckets => ({
  burn: 0, operator: 0, hourly: 0, mega: 0, apiReserve: 0, apiBuffer: 0, pendingCost: 0, pendingApi: 0, burnDebt: 0,
})

/**
 * Lamports the wallet must hold for the buckets: everything owed minus costs the wallet has
 * already paid out of its balance. wallet == float + accountedLamports(buckets) at all times.
 * pendingApi is not in it: that money has not left the wallet, it is just not in a bucket yet.
 */
export function accountedLamports(b: Buckets): number {
  return b.burn + b.operator + b.hourly + b.mega + b.apiReserve + b.apiBuffer - b.pendingCost - b.burnDebt
}

/** Split freshly claimed creator fees into buckets. Rounding dust goes to the jackpot. */
export function splitFees(feesLamports: number, operatorBps: number) {
  assertInt(feesLamports, 'feesLamports')
  if (operatorBps < 0 || operatorBps > MAX_OPERATOR_BPS) throw new Error(`operatorBps ${operatorBps} out of range`)
  const operator = Math.floor((feesLamports * operatorBps) / BPS)
  const burn = Math.floor((feesLamports * BURN_BPS) / BPS)
  const jackpot = feesLamports - operator - burn
  const hourly = Math.floor((jackpot * HOURLY_SHARE_BPS) / BPS)
  const mega = jackpot - hourly
  return { operator, burn, hourly, mega }
}

/**
 * Credit claimed fees, net of the claim tx fee (so every bucket shares it proportionally).
 * The burn share first repays any burn-bucket debt.
 */
export function creditFees(b: Buckets, netFeesLamports: number, operatorBps: number): Buckets {
  const s = splitFees(netFeesLamports, operatorBps)
  const repaid = Math.min(b.burnDebt, s.burn)
  return {
    ...b,
    operator: b.operator + s.operator,
    burn: b.burn + s.burn - repaid,
    burnDebt: b.burnDebt - repaid,
    hourly: b.hourly + s.hourly,
    mega: b.mega + s.mega,
  }
}

/**
 * Close a burn cycle: `reserved` was taken out of the burn bucket up front, `spent` is what the
 * wallet actually lost (swap amount, tx and priority fees, rent, curve-route overspend).
 * Unspent reservation returns to the bucket; overspend becomes debt.
 */
export function settleBurnCycle(b: Buckets, reserved: number, spent: number): Buckets {
  assertInt(reserved, 'reserved')
  assertInt(spent, 'spent')
  return spent <= reserved
    ? { ...b, burn: b.burn + (reserved - spent) }
    : { ...b, burnDebt: b.burnDebt + (spent - reserved) }
}

export type SettleOutcome =
  | { kind: 'no-entries' }
  /** The prize never reached the reading threshold before the close: nothing was read, no commit, no seed, no mega roll. */
  | { kind: 'pot-building' }
  /** The read budget ran out before MIN_ENTRANTS_ON_BUDGET_STOP valid entrants: flooding the round buys nothing. */
  | { kind: 'too-few-entrants' }
  | { kind: 'below-minimum' }
  | { kind: 'hourly'; payoutLamports: number }
  | { kind: 'mega'; payoutLamports: number }

/**
 * The X API budget of one round, fixed at draw open: API_POT_BPS of the hourly pot, and when that is under the floor
 * the API buffer covers the difference as far as it can. Both in lamports; the USD figure the entry cap is derived
 * from uses the open-time price, and the floor is that price's worth of API_BUDGET_FLOOR_USD.
 */
export function apiBudget(b: Buckets, floorLamports: number): { potLamports: number; bufferLamports: number } {
  assertInt(floorLamports, 'floorLamports')
  const potLamports = Math.floor((b.hourly * API_POT_BPS) / BPS)
  return { potLamports, bufferLamports: Math.min(b.apiBuffer, Math.max(0, floorLamports - potLamports)) }
}

/**
 * After a draw: if the API buffer is under its target, move up to API_BUFFER_REFILL_BPS of the hourly pot into it,
 * never more than the shortfall. Money inside the wallet changes bucket; accountedLamports is unchanged.
 */
export function refillBuffer(b: Buckets, targetLamports: number): { buckets: Buckets; moved: number } {
  assertInt(targetLamports, 'targetLamports')
  if (b.apiBuffer >= targetLamports) return { buckets: b, moved: 0 }
  const moved = Math.min(Math.floor((b.hourly * API_BUFFER_REFILL_BPS) / BPS), targetLamports - b.apiBuffer)
  return { buckets: { ...b, hourly: b.hourly - moved, apiBuffer: b.apiBuffer + moved }, moved }
}

/** The buffer's target looks back this many draws ... */
export const BUFFER_TARGET_WINDOW = 24
/** ... and aims to hold this many draws' worth of their average spend (about a day of reading). */
export const BUFFER_TARGET_MULTIPLE = 24

/**
 * The API buffer's target: BUFFER_TARGET_MULTIPLE times the average actual X spend (reads plus the post) of the
 * last BUFFER_TARGET_WINDOW draws, never under `floorUsd`. `spendsUsd` is newest first; with no history the
 * target is the floor.
 */
export function bufferTargetUsd(spendsUsd: number[], floorUsd: number): { targetUsd: number; avgSpendUsd: number; draws: number } {
  const recent = spendsUsd.slice(0, BUFFER_TARGET_WINDOW).filter((v) => Number.isFinite(v) && v >= 0)
  const avgSpendUsd = recent.length ? recent.reduce((s, v) => s + v, 0) / recent.length : 0
  return { targetUsd: Math.max(floorUsd, BUFFER_TARGET_MULTIPLE * avgSpendUsd), avgSpendUsd, draws: recent.length }
}

/** Entries a round can admit: one post read and one user lookup each, out of the budget. */
export function entryCap(budgetUsd: number, costPostReadUsd: number, costUserReadUsd: number): number {
  const perEntry = costPostReadUsd + costUserReadUsd
  if (perEntry <= 0) throw new Error('per-entry cost must be positive')
  return Math.max(0, Math.floor(budgetUsd / perEntry + 1e-9))
}

export interface SettleInput {
  buckets: Buckets
  /** Cost of the draw's own announcement post, in lamports. Hourly pot, outside the cap. */
  postCostLamports: number
  /** X reads this round (post reads + user lookups), in lamports. Charged to the pot share first, then the buffer share, never beyond either. */
  apiReadsLamports: number
  /** The round's budget as fixed at open (see apiBudget). */
  potBudgetLamports: number
  bufferBudgetLamports: number
  /** The API buffer's target at the draw's price; up to API_BUFFER_REFILL_BPS of the hourly pot refills it. 0: no refill. */
  bufferTargetLamports?: number
  entrantCount: number
  /** Reading stopped because the budget ran out, with fewer valid entrants than the configured minimum: roll over. */
  tooFewEntrants?: boolean
  megaHit: boolean
  minPayoutLamports: number
  /** The round never started reading (see readingOpen): charge the post cost and carried costs, no refill, everything rolls. */
  potBuilding?: boolean
}

/**
 * Reading threshold. Replies are only read once the hourly prize (HOURLY_PAYOUT_BPS of the hourly pot) is worth at
 * least `minPayoutUsd`; checked every poll while a round is open, at the price of that moment. Once reading has
 * started it continues whatever the price does; the payout minimum at settlement is the final guard.
 */
export function readingOpen(hourlyLamports: number, solUsd: number, minPayoutUsd: number): { prizeUsd: number; prizeLamports: number; open: boolean } {
  assertInt(hourlyLamports, 'hourlyLamports')
  if (!Number.isFinite(solUsd) || solUsd <= 0) throw new Error(`bad SOL price ${solUsd}`)
  const prizeLamports = Math.floor((hourlyLamports * HOURLY_PAYOUT_BPS) / BPS)
  const prizeUsd = lamportsToSol(prizeLamports) * solUsd
  return { prizeUsd, prizeLamports, open: prizeUsd >= minPayoutUsd }
}

/**
 * Settle one draw against the ledger.
 * 1. Charge API reads: up to potBudget from the hourly pot, the rest up to bufferBudget from the API buffer.
 *    Both move to apiReserve (real money owed to X). Nothing above the budget is charged to anyone.
 * 2. The hourly pot pays, in this order, what it can: API charges (this draw's post and pot-side reads, plus
 *    pendingApi carried from earlier draws) into apiReserve, then carried network fees (pendingCost, already
 *    gone from the wallet). What it cannot cover carries as pendingApi / pendingCost.
 *    Then the buffer refill (see refillBuffer): counted as pot spend, before the payout is sized.
 * 3. No entries, or the budget ran out before enough entrants (tooFewEntrants): everything rolls.
 * 4. Mega hit and 50% of mega >= minimum: winner gets it, 50% seeds the next mega, hourly rolls fully.
 * 5. Otherwise, if 20% of hourly >= minimum: winner gets it, 80% rolls.
 * 6. Otherwise: everything rolls.
 */
export function settle(input: SettleInput): { buckets: Buckets; outcome: SettleOutcome; costDeducted: number; apiCharged: { pot: number; buffer: number }; refilled: number } {
  const { postCostLamports, apiReadsLamports, potBudgetLamports, bufferBudgetLamports, bufferTargetLamports = 0, entrantCount, tooFewEntrants, megaHit, minPayoutLamports, potBuilding } = input
  for (const [k, v] of Object.entries({ postCostLamports, apiReadsLamports, potBudgetLamports, bufferBudgetLamports, bufferTargetLamports, minPayoutLamports })) assertInt(v, k)
  let b = { ...input.buckets }

  // 1. API reads, hard-capped by the budget fixed at open.
  const potApi = Math.min(apiReadsLamports, potBudgetLamports)
  const bufferApi = Math.min(apiReadsLamports - potApi, bufferBudgetLamports, b.apiBuffer)
  b.apiBuffer -= bufferApi
  b.apiReserve += bufferApi

  // 2. Hourly-pot costs. API money first (it is owed to X and must reach apiReserve), then network fees.
  const apiDue = postCostLamports + potApi + b.pendingApi
  const apiPaid = Math.min(apiDue, b.hourly)
  b.hourly -= apiPaid
  b.apiReserve += apiPaid
  b.pendingApi = apiDue - apiPaid
  const feesPaid = Math.min(b.pendingCost, b.hourly)
  b.hourly -= feesPaid
  b.pendingCost -= feesPaid
  const deducted = apiPaid + feesPaid
  const apiCharged = { pot: potApi, buffer: bufferApi }
  // A round that never read: its post and carried costs are paid, nothing else moves (no refill, no draw).
  if (potBuilding) return { buckets: b, outcome: { kind: 'pot-building' }, costDeducted: deducted, apiCharged, refilled: 0 }
  const refill = refillBuffer(b, bufferTargetLamports)
  b = { ...refill.buckets }
  const refilled = refill.moved

  if (entrantCount === 0) return { buckets: b, outcome: { kind: 'no-entries' }, costDeducted: deducted, apiCharged, refilled }
  if (tooFewEntrants) return { buckets: b, outcome: { kind: 'too-few-entrants' }, costDeducted: deducted, apiCharged, refilled }

  if (megaHit) {
    const payout = Math.floor((b.mega * MEGA_PAYOUT_BPS) / BPS)
    if (payout >= minPayoutLamports && payout > 0) {
      b.mega -= payout
      return { buckets: b, outcome: { kind: 'mega', payoutLamports: payout }, costDeducted: deducted, apiCharged, refilled }
    }
  }

  const payout = Math.floor((b.hourly * HOURLY_PAYOUT_BPS) / BPS)
  if (payout >= minPayoutLamports && payout > 0) {
    b.hourly -= payout
    return { buckets: b, outcome: { kind: 'hourly', payoutLamports: payout }, costDeducted: deducted, apiCharged, refilled }
  }

  return { buckets: b, outcome: { kind: 'below-minimum' }, costDeducted: deducted, apiCharged, refilled }
}

// ---------------------------------------------------------------------------
// Entries commitment
// ---------------------------------------------------------------------------

export type AddressKind = 'wallet' | 'mint'

export interface Entry {
  xUserId: string
  /** A wallet (paid in SOL) or a pump.fun coin mint (the payout buys and burns that coin). */
  address: string
  kind: AddressKind
}

/** Canonical order: X user id ascending (numeric). */
export function canonicalEntries<T extends Entry>(entries: T[]): T[] {
  const seen = new Set<string>()
  for (const e of entries) {
    if (!/^\d+$/.test(e.xUserId)) throw new Error(`bad xUserId ${e.xUserId}`)
    if (seen.has(e.xUserId)) throw new Error(`duplicate entrant ${e.xUserId}`)
    seen.add(e.xUserId)
  }
  return [...entries].sort((a, b) => {
    const x = BigInt(a.xUserId), y = BigInt(b.xUserId)
    return x < y ? -1 : x > y ? 1 : 0
  })
}

/**
 * What the commit hash covers: the draw number and, in canonical order, each entrant's X user id, address kind and
 * address. The kind is in it so a committed list cannot be re-read with a wallet entry as a coin entry or the reverse
 * (the payout path depends on it).
 */
export function commitmentPreimage(drawNumber: number, entries: Entry[]): string {
  const lines = canonicalEntries(entries).map((e) => {
    if (e.kind !== 'wallet' && e.kind !== 'mint') throw new Error(`bad address kind ${e.kind}`)
    return `${e.xUserId}:${e.kind}:${e.address}`
  })
  return [`${PROTOCOL_VERSION}:draw:${drawNumber}`, ...lines].join('\n')
}

export function commitmentHash(drawNumber: number, entries: Entry[]): string {
  return sha256Hex(commitmentPreimage(drawNumber, entries))
}

export function commitMemo(drawNumber: number, entryCount: number, hash: string): string {
  return `${PROTOCOL_VERSION} commit draw=${drawNumber} entries=${entryCount} sha256=${hash}`
}

// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------

/** drand quicknet chain parameters. */
export const QUICKNET = {
  hash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  genesisTime: 1692803367, // seconds
  period: 3, // seconds
}

/** Round whose emission time is <= t. Mirrors drand's roundAt. */
export function roundAt(timeMs: number): number {
  const t = Math.floor(timeMs / 1000)
  if (t < QUICKNET.genesisTime) throw new Error('time before genesis')
  return Math.floor((t - QUICKNET.genesisTime) / QUICKNET.period) + 1
}

export function roundTimeMs(round: number): number {
  return (QUICKNET.genesisTime + (round - 1) * QUICKNET.period) * 1000
}

/** The seed round for a draw: first round emitted at least `delayMs` (the draw's `params.seedDelayMs`) after the commit block time. */
export function seedRound(commitBlockTimeSec: number, delayMs: number = SEED_DELAY_MS): number {
  if (!Number.isInteger(delayMs) || delayMs < 0) throw new Error(`bad seed delay ${delayMs}`)
  const target = commitBlockTimeSec * 1000 + delayMs
  const r = roundAt(target)
  return roundTimeMs(r) >= target ? r : r + 1
}

const TWO_256 = 1n << 256n

/** Unbiased integer in [0, n) derived from the seed, via rejection sampling. */
export function uniform(randomnessHex: string, label: string, n: number): number {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`bad n ${n}`)
  if (!/^[0-9a-f]{64}$/.test(randomnessHex)) throw new Error('randomness must be 32 bytes hex')
  const N = BigInt(n)
  const limit = TWO_256 - (TWO_256 % N)
  for (let counter = 0; ; counter++) {
    const h = BigInt('0x' + sha256Hex(`${PROTOCOL_VERSION}:${randomnessHex}:${label}:${counter}`))
    if (h < limit) return Number(h % N)
  }
}

export function pickWinnerIndex(randomnessHex: string, drawNumber: number, entrantCount: number): number {
  return uniform(randomnessHex, `draw:${drawNumber}:winner`, entrantCount)
}

/**
 * The winner of a draw: the index is into the canonical (X user id ascending) order, whatever
 * order the entries were stored or published in. Engine and verifier both use this.
 */
export function pickWinner<T extends Entry>(randomnessHex: string, drawNumber: number, entries: T[]): { index: number; entry: T } | null {
  const sorted = canonicalEntries(entries)
  if (!sorted.length) return null
  const index = pickWinnerIndex(randomnessHex, drawNumber, sorted.length)
  return { index, entry: sorted[index]! }
}

/** The mega roll: hits with probability 1 / odds. The odds are the draw record's (`params.megaOdds`), default MEGA_ODDS. */
export function isMegaHit(randomnessHex: string, drawNumber: number, odds: number = MEGA_ODDS): boolean {
  if (!Number.isInteger(odds) || odds < 1) throw new Error(`bad mega odds ${odds}`)
  return uniform(randomnessHex, `draw:${drawNumber}:mega`, odds) === 0
}

// ---------------------------------------------------------------------------

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

function assertInt(n: number, name: string) {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative safe integer, got ${n}`)
}

export const LAMPORTS_PER_SOL = 1_000_000_000
export const solToLamports = (sol: number) => Math.floor(sol * LAMPORTS_PER_SOL)
export const lamportsToSol = (l: number) => l / LAMPORTS_PER_SOL
