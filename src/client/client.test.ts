// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { refreshHours } from './hours'
import { applyStoredTheme } from './theme'
import alt from '../../tools/parity/fixtures/hours.alt.json'

const cfg = {
  storageKey: 'oasis-theme',
  attribute: 'data-theme',
  default: 'light',
  values: ['light', 'dark'],
}

describe('applyStoredTheme', () => {
  it('patches every default-themed element to the stored theme before hydration, ignoring unknown values', () => {
    document.body.innerHTML =
      '<div id="dc-root"><div data-theme="light"><p data-theme="light"></p><i data-theme="dark"></i></div></div>'
    const root = document.getElementById('dc-root')!
    expect(applyStoredTheme(root, cfg, { getItem: () => 'dark' })).toBe('dark')
    expect(
      Array.from(root.querySelectorAll('[data-theme]')).map((e) => e.getAttribute('data-theme')),
    ).toEqual(['dark', 'dark', 'dark'])
    expect(applyStoredTheme(root, cfg, { getItem: () => 'light' })).toBeNull()
    expect(applyStoredTheme(root, cfg, { getItem: () => 'neon' })).toBeNull()
    expect(applyStoredTheme(root, cfg, null)).toBeNull()
    expect(
      applyStoredTheme(root, cfg, {
        getItem: () => {
          throw new Error('blocked')
        },
      }),
    ).toBeNull()
  })
})

describe('refreshHours', () => {
  const html = '<p data-hours="week.1.range">8:00 AM – 6:00 PM</p><p data-hours="today.status">x</p>'
  const okFetch = (body: unknown, status = 200): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch

  it('re-applies the fetched hours and leaves the baked strings on any failure', async () => {
    document.body.innerHTML = html
    expect(
      await refreshHours(document.body, {
        endpoint: '/api/v1/public/hours',
        timeoutMs: 3000,
        fetchImpl: okFetch(alt),
      }),
    ).toBe(2)
    expect(document.querySelector('[data-hours="week.1.range"]')!.textContent).toBe('7:30 AM – 7:00 PM')
    document.body.innerHTML = html
    expect(
      await refreshHours(document.body, {
        endpoint: '/x',
        timeoutMs: 3000,
        fetchImpl: okFetch({ error: 'x' }, 503),
      }),
    ).toBe(0)
    expect(
      await refreshHours(document.body, {
        endpoint: '/x',
        timeoutMs: 3000,
        fetchImpl: okFetch({ week: [] }),
      }),
    ).toBe(0)
    expect(
      await refreshHours(document.body, {
        endpoint: '/x',
        timeoutMs: 3000,
        fetchImpl: (async () => {
          throw new TypeError('network')
        }) as unknown as typeof fetch,
      }),
    ).toBe(0)
    expect(document.querySelector('[data-hours="week.1.range"]')!.textContent).toBe('8:00 AM – 6:00 PM')
    document.body.innerHTML = '<p>no hours region</p>'
    const spy = vi.fn()
    expect(
      await refreshHours(document.body, {
        endpoint: '/x',
        timeoutMs: 3000,
        fetchImpl: spy as unknown as typeof fetch,
      }),
    ).toBe(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it('aborts after the timeout', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = html
    const slow: typeof fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as unknown as typeof fetch
    const p = refreshHours(document.body, { endpoint: '/x', timeoutMs: 3000, fetchImpl: slow })
    await vi.advanceTimersByTimeAsync(3001)
    expect(await p).toBe(0)
    vi.useRealTimers()
  })
})
