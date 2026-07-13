// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { buildDraft, buildSubmissionPayload } from '../src/pages/DashboardPage.jsx';

describe('Dashboard conflict drafts', () => {
  test('keeps the original expected version after the server reports a newer record', () => {
    const opened = {
      id: 'record-1',
      updated_at: '2026-07-12T10:00:00.000Z',
      notes: 'original notes',
      tags: [],
      metadata: {},
    };
    const latestServerRecord = {
      ...opened,
      updated_at: '2026-07-12T10:05:00.000Z',
      notes: 'another editor changed this',
    };
    const draft = { ...buildDraft(opened), notes: 'my unsaved notes' };
    const retryPayload = buildSubmissionPayload(draft, latestServerRecord);

    expect(retryPayload.notes).toBe('my unsaved notes');
    expect(retryPayload.expected_updated_at).toBe(opened.updated_at);
  });
});
