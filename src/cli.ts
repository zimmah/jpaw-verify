// Independently verify one JPAW draw from public data only: the site's published draw record, the Solana
// chain, and drand. No trust in the site's server: every check is re-derived here.
//   npm run verify -- <drawNumber> <siteUrl> [rpcUrl] [hotWallet]
// The hot wallet the record names must be on the pinned list of known hot wallets for the record's profile and cover
// the draw (src/wallets.ts); pass one you know as the fourth argument to pin it further. The site's current wallet is
// reported when it differs.

import { Connection } from '@solana/web3.js'
import { fetchBeacon, quicknetClient } from 'drand-client'
import { verifyDraw, UnverifiableError, VerifyError } from './verify'
import { scrubSecrets } from './redact'

const [nArg, site, rpc = 'https://api.mainnet-beta.solana.com', hotArg] = process.argv.slice(2)
if (!nArg || !site) { console.error('usage: npm run verify -- <draw> <siteUrl> [rpcUrl] [hotWallet]'); process.exit(2) }
const n = Number(nArg)
// The RPC URL can carry a key (in the query, the path or the userinfo): every error is printed without it.
const redact = (text: string) => scrubSecrets(text, [rpc], { keepSignatures: true })

const d = await (await fetch(`${site}/api/draws/${n}`)).json()
// The draw is verified against the hot wallet its own record names (the wallet that signed it). Pass one as the fourth
// argument to pin it: a record naming any other wallet then fails. Without a pin the site's current wallet is only
// reported, so a draw from before a key rotation still verifies.
const hotWallet: string | null = hotArg ?? null
const current: string | null = (await (await fetch(`${site}/api/state`)).json()).hotWallet ?? null
console.log(`Draw #${n}: ${d.entries?.length ?? 0} entries, outcome ${d.outcome?.kind}; hot wallet ${d.hotWallet ?? '(none published)'}, checked against the known hot wallets${hotWallet ? ` and pinned to ${hotWallet}` : ''}`)
if (!hotWallet && d.hotWallet && current && current !== d.hotWallet) console.log(`  note: the site's current hot wallet is ${current}; this draw was signed by an earlier key`)

try {
  const lines = await verifyDraw(d, {
    conn: new Connection(rpc, 'confirmed'),
    getBeacon: (round) => fetchBeacon(quicknetClient(), round), // BLS-verified against the pinned quicknet key
  }, { hotWallet })
  for (const l of lines) console.log(`  ✓ ${l}`)
  console.log('Draw verified.')
} catch (e) {
  if (e instanceof VerifyError) { console.error(`  ✗ ${redact(e.message)}`); process.exit(1) }
  if (e instanceof UnverifiableError) { console.error(`  ? could not verify: ${redact(e.message)} (not a pass; try again or with another RPC)`); process.exit(3) }
  console.error(redact(String((e as any)?.stack ?? e)))
  process.exit(1)
}
