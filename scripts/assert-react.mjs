// assert:react — the visual-parity pin. Fails when
//   * more than one copy of react or react-dom is installed (pnpm store layout: node_modules/.pnpm/react@*),
//   * the installed copies are not exactly 18.3.1, or a canary/rc/experimental build is installed,
//   * with --dist <dir>: a built client bundle under <dir>/assets carries a React canary marker, or a page that the
//     build manifest marks as hydrated has no bundle carrying the 18.3.1 version string.
// Usage: node scripts/assert-react.mjs [--dist dist]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WANT = '18.3.1'
const problems = []

const pnpmDir = path.join(root, 'node_modules', '.pnpm')
const direct = (name) => path.join(root, 'node_modules', name, 'package.json')

function installedCopies(name) {
  const dirs = new Set()
  if (fs.existsSync(pnpmDir)) {
    for (const d of fs.readdirSync(pnpmDir)) {
      if (d === name || d.startsWith(name + '@')) {
        const pkg = path.join(pnpmDir, d, 'node_modules', name, 'package.json')
        if (fs.existsSync(pkg)) dirs.add(fs.realpathSync(path.dirname(pkg)))
      }
    }
  }
  if (fs.existsSync(direct(name))) dirs.add(fs.realpathSync(path.dirname(direct(name))))
  return [...dirs]
}

for (const name of ['react', 'react-dom']) {
  const copies = installedCopies(name)
  if (copies.length === 0) problems.push(`${name} is not installed`)
  if (copies.length > 1)
    problems.push(`${copies.length} copies of ${name} installed:\n    ${copies.join('\n    ')}`)
  for (const dir of copies) {
    const v = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version
    if (v !== WANT) problems.push(`${name} is ${v}, expected exactly ${WANT} (${dir})`)
    if (/canary|experimental|rc|beta|alpha|nightly/i.test(v))
      problems.push(`${name} ${v} is a pre-release build`)
  }
}

const distArg = process.argv.indexOf('--dist')
if (distArg > 0) {
  const dist = path.resolve(root, process.argv[distArg + 1] ?? 'dist')
  const assets = path.join(dist, 'assets')
  const manifestFile = path.join(dist, 'manifest.json')
  if (!fs.existsSync(assets) || !fs.existsSync(manifestFile)) {
    problems.push(`${path.relative(root, dist)} has no assets/ or manifest.json (build first)`)
  } else {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    const hydrated = (manifest.pages ?? []).filter((p) => p.hydrated)
    const canary = /\b\d+\.\d+\.\d+-(canary|rc|experimental|beta)-[0-9a-f]{6,}/
    let sawVersion = false
    for (const f of fs.readdirSync(assets).filter((n) => n.endsWith('.js'))) {
      const text = fs.readFileSync(path.join(assets, f), 'utf8')
      const m = text.match(canary)
      if (m) problems.push(`React canary marker "${m[0]}" in assets/${f}`)
      if (text.includes(`"${WANT}"`)) sawVersion = true
    }
    if (hydrated.length && !sawVersion)
      problems.push(
        `${hydrated.length} hydrated page(s) but no bundle under assets/ carries the React ${WANT} version string`,
      )
  }
}

if (problems.length) {
  console.error('assert:react FAILED\n  - ' + problems.join('\n  - '))
  process.exit(1)
}
console.log(`assert:react OK (single react/react-dom ${WANT}${distArg > 0 ? ', dist clean' : ''})`)
