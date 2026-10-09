import type { ReactElement } from 'react'
import type { DCLogic } from './DCLogic'

/** What the host hands to a compiled render function next to the vals (used for warning labels). */
export interface DCRenderCtx {
  name: string
}

export type DCRender = (vals: Record<string, any>, ctx: DCRenderCtx) => ReactElement // eslint-disable-line @typescript-eslint/no-explicit-any

export interface PageMeta {
  /** pages.json slug (also the output file stem) */
  readonly slug: string
  /** clean route, "/" for the index */
  readonly route: string
  /** The name the dc runtime gave the root component (`data-sc-name`). */
  readonly name: string
  readonly variant: 'prod' | 'parity'
  /** Number of elements in the template, i.e. the highest `data-dc-tpl` + 1. */
  readonly tplCount: number
}

export type DCLogicCtor = new (props?: Record<string, unknown>) => DCLogic
