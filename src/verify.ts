// Independent verification of one JPAW draw from public data only:
// the published draw record, the Solana chain, and a drand beacon source.
// Used by scripts/verify.ts (CLI) and by the fork test harness.

import { PublicKey, type Connection, type VersionedTransactionResponse } from '@solana/web3.js'
import { commitmentHash, commitMemo, seedRound, roundTimeMs, pickWinner, isMegaHit, PROTOCOL_VERSION, MEGA_ODDS, ROUND_MINUTES, SETTLEMENT_MINUTES, SEED_DELAY_MS, LEGACY_SEED_DELAY_MS, type Entry } from './lotto'
import { burnedAmountOf, feePayerOf, knownTxVersion, lamportDeltaOf, memoSignedBy, MAX_TX_VERSION, tokenDeltaOf, topLevelPrograms } from './tx'
import { isAllowedProgram, isVenueProgram, maxSwapOverspend } from './policy'
import { KNOWN_HOT_WALLETS, knownHotWallet, type KnownHotWallets } from './wallets'

/** The subset of the public draw record the verifier reads. Matches server/lib/public.ts publicDraw(). */
/** The configurable rules the draw ran under, as published with it. The verifier never reads the site's current config. */
export interface PublicDrawParams {
  profile: string
  minPayoutUsd: number
  readingThresholdUsd: number
  minEntrantsOnBudgetStop: number
  operatorBps: number
  /** Round length in minutes. Absent on records from before it was stored: 60. */
  roundMinutes?: number
  /** Entries close this many minutes before the draw. Absent on early records: 5. */
  settlementMinutes?: number
  /** The mega roll hits 1 in this many draws. Absent on early records: 168. */
  megaOdds?: number
  /** The seed is the first drand round emitted this long after the commit's block time. Absent on early records: 30 s. */
  seedDelayMs?: number
}

export interface PublicDrawRecord {
  n: number
  /** The draw's state machine status as published (posting, open, collected, committed, seeded, settled, paid, done). Only read to explain an uncommitted draw. */
  status?: string | null
  /** The rules in force when this draw opened. Absent on records from before the field existed (production defaults). */
  params?: PublicDrawParams | null
  /** When entries closed (HH:55 UTC with the production timing). The commit must be at or after this. */
  closesAt: string | Date
  /** When the winner was drawn (closesAt + the record's settlement minutes; HH:00 UTC in production). */
  drawAt?: string | Date | null
  /** When reading started (the prize reached the threshold). Null on a pot-building round. */
  readingSince?: string | Date | null
  /** The wallet that signs the commit and pays the winner. */
  hotWallet: string | null
  entries: (Entry & { username?: string })[] | null
  commitHash: string | null
  commitSig: string | null
  commitBlockTime: number | null
  drandRound: number | null
  drandRandomness: string | null
  megaHit: boolean | null
  winnerIndex: number | null
  winner: { address: string; kind: string } | null
  outcome: { kind: string; payoutLamports?: number } | null
  payoutSig: string | null
  /**
   * The commit signature of the next draw that committed (published by the site with the record): the bound of the
   * single-commit scan for a draw without a payout. Checked on-chain before use; absent, the scan starts at the
   * wallet's latest transaction.
   */
  nextCommitSig?: string | null
  /**
   * A burn publishes what the payout tx burned and, on records that carry it, what it bought (`bought`, checked
   * against the tx when present). A refund names the coin (`mint`) whose buy failed or the wallet (`to`) whose
   * transfer failed.
   */
  payout: { kind: 'sol' } | { kind: 'burn'; mint: string; burned: string; bought?: string } | { kind: 'refund'; reason: string; mint?: string; to?: string } | null
}

export interface VerifyDeps {
  conn: Connection
  /** Authentic beacon for a round. The CLI uses drand-client (BLS verified); tests inject their fake. */
  getBeacon(round: number): Promise<{ randomness: string } | null>
  /** Pause between retries of a commit-scan candidate the RPC returned nothing for. Default a real timer. */
  sleep?(ms: number): Promise<void>
}

/** The draw is wrong: a check failed. */
export class VerifyError extends Error {}

/**
 * The draw could not be verified from the chain as served: a transaction the RPC would not return or the verifier
 * cannot read (an unknown version, a decode failure, a commit-scan candidate that stays missing). Never a pass; not a
 * verdict that the draw is wrong either.
 */
export class UnverifiableError extends Error {}

/** Retries of a commit-scan candidate the RPC returned null for, within one run, before the draw is unverifiable. */
export const CANDIDATE_RETRIES = 3
const CANDIDATE_RETRY_MS = 1_500

/**
 * getTransaction at MAX_TX_VERSION. An RPC error (it refused the version, the node failed) or a response the SDK
 * cannot decode, and a tx in a version the readers do not know, make the draw unverifiable; null is returned as null.
 */
async function readTx(conn: Connection, sig: string): Promise<VersionedTransactionResponse | null> {
  let t: VersionedTransactionResponse | null
  try {
    t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: MAX_TX_VERSION })
  } catch (e: any) {
    throw new UnverifiableError(`tx ${sig} could not be read from the RPC (${String(e?.message ?? e).split('\n')[0]!.slice(0, 200)})`)
  }
  if (t && !knownTxVersion(t)) throw new UnverifiableError(`tx ${sig} is a version ${String(t.version)} transaction, which this verifier cannot read`)
  return t
}

/**
 * A round whose prize never reached the reading threshold before the close: no entrant list, no commit memo, no seed,
 * no mega roll, everything rolled over. There is nothing on-chain to check; the record must publish none of it.
 */
export function potBuildingChecks(d: PublicDrawRecord): string[] {
  const fail = (m: string): never => { throw new VerifyError(m) }
  if (d.outcome?.kind !== 'pot-building') fail('not a pot-building round')
  if (d.entries?.length) fail('a pot-building round must publish no entries')
  if (d.commitSig || d.commitHash) fail('a pot-building round must publish no commit: a memo here would mean entries were read after all')
  if (d.drandRound || d.drandRandomness) fail('a pot-building round must publish no seed')
  if (d.megaHit !== null && d.megaHit !== undefined) fail('a pot-building round has no mega roll')
  if (d.winner || d.winnerIndex !== null && d.winnerIndex !== undefined || d.payoutSig || d.payout) fail('a pot-building round pays nobody')
  const threshold = d.params?.readingThresholdUsd
  return [
    `no draw this round: the prize (20% of the hourly pot) was under the reading threshold${threshold != null ? ` ($${threshold})` : ''} when entries closed, so replies were never read`,
    'nothing to verify on-chain: no entrant list, no commit memo, no drand seed, no mega roll; the pot rolled over in full',
  ]
}

/**
 * The round timing, the mega odds and the seed delay a draw ran under, from its record. A record without them (from
 * before they were stored) ran on the values of the time: hourly rounds closing 5 minutes before the draw, mega 1 in
 * 168, and a seed 30 seconds after the commit (raised to 60 when the delay started being stored).
 */
export function timingOf(d: PublicDrawRecord): { roundMinutes: number; settlementMinutes: number; megaOdds: number; seedDelayMs: number } {
  return {
    roundMinutes: d.params?.roundMinutes ?? ROUND_MINUTES,
    settlementMinutes: d.params?.settlementMinutes ?? SETTLEMENT_MINUTES,
    megaOdds: d.params?.megaOdds ?? MEGA_ODDS,
    seedDelayMs: d.params?.seedDelayMs ?? LEGACY_SEED_DELAY_MS,
  }
}

/**
 * The rules every production draw runs on. They are configuration in the engine, so a record could publish any
 * self-consistent values; the verifier holds a record that says `profile: production` to these, whatever it publishes.
 * The test profile (short rounds, frequent mega hits) runs on the values its records carry.
 */
export const PRODUCTION_RULES = { roundMinutes: ROUND_MINUTES, settlementMinutes: SETTLEMENT_MINUTES, megaOdds: MEGA_ODDS, seedDelayMs: SEED_DELAY_MS } as const

/** The rule a production record publishes that is not the production rule, or null when they all match. */
export function productionMismatch(d: PublicDrawRecord): string | null {
  if (d.params?.profile !== 'production') return null
  const t = timingOf(d)
  for (const [k, want] of Object.entries(PRODUCTION_RULES) as [keyof typeof PRODUCTION_RULES, number][]) {
    if (t[k] !== want) return `${k} ${t[k]} (the production rule is ${want})`
  }
  return null
}

/** One line describing the rules a draw ran under, from its record. */
export function describeParams(d: PublicDrawRecord): string {
  const p = d.params
  const t = timingOf(d)
  const timing = `${t.roundMinutes}-minute rounds, entries close ${t.settlementMinutes} min before the draw, mega 1 in ${t.megaOdds}, seed ${t.seedDelayMs / 1000} s after the commit`
  if (!p) return `rules: not published with this draw (production defaults: ${timing})`
  return `rules (${p.profile} profile): minimum payout $${p.minPayoutUsd}, reading threshold $${p.readingThresholdUsd}, at least ${p.minEntrantsOnBudgetStop} entrants on a budget stop, operator cut ${p.operatorBps / 100}%, ${timing}`
}

/** The draw time must be the close plus the record's own settlement window: the timing the draw published is the one it ran on. */
export function timingChecks(d: PublicDrawRecord): string[] {
  const t = timingOf(d)
  if (!Number.isInteger(t.roundMinutes) || t.roundMinutes < 2) throw new VerifyError(`bad round length ${t.roundMinutes}`)
  if (!Number.isInteger(t.settlementMinutes) || t.settlementMinutes < 1 || t.settlementMinutes >= t.roundMinutes) throw new VerifyError(`bad settlement window ${t.settlementMinutes}`)
  if (!Number.isInteger(t.megaOdds) || t.megaOdds < 2) throw new VerifyError(`bad mega odds ${t.megaOdds}`)
  if (!Number.isInteger(t.seedDelayMs) || t.seedDelayMs < 1_000) throw new VerifyError(`bad seed delay ${t.seedDelayMs} ms`)
  const ok: string[] = []
  const mismatch = productionMismatch(d)
  if (mismatch) throw new VerifyError(`a production draw cannot run on ${mismatch}`)
  if (d.params?.profile === 'production') ok.push(`production rules pinned: ${PRODUCTION_RULES.roundMinutes}-minute rounds, entries close ${PRODUCTION_RULES.settlementMinutes} min before the draw, mega 1 in ${PRODUCTION_RULES.megaOdds}, seed ${PRODUCTION_RULES.seedDelayMs / 1000} s after the commit`)
  if (d.drawAt == null) return ok
  const expected = new Date(d.closesAt).getTime() + t.settlementMinutes * 60_000
  if (new Date(d.drawAt).getTime() !== expected) throw new VerifyError(`draw time ${new Date(d.drawAt).toISOString()} is not the close plus ${t.settlementMinutes} min (${new Date(expected).toISOString()})`)
  ok.push(`drawn ${t.settlementMinutes} min after the close (${new Date(expected).toISOString()})`)
  return ok
}

export interface VerifyOptions {
  /**
   * A hot wallet to pin (the coin's creator, an earlier draw, the operator's announcement): a draw record naming a
   * different wallet then fails. Without it the draw is checked against the wallet its own record names, the one
   * that signed it, so a draw from before a key rotation verifies on the site and in the CLI alike.
   */
  hotWallet?: string | null
  /**
   * The known hot wallets per profile (shared/wallets.ts). Only tests replace it (their wallets are generated);
   * never set by the CLI or the site.
   */
  knownHotWallets?: KnownHotWallets
  /**
   * Skip the "committed at or after entries closed" check. Only for the mainnet-fork tests, whose draws run on a
   * simulated clock while the fork's block times are wall-clock. Never set by the CLI or the site.
   */
  simulatedClock?: boolean
}

/** Commits are scanned in the hot wallet's history back to this long before the draw closed. */
export const COMMIT_SCAN_MARGIN_S = 3_600

/** The memo text of a commit for draw `n` up to the entry count. */
const commitMarker = (n: number) => `${PROTOCOL_VERSION} commit draw=${n} entries=`

/** The draw number a commit memo names, or null when the text is not a commit memo. */
export function commitMemoDraw(memo: string): number | null {
  const prefix = `${PROTOCOL_VERSION} commit draw=`
  if (!memo.startsWith(prefix)) return null
  const m = /^(\d+) entries=/.exec(memo.slice(prefix.length))
  return m ? Number(m[1]) : null
}

/**
 * Re-derive every step of a draw and compare with what was published.
 * Returns one line per passed check. Throws VerifyError on the first mismatch.
 */
export async function verifyDraw(d: PublicDrawRecord, deps: VerifyDeps, opts: VerifyOptions = {}): Promise<string[]> {
  const ok: string[] = []
  const fail = (m: string): never => { throw new VerifyError(m) }
  const n = d.n
  const entries = d.entries ?? []
  if (d.outcome?.kind === 'pot-building') return [describeParams(d), ...timingChecks(d), ...potBuildingChecks(d)]
  ok.push(describeParams(d), ...timingChecks(d))
  // A draw that has not committed yet has nothing on-chain: say where it stands instead of failing on the hash.
  if (!d.commitSig) {
    if (d.status === 'posting') fail('not committed yet: the draw post is going out')
    if (d.status === 'open' && !d.readingSince) fail('not committed yet: the pot is still building, replies are read once the prize reaches the threshold')
    if (d.status === 'open' || d.status === 'collected') fail('draw not committed yet')
    fail('no commit signature published')
  }
  if (!d.hotWallet) fail('no hot wallet published')
  // The wallet the record names must be on the pinned list for the record's profile and cover this draw.
  const known = knownHotWallet(d.params?.profile ?? 'production', n, d.hotWallet!, opts.knownHotWallets ?? KNOWN_HOT_WALLETS)
  if (!known.ok) fail(known.reason)
  if (opts.hotWallet && d.hotWallet !== opts.hotWallet) fail(`draw record names hot wallet ${d.hotWallet}, expected ${opts.hotWallet}`)
  if (known.ok) ok.push(known.line)
  const hot = new PublicKey(d.hotWallet!)
  const closesAtSec = Math.floor(new Date(d.closesAt).getTime() / 1000)
  const getTx = (sig: string) => readTx(deps.conn, sig)

  // 1. Commitment matches the published entry list.
  const hash = commitmentHash(n, entries)
  if (hash !== d.commitHash) fail(`commit hash mismatch: computed ${hash}, published ${d.commitHash}`)
  ok.push(`entry list hashes to ${hash}`)

  // 2. That hash is in an on-chain memo, paid for and signed by the hot wallet, and gives us the block time.
  const tx = await getTx(d.commitSig!)
  if (!tx) fail(`commit tx ${d.commitSig} not found`)
  if (tx!.meta?.err) fail(`commit tx ${d.commitSig} failed on-chain`)
  if (!feePayerOf(tx!).equals(hot)) fail(`commit tx ${d.commitSig} was not paid by the hot wallet`)
  const memo = commitMemo(n, entries.length, hash)
  if (!memoSignedBy(tx!, memo, hot)) fail('commit memo not found in the tx, or not signed by the hot wallet')
  ok.push(`memo on-chain in ${d.commitSig}, signed by ${hot.toBase58()}`)
  const blockTime = tx!.blockTime
  if (!blockTime) fail('commit tx has no block time')
  if (blockTime !== d.commitBlockTime) fail(`block time mismatch ${blockTime} vs ${d.commitBlockTime}`)
  if (!opts.simulatedClock) {
    if (blockTime! < closesAtSec) fail(`commit at ${blockTime} is before entries closed at ${closesAtSec}: the list was locked early`)
    ok.push(`committed after entries closed (${new Date(closesAtSec * 1000).toISOString()})`)
  }

  // 3. Exactly one commit memo for this draw signed and paid by the hot wallet: no grinding of commits. The scan
  //    covers the wallet's history from an hour before the close up to a bound that is itself on-chain and after the
  //    commit: the payout tx (the result acted on), else the next draw's commit (the result was announced by then),
  //    else the wallet's latest tx. A commit after the bound cannot be the published one (the published commit must
  //    be found inside the window), so it cannot have produced this draw's seed.
  const pays = d.outcome && (d.outcome.kind === 'hourly' || d.outcome.kind === 'mega')
  let payoutTx: VersionedTransactionResponse | null = null
  if (d.payoutSig) {
    if (!pays || !d.winner || !d.outcome?.payoutLamports) fail('payout signature published without a winner/amount')
    payoutTx = await getTx(d.payoutSig)
    if (!payoutTx || payoutTx.meta?.err) fail(`payout tx ${d.payoutSig} not found or failed`)
    if (!feePayerOf(payoutTx!).equals(hot)) fail(`payout tx ${d.payoutSig} was not paid by the hot wallet`)
    if (!payoutTx!.blockTime) fail('payout tx has no block time')
    if (payoutTx!.blockTime! < blockTime!) fail(`payout tx at ${payoutTx!.blockTime} is before the commit at ${blockTime}`)
  }
  let bound: { sig: string; from: string } | null = null
  if (payoutTx) bound = { sig: d.payoutSig!, from: 'the payout tx' }
  else if (d.nextCommitSig) {
    const next = await getTx(d.nextCommitSig)
    if (!next || next.meta?.err) fail(`next commit tx ${d.nextCommitSig} not found or failed`)
    if (!feePayerOf(next!).equals(hot)) fail(`next commit tx ${d.nextCommitSig} was not paid by the hot wallet`)
    const named = { draw: null as number | null }
    if (!memoSignedBy(next!, (memo) => { named.draw = commitMemoDraw(memo); return named.draw !== null }, hot)) fail(`next commit tx ${d.nextCommitSig} carries no commit memo signed by the hot wallet`)
    if (named.draw! <= n) fail(`next commit tx ${d.nextCommitSig} commits draw ${named.draw}, not a later draw than ${n}`)
    if (!next!.blockTime || next!.blockTime < blockTime!) fail(`next commit tx ${d.nextCommitSig} is not after this draw's commit`)
    bound = { sig: d.nextCommitSig, from: `draw ${named.draw}'s commit` }
  }
  const commits = await commitSignatures(deps.conn, hot, n, closesAtSec - COMMIT_SCAN_MARGIN_S, bound?.sig, deps.sleep)
  if (commits.length !== 1 || commits[0] !== d.commitSig) fail(`expected exactly one commit memo for draw ${n} from the hot wallet, found ${commits.length}: ${commits.join(', ')}`)
  ok.push(`single commit for this draw in the hot wallet history (scanned from ${bound ? bound.from : 'the wallet\'s latest tx'} back to an hour before the close)`)

  // 4. Seed round is determined by the commit time and the record's delay, and was not out before the commit.
  const delayMs = timingOf(d).seedDelayMs
  const round = seedRound(blockTime!, delayMs)
  if (round !== d.drandRound) fail(`seed round should be ${round}, published ${d.drandRound}`)
  ok.push(`seed round ${round} (first drand quicknet round >= ${delayMs / 1000}s after commit)`)
  if (payoutTx && !opts.simulatedClock) {
    // The payout cannot precede the seed it depends on.
    const emitted = Math.floor(roundTimeMs(round) / 1000)
    if (payoutTx.blockTime! < emitted) fail(`payout tx at ${payoutTx.blockTime} is before the seed round was emitted at ${emitted}`)
  }

  // 5. Beacon is authentic and matches.
  const beacon = await deps.getBeacon(round)
  if (!beacon) fail(`beacon for round ${round} unavailable`)
  if (beacon!.randomness !== d.drandRandomness) fail('randomness mismatch')
  ok.push('drand randomness verified')

  // 6. Winner (index into the canonical order) and mega roll, at the odds the record published.
  const odds = timingOf(d).megaOdds
  const mega = isMegaHit(beacon!.randomness, n, odds)
  if (mega !== d.megaHit) fail(`mega roll mismatch: computed ${mega} at 1 in ${odds}`)
  ok.push(`mega roll (1 in ${odds}): ${mega ? 'HIT' : 'miss'}`)
  const w = pickWinner(beacon!.randomness, n, entries)
  if (w) {
    if (w.index !== d.winnerIndex) fail(`winner index should be ${w.index}, published ${d.winnerIndex}`)
    ok.push(`winner index ${w.index}: ${w.entry.username ? `@${w.entry.username} ` : ''}(${w.entry.kind} ${w.entry.address})`)
    if (d.winner && d.winner.address !== w.entry.address) fail(`published winner ${d.winner.address} is not entry ${w.index}`)
  }

  // 7. Payout: SOL to the wallet, or a buy+burn of the coin, for the published amount, from the hot wallet (fetched
  //    and checked for payer and timing in step 3).
  if (payoutTx) {
    const p: VersionedTransactionResponse | null = payoutTx
    const amount = d.outcome!.payoutLamports!
    if (d.winner!.kind === 'mint') {
      const pub = d.payout?.kind === 'burn' ? d.payout : null
      if (!pub || pub.mint !== d.winner!.address) fail('coin winner but the payout record is not a burn of that coin')
      const spent = -lamportDeltaOf(p!, hot, true)
      if (spent < amount) fail(`payout tx spent ${spent} lamports, less than the ${amount} payout`)
      if (spent > amount + maxSwapOverspend(amount)) fail(`payout tx spent ${spent} lamports, more than the ${amount} payout plus the ${maxSwapOverspend(amount)} allowance`)
      const programs = topLevelPrograms(p!)
      const outside = programs.filter((k) => !isAllowedProgram(k))
      if (outside.length) fail(`payout tx invokes programs outside the signing allowlist: ${outside.map((k) => k.toBase58()).join(', ')}`)
      // A buy happens on a venue: the router or pump's own programs. A transfer plus a burn is not a payout.
      if (!programs.some(isVenueProgram)) fail('payout tx invokes no swap venue (Jupiter, pump.fun or PumpSwap): no coin was bought in it')
      const mint = new PublicKey(d.winner!.address)
      // Only burns the hot wallet itself signed for count, and only tokens the tx delivered to the hot wallet may be
      // burned: bought = the wallet's balance change plus what it burned; a burn of tokens held from before is refused.
      const burned = burnedAmountOf(p!, mint, hot)
      if (burned <= 0n) fail('payout tx burns none of the winning coin with the hot wallet as the burn authority')
      const bought = tokenDeltaOf(p!, hot, mint) + burned
      if (bought < burned) fail(`payout tx acquired ${bought} of the coin, fewer than the ${burned} it burned: tokens held from before were burned`)
      if (burned.toString() !== pub!.burned) fail(`payout tx burned ${burned}, published ${pub!.burned}`)
      if (pub!.bought != null && bought.toString() !== pub!.bought) fail(`payout tx bought ${bought}, published ${pub!.bought}`)
      ok.push(`spent ${spent / 1e9} SOL buying ${bought} of ${d.winner!.address} on a swap venue and burned ${burned} of it in ${d.payoutSig}`)
    } else {
      const keys = p!.transaction.message.getAccountKeys({ accountKeysFromLookups: p!.meta?.loadedAddresses })
        .staticAccountKeys.map((k) => k.toBase58())
      const i = keys.indexOf(d.winner!.address)
      if (i < 0) fail('payout tx does not touch winner wallet')
      const got = p!.meta!.postBalances[i]! - p!.meta!.preBalances[i]!
      if (got !== amount) fail(`payout ${got} lamports, expected ${amount}`)
      ok.push(`paid ${got / 1e9} SOL in ${d.payoutSig}`)
    }
  } else if (pays) {
    if (d.payout?.kind === 'refund') ok.push(`${d.payout.mint ? 'coin buy' : 'SOL transfer'} could not execute (${d.payout.reason}); payout returned to the ${d.outcome!.kind} pot`)
    else fail(`outcome ${d.outcome!.kind} but no payout signature published`)
  }
  return ok
}

/**
 * Signatures of the wallet's transactions since `sinceBlockTime` (and before `beforeSig`, when given: a tx of the
 * wallet's that is known to be after the draw's commit) that are commits for draw `n`: paid by the wallet, with a
 * top-level memo it signed whose text is a commit for that draw. The signature list's memo field is only a
 * prefilter; anyone can reference the wallet in a tx with a look-alike memo, so each candidate is fetched and
 * checked. With a bound the scan costs a page or two whatever the wallet has done since.
 */
export async function commitSignatures(conn: Connection, wallet: PublicKey, n: number, sinceBlockTime: number, beforeSig?: string, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<string[]> {
  const marker = commitMarker(n)
  const candidates: string[] = []
  let before: string | undefined = beforeSig
  for (let page = 0; page < 200; page++) {
    const sigs = await conn.getSignaturesForAddress(wallet, { limit: 1000, before }, 'confirmed')
    if (!sigs.length) break
    for (const s of sigs) {
      if (s.err) continue
      if (s.memo?.includes(marker)) candidates.push(s.signature)
    }
    const oldest = sigs[sigs.length - 1]!
    if ((oldest.blockTime ?? 0) < sinceBlockTime || sigs.length < 1000) break
    before = oldest.signature
  }
  const found: string[] = []
  for (const sig of candidates) {
    // A candidate is never skipped unread: it could be a second commit. Missing is retried a few times (the RPC may
    // lag); still missing, or unreadable, and the draw is unverifiable.
    let t = await readTx(conn, sig)
    for (let i = 0; !t && i < CANDIDATE_RETRIES; i++) { await sleep(CANDIDATE_RETRY_MS * (i + 1)); t = await readTx(conn, sig) }
    if (!t) throw new UnverifiableError(`commit-scan candidate ${sig} (a tx of the hot wallet with a commit memo for draw ${n}) was not returned by the RPC after ${CANDIDATE_RETRIES} retries`)
    if (t.meta?.err) continue
    if (!feePayerOf(t).equals(wallet)) continue
    if (memoSignedBy(t, (m) => m.startsWith(marker), wallet)) found.push(sig)
  }
  return found
}
