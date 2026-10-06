function formatLabel(value) {
  return String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function usd(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(Number(value));
}

export function earningsPresentation(financials = {}) {
  const evidence = financials.annualProfitEvidence || {};
  const metricValue = String(evidence.metric || '').toLowerCase();
  const metric = ['sde', 'ebitda'].includes(metricValue)
    ? metricValue.toUpperCase() : 'Earnings metric unverified';
  const period = evidence.period && evidence.period !== 'unknown'
    ? formatLabel(evidence.period).toLowerCase() : 'period unverified';
  const value = financials.annualProfit;
  const amount = value === null || value === undefined || value === '' ? '—'
    : evidence.currency === 'USD' ? usd(value)
      : `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value))} ${evidence.currency && evidence.currency !== 'unknown' ? evidence.currency : 'currency unverified'}`;
  return { label: `${metric} · ${period}`, amount };
}
