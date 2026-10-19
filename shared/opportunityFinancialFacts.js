export const financialFactFields = Object.freeze(['annual_profit', 'annual_revenue', 'asking_price']);
export const financialFactCurrencies = Object.freeze(['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'unknown']);
export const financialFactPeriods = Object.freeze(['annual', 'trailing-twelve-months', 'current', 'unknown']);
export const financialFactMetrics = Object.freeze({ annual_profit: ['sde', 'ebitda', 'unknown'],
  annual_revenue: ['revenue'], asking_price: ['asking-price'] });

// One complete observation per immutable fact revision. The existing TEXT value
// has an explicit versioned format for these three fields, never an opaque note.
export function normalizeFinancialFact(field, input) {
  if (!financialFactFields.includes(field)) throw new Error('Unsupported financial fact field.');
  if (typeof input === 'string') {
    if (input.length > 2000) throw new Error('Financial fact value is too long.');
    try { input = JSON.parse(input); } catch { throw new Error('Financial fact requires amount, currency, metric, period and evidence source.'); }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== 'amount,currency,evidenceSource,metric,period,version'
    || input.version !== 1) throw new Error('Financial fact must use the complete version 1 contract.');
  if (typeof input.amount !== 'string' || !/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(input.amount)) {
    throw new Error('Amount must be a plain decimal with at most 12 integer digits and 2 decimal places.');
  }
  const negative = input.amount.startsWith('-');
  const [whole, fraction = ''] = input.amount.replace(/^-/, '').split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (negative && cents !== 0n && field !== 'annual_profit') throw new Error('Revenue and asking price cannot be negative.');
  if (!financialFactCurrencies.includes(input.currency)) throw new Error('Select a supported financial currency or explicit unknown.');
  if (!financialFactMetrics[field].includes(input.metric)) throw new Error('Financial metric does not match this field.');
  if (!financialFactPeriods.includes(input.period)
    || (field === 'asking_price' && !['current', 'unknown'].includes(input.period))
    || (field !== 'asking_price' && input.period === 'current')) throw new Error('Financial period does not match this field.');
  if (typeof input.evidenceSource !== 'string' || !input.evidenceSource.trim()
    || input.evidenceSource.trim().length > 500 || [...input.evidenceSource].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error('Financial evidence source is required, must be plain text and at most 500 characters.');
  }
  return { version: 1, amount: `${negative && cents !== 0n ? '-' : ''}${whole}.${fraction.padEnd(2, '0')}`,
    currency: input.currency, metric: input.metric, period: input.period, evidenceSource: input.evidenceSource.trim() };
}

export function parseFinancialFact(field, value) {
  try { return normalizeFinancialFact(field, value); } catch { return null; }
}

export function financialFactDescription(field, value) {
  const fact = parseFinancialFact(field, value);
  if (!fact) return '';
  const amount = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(fact.amount));
  return `${amount} ${fact.currency === 'unknown' ? 'currency unknown' : fact.currency} · ${fact.metric} · ${fact.period} · Evidence: ${fact.evidenceSource}`;
}
