// Future isolated human-review replay only. This never changes app authority.
export function createOwnerReviewRoutePolicy({ opportunityIds, crmIds }) {
  const ids = new Set(opportunityIds);
  const crm = new Set(crmIds);
  const reads = new Set(['/api/admin/session', '/api/admin/onboarding', '/api/admin/acquisition-command-center',
    '/api/admin/follow-ups', '/api/admin/crm-duplicates', '/api/admin/deal-hunter/triage']);
  return (method, rawUrl) => {
    if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/') || rawUrl.startsWith('//') || rawUrl.length > 4000) return false;
    const url = new URL(rawUrl, 'http://127.0.0.1');
    const name = url.pathname;
    if (['GET', 'HEAD'].includes(method)) {
      if (name === '/api/admin/submissions') {
        const keys = [...url.searchParams.keys()];
        if (new Set(keys).size !== keys.length || keys.some((key) => !['status', 'search', 'created', 'page', 'pageSize', 'sort', 'direction'].includes(key))) return false;
        return (!url.searchParams.has('pageSize') || /^(?:[1-9][0-9]?|100)$/.test(url.searchParams.get('pageSize')))
          && (!url.searchParams.has('page') || /^[1-9][0-9]{0,3}$/.test(url.searchParams.get('page')))
          && (url.searchParams.get('search') || '').length <= 200;
      }
      if (reads.has(name) || ['/', '/admin', '/admin/deal-hunter', '/admin/crm', '/favicon.svg'].includes(name)
        || /^\/assets\/[a-zA-Z0-9_.-]+$/.test(name)) return true;
      const record = name.match(/^\/(?:api\/admin\/submissions|admin\/crm)\/([^/]+)(?:\/(?:activity|communications))?$/);
      if (record) return crm.has(record[1]);
      const detail = name.match(/^\/api\/admin\/deal-hunter\/triage\/([^/]+)(?:\/cim-release)?$/);
      return Boolean(detail && ids.has(detail[1]));
    }
    if (name === '/api/admin/session' && ['POST', 'DELETE'].includes(method)) return true;
    if (method === 'POST' && name === '/api/admin/submissions/crm-low/restore') return crm.has('crm-low');
    const action = name.match(/^\/api\/admin\/deal-hunter\/triage\/([^/]+)\/(action|decision|restore)$/);
    if (method === 'POST' && action && ids.has(action[1])) return true;
    return method === 'PUT' && /^\/api\/admin\/deal-hunter\/opportunities\/fresh\/facts\/[a-z_]+$/.test(name) && ids.has('fresh');
  };
}
