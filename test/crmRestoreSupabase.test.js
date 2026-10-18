import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createSupabaseStorage } from '../server/storage/supabase.js';

test('Supabase uses one dedicated restore RPC with no generic update or outreach capability', async () => {
  const calls = [];
  const payload = { id: '11111111-1111-4111-8111-111111111111', expectedUpdatedAt: '2026-10-18T10:00:00.000Z', status: 'review' };
  const activity = { id: '11111111-2222-4222-8222-111111111111', submission_id: payload.id,
    event_type: 'submission.restored', actor: 'owner', role: 'admin', created_at: '2026-10-18T11:00:00.000Z',
    summary: 'Restored for review; outreach stopped', metadata: { outreachRestarted: false } };
  const storage = createSupabaseStorage({ storage: {} }, { client: {
    async rpc(name, parameters) {
      calls.push({ name, parameters });
      return { data: { applied: true, record: { id: payload.id, status: 'review', metadata: {} }, activity }, error: null };
    },
  } });
  const result = await storage.mutateWithCrmActivity({ operation: 'restore_submission', payload, activity });
  assert.equal(result.applied, true);
  assert.equal(result.record.status, 'review');
  assert.deepEqual(calls, [{ name: 'restore_archived_submission_with_crm_activity', parameters: { p_payload: payload, p_activity: activity } }]);
});

test('fresh and upgrade SQL retain the same service-only atomic restore definition', () => {
  const migration = fs.readFileSync(new URL('../supabase/migrations/20261018120000_atomic_crm_restore.sql', import.meta.url), 'utf8').trim();
  const schema = fs.readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  assert.ok(schema.endsWith(`${migration}\n`));
  assert.match(migration, /security invoker set search_path = ''/);
  assert.match(migration, /from public, anon, authenticated/);
  assert.match(migration, /to service_role/);
  assert.match(migration, /in share row exclusive mode/);
});
