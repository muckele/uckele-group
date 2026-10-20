import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnerReviewRoutePolicy } from '../test-owner-flow/review-route-policy.js';

test('future review admits bounded CRM index navigation and exact fixture records while denying setup/send and other mutations', () => {
  const allowed = createOwnerReviewRoutePolicy({ opportunityIds: ['fresh', 'low'], crmIds: ['crm-low'] });
  for (const url of ['/admin/crm', '/api/admin/crm-duplicates', '/api/admin/submissions?status=archived&page=1&pageSize=25&sort=created_at&direction=desc&search=Synthetic',
    '/api/admin/submissions/crm-low', '/api/admin/submissions/crm-low/activity']) assert.equal(allowed('GET', url), true, url);
  for (const url of ['/api/admin/submissions?pageSize=1000', '/api/admin/submissions?pageSize=25&pageSize=50',
    '/api/admin/submissions/unknown', '/api/admin/settings', '//outside.example/path']) assert.equal(allowed('GET', url), false, url);
  for (const url of ['/api/admin/submissions', '/api/admin/deal-hunter/cim-request', '/api/admin/deal-hunter/cim-requests',
    '/api/admin/deal-hunter/triage/fresh/broker-materials/approve', '/api/admin/deal-hunter/dispositions']) assert.equal(allowed('POST', url), false, url);
  assert.equal(allowed('DELETE', '/api/admin/submissions/crm-low'), false);
  assert.equal(allowed('POST', '/api/admin/deal-hunter/triage/fresh/restore'), true);
  assert.equal(allowed('POST', '/api/admin/deal-hunter/triage/unknown/restore'), false);
});
