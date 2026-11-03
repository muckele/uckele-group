// Target-state helpers shared by the criteria profile, CIM automation and the timezone resolver.
// Keep this module dependency-free: the timezone resolver imports it, and anything heavier here
// would pull storage into that resolver's import graph.

/** The states Uckele acquires in, as 2-letter codes. */
export const trustedTargetStates = ['NY', 'CA', 'NJ', 'AZ', 'NV', 'CT'];

export const stateNameCodes = Object.freeze({
  'NEW YORK': 'NY',
  CALIFORNIA: 'CA',
  'NEW JERSEY': 'NJ',
  ARIZONA: 'AZ',
  NEVADA: 'NV',
  CONNECTICUT: 'CT',
});

/**
 * Distinct target-state codes named in free text, by 2-letter code or full state name, in the
 * order the target list gives them. Shared by the criteria geography check and the timezone
 * resolver so both read a deal's state the same way.
 */
export function targetStatesIn(text, targetStates = trustedTargetStates) {
  let upper = String(text ?? '').toUpperCase();
  for (const [name, code] of Object.entries(stateNameCodes)) {
    upper = upper.replace(new RegExp(`(^|[^A-Z])${name}(?=[^A-Z]|$)`, 'g'), `$1${code}`);
  }
  return targetStates.filter((state) => new RegExp(`(^|[^A-Z])${state}([^A-Z]|$)`).test(upper));
}
