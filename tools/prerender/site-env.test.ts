// readSnapshot: the deploy kit (site-deploy.sh) passes SITE_HOURS_JSON as a file path; tests and CI pass the JSON itself.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readSnapshot } from './site-env'

describe('readSnapshot', () => {
  it('reads inline JSON and the path of a file holding it', () => {
    expect(readSnapshot(' {"tz":"America/New_York"} ')).toEqual({ tz: 'America/New_York' })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-snap-'))
    const file = path.join(dir, 'hours.json')
    fs.writeFileSync(file, '{"week":[]}')
    expect(readSnapshot(file)).toEqual({ week: [] })
    fs.rmSync(dir, { recursive: true })
  })

  it('names the problem when the value is neither', () => {
    expect(() => readSnapshot('/var/www/site/nope.json')).toThrow(/neither JSON nor an existing file/)
    expect(() => readSnapshot('{"broken"')).toThrow()
  })
})
