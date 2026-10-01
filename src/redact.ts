// The one redaction function for every output: logs, alerts, the doctor, stored errors, the site's verify route and
// the scripts. Import-free (copied into the standalone verifier). Value-based first: every configured secret, and for
// a secret that is a URL (an RPC endpoint, the Mongo URI) its parts, because a provider can put its key anywhere in the
// URL (Helius in the query, Alchemy and QuickNode in the path, others in the userinfo). Pattern rules second.

/**
 * The env vars that hold an RPC or other keyed endpoint URL (HEALTHCHECK_URL: the ping URL is its own key). SOLANA_RPC_FALLBACK_URLS is a
 * comma-separated list.
 */
export const RPC_URL_VARS = ['SOLANA_RPC_URL', 'SOLANA_RPC_FALLBACK_URLS', 'FORK_DATASOURCE_RPC_URL', 'JITO_BLOCK_ENGINE_URL', 'HEALTHCHECK_URL'] as const
/** The env vars that hold a secret value as a whole. */
export const SECRET_VARS = [
  'HOT_WALLET_SECRET', 'MONGODB_URI', 'BACKUP_MONGODB_URI', 'X_BEARER_TOKEN', 'X_APP_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET',
  'TELEGRAM_BOT_TOKEN', 'PINATA_JWT', 'JUPITER_API_KEY', 'PYTH_API_KEY', 'BACKUP_S3_SECRET_KEY', 'BACKUP_S3_ACCESS_KEY',
] as const

/** Every configured RPC (and keyed endpoint) URL, the fallback list split. */
export function rpcUrlsFromEnv(env: Record<string, string | undefined>): string[] {
  return RPC_URL_VARS.flatMap((k) => (env[k] ?? '').split(',').map((u) => u.trim()).filter(Boolean))
}

/** Every secret in the environment: the secret vars and every RPC URL. The input of scrubSecrets. */
export function secretsFromEnv(env: Record<string, string | undefined>): string[] {
  return [...SECRET_VARS.map((k) => env[k] ?? '').filter(Boolean), ...rpcUrlsFromEnv(env)]
}

/**
 * How a configured URL is described in output: scheme and host, nothing else (no userinfo, path, query or fragment),
 * e.g. https://eth-mainnet.g.alchemy.com. Works for non-web schemes too (mongodb+srv://cluster0.abc.mongodb.net).
 */
export function urlOrigin(url: string): string {
  try { const u = new URL(url); return u.host ? `${u.protocol}//${u.host}` : '[unparseable url]' } catch { return '[unparseable url]' }
}

/** A secret part shorter than this is not replaced on its own (it would mangle ordinary words); in a URL it still is. */
const MIN_PART = 8
const RPC_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:'])
/** A path segment that is only an API version marker (v1, v2, v1.1): not a secret. */
const VERSION = /^v\d+(\.\d+)*$/i
/** A URL inside free text. Trailing punctuation is trimmed off a match. */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`()[\]{}]+/gi
const SWAP: Record<string, string> = { 'http:': 'ws:', 'https:': 'wss:', 'ws:': 'http:', 'wss:': 'https:' }

const decode = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }
const variants = (s: string) => [...new Set([s, decode(s), encodeURIComponent(decode(s))])]

interface Expanded { whole: Map<string, string>; parts: Set<string>; hosts: Set<string> }

/** One secret into what must not survive: the whole value (and, for a URL, its spellings and secret parts). */
function expand(secrets: readonly string[]): Expanded {
  const whole = new Map<string, string>(), parts = new Set<string>(), hosts = new Set<string>()
  for (const s of secrets) {
    if (!s || s.length < MIN_PART) continue
    let u: URL | null = null
    try { u = new URL(s) } catch { /* not a URL: the value as a whole */ }
    if (!u || !u.host) { whole.set(s, '[redacted]'); continue }
    const label = RPC_SCHEMES.has(u.protocol) ? '[rpc]' : '[redacted]'
    hosts.add(u.hostname.toLowerCase())
    const bare = `${u.host}${u.pathname}`
    const spellings = [s, s.replace(/\/+$/, ''), `${u.protocol}//${bare}${u.search}`, `${u.protocol}//${bare}`]
    // web3.js derives the websocket URL from the http one (and back): the same key under the other scheme.
    if (SWAP[u.protocol]) spellings.push(`${SWAP[u.protocol]}//${bare}${u.search}`, `${SWAP[u.protocol]}//${bare}`)
    for (const sp of spellings) for (const v of variants(sp)) if (v.replace(/\/+$/, '') !== `${u.protocol}//${u.host}`) whole.set(v, label)
    for (const seg of u.pathname.split('/')) if (seg && !VERSION.test(seg)) for (const v of variants(seg)) parts.add(v)
    for (const v of u.searchParams.values()) for (const x of variants(v)) parts.add(x)
    for (const raw of u.search.slice(1).split('&')) { const v = raw.split('=').slice(1).join('='); if (v) parts.add(v) }
    if (u.hash.length > 1) parts.add(u.hash.slice(1))
    for (const v of [u.username, u.password]) if (v) for (const x of variants(v)) parts.add(x)
  }
  return { whole, parts, hosts }
}

const replaceAll = (text: string, from: string, to: string) => text.split(from).join(to)

/** A URL on a secret's host, rewritten so only its origin is left; an origin alone is left as is (a display line). */
function scrubUrl(match: string, hosts: Set<string>): string {
  const trail = /[.,;:!?]+$/.exec(match)?.[0] ?? ''
  const raw = trail ? match.slice(0, -trail.length) : match
  let u: URL
  try { u = new URL(raw) } catch { return match }
  if (!u.host || !hosts.has(u.hostname.toLowerCase())) return match
  const path = u.pathname && u.pathname !== '/' ? '/[redacted]' : ''
  const query = u.search ? '?[redacted]' : ''
  const hash = u.hash ? '#[redacted]' : ''
  return `${u.protocol}//${u.host}${path}${query}${hash}${trail}`
}

/**
 * Redact secrets from any text that can reach an output. Layer 1, value-based: each given secret as a whole (an RPC
 * URL becomes [rpc], anything else [redacted]); for a secret that is a URL, also its http/ws spellings, every URL in
 * the text on its host (rewritten to the origin), and on their own every path segment that is not a version marker,
 * every query value, the fragment and the userinfo ([redacted]). Layer 2, patterns: Telegram bot tokens, `api-key=` and
 * `api_key=` values, URL userinfo of any scheme, and base58 strings long enough to be a secret key (64 bytes, 86+
 * characters; a public key is 32-44). `keepSignatures`: skip that last rule, for a log whose tx signatures (the same
 * shape) must stay readable; the configured secret keys are still replaced by value.
 */
export function scrubSecrets(text: string, secrets: readonly string[] = [], opts: { keepSignatures?: boolean } = {}): string {
  let out = text
  const { whole, parts, hosts } = expand(secrets)
  for (const [v, label] of [...whole].sort((a, b) => b[0].length - a[0].length)) out = replaceAll(out, v, label)
  if (hosts.size) out = out.replace(URL_IN_TEXT, (m) => scrubUrl(m, hosts))
  for (const p of [...parts].filter((p) => p.length >= MIN_PART).sort((a, b) => b.length - a.length)) out = replaceAll(out, p, '[redacted]')
  out = out.replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '[redacted-token]')
  out = out.replace(/(api[-_]?key=)[^&\s)"']+/gi, '$1[redacted]')
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>]+@/gi, '$1[redacted]@')
  if (!opts.keepSignatures) out = out.replace(/[1-9A-HJ-NP-Za-km-z]{86,90}/g, '[redacted-key]')
  return out
}
