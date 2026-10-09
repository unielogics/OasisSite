import { clickBtn, exact, initialScenario, themeScenario } from './common'
import type { Scenario } from './types'

const MARIA = /INV-20601\s*Maria Delgado/
const MARCUS = /INV-20607\s*Marcus Webb/

export const paymentsScenarios: Scenario[] = [
  initialScenario('payments', 'Payments with the 7-day range and the pre-selected invoice'),
  {
    id: 'ranges',
    page: 'payments',
    title: 'the four range buttons',
    tags: ['smoke'],
    steps: [
      clickBtn('range-today', exact('Today')),
      clickBtn('range-30d', exact('30 days')),
      clickBtn('range-mtd', exact('Month to date')),
      clickBtn('range-7d', exact('7 days')),
    ],
  },
  {
    id: 'filters',
    page: 'payments',
    title: 'the five filter chips',
    steps: [
      clickBtn('filter-open-balance', 'Open balance'),
      clickBtn('filter-refunds', 'Refunds'),
      clickBtn('filter-adjusted', 'Adjusted'),
      clickBtn('filter-credits', 'Credits'),
      clickBtn('filter-all', 'All'),
    ],
  },
  {
    id: 'select-invoice',
    page: 'payments',
    title: 'select invoices from the table',
    steps: [
      clickBtn('select-paid', MARIA, 'select INV-20601 (Maria Delgado)'),
      clickBtn('select-open', MARCUS, 'select INV-20607 (Marcus Webb)'),
    ],
  },
  {
    id: 'refund-sheet',
    page: 'payments',
    title: 'open the refund sheet and switch its modes',
    tags: ['smoke'],
    steps: [
      clickBtn('select-invoice', MARIA, 'select a refundable invoice'),
      clickBtn('open-refund', exact('Refund')),
      clickBtn('mode-by-item', exact('By item')),
      clickBtn('mode-custom', exact('Custom')),
      clickBtn('dest-credit', exact('Store credit')),
      clickBtn('cancel', exact('Cancel')),
    ],
  },
  themeScenario('payments'),
]
