// parity:fonts - vendors the deterministic fallback fonts used by the parity harness into parity/fonts/ and records
// their sha256 in parity/fonts/MANIFEST.json. The designs only bundle Manrope and Bricolage Grotesque (Latin subsets);
// glyphs such as warning, star, arrows, minus and check fall back to system fonts, so both renders must resolve the
// same fallback fonts regardless of the host. Run with --check to verify the vendored copy without touching it.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dest = path.join(root, 'parity', 'fonts')
const SOURCES = [
  '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/google-noto/NotoSans-Regular.ttf',
  '/usr/share/fonts/google-noto/NotoSans-Bold.ttf',
  '/usr/share/fonts/google-noto/NotoSansSymbols-Regular.ttf',
  '/usr/share/fonts/google-noto/NotoSansSymbols-Bold.ttf',
  '/usr/share/fonts/google-noto/NotoSansSymbols2-Regular.ttf',
  '/usr/share/fonts/google-noto-emoji/NotoEmoji-Regular.ttf',
]
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const manifestPath = path.join(dest, 'MANIFEST.json')

if (process.argv.includes('--check')) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  let bad = 0
  for (const [name, meta] of Object.entries(manifest.files)) {
    const file = path.join(dest, name)
    if (!fs.existsSync(file) || sha(fs.readFileSync(file)) !== meta.sha256) {
      console.error(`MISMATCH ${name}`)
      bad++
    }
  }
  if (bad) process.exit(1)
  console.log(`parity:fonts OK (${Object.keys(manifest.files).length} fonts)`)
  process.exit(0)
}

fs.mkdirSync(dest, { recursive: true })
const files = {}
for (const src of SOURCES) {
  if (!fs.existsSync(src)) {
    console.error(
      `missing system font ${src} (dnf install dejavu-sans-fonts google-noto-sans-fonts google-noto-sans-symbols-fonts google-noto-sans-symbols2-fonts google-noto-emoji-fonts)`,
    )
    process.exit(1)
  }
  const buf = fs.readFileSync(src)
  const name = path.basename(src)
  fs.writeFileSync(path.join(dest, name), buf)
  files[name] = { sha256: sha(buf), bytes: buf.length, source: src }
}
fs.writeFileSync(manifestPath, JSON.stringify({ files }, null, 2) + '\n')
console.log(`parity:fonts vendored ${SOURCES.length} fonts into ${path.relative(root, dest)}`)
