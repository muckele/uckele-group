// Deterministic semantic matching for Deal Hunter listing narratives.
//
// The v2 scorer matched keyword families with plain substring search, so
// "no recurring revenue" earned recurring-revenue points and "low customer
// concentration" was penalised as a concentration risk. This module keeps the
// exact substring acceptance semantics of the old matcher and adds bounded,
// testable suppression on top: a term still matches wherever it matched before
// unless a specific documented rule suppresses that occurrence. A term counts
// for scoring when at least one of its occurrences survives suppression.
//
// Everything here is pure and synchronous. There is no model, no configuration,
// and no I/O.

export const DEAL_SEMANTIC_MATCHER_VERSION = 'deal-semantic-matcher-v1';

// How far back a negator or context marker can reach, in whitespace-delimited
// tokens, before a matched phrase. The window never crosses a clause boundary.
const negationWindowTokens = 6;
// Favorable qualifiers bind tightly ("low customer concentration"), so their
// window is deliberately shorter than the negation window.
const qualifierWindowTokens = 2;

// Clause boundaries reset every window: sentence punctuation ends the clause,
// and an adversative conjunction reverses meaning ("was struggling, but now has
// recurring contracts" must keep the positive match).
const clauseBoundaryPattern = /[.;!?\n\r]/;
const adversativeTokens = new Set(['but', 'however', 'although', 'though', 'yet', 'whereas']);

// Single-token negators. "not" is handled specially: "not only" is emphasis,
// not negation.
const negatorTokens = new Set([
  'no', 'not', 'never', 'without', 'lacks', 'lacking', 'neither', 'nor',
  "isn't", "aren't", "wasn't", "weren't", "doesn't", "don't", "didn't",
  "hasn't", "haven't", "hadn't", "won't", "can't", 'cannot',
]);

// Two-token negator sequences, checked against adjacent window tokens.
const negatorSequences = [
  ['does', 'not'], ['do', 'not'], ['did', 'not'],
  ['is', 'not'], ['are', 'not'], ['was', 'not'], ['were', 'not'],
  ['has', 'no'], ['have', 'no'], ['had', 'no'],
  ['no', 'longer'], ['lack', 'of'], ['absence', 'of'],
];

// Adverse context suppresses a positive match: "losing maintenance contracts"
// is not recurring-revenue support. Applied to positive families only.
const adverseContextTokens = new Set([
  'losing', 'lost', 'loses', 'declining', 'declined', 'cancelled', 'canceled',
  'cancelling', 'canceling', 'terminated', 'terminating', 'expiring', 'expired',
  'discontinued', 'dwindling', 'eroding', 'shrinking', 'ended', 'ending',
]);

// A favorable qualifier suppresses a risk match: "low customer concentration"
// is diversification, not risk. Applied to risk families only, tight window.
const favorableQualifierTokens = new Set(['low', 'minimal', 'negligible', 'little']);

// Future or conditional markers suppress a positive match: a plan to add
// recurring contracts is not current recurring revenue. Only unambiguous
// multi-word markers are handled; bare "will", "may", "could", and "if" are
// deliberately left alone because they suppress too much real language.
const futureConditionalSequences = [
  ['plans', 'to'], ['plan', 'to'], ['planning', 'to'],
  ['expects', 'to'], ['expect', 'to'], ['intends', 'to'], ['intend', 'to'],
  ['aims', 'to'], ['hopes', 'to'], ['after', 'closing'],
];

// Historical markers suppress a positive match: "formerly ran on maintenance
// contracts" is not current support. "historically" is deliberately excluded
// because it usually describes a continuing track record.
const historicalTokens = new Set(['formerly', 'previously']);
const historicalSequences = [['used', 'to']];

export const dealSemanticSuppressionReasons = Object.freeze([
  'negated-positive',
  'negated-risk',
  'favorable-qualifier',
  'adverse-context',
  'future-or-conditional',
  'historical-only',
  'longer-phrase-precedence',
]);

function normalizeMatcherText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[–—]/g, '-');
}

// Tokens keep internal hyphens and apostrophes ("no-price" stays one token and
// is not the negator "no"; "isn't" survives as a unit) but shed surrounding
// punctuation.
function tokenize(text) {
  return text
    .split(/\s+/)
    .map((token) => token.replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, ''))
    .filter(Boolean);
}

// Occurrence discovery preserves the old matcher's acceptance rules exactly:
// short alphanumeric terms require word boundaries, longer terms are plain
// substrings.
function findOccurrences(text, term) {
  const occurrences = [];
  if (!term) return occurrences;
  if (/^[a-z0-9]+$/.test(term) && term.length <= 4) {
    const pattern = new RegExp(`(^|[^a-z0-9])(${term})([^a-z0-9]|$)`, 'g');
    let match = pattern.exec(text);
    while (match) {
      const start = match.index + match[1].length;
      occurrences.push({ start, end: start + term.length });
      pattern.lastIndex = start + term.length;
      match = pattern.exec(text);
    }
    return occurrences;
  }
  let index = text.indexOf(term);
  while (index !== -1) {
    occurrences.push({ start: index, end: index + term.length });
    index = text.indexOf(term, index + 1);
  }
  return occurrences;
}

// The tokens between the last clause boundary and the occurrence, nearest
// first, stopping at an adversative conjunction because it reverses meaning.
function windowBefore(text, start) {
  let clauseStart = 0;
  for (let index = start - 1; index >= 0; index -= 1) {
    if (clauseBoundaryPattern.test(text[index])) {
      clauseStart = index + 1;
      break;
    }
  }
  const preceding = tokenize(text.slice(clauseStart, start));
  const window = [];
  for (let index = preceding.length - 1; index >= 0 && window.length < negationWindowTokens; index -= 1) {
    const token = preceding[index];
    if (adversativeTokens.has(token)) break;
    window.push({ token, next: preceding[index + 1] || '' });
  }
  return window;
}

function windowHasSequence(window, sequences) {
  // window is nearest-first; each entry knows the token that follows it in
  // reading order, so a two-word sequence is (entry.token, entry.next).
  return window.some((entry) => sequences.some(
    ([first, second]) => entry.token === first && entry.next === second,
  ));
}

function windowHasNegator(window) {
  if (windowHasSequence(window, negatorSequences)) return true;
  return window.some((entry) => {
    if (!negatorTokens.has(entry.token)) return false;
    // "not only" is emphasis, not negation.
    if (entry.token === 'not' && entry.next === 'only') return false;
    return true;
  });
}

function immediateNonPrefix(text, start) {
  const before = text.slice(Math.max(0, start - 4), start);
  return /(^|[^a-z0-9])non[\s-]$/.test(before);
}

// Reasons are checked most-specific first, so the recorded explanation is the
// most informative one. "low customer concentration" reports the favorable
// qualifier rather than the generic containment rule, even though both hold.
function suppressionReasonFor({ text, occurrence, polarity, containers }) {
  const window = windowBefore(text, occurrence.start);

  if (polarity === 'risk') {
    const tight = window.slice(0, qualifierWindowTokens);
    if (tight.some((entry) => favorableQualifierTokens.has(entry.token))) return 'favorable-qualifier';
  }

  // Longest-phrase precedence: an occurrence strictly inside a longer matched
  // phrase of the opposite polarity is that phrase's evidence, not its own.
  const contained = containers.some((container) => (
    container.polarity !== polarity
    && container.start <= occurrence.start
    && container.end >= occurrence.end
    && (container.end - container.start) > (occurrence.end - occurrence.start)
  ));
  if (contained) return 'longer-phrase-precedence';

  if (polarity === 'positive' && immediateNonPrefix(text, occurrence.start)) {
    return 'negated-positive';
  }

  if (windowHasNegator(window)) {
    return polarity === 'positive' ? 'negated-positive' : 'negated-risk';
  }
  if (polarity === 'positive') {
    if (window.some((entry) => adverseContextTokens.has(entry.token))) return 'adverse-context';
    if (windowHasSequence(window, futureConditionalSequences)) return 'future-or-conditional';
    if (window.some((entry) => historicalTokens.has(entry.token))
      || windowHasSequence(window, historicalSequences)) return 'historical-only';
  }
  return null;
}

/**
 * Match one keyword family against normalized listing text.
 *
 * Returns the terms that survive suppression (same shape the old substring
 * matcher produced) plus a structured record of every fully suppressed term.
 * `containers` are the opposite-polarity spans used for phrase precedence.
 */
export function matchSemanticFamily({ text, terms, polarity, containers = [] }) {
  const matched = [];
  const suppressed = [];
  for (const rawTerm of terms) {
    const term = rawTerm.toLowerCase();
    const occurrences = findOccurrences(text, term);
    if (occurrences.length === 0) continue;
    let accepted = false;
    let lastReason = null;
    for (const occurrence of occurrences) {
      const reason = suppressionReasonFor({ text, occurrence, polarity, containers });
      if (!reason) {
        accepted = true;
        break;
      }
      lastReason = reason;
    }
    if (accepted) matched.push(rawTerm);
    else suppressed.push({ term: rawTerm, reason: lastReason });
  }
  return { matched, suppressed };
}

// Family polarity. `excluded` is deliberately absent: category gates stay on
// raw substring matching because falsely suppressing a gate ("no experience
// needed! restaurant...") admits a disqualified deal, which is the expensive
// error, while a false gate is a reviewable one.
export const dealSemanticFamilies = Object.freeze({
  preferred: 'positive',
  recurring: 'positive',
  commercial: 'positive',
  recession: 'positive',
  aiProof: 'positive',
  management: 'positive',
  financeable: 'positive',
  capex: 'risk',
  ownerDependency: 'risk',
  concentrationRisk: 'risk',
  financialRisk: 'risk',
});

const familyKeywordSource = Object.freeze({
  preferred: 'preferredKeywords',
  recurring: 'recurringRevenueKeywords',
  commercial: 'commercialCustomerKeywords',
  recession: 'recessionProofKeywords',
  aiProof: 'aiProofKeywords',
  management: 'managementKeywords',
  financeable: 'financeableKeywords',
  capex: 'capexKeywords',
  ownerDependency: 'ownerDependencyRiskKeywords',
  concentrationRisk: 'customerConcentrationRiskKeywords',
  financialRisk: 'financialRiskKeywords',
});

/**
 * Match every semantic keyword family for one listing.
 *
 * Returns { matches, suppressed, matcherVersion } where `matches` has exactly
 * the family -> [terms] shape the scorer's old substring matcher produced.
 */
export function matchDealNarrative(fullText, profile) {
  const text = normalizeMatcherText(fullText);

  // Opposite-polarity container spans for phrase precedence. Only positive
  // spans need collecting today ("low customer concentration" is a preferred
  // term containing a risk term), but both sides are collected so a future
  // list change cannot silently break precedence.
  const spansByPolarity = { positive: [], risk: [] };
  for (const [family, polarity] of Object.entries(dealSemanticFamilies)) {
    for (const rawTerm of profile[familyKeywordSource[family]] || []) {
      const term = rawTerm.toLowerCase();
      for (const occurrence of findOccurrences(text, term)) {
        spansByPolarity[polarity].push({ ...occurrence, polarity });
      }
    }
  }
  const containersFor = (polarity) => (polarity === 'risk' ? spansByPolarity.positive : spansByPolarity.risk);

  const matches = {};
  const suppressed = [];
  for (const [family, polarity] of Object.entries(dealSemanticFamilies)) {
    const result = matchSemanticFamily({
      text,
      terms: profile[familyKeywordSource[family]] || [],
      polarity,
      containers: containersFor(polarity),
    });
    matches[family] = result.matched;
    for (const item of result.suppressed) {
      suppressed.push({ family, term: item.term, reason: item.reason });
    }
  }
  return { matches, suppressed, matcherVersion: DEAL_SEMANTIC_MATCHER_VERSION };
}
