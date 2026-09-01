// CIM request IDs participate in bounded, cross-provider authority ordering.
// Keep the accepted domain ASCII-only so SQLite BINARY, PostgreSQL COLLATE C,
// and JavaScript all share the same lexical order for legitimate records.

export const canonicalCimRequestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function normalizeCanonicalCimRequestId(value) {
  if (typeof value !== 'string') return '';
  return canonicalCimRequestIdPattern.test(value) ? value : '';
}

export function requireCanonicalCimRequestId(value) {
  const normalized = normalizeCanonicalCimRequestId(value);
  if (!normalized) {
    throw new Error('A canonical CIM request ID must be a 1-200 character ASCII token.');
  }
  return normalized;
}
