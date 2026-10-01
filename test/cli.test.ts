// The command's exit codes, against a stub site and a stub Solana RPC on localhost: 3 when the chain cannot be read (not
// a pass), 1 when a check fails, 2 on bad usage. No network.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { commitmentHash } from '../src/lotto'

const root = new URL('..', import.meta.url).pathname
const draw = {
  n: 1, status: 'done', closesAt: '2026-10-01T10:55:00Z', drawAt: '2026-10-01T11:00:00Z', readingSince: '2026-10-01T10:05:00Z',
  hotWallet: 'Auac6nRRV3tToiNoHFJKWtqVzmRrfK8LEdW5qt7kuPFj',
  params: { profile: 'production', roundMinutes: 60, settlementMinutes: 5, megaOdds: 168, seedDelayMs: 60_000 },
  entries: [], commitHash: commitmentHash(1, []), commitSig: '5'.repeat(88), commitBlockTime: null, drandRound: null,
  drandRandomness: null, megaHit: null, winnerIndex: null, winner: null, outcome: { kind: 'rollover' }, payoutSig: null, payout: null,
}

/** The RPC answers every call with a JSON-RPC error (`error`) or with a null result, as for a tx it does not have. */
let rpcMode: 'error' | 'null' = 'error'
const servers: Server[] = []
const listen = (handler: Parameters<typeof createServer>[1]) => new Promise<string>((resolve) => {
  const s = createServer(handler)
  servers.push(s)
  s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`))
})
let site = ''
let rpc = ''

beforeAll(async () => {
  site = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(req.url === '/api/state' ? { hotWallet: draw.hotWallet } : draw))
  })
  rpc = await listen((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const id = (JSON.parse(body) as { id?: unknown }).id ?? null
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(rpcMode === 'error' ? { jsonrpc: '2.0', id, error: { code: -32603, message: 'internal error' } } : { jsonrpc: '2.0', id, result: null }))
    })
  })
})
afterAll(() => { for (const s of servers) s.close() })

const run = (args: string[]) => new Promise<{ code: number | null; out: string }>((resolve) => {
  const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', (d) => (out += d))
  p.stderr.on('data', (d) => (out += d))
  p.on('exit', (code) => resolve({ code, out }))
})

describe('cli', () => {
  it('exits 3 when the RPC will not return the commit tx: could not verify, not a pass', async () => {
    rpcMode = 'error'
    const r = await run(['1', site, rpc])
    expect(r.out).toMatch(/\? could not verify/)
    expect(r.out).not.toMatch(/Draw verified/)
    expect(r.code).toBe(3)
  }, 60_000)
  it('exits 1 when a check fails (the commit tx does not exist)', async () => {
    rpcMode = 'null'
    const r = await run(['1', site, rpc])
    expect(r.out).toMatch(/✗/)
    expect(r.code).toBe(1)
  }, 60_000)
  it('exits 2 without a draw and a site', async () => {
    expect((await run([])).code).toBe(2)
  }, 60_000)
})
