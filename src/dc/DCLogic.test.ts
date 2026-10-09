import { describe, expect, it, vi } from 'vitest'
import { DCLogic } from './DCLogic'
import type { DCHostLike } from './DCLogic'

/** A host that behaves like DCHost.__setLogicState: patch now, re-render later. */
function fakeHost(logic: DCLogic) {
  const renders: unknown[] = []
  const cbs: (() => void)[] = []
  const host: DCHostLike = {
    __setLogicState(update, cb) {
      const prev = logic.state
      const patch = typeof update === 'function' ? update(prev) : update
      logic.state = { ...prev, ...patch }
      renders.push(logic.state)
      if (cb) cbs.push(cb)
    },
    forceUpdate() {
      renders.push('force')
    },
  }
  logic.__host = host
  return { renders, cbs }
}

class Counter extends DCLogic<{ n: number; log: string[] }> {
  state = { n: 0, log: [] as string[] }
  bump() {
    this.setState({ n: this.state.n + 1 })
    this.setState({ n: this.state.n + 1 })
    return this.state.n
  }
}

describe('DCLogic.setState', () => {
  it('applies the patch to this.state synchronously, so the next line reads the new state', () => {
    const c = new Counter()
    const h = fakeHost(c)
    expect(c.bump()).toBe(2)
    expect(c.state.n).toBe(2)
    expect(h.renders).toHaveLength(2)
  })

  it('merges patches into a new object and supports functional updaters seeing the latest state', () => {
    const c = new Counter()
    fakeHost(c)
    const before = c.state
    c.setState((p) => ({ log: [...p.log, 'a'] }))
    c.setState((p) => ({ log: [...p.log, 'b'], n: p.n + 5 }))
    expect(c.state).not.toBe(before)
    expect(before).toEqual({ n: 0, log: [] })
    expect(c.state).toEqual({ n: 5, log: ['a', 'b'] })
  })

  it('hands the callback to the host (it fires after the commit, not here)', () => {
    const c = new Counter()
    const h = fakeHost(c)
    const cb = vi.fn()
    c.setState({ n: 1 }, cb)
    expect(cb).not.toHaveBeenCalled()
    expect(h.cbs).toEqual([cb])
  })

  it('is a complete no-op until a host is attached, like the runtime (state is not touched either)', () => {
    const c = new Counter()
    c.setState({ n: 9 })
    c.forceUpdate()
    expect(c.state.n).toBe(0)
    expect(c.__host).toBeUndefined()
  })

  it('forceUpdate goes to the host', () => {
    const c = new Counter()
    const h = fakeHost(c)
    c.forceUpdate()
    expect(h.renders).toEqual(['force'])
  })
})

describe('DCLogic construction', () => {
  it('stores props (defaulting to {}) and starts with empty state and no host', () => {
    expect(new DCLogic().props).toEqual({})
    expect(new DCLogic({ a: 1 }).props).toEqual({ a: 1 })
    expect(new DCLogic().state).toEqual({})
    expect(new DCLogic().renderVals()).toEqual({})
  })

  it('runs subclass field initialisers after the base constructor, in source order, seeing props and earlier fields', () => {
    const order: string[] = []
    class Sub extends DCLogic<{ total: number }> {
      SERVICES = (order.push('SERVICES'), { a: 2, b: 3 })
      ghost = (order.push('ghost'), this.props.seed as number)
      state = (() => {
        order.push('state')
        return { total: Object.values(this.SERVICES).reduce((x, y) => x + y, 0) + this.ghost }
      })()
    }
    const s = new Sub({ seed: 10 })
    expect(order).toEqual(['SERVICES', 'ghost', 'state'])
    expect(s.state.total).toBe(15)
    expect(s.__host).toBeUndefined()
  })

  it('a subclass that redeclares fields with `declare` keeps the base-initialised values', () => {
    class Sub extends DCLogic<{ x: number }> {
      declare props: { y: number }
      declare state: { x: number }
      constructor(p: { y: number }) {
        super(p as never)
        this.state = { x: this.props.y * 2 }
      }
    }
    expect(new Sub({ y: 4 }).state.x).toBe(8)
    expect(new Sub({ y: 4 }).props.y).toBe(4)
  })

  it('exposes the same class as StreamableLogic', async () => {
    const mod = await import('./DCLogic')
    expect(mod.StreamableLogic).toBe(mod.DCLogic)
  })
})
