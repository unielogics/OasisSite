import { serializeVals } from './serialize'

export interface OasisParity {
  /** Serialised result of the live logic's renderVals() merged over the host props (see serialize.ts). */
  getVals(): unknown
  /** Resolves once the page is mounted (same moment `#dc-root` gets data-oasis-ready="1"). */
  ready: Promise<void>
  page: string | null
}

declare global {
  interface Window {
    __oasisParity?: OasisParity
  }
}

/** True in parity builds (esbuild defines the literal, so production code drops the branch). */
export const PARITY = process.env.OASIS_PARITY === '1'

let resolveReady: () => void = () => {}
let currentVals: (() => Record<string, unknown>) | null = null
let currentPage: string | null = null

if (PARITY && typeof window !== 'undefined' && !window.__oasisParity) {
  const ready = new Promise<void>((r) => {
    resolveReady = r
  })
  window.__oasisParity = {
    ready,
    get page() {
      return currentPage
    },
    getVals() {
      if (!currentVals) throw new Error('__oasisParity.getVals(): no page mounted yet')
      return serializeVals(currentVals())
    },
  }
}

export function registerParityHost(page: string, vals: () => Record<string, unknown>): void {
  if (!PARITY) return
  currentPage = page
  currentVals = vals
}

export function markParityReady(root: HTMLElement | null): void {
  if (!PARITY) return
  root?.setAttribute('data-oasis-ready', '1')
  resolveReady()
}
