import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { runIntake } from './unpack'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const tmpDir = path.join(root, '.tmp-snippets')

/** The three dashboard bundles unpacked once per test run into .tmp-snippets/fixtures-extracted (shared by the test files). */
export function fixtureExtracted(): { extractedDir: string; pagesFile: string } {
  const extractedDir = path.join(tmpDir, 'fixtures-extracted')
  const stamp = path.join(extractedDir, '.stamp')
  const key = ['operations', 'payments', 'settings']
    .map((s) =>
      crypto
        .createHash('sha1')
        .update(fs.readFileSync(path.join(root, 'design/fixtures', `${s}.bundle.html`)))
        .digest('hex'),
    )
    .join('|')
  if (!fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== key) {
    runIntake({ root, pagesFile: 'design/fixtures/pages.json', outDir: extractedDir, log: () => {} })
    fs.writeFileSync(stamp, key)
  }
  return { extractedDir, pagesFile: 'design/fixtures/pages.json' }
}
