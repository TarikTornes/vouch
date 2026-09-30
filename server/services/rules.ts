// Deterministic keyword interpreter used when no LLM is connected.
// Narrow on purpose: anything it cannot map is reported as unsupported, never guessed.
import type { Condition, Intent } from '../../shared/types'
import type { Interpretation } from './llm'

const CONDITION_PATTERNS: [Condition, RegExp][] = [
  ['saturday', /\bsaturdays?\b|\bzaterdag|\bsamedi|\bdissabte/i],
  ['sunday', /\bsundays?\b|\bzondag|\bdimanche|\bdiumenge/i],
  ['public_holiday', /public holiday|bank holiday|\bholiday work|feestdag|jour f[ée]ri[ée]|festiu/i],
  ['night', /\bnight|\bnacht|\bnuit\b|\bnit\b/i],
]
const WEEKEND = /\bweekends?\b|\bweekend-/i
const SURCHARGE = /surcharge|premium|toeslag|suppl[ée]ment|\brate\b|percent|%|extra pay|pay extra|paid extra|how much|uplift|allowance for (overtime|weekend)|recàrrec/i
const ELIGIBILITY = /count(s|ed)? as overtime|qualif(y|ies)|considered (as )?overtime|is it overtime|are .* overtime|treated as overtime/i
const OVERTIME = /overtime|over-time|overwerk|heures? sup|hores extra|extra hours/i

export function interpretByRules(question: string): Interpretation {
  const conditions = CONDITION_PATTERNS.filter(([, re]) => re.test(question)).map(([c]) => c)
  if (WEEKEND.test(question)) for (const c of ['saturday', 'sunday'] as Condition[]) if (!conditions.includes(c)) conditions.push(c)
  const wantsSurcharge = SURCHARGE.test(question)
  const wantsEligibility = ELIGIBILITY.test(question)
  const mentionsOvertime = OVERTIME.test(question)
  const requests: Intent[] = []
  for (const condition of conditions) {
    if (wantsEligibility || (mentionsOvertime && !wantsSurcharge)) requests.push({ topic: 'overtime_eligibility', condition })
    if (wantsSurcharge) requests.push({ topic: 'overtime_surcharge', condition })
  }
  const inDomain = requests.length > 0
  return {
    in_domain: inDomain,
    requests,
    requested_information: inDomain
      ? requests.map((r) => `${r.condition.replace('_', ' ')} ${r.topic === 'overtime_surcharge' ? 'overtime surcharge' : 'overtime eligibility'}`).join(', ')
      : 'No supported topic recognised',
    out_of_domain_reason: inDomain ? null : conditions.length
      ? 'The keyword rules found a day or period but not an overtime surcharge or eligibility question.'
      : 'The keyword rules did not recognise an overtime question about Saturday, Sunday, public holidays or night work.',
    mentioned_client: null,
    mentioned_country: null,
  }
}
