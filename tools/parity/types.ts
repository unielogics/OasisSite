import type { Side, Theme } from './config'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue }

export type CheckName = 'dom' | 'style' | 'pixels' | 'vals' | 'console'
export const CHECK_NAMES: readonly CheckName[] = ['dom', 'style', 'pixels', 'vals', 'console']

export type DiffKind =
  | 'text'
  | 'attr'
  | 'element-added'
  | 'element-removed'
  | 'reorder'
  | 'style'
  | 'rect'
  | 'value'
  | 'pixel'
  | 'console'

/** One concrete difference between the original and the port. */
export interface Diff {
  check: CheckName
  kind: DiffKind
  /** Stable locator: DOM path / element key (dom, style), JSON path (vals), "x,y" (pixels). */
  loc: string
  /** Attribute name, style property or message class, when relevant. */
  name?: string
  orig?: string
  port?: string
  /** data-dc-tpl key of the element, when both sides have one. */
  tpl?: string
  /** Set by the allow-list engine when a diff is covered by an entry. */
  allowedBy?: string
}

export interface ElementSnap {
  key: string
  tag: string
  tpl: string | null
  path: string
  rect: [number, number, number, number]
  /** scrollWidth, scrollHeight, clientWidth, clientHeight, scrollLeft, scrollTop */
  scroll: [number, number, number, number, number, number]
  cs: Record<string, string>
  /** ::before / ::after computed style when the pseudo-element generates content */
  pseudo?: Record<string, Record<string, string>>
  /** form control state (the typed value is not part of outerHTML) */
  ctl?: { value: string; checked: boolean }
}

export interface ConsoleMsg {
  type: string
  text: string
}

export interface Snapshot {
  side: Side
  html: string
  elements: ElementSnap[]
  vals: JsonValue
  png: Buffer
  console: ConsoleMsg[]
  /** requests aborted by the network block (anything other than the two local origins) */
  blocked: string[]
  fullStyle: boolean
}

export interface CheckResult {
  check: CheckName
  ok: boolean
  /** number of differences before the allow-list was applied */
  rawDiffs: number
  /** differences left after the allow-list (these fail the run) */
  diffs: number
  allowed: number
  artifacts: string[]
  note?: string
  /** First differences, capped for readability; the full list is in <check>.diff.json */
  sample: Diff[]
}

export interface StepResult {
  step: string
  ok: boolean
  checks: Record<CheckName, CheckResult>
  /** short hashes of the original's #dc-root HTML and screenshot, to prove that scenario actions changed something */
  htmlHash: string
  pngHash: string
}

export interface UnitResult {
  page: string
  scenario: string
  theme: Theme
  ok: boolean
  steps: StepResult[]
  error?: string
  /** allow-list entries that applied to this unit but matched nothing / too much */
  allowlistProblems: string[]
  /** number of distinct (html, screenshot) states the original went through; 1 means the actions did nothing */
  distinctStates: number
  durationMs: number
}
