// Pure readers of confirmed transactions. Shared by the engine and the public verifier, so they
// interpret a transaction the same way. Nothing here touches a database or a network.

import { PublicKey, type VersionedTransactionResponse } from '@solana/web3.js'

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
export const TOKEN_PROGRAMS = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID] as const

/**
 * The newest transaction version every reader asks the RPC for (`maxSupportedTransactionVersion`). Version 1
 * transactions are live on mainnet and the RPC refuses to return one to a client asking for less; the readers below
 * handle legacy, 0 and 1 (a v1 message has only static keys and a transactionConfig). The standalone verifier uses the
 * same value (this file is copied into it).
 */
export const MAX_TX_VERSION = 1

/** Whether a fetched tx is in a version the readers know. Anything else is never interpreted: the caller fails closed. */
export function knownTxVersion(t: Pick<VersionedTransactionResponse, 'version'>): boolean {
  return t.version === undefined || t.version === 'legacy' || t.version === 0 || t.version === 1
}

/**
 * Lamport change of `owner` in a confirmed tx. With `addBackFee` (default) the tx fee is added back
 * when owner was the fee payer, giving the gross amount moved; without it, the wallet's real change.
 */
export function lamportDeltaOf(t: VersionedTransactionResponse, owner: PublicKey, addBackFee = true): number {
  if (!t.meta) throw new Error('tx has no meta')
  const idx = accountIndexOf(t, owner)
  if (idx < 0) return 0
  const delta = t.meta.postBalances[idx]! - t.meta.preBalances[idx]!
  return idx === 0 && addBackFee ? delta + t.meta.fee : delta
}

/** Index of `account` among every key the tx loaded (static and from lookup tables), or -1. */
export function accountIndexOf(t: VersionedTransactionResponse, account: PublicKey): number {
  const keys = t.transaction.message.getAccountKeys({ accountKeysFromLookups: t.meta?.loadedAddresses })
  for (let i = 0; i < keys.length; i++) if (keys.get(i)?.equals(account)) return i
  return -1
}

/** Raw token change of the token account at `address` in a confirmed tx (0 when the tx did not touch it). */
export function tokenDeltaAt(t: VersionedTransactionResponse, address: PublicKey): bigint {
  if (!t.meta) throw new Error('tx has no meta')
  const idx = accountIndexOf(t, address)
  if (idx < 0) return 0n
  const pick = (arr: any[] | null | undefined) => BigInt(arr?.find((b) => b.accountIndex === idx)?.uiTokenAmount.amount ?? '0')
  return pick(t.meta.postTokenBalances) - pick(t.meta.preTokenBalances)
}

/** The fee payer (first static account) of a confirmed tx. */
export function feePayerOf(t: VersionedTransactionResponse): PublicKey {
  return t.transaction.message.staticAccountKeys[0]!
}

/** Raw token amount of `mint` received by `owner` in a confirmed tx. */
export function tokenDeltaOf(t: VersionedTransactionResponse, owner: PublicKey, mint: PublicKey): bigint {
  if (!t.meta) throw new Error('tx has no meta')
  const pick = (arr: any[] | null | undefined) =>
    BigInt(arr?.find((b) => b.owner === owner.toBase58() && b.mint === mint.toBase58())?.uiTokenAmount.amount ?? '0')
  return pick(t.meta.postTokenBalances) - pick(t.meta.preTokenBalances)
}

/**
 * Total raw amount of `mint` burned by top-level Burn / BurnChecked instructions in a confirmed tx
 * (SPL Token or Token-2022). With `authority`, only burns whose owner/delegate account is that key and signed
 * the tx count: what the verifier reads to accept a swap+burn as a coin payout (the hot wallet must be the one
 * burning; a burn by anyone else in the same tx is not the payout).
 */
export function burnedAmountOf(t: VersionedTransactionResponse, mint: PublicKey, authority?: PublicKey): bigint {
  const msg = t.transaction.message
  const keys = msg.getAccountKeys({ accountKeysFromLookups: t.meta?.loadedAddresses })
  let total = 0n
  for (const ix of msg.compiledInstructions) {
    const program = keys.get(ix.programIdIndex)
    if (!program || !TOKEN_PROGRAMS.some((p) => p.equals(program))) continue
    const data = Buffer.from(ix.data)
    // Burn = 8 (account, mint, owner), BurnChecked = 15 (account, mint, owner). Amount is u64 LE at [1..9].
    if ((data[0] !== 8 && data[0] !== 15) || data.length < 9) continue
    const mintKey = keys.get(ix.accountKeyIndexes[1]!)
    if (!mintKey?.equals(mint)) continue
    if (authority) {
      const ownerIdx = ix.accountKeyIndexes[2]
      if (ownerIdx === undefined || !keys.get(ownerIdx)?.equals(authority) || !msg.isAccountSigner(ownerIdx)) continue
    }
    total += data.readBigUInt64LE(1)
  }
  return total
}

/**
 * True if the tx has a top-level memo instruction whose text is exactly `text` (or satisfies it, when a
 * predicate is given) and whose account list includes `signer` as a signer.
 */
export function memoSignedBy(t: VersionedTransactionResponse, text: string | ((memo: string) => boolean), signer: PublicKey): boolean {
  const msg = t.transaction.message
  const keys = msg.getAccountKeys({ accountKeysFromLookups: t.meta?.loadedAddresses })
  const matches = typeof text === 'string' ? (m: string) => m === text : text
  for (const ix of msg.compiledInstructions) {
    if (!keys.get(ix.programIdIndex)?.equals(MEMO_PROGRAM_ID)) continue
    if (!matches(Buffer.from(ix.data).toString('utf8'))) continue
    if (ix.accountKeyIndexes.some((i) => keys.get(i)?.equals(signer) && msg.isAccountSigner(i))) return true
  }
  return false
}

/** Program ids invoked by the tx's top-level instructions. */
export function topLevelPrograms(t: VersionedTransactionResponse): PublicKey[] {
  const keys = t.transaction.message.getAccountKeys({ accountKeysFromLookups: t.meta?.loadedAddresses })
  return t.transaction.message.compiledInstructions.map((ix) => keys.get(ix.programIdIndex)!).filter(Boolean)
}
