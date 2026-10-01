// What a standalone verifier must carry: the protocol and its pinned digests, the transaction version it reads, the
// pinned hot wallets, and the unverifiable result (never a pass). Runs in the exported repository and in the JPAW
// repository alike, with no network.
import { describe, expect, it } from 'vitest'
import type { Connection } from '@solana/web3.js'
import { commitmentHash, PROTOCOL_VERSION } from '../src/lotto'
import { MAX_TX_VERSION } from '../src/tx'
import { KNOWN_HOT_WALLETS, knownHotWallet } from '../src/wallets'
import { verifyDraw, UnverifiableError, VerifyError, type PublicDrawRecord } from '../src/verify'

const PRODUCTION_HOT_WALLET = 'Auac6nRRV3tToiNoHFJKWtqVzmRrfK8LEdW5qt7kuPFj'
const TEST_HOT_WALLET = 'Cvwkth7b8fEYmnKanDaaXE8q1kALzRC61pzSPVSpmjXM'
const PRODUCTION = { profile: 'production', minPayoutUsd: 5, readingThresholdUsd: 5, minEntrantsOnBudgetStop: 10, operatorBps: 1000, roundMinutes: 60, settlementMinutes: 5, megaOdds: 168, seedDelayMs: 60_000 }

const record = (over: Partial<PublicDrawRecord> = {}): PublicDrawRecord => ({
  n: 1, closesAt: '2026-10-01T10:55:00Z', drawAt: '2026-10-01T11:00:00Z', readingSince: '2026-10-01T10:05:00Z',
  hotWallet: PRODUCTION_HOT_WALLET, params: PRODUCTION, entries: [], commitHash: commitmentHash(1, []), commitSig: '5'.repeat(88),
  commitBlockTime: null, drandRound: null, drandRandomness: null, megaHit: null, winnerIndex: null, winner: null,
  outcome: { kind: 'rollover' }, payoutSig: null, payout: null, ...over,
})
const noBeacon = async () => { throw new Error('drand must not be consulted') }
/** A connection whose every call fails the way an RPC error does. */
const failingConn = new Proxy({}, { get: () => async () => { throw new Error('rpc refused') } }) as unknown as Connection

describe('protocol', () => {
  it('is jpaw:v3 with the pinned commitment digests', () => {
    expect(PROTOCOL_VERSION).toBe('jpaw:v3')
    expect(commitmentHash(7, [{ xUserId: '1', address: 'W', kind: 'wallet' }])).toBe('05e2fc5f3195ed8d86486ad643bb49563325b8b1785063c0464fed0adf98023a')
    expect(commitmentHash(1, [{ xUserId: '10', address: 'W1', kind: 'wallet' }, { xUserId: '9', address: 'W2', kind: 'mint' }])).toBe('19f59c2408c3aaad6ad828f9855239135742836791698b3a2b9b354043c8da05')
  })
  it('reads transactions up to version 1', () => {
    expect(MAX_TX_VERSION).toBe(1)
  })
})

describe('pinned hot wallets', () => {
  it('production and test each pin their wallet from draw 1', () => {
    expect(KNOWN_HOT_WALLETS.production).toEqual([{ address: PRODUCTION_HOT_WALLET, fromDraw: 1, toDraw: null }])
    expect(KNOWN_HOT_WALLETS.test).toEqual([{ address: TEST_HOT_WALLET, fromDraw: 1, toDraw: null }])
    expect(knownHotWallet('production', 1, PRODUCTION_HOT_WALLET).ok).toBe(true)
    expect(knownHotWallet('production', 1, TEST_HOT_WALLET).ok).toBe(false)
  })
  it('a committed draw signed by any other wallet fails before the chain is read', async () => {
    await expect(verifyDraw(record({ hotWallet: TEST_HOT_WALLET }), { conn: failingConn, getBeacon: noBeacon }))
      .rejects.toThrow(VerifyError)
  })
})

describe('results', () => {
  it('a transaction the RPC will not return is unverifiable, never a pass', async () => {
    await expect(verifyDraw(record(), { conn: failingConn, getBeacon: noBeacon })).rejects.toThrow(UnverifiableError)
  })
  it('a pot-building round is decided from the record alone', async () => {
    const lines = await verifyDraw(record({ readingSince: null, commitHash: null, commitSig: null, outcome: { kind: 'pot-building' } }), { conn: failingConn, getBeacon: noBeacon })
    expect(lines.join('\n')).toMatch(/nothing to verify on-chain/)
  })
})
