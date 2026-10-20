// Caller owns the IMMEDIATE transaction. Restore only the exact reviewed Pass;
// this operation has no CRM, campaign, permission or scheduling writes.
export function restoreCurrentUnlinkedInTransaction(database, input) {
  const reject = () => ({ applied: false, reason: 'restore-authority-changed' });
  const opportunity = database.prepare('SELECT * FROM deal_hunter_opportunities WHERE opportunity_id=?').get(input.opportunityId);
  if (!opportunity || opportunity.status !== 'active' || opportunity.primary_submission_id !== null
    || opportunity.campaign_authority_revision !== input.expectedCampaignAuthorityRevision) return reject();
  const score = database.prepare('SELECT deal_key FROM deal_hunter_opportunity_scores WHERE opportunity_id=? AND current_triage_eligible=1').get(input.opportunityId);
  if (!score?.deal_key) return reject();
  const pass = database.prepare('SELECT * FROM deal_hunter_dispositions WHERE id=?').get(input.passId);
  if (!pass || pass.deal_key !== score.deal_key || pass.submission_id !== null
    || pass.disposition !== 'dismissed' || pass.updated_at !== input.passUpdatedAt) return reject();
  const keys = [...new Set([score.deal_key, ...database.prepare("SELECT alias_value FROM deal_hunter_opportunity_aliases WHERE opportunity_id=? AND alias_type='deal-key'").all(input.opportunityId).map((row) => row.alias_value)])];
  const placeholders = keys.map(() => '?').join(',');
  const owners = database.prepare(`SELECT opportunity_id FROM deal_hunter_opportunity_aliases WHERE alias_type='deal-key' AND alias_value IN (${placeholders})
    UNION SELECT opportunity_id FROM deal_hunter_opportunity_scores WHERE deal_key IN (${placeholders})`).all(...keys, ...keys);
  if (owners.some((row) => row.opportunity_id !== input.opportunityId)) return reject();
  if (database.prepare(`SELECT 1 FROM contact_submissions WHERE deal_hunter_opportunity_id=?
    OR CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.dealHunter.opportunityId')=?
      OR json_extract(metadata,'$.dealHunter.dealKey') IN (${placeholders}) ELSE 0 END LIMIT 1`)
    .get(input.opportunityId, input.opportunityId, ...keys)) return reject();
  for (const table of ['deal_hunter_crm_imports', 'deal_hunter_cim_requests']) {
    if (database.prepare(`SELECT 1 FROM ${table} WHERE (opportunity_id=? OR deal_key IN (${placeholders}))
      AND (submission_id IS NOT NULL OR opportunity_id IS NOT ?) LIMIT 1`).get(input.opportunityId, ...keys, input.opportunityId)) return reject();
  }
  if (database.prepare(`SELECT 1 FROM deal_hunter_dispositions d WHERE d.disposition='dismissed' AND d.id<>?
    AND d.deal_key IN (${placeholders}) LIMIT 1`).get(pass.id, ...keys)) return reject();
  database.prepare(`UPDATE deal_hunter_dispositions SET disposition='restored',updated_at=?,updated_by=?,restored_at=?,restored_by=? WHERE id=?`)
    .run(input.at, input.actor, input.at, input.actor, pass.id);
  database.prepare('UPDATE deal_hunter_opportunities SET campaign_authority_revision=campaign_authority_revision+1 WHERE opportunity_id=?').run(input.opportunityId);
  return { applied: true, disposition: database.prepare('SELECT * FROM deal_hunter_dispositions WHERE id=?').get(pass.id) };
}
