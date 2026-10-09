// design:verify — design/ is the immutable reference (original bundles, loose files, fixtures and the intake output).
// Fails if any file differs from design/CHECKSUMS.sha256 or is missing, or if a file exists that is not listed.
// design:checksums (--write) regenerates the list; review the diff before committing it.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const designDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'design')
const listFile = path.join(designDir, 'CHECKSUMS.sha256')
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

function listFiles(dir, prefix = '') {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), rel))
    else if (rel !== 'CHECKSUMS.sha256') out.push(rel)
  }
  return out
}

if (process.argv.includes('--write')) {
  const lines = listFiles(designDir).map((rel) => `${sha(path.join(designDir, rel))}  ${rel}`)
  fs.writeFileSync(listFile, lines.join('\n') + '\n')
  console.log(`design:checksums wrote ${lines.length} entries`)
  process.exit(0)
}

if (!fs.existsSync(listFile)) {
  console.error('design:verify FAILED: design/CHECKSUMS.sha256 is missing (run pnpm design:checksums)')
  process.exit(1)
}
const bad = []
const listed = new Set()
for (const line of fs.readFileSync(listFile, 'utf8').split('\n').filter(Boolean)) {
  const m = /^([0-9a-f]{64})\s+(.+)$/.exec(line)
  if (!m) {
    bad.push(`malformed line: ${line}`)
    continue
  }
  const [, sum, rel] = m
  listed.add(rel)
  const file = path.join(designDir, rel)
  const actual = fs.existsSync(file) ? sha(file) : 'MISSING'
  if (actual !== sum) bad.push(`${rel}: expected ${sum}, got ${actual}`)
}
for (const rel of listFiles(designDir)) if (!listed.has(rel)) bad.push(`${rel}: not in CHECKSUMS.sha256`)
if (bad.length) {
  console.error('design:verify FAILED\n' + bad.join('\n'))
  process.exit(1)
}
console.log(`design:verify OK (${listed.size} files)`)
