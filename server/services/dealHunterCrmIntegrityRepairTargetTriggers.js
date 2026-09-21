import { createHash } from 'node:crypto';

const reviewedTargetTriggerDigests = new Map([
  [
    'contact_submissions:trg_crm_submission_supersessions_guard_contact_delete',
    '581f73de393e598ef8c12fea6ea508a2c9efba24e66bdef2da226518275dd18b',
  ],
  [
    'contact_submissions:trg_crm_submission_supersessions_guard_contact_owner_update',
    '6716c91e536e452d534ca0404f999d83e752e89ca076cb1ae88d53a5716becc0',
  ],
]);

function sqlDigest(sql) {
  return createHash('sha256').update(String(sql || '')).digest('hex');
}

export function findUnsupportedCrmIntegrityRepairTargetTriggers(database) {
  const triggers = database.prepare(`
    SELECT name, tbl_name, sql
    FROM sqlite_schema
    WHERE type = 'trigger' AND tbl_name IN ('contact_submissions', 'deal_hunter_crm_imports')
    ORDER BY name
  `).all();
  return triggers.flatMap((trigger) => {
    const key = `${trigger.tbl_name}:${trigger.name}`;
    return reviewedTargetTriggerDigests.get(key) === sqlDigest(trigger.sql)
      ? []
      : [`UNSUPPORTED_TARGET_TRIGGER:${key}`];
  });
}
