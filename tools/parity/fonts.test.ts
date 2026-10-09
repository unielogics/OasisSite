import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FONTCONFIG_FILE, FONTS_DIR } from './config'

const manifest = JSON.parse(fs.readFileSync(path.join(FONTS_DIR, 'MANIFEST.json'), 'utf8')) as {
  files: Record<string, { sha256: string }>
}

describe('vendored parity fonts', () => {
  it('matches the manifest checksums', () => {
    for (const [name, meta] of Object.entries(manifest.files)) {
      const buf = fs.readFileSync(path.join(FONTS_DIR, name))
      expect(crypto.createHash('sha256').update(buf).digest('hex'), name).toBe(meta.sha256)
    }
  })

  it('ships DejaVu Sans, Noto Sans, Noto Sans Symbols/Symbols2 and Noto Emoji', () => {
    const names = Object.keys(manifest.files).join(' ')
    for (const f of [
      'DejaVuSans.ttf',
      'NotoSans-Regular.ttf',
      'NotoSansSymbols-Regular.ttf',
      'NotoSansSymbols2-Regular.ttf',
      'NotoEmoji-Regular.ttf',
    ])
      expect(names).toContain(f)
  })

  it('fonts.conf points at the vendored directory only', () => {
    const conf = fs.readFileSync(FONTCONFIG_FILE, 'utf8')
    expect(conf).toContain('<dir prefix="relative">../fonts</dir>')
    expect(conf).not.toMatch(/<include/)
    expect(conf).not.toContain('/usr/share/fonts')
  })

  it('covers every non-ASCII glyph the designs use (when fontconfig tools are installed)', () => {
    let list: string
    try {
      list = execFileSync(
        'fc-list',
        [':charset=2190 2191 2192 2193 21a9 221e 2264 25c6 25ce 25f3 2605 26a0 2713 2715 2212 b1 2039 203a'],
        {
          env: { ...process.env, FONTCONFIG_FILE },
          encoding: 'utf8',
        },
      )
    } catch {
      return
    }
    expect(list).toContain('DejaVuSans.ttf')
    // nothing outside the vendored directory may be visible to Chromium
    for (const line of list.split('\n').filter(Boolean)) expect(line.startsWith(FONTS_DIR)).toBe(true)
  })
})
