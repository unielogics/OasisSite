import type { Actions } from '../drivers'
import type { Theme } from '../config'

export interface ScenarioStep {
  /** unique inside the scenario; becomes the artifact folder name */
  id: string
  title?: string
  /** performed identically on both pages; omit for a pure re-snapshot */
  run?: (a: Actions) => Promise<void>
  /** compare the full computed-style set (default: only the automatic "initial" step does) */
  full?: boolean
  /** do not park the pointer before the snapshot: the step ends in the middle of a drag or swipe */
  keepPointer?: boolean
}

export interface Scenario {
  /** unique per screen, kebab-case */
  id: string
  /** page slug (design/pages.json) */
  page: string
  title: string
  /** URL hash to load with (for example "emergency" on settings) */
  hash?: string
  /** both themes by default */
  themes?: readonly Theme[]
  /**
   * `other`: a theme choice is stored on the device before load, the opposite of the run's device theme (DV-THEME: the
   * stored choice must win; the original is rendered with the stored theme)
   */
  storedTheme?: 'other'
  /** enable touch emulation (hasTouch) on both pages */
  touch?: boolean
  tags?: readonly string[]
  /**
   * The scenario changes server data when it runs against the live API (a drop assigns a bay, a swipe advances a job). The
   * fixture harness ignores it; the live run saves the stack's schema before each run of it and restores it afterwards.
   */
  writes?: boolean
  /** the harness always snapshots an "initial" step first, right after load; these run after it */
  steps: readonly ScenarioStep[]
}
