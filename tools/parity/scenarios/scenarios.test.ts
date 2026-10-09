import { describe, expect, it } from 'vitest'
import { SLUGS } from '../config'
import { ALL_SCENARIOS, selectScenarios, themesOf, validateScenarios } from './index'
import type { Scenario } from './types'

describe('scenario catalogue', () => {
  it('is valid: unique ids per page and kebab-case step ids', () => {
    expect(() => validateScenarios(ALL_SCENARIOS)).not.toThrow()
  })

  it('covers every page of design/pages.json with at least the initial scenario', () => {
    for (const page of SLUGS) expect(selectScenarios({ page }).map((s) => s.id)).toContain('initial')
  })

  it('has the dashboard-fixture scenarios when those pages are configured', () => {
    const ids = (page: string) => selectScenarios({ page }).map((s) => s.id)
    const steps = (page: string, id: string) =>
      selectScenarios({ page, scenario: id })[0]!.steps.map((s) => s.id)
    if (SLUGS.includes('settings')) {
      expect(ids('settings')).toEqual(['initial', 'sections', 'theme-toggle', 'emergency-deeplink'])
      expect(steps('settings', 'sections')).toHaveLength(8)
    }
    if (SLUGS.includes('payments')) {
      expect(ids('payments')).toContain('theme-toggle')
      expect(steps('payments', 'ranges')).toHaveLength(4)
      expect(steps('payments', 'filters')).toHaveLength(5)
      expect(steps('payments', 'refund-sheet')).toContain('open-refund')
    }
    if (SLUGS.includes('operations')) {
      expect(steps('operations', 'view-tabs')).toHaveLength(4)
      expect(steps('operations', 'appointment-file')).toHaveLength(9)
    }
  })

  it('runs every scenario in both themes unless it narrows them', () => {
    expect(themesOf(ALL_SCENARIOS[0]!)).toEqual(['light', 'dark'])
    expect(themesOf(ALL_SCENARIOS[0]!, 'dark')).toEqual(['dark'])
    expect(themesOf({ ...ALL_SCENARIOS[0]!, themes: ['light'] }, 'dark')).toEqual([])
  })

  it('rejects duplicates, unknown pages and malformed ids', () => {
    const s: Scenario = { id: 'x', page: SLUGS[0]!, title: 't', steps: [] }
    expect(() => validateScenarios([s, s])).toThrow(/duplicate scenario/)
    expect(() => validateScenarios([{ ...s, id: 'Bad_Id' }])).toThrow(/kebab-case/)
    expect(() => validateScenarios([{ ...s, page: 'nope' }])).toThrow(/unknown page/)
    expect(() => validateScenarios([{ ...s, steps: [{ id: 'initial' }] }])).toThrow(/duplicate step id/)
  })
})
