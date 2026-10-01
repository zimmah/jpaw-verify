// The parity hash of the verifier: one SHA-256 over every published file (path and content), so the exported repository
// and the JPAW repository's verifier/ folder can be compared with one value. No dependencies.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** Not part of the hash: the manifest itself, install and build output, git, and the lockfile npm install writes. */
export const UNHASHED = new Set(['PARITY.json', 'package-lock.json', 'node_modules', 'dist', '.git'])

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

/** Every hashed file under `root`, as a POSIX path relative to it, sorted. */
export function treeFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (UNHASHED.has(name)) continue
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(relative(root, p).split(sep).join('/'))
    }
  }
  walk(root)
  return out.sort()
}

/** Per-file SHA-256 of every hashed file under `root`. */
export function fileHashes(root: string): Record<string, string> {
  return Object.fromEntries(treeFiles(root).map((f) => [f, sha256(readFileSync(join(root, f)))]))
}

/** The tree hash: SHA-256 over `<path> <sha256>\n` for every hashed file, sorted by path. */
export function treeHash(files: Record<string, string>): string {
  return sha256(Object.keys(files).sort().map((f) => `${f} ${files[f]}\n`).join(''))
}
