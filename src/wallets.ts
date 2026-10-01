// The hot wallets a draw record may name, per profile, each with the range of draws it signed. The verifier (the
// site's verify route and page, the CLI, the standalone verifier) checks every committed draw against this list and
// never trusts the wallet a record names on its own. A key rotation closes the current range and appends the new
// wallet. No imports, so the standalone verifier copies this file byte for byte (npm run verifier:sync).

export interface KnownHotWallet {
  address: string
  /** The first draw this wallet signed. */
  fromDraw: number
  /** The last draw it signed, or null while it is the current wallet. */
  toDraw: number | null
}

export type KnownHotWallets = Readonly<Record<string, readonly KnownHotWallet[]>>

export const KNOWN_HOT_WALLETS: KnownHotWallets = {
  production: [
    { address: 'Auac6nRRV3tToiNoHFJKWtqVzmRrfK8LEdW5qt7kuPFj', fromDraw: 1, toDraw: null },
  ],
  test: [
    { address: 'Cvwkth7b8fEYmnKanDaaXE8q1kALzRC61pzSPVSpmjXM', fromDraw: 1, toDraw: null },
  ],
}

const range = (w: KnownHotWallet) => `draws ${w.fromDraw}${w.toDraw === null ? ' on' : `-${w.toDraw}`}`

/**
 * Whether `wallet` may have signed draw `n` of `profile`: the list entry that covers it, or why not (a profile with
 * no known wallets, a wallet not on the list, or a draw outside the wallet's range).
 */
export function knownHotWallet(profile: string, n: number, wallet: string, list: KnownHotWallets = KNOWN_HOT_WALLETS):
  { ok: true; wallet: KnownHotWallet; line: string } | { ok: false; reason: string } {
  const known = list[profile] ?? []
  if (!known.length) return { ok: false, reason: `no known hot wallets for the ${profile} profile` }
  const mine = known.filter((w) => w.address === wallet)
  if (!mine.length) return { ok: false, reason: `hot wallet ${wallet} is not a known ${profile} hot wallet` }
  const covering = mine.find((w) => n >= w.fromDraw && (w.toDraw === null || n <= w.toDraw))
  if (!covering) return { ok: false, reason: `hot wallet ${wallet} is a known ${profile} hot wallet for ${mine.map(range).join(', ')}, not draw ${n}` }
  return { ok: true, wallet: covering, line: `hot wallet ${wallet} is a known ${profile} hot wallet for ${range(covering)}` }
}
