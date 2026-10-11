// @vitest-environment jsdom
// The test kit's teardown: a site from an earlier test is disposed after it, so the design's pending timers (the toast's
// 2.6 s flash, the join flow's delayed openBook) can neither update it nor reach `document` once jsdom is gone.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { disposeSites, makeSite } from './bridge.testkit'

afterEach(() => {
  vi.useRealTimers()
})

describe('bridge test kit', () => {
  it('a disposed site ignores the timers the design left behind', () => {
    vi.useFakeTimers()
    const t = makeSite()
    t.c.flash('That time is booked. Try another.')
    expect(t.c.state.toast).toBe('That time is booked. Try another.')
    const updated = vi.spyOn(t.c, 'componentDidUpdate')
    disposeSites()
    vi.advanceTimersByTime(5_000)
    expect(updated).not.toHaveBeenCalled()
    // and a late setState of its own (a fetch answering after the test) is a no-op too
    t.c.setState({ toast: null })
    expect(updated).not.toHaveBeenCalled()
    expect(t.c.state.toast).toBe('That time is booked. Try another.')
  })
})
