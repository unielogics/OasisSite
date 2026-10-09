import { refreshHours } from './hours'
import type { HoursLabels } from '../hours/format'

declare const __OASIS_HOURS__: { endpoint: string; timeoutMs: number; labels?: Partial<HoursLabels> }
const root = document.getElementById('dc-root')
if (root) void refreshHours(root, __OASIS_HOURS__)
