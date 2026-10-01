// The exported repository carries PARITY.json, written by the JPAW repository's export (npm run verifier:export): the
// tree hash and every file's SHA-256 as exported. A file changed, added or removed here after the export fails this
// test. Inside the JPAW repository there is no PARITY.json and the test is skipped (the JPAW side checks parity there).
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileHashes, treeHash } from './tree-hash'

const root = new URL('..', import.meta.url).pathname
const manifestPath = `${root}PARITY.json`
const exported = existsSync(manifestPath)

describe.skipIf(!exported)('parity with the JPAW repository', () => {
  const manifest = exported ? JSON.parse(readFileSync(manifestPath, 'utf8')) as { treeHash: string; files: Record<string, string> } : null
  it('every file is exactly as exported', () => {
    expect(fileHashes(root)).toEqual(manifest!.files)
  })
  it('the tree hash matches the manifest', () => {
    expect(treeHash(fileHashes(root))).toBe(manifest!.treeHash)
  })
})
