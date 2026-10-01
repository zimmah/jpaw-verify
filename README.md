# jpaw-verify

Re-derive a JPAW hourly draw from public data and check it against what the site published. Nothing here trusts the
site's server: the entrant list is re-hashed, the commit memo is read from Solana, the seed round is derived from the
memo's block time, the drand beacon is fetched and BLS-verified, the winner and mega roll are recomputed, and the
payout transaction is checked against the winner and amount.

## Usage

Needs Node 22 or later and git.

```
git clone https://github.com/zimmah/jpaw-verify.git
cd jpaw-verify
npm install
npm run verify -- <draw> <site> [rpcUrl] [hotWallet]
```

For example `npm run verify -- 42 https://jpaw.fun`.

- `draw`: the draw number.
- `site`: the JPAW site; `/api/draws/<n>` and `/api/state` are read from it.
- `rpcUrl`: a Solana RPC (default `https://api.mainnet-beta.solana.com`). Public endpoints rate-limit the history scan;
  any RPC you trust works. A key in the URL is never printed.
- `hotWallet`: optional. The hot wallet a record names must be on the list of known hot wallets pinned in
  `src/wallets.ts` for the record's profile, with a draw range that covers the draw (production:
  `Auac6nRRV3tToiNoHFJKWtqVzmRrfK8LEdW5qt7kuPFj` from draw 1); any other wallet fails. The site's current wallet is
  printed when it differs (a key rotation after the draw). Pass a wallet you know to pin it further: a record naming
  any other wallet then fails.

### Results

| Exit code | Last line | Meaning |
|---|---|---|
| 0 | `Draw verified.` | every line printed `✓` |
| 1 | `✗ <check>` | the named check failed |
| 2 | `usage: ...` | missing arguments |
| 3 | `? could not verify: ...` | the chain, as the RPC served it, could not be read (a transaction it would not return, or one it cannot decode). Not a pass: try again or with another RPC |

Transactions are read up to version 1 (`MAX_TX_VERSION` in `src/tx.ts`); a newer version is reported as could not
verify, never as a pass. The commitment format is protocol `jpaw:v3` (`PROTOCOL_VERSION` in `src/lotto.ts`).

### Tests

```
npm test            # protocol digests, pinned wallets, exit codes, parity with the JPAW repository
npm run typecheck
```

`PARITY.json` holds the SHA-256 of every file as exported from the JPAW repository and their tree hash; `npm test`
fails if any file was changed, added or removed since. The JPAW repository's own test suite holds the same tree hash,
so the two can be compared with one value.

## What is checked

0. The rules the draw ran under are read from its record (round length, close lead, mega odds, seed delay). A record
   whose profile is `production` must carry the production rules (60-minute rounds, entries close 5 minutes before the
   draw, mega 1 in 168, seed 60 seconds after the commit); any other value fails. A round whose prize never reached the reading threshold before the close (`outcome.kind` `pot-building`) has no
   entrant list, no commit memo, no seed and no mega roll: the verifier checks that the record publishes none of
   those and stops there, since there is nothing on-chain to verify. No memo is expected or looked for.
1. The record's hot wallet is on the pinned list for its profile and its range covers the draw (`src/wallets.ts`: a
   key rotation closes the old wallet's range and adds the new one; the list is never read from the site).
   The published entries hash to the published commit hash (entries sorted by X user id; each line carries the X user
   id, the address kind and the address, so a wallet entry cannot be re-read as a coin entry).
2. That hash is in a Memo instruction of the published commit transaction, paid for and signed by the hot wallet,
   confirmed at or after the time entries closed (HH:55 UTC; the draw itself is at HH:00).
3. Exactly one such commit exists for the draw in the hot wallet's history (each candidate is fetched and checked;
   look-alike memos from strangers do not count). The history is scanned from an hour before the close up to a bound
   that is on-chain and after the commit: the payout transaction (which must follow the commit and the seed), else the
   next draw's commit (`nextCommitSig` on the record, checked to be the hot wallet's own commit memo for a later draw),
   else the wallet's latest transaction. A commit after the bound cannot be the published one, so the scan stays a page
   or two however old the draw is.
4. The seed round is the first drand quicknet round at least 60 seconds after the commit's block time (the delay the
   record stores; a record from before it was stored ran on 30 seconds).
5. The beacon for that round verifies against the pinned quicknet public key and matches the published randomness.
6. The mega roll and the winner index are recomputed with SHA-256 rejection sampling.
7. The payout: a SOL payout credits the winner's wallet by exactly the amount; a coin payout spends at least the amount
   and at most the amount plus the engine's own allowance, invokes only allowlisted programs and at least one swap venue
   (Jupiter, pump.fun or PumpSwap), and burns the published quantity of the winner's mint in the same transaction, with
   the hot wallet signing the burn and the burned tokens covered by what the transaction delivered to it (a transfer plus
   a burn of tokens held from before is refused); a refund needs no transaction.

## Source

`src/lotto.ts` (draw math and randomness), `src/tx.ts` (transaction readers), `src/policy.ts` (signing allowlist and
allowance), `src/verify.ts` (the checks), `src/wallets.ts` (the pinned hot wallets) and `src/redact.ts` (keeps RPC keys
out of the output) are byte-for-byte copies of the JPAW engine's `shared/` directory: the engine, the site's verify
page and this verifier run the same code. `src/cli.ts` is the command.

## License

MIT, see `LICENSE`.
