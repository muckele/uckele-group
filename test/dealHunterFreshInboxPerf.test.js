import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createSqliteStorage } from '../server/storage/sqlite.js';

const enabled = process.env.DEAL_HUNTER_FRESH_INBOX_PERF === '1';

function percentile(values, fraction) {
  return [...values].sort((left, right) => left - right)[Math.ceil(values.length * fraction) - 1];
}

test('representative SQLite Inbox read plan and resources', {
  skip: enabled ? false : 'set DEAL_HUNTER_FRESH_INBOX_PERF=1 for 10k/30k synthetic read measurement',
  timeout: 180_000,
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-fl01-read-perf-'));
  const sqlitePath = path.join(directory, 'fresh-inbox.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  const db = new Database(sqlitePath);
  t.after(() => { db.close(); storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const opportunity = db.prepare(`insert into deal_hunter_opportunities
    (opportunity_id, created_at, updated_at, canonical_name, identity_version,
      discovery_state, first_accepted_at, discovery_revision)
    values (?, ?, ?, ?, 'synthetic-perf', ?, ?, ?)`);
  const score = db.prepare(`insert into deal_hunter_opportunity_scores
    (opportunity_id, created_at, scored_at, deal_key, name, fit_score, confidence,
      score_fingerprint, engine_version, rules_version, profile_version,
      completeness_policy_version, current_triage_eligible, operator_priority)
    values (?, ?, ?, ?, ?, ?, 'high', 'synthetic-perf', 'test', 'test', 'test', 'test', 1, ?)`);
  const observation = db.prepare(`insert into deal_hunter_opportunity_source_observations
    (id, opportunity_id, source_id, source_name, source_record_id, field, value,
      observed_at, created_at, updated_at)
    values (?, ?, 'synthetic-perf', 'Synthetic perf', ?, ?, ?, ?, ?, ?)`);
  const at = new Date().toISOString();
  db.transaction(() => {
    for (let index = 0; index < 10_000; index += 1) {
      const id = `perf-${String(index).padStart(5, '0')}`;
      const isFresh = index >= 9_900;
      opportunity.run(id, at, at, id, isFresh ? 'known_prospective' : 'untracked_legacy',
        isFresh ? at : null, isFresh ? 1 : 0);
      score.run(id, at, at, id, id, 80 + index % 20,
        index % 10 === 0 ? 'high' : 'normal');
      for (const [field, value] of [['industry', 'Synthetic industry'],
        ['annual_profit', String(100_000 + index)], ['asking_price', String(500_000 + index)]]) {
        observation.run(`${id}:${field}`, id, id, field, value, at, at, at);
      }
    }
  })();
  assert.equal(db.prepare('select count(*) as count from deal_hunter_opportunity_scores').get().count, 10_000);
  assert.equal(db.prepare('select count(*) as count from deal_hunter_opportunity_source_observations').get().count, 30_000);
  const plan = db.prepare(`explain query plan select scores.opportunity_id
    from deal_hunter_opportunity_scores as scores
    join deal_hunter_opportunities as opportunity
      on opportunity.opportunity_id = scores.opportunity_id
    where scores.current_triage_eligible = 1 and scores.should_remove = 0
      and opportunity.status = 'active'`).all();
  const baseline = [];
  const inbox = [];
  let peakRss = process.memoryUsage().rss;
  for (let index = 0; index < 20; index += 1) {
    let started = performance.now();
    await storage.listDealHunterOpportunityScores({ view: 'all', pageSize: 25 });
    baseline.push(performance.now() - started);
    started = performance.now();
    const result = await storage.listDealHunterFreshInbox({ area: 'inbox' });
    inbox.push(performance.now() - started);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    assert.equal(result.areas[1].total, 100);
    assert.equal(result.areas[1].rows.length, 10);
  }
  const output = { dataset: { scores: 10_000, currentObservations: 30_000 },
    explainCandidate: plan.map((row) => row.detail),
    baselineMs: { p50: percentile(baseline, 0.5), p95: percentile(baseline, 0.95) },
    inboxMs: { p50: percentile(inbox, 0.5), p95: percentile(inbox, 0.95) },
    peakProcessRssBytes: peakRss };
  process.stdout.write(`FL01_SQLITE_PERF ${JSON.stringify(output)}\n`);
});
