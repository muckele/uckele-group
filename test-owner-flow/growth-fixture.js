import { createHash } from 'node:crypto';

export const activeCount = 1000, archiveCount = 5000;
export const protectedTables = ['contact_submissions', 'deal_hunter_opportunities',
  'deal_hunter_opportunity_scores', 'deal_hunter_freshness_evidence', 'deal_hunter_dispositions',
  'deal_hunter_opportunity_aliases', 'deal_hunter_opportunity_source_observations',
  'crm_activity_events', 'email_suppressions', 'deal_hunter_pursuit_enrollments',
  'deal_hunter_owner_decision_events', 'deal_hunter_broker_conversations', 'deal_hunter_cim_requests',
  'deal_hunter_cim_live_provider_authorizations',
  'deal_hunter_cim_campaigns', 'deal_hunter_cim_capacity_reservations',
  'deal_hunter_cim_capability_activations', 'deal_hunter_cim_transmissions', 'crm_email_outbox'];

export function fingerprint(db, tables = protectedTables) {
  const hash = createHash('sha256');
  for (const table of tables) {
    hash.update(table);
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).iterate()) hash.update(JSON.stringify(row));
  }
  return hash.digest('hex');
}

export function seedGrowth(db) {
  const template = Object.fromEntries(['deal_hunter_opportunities', 'deal_hunter_opportunity_scores',
    'deal_hunter_opportunity_aliases'].map((table) => [table,
    db.prepare(`SELECT * FROM ${table} WHERE opportunity_id='older' LIMIT 1`).get()]));
  const insert = Object.fromEntries(Object.entries(template).map(([table, row]) => [table,
    db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map((key) => `@${key}`).join(',')})`)]));
  const pass = db.prepare(`INSERT INTO deal_hunter_dispositions
    (id,deal_key,deal_name,created_at,updated_at,disposition,reason,note,dismissed_at,created_by,updated_by)
    VALUES (@id,@key,@name,@at,@at,'dismissed','volume-retained-reason','Volume archive retained note',@at,'fixture','fixture')`);
  db.transaction(() => {
    for (const [kind, count] of [['active', activeCount], ['archive', archiveCount]]) {
      for (let index = 0; index < count; index += 1) {
        const id = `volume-${kind}-${String(index).padStart(5, '0')}`;
        const name = `Synthetic Volume ${kind} ${index}`;
        const opportunity = { ...template.deal_hunter_opportunities, opportunity_id: id,
          canonical_name: name, primary_submission_id: null };
        insert.deal_hunter_opportunities.run(opportunity);
        insert.deal_hunter_opportunity_scores.run({ ...template.deal_hunter_opportunity_scores,
          opportunity_id: id, deal_key: id, name, current_triage_eligible: kind === 'active' ? 1 : 0 });
        insert.deal_hunter_opportunity_aliases.run({ ...template.deal_hunter_opportunity_aliases,
          id: `alias-${id}`, opportunity_id: id, alias_value: id, alias_key: `deal-key:${id}` });
        if (kind === 'archive') pass.run({ id: `pass-${id}`, key: id, name, at: opportunity.updated_at });
      }
    }
  })();
}
