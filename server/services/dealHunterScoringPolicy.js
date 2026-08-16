// Scoring policy for Deal Hunter opportunity scoring and operator triage.
//
// Phase 3A decomposes the existing `deal-hunter-fit-v2` scorer into explainable
// dimensions. It deliberately does not change the arithmetic: every rule below
// describes a branch that already existed, and `fitScore` is the number the v2
// scorer already produced. A future scoring philosophy change must ship under a
// new rules version, never under `deal-hunter-fit-v2`.

export const DEAL_SCORING_ENGINE_VERSION = 'deal-scoring-engine-v1';
// v2.1 corrects semantic matching only: negated positives no longer score,
// favorable qualifiers no longer draw risk penalties. No weight, threshold,
// gate, band or arithmetic changed. A result produced under v2 and one produced
// under v2.1 are distinguishable in storage, which is why the version moves.
export const DEAL_SCORING_RULES_VERSION = 'deal-hunter-fit-v2.1';
export const DEAL_SCORING_RULES_VERSION_PREVIOUS = 'deal-hunter-fit-v2';
export const DEAL_SCORING_PROFILE_VERSION = 'deal-hunter-profile-v1';
export const DEAL_COMPLETENESS_POLICY_VERSION = 'deal-hunter-completeness-v1';

// The one absent-evidence rule, stated once and enforced by tests.
//
// Absent evidence never changes a dimension's point contribution. It may cap the
// achievable score, which bounds upside without asserting a negative, and it
// always lowers completeness and confidence. Only explicitly observed negative
// evidence deducts points. A listing that says nothing about recurring revenue
// and a listing that says revenue is non-recurring therefore score differently:
// the first is capped and low confidence, the second is capped and deducted.
export const DEAL_SCORING_ABSENT_EVIDENCE_RULE =
  'Absent evidence never deducts points. It may cap the achievable score and always lowers '
  + 'completeness and confidence. Only observed negative evidence deducts points.';

export const dealScoreEvidenceClasses = Object.freeze([
  'observed',
  'calculated',
  'heuristic',
  // Reserved for Phase 3B. Phase 3A never produces evidence in this class.
  'inferred',
  'missing',
  'contradicted',
]);

export const dealScoreDimensions = Object.freeze([
  {
    id: 'financial-fit',
    label: 'Financial fit',
    summary: 'Annual profit against the target band, purchase multiple, asking price, and financing support.',
  },
  {
    id: 'revenue-durability',
    label: 'Revenue durability',
    summary: 'Recurring, contracted, or repeat revenue and commercial customer mix.',
  },
  {
    id: 'demand-resilience',
    label: 'Demand resilience',
    summary: 'Recession resistance and resistance to automation of the operating work.',
  },
  {
    id: 'transferability',
    label: 'Transferability',
    summary: 'Management depth versus owner dependence.',
  },
  {
    id: 'operating-profile',
    label: 'Operating profile',
    summary: 'Capital intensity and asset burden.',
  },
  {
    id: 'concentration-quality-risk',
    label: 'Concentration and quality risk',
    summary: 'Customer concentration and financial-quality risk language.',
  },
  {
    id: 'strategic-geographic-fit',
    label: 'Strategic and geographic fit',
    summary: 'Search-theme match, business age, target geography, and category exclusions.',
  },
]);

export const dealScoreDimensionIds = Object.freeze(dealScoreDimensions.map((dimension) => dimension.id));

// Every branch in the v2 scorer that can move the score, cap it, or disqualify
// the listing. `evidenceClass` records how the fact was established:
// `observed` came straight from a source field, `calculated` was derived from
// observed values, and `heuristic` came from matching the profile keyword lists
// against the listing narrative.
export const dealScoreRules = Object.freeze({
  'baseline.start': { dimension: null, label: 'Baseline score', evidenceClass: 'calculated' },

  'profit.in-band': { dimension: 'financial-fit', label: 'Annual profit inside the target band', evidenceClass: 'observed' },
  'profit.below-floor': { dimension: 'financial-fit', label: 'Annual profit below the target floor', evidenceClass: 'observed' },
  'profit.well-below': { dimension: 'financial-fit', label: 'Annual profit well below target', evidenceClass: 'observed' },
  'profit.far-above-band': { dimension: 'financial-fit', label: 'Annual profit far above the target band', evidenceClass: 'observed' },
  'profit.above-band': { dimension: 'financial-fit', label: 'Annual profit above the target band', evidenceClass: 'observed' },
  'profit.missing': { dimension: 'financial-fit', label: 'Annual profit not disclosed', evidenceClass: 'missing' },
  'multiple.financeable': { dimension: 'financial-fit', label: 'Profit multiple is financeable', evidenceClass: 'observed' },
  'multiple.workable': { dimension: 'financial-fit', label: 'Profit multiple may be workable', evidenceClass: 'observed' },
  'multiple.above-preferred': { dimension: 'financial-fit', label: 'Profit multiple above the preferred range', evidenceClass: 'observed' },
  'multiple.too-high': { dimension: 'financial-fit', label: 'Profit multiple too high', evidenceClass: 'observed' },
  'implied-multiple.financeable': { dimension: 'financial-fit', label: 'Implied multiple is financeable', evidenceClass: 'calculated' },
  'implied-multiple.workable': { dimension: 'financial-fit', label: 'Implied multiple may be workable', evidenceClass: 'calculated' },
  'implied-multiple.above-preferred': { dimension: 'financial-fit', label: 'Implied multiple above the preferred range', evidenceClass: 'calculated' },
  'implied-multiple.too-high': { dimension: 'financial-fit', label: 'Implied multiple too high', evidenceClass: 'calculated' },
  'asking.in-band': { dimension: 'financial-fit', label: 'Asking price within a plausible structure', evidenceClass: 'observed' },
  'asking.too-large': { dimension: 'financial-fit', label: 'Asking price likely needs outside equity', evidenceClass: 'observed' },
  'asking.too-small': { dimension: 'financial-fit', label: 'Asking price suggests a small owner-operator business', evidenceClass: 'observed' },
  'financeable.signals': { dimension: 'financial-fit', label: 'Financing support signals', evidenceClass: 'heuristic' },

  'recurring.present': { dimension: 'revenue-durability', label: 'Recurring or repeat revenue signals', evidenceClass: 'heuristic' },
  'recurring.absent': { dimension: 'revenue-durability', label: 'No recurring revenue signal in the listing text', evidenceClass: 'missing' },
  'recurring.unknown': { dimension: 'revenue-durability', label: 'Recurring revenue unknown: source supplied no narrative', evidenceClass: 'missing' },
  'commercial.present': { dimension: 'revenue-durability', label: 'Commercial or institutional customer signals', evidenceClass: 'heuristic' },

  'recession.present': { dimension: 'demand-resilience', label: 'Recession-resistant indicators', evidenceClass: 'heuristic' },
  'recession.absent': { dimension: 'demand-resilience', label: 'No recession-resistant indicator in the listing text', evidenceClass: 'missing' },
  'recession.unknown': { dimension: 'demand-resilience', label: 'Recession resistance unknown: source supplied no narrative', evidenceClass: 'missing' },
  'ai-resistance.present': { dimension: 'demand-resilience', label: 'AI-resistant operating work', evidenceClass: 'heuristic' },
  'ai-resistance.absent': { dimension: 'demand-resilience', label: 'No physical, field-service, or regulated work signal', evidenceClass: 'missing' },
  'ai-resistance.unknown': { dimension: 'demand-resilience', label: 'AI resistance unknown: source supplied no narrative', evidenceClass: 'missing' },

  'management.present': { dimension: 'transferability', label: 'Management, staff, or absentee signal', evidenceClass: 'heuristic' },
  'management.absent': { dimension: 'transferability', label: 'Management in place is not shown', evidenceClass: 'missing' },
  'owner-dependency.present': { dimension: 'transferability', label: 'Owner-dependency risk language', evidenceClass: 'heuristic' },

  'capex.present': { dimension: 'operating-profile', label: 'Capex or asset-heavy language', evidenceClass: 'heuristic' },

  'concentration.present': { dimension: 'concentration-quality-risk', label: 'Customer concentration risk language', evidenceClass: 'heuristic' },
  'financial-risk.present': { dimension: 'concentration-quality-risk', label: 'Financial quality risk language', evidenceClass: 'heuristic' },

  'preferred.present': { dimension: 'strategic-geographic-fit', label: 'Preferred search themes matched', evidenceClass: 'heuristic' },
  'age.established': { dimension: 'strategic-geographic-fit', label: 'Business age clears the 5+ year preference', evidenceClass: 'observed' },
  'age.young': { dimension: 'strategic-geographic-fit', label: 'Business is younger than the 5+ year preference', evidenceClass: 'observed' },
  'age.flagged': { dimension: 'strategic-geographic-fit', label: 'Source marks the business as 5+ years old', evidenceClass: 'observed' },
  'geography.target-state': { dimension: 'strategic-geographic-fit', label: 'Located in a target state', evidenceClass: 'observed' },
  'geography.remote': { dimension: 'strategic-geographic-fit', label: 'Remote, relocatable, or absentee-run', evidenceClass: 'observed' },

  'gate.excluded-category': { dimension: 'strategic-geographic-fit', label: 'Excluded category', evidenceClass: 'heuristic' },
  'gate.franchise': { dimension: 'strategic-geographic-fit', label: 'Franchise listing', evidenceClass: 'observed' },
  'gate.removed-floor': { dimension: null, label: 'Score floored because the listing is disqualified', evidenceClass: 'calculated' },
});

export const dealScoreRuleIds = Object.freeze(Object.keys(dealScoreRules));

// Which dimension a canonical field belongs to, used to attribute source
// contradictions. Fields that inform several dimensions at once, such as the
// listing narrative, are deliberately absent and stay unattributed rather than
// being assigned to an arbitrary one.
export const dealScoreFieldDimensions = Object.freeze({
  annualProfit: 'financial-fit',
  annualRevenue: 'financial-fit',
  askingPrice: 'financial-fit',
  profitMultiple: 'financial-fit',
  netMargin: 'financial-fit',
  yearsEstablished: 'strategic-geographic-fit',
  state: 'strategic-geographic-fit',
  city: 'strategic-geographic-fit',
  county: 'strategic-geographic-fit',
  location: 'strategic-geographic-fit',
  country: 'strategic-geographic-fit',
  franchiseFlag: 'strategic-geographic-fit',
  remoteFlag: 'transferability',
});

// Operator priority is the human's judgment about attention. It is deliberately
// separate from `fitScore` so a person never has to overwrite the machine's
// number to express urgency.
export const dealOperatorPriorities = Object.freeze(['urgent', 'high', 'normal', 'watch']);
export const defaultDealOperatorPriority = 'normal';

export const dealConfidenceBands = Object.freeze(['low', 'medium', 'high']);

export function dealScoreDimension(ruleId) {
  return dealScoreRules[ruleId]?.dimension || null;
}

export function isDealScoreRule(ruleId) {
  return Object.hasOwn(dealScoreRules, ruleId);
}

export function normalizeDealOperatorPriority(value, fallback = defaultDealOperatorPriority) {
  const normalized = String(value || '').trim().toLowerCase();
  return dealOperatorPriorities.includes(normalized) ? normalized : fallback;
}
