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

/**
 * True in parity builds. The guards below repeat the `process.env.OASIS_PARITY === '1'` test literally instead of
 * reading this constant: esbuild substitutes the define and folds the branch away, but does not propagate an
 * imported constant, so only the literal form keeps the hook out of the production bundle (a test checks it).
 */
export const PARITY = process.env.OASIS_PARITY === '1'

let resolveReady: () => void = () => {}
let currentVals: (() => Record<string, unknown>) | null = null
let currentPage: string | null = null

function installHook(): void {
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

function doRegister(page: string, vals: () => Record<string, unknown>): void {
  currentPage = page
  currentVals = vals
}

function doMark(root: HTMLElement | null): void {
  root?.setAttribute('data-oasis-ready', '1')
  resolveReady()
}

if (process.env.OASIS_PARITY === '1' && typeof window !== 'undefined' && !window.__oasisParity) installHook()

export function registerParityHost(page: string, vals: () => Record<string, unknown>): void {
  if (process.env.OASIS_PARITY === '1') doRegister(page, vals)
}

export function markParityReady(root: HTMLElement | null): void {
  if (process.env.OASIS_PARITY === '1') doMark(root)
}
