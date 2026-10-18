// Runs only inside SQLite's existing IMMEDIATE CRM activity transaction.
// Nothing here can authorize, schedule, unsuppress or reopen outreach.
function passProjectionTime(value) {
  if (typeof value !== 'string') return NaN;
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.(\d{1,3}))?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/);
  if (!match) return NaN; // Unknown/sub-millisecond representations cannot prove equality.
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return NaN;
  const zone = match[3];
  const offset = zone === 'Z' ? 0 : (zone[0] === '-' ? -1 : 1)
    * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  // Reject JavaScript's normalization of invalid calendar dates (e.g. Feb 30).
  return new Date(instant + offset * 60_000).toISOString() === `${match[1]}.${(match[2] || '').padEnd(3, '0')}Z`
    ? instant : NaN;
}

export function restoreCrmLifecycleInTransaction(database, payload, activity) {
  const reject = (reason) => ({ applied: false, reason, record: null, activity: null });
  if (activity?.submission_id !== payload.id || activity?.event_type !== 'submission.restored'
    || activity?.role !== 'admin' || !['sourced', 'new', 'review', 'contacted'].includes(payload.status)
    || !payload.expectedUpdatedAt || !Number.isFinite(Date.parse(activity.created_at))
    || Object.keys(payload).some((key) => !['id', 'status', 'expectedUpdatedAt'].includes(key))) {
    throw new Error('Invalid atomic CRM restore authority.');
  }
  const submission = database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(payload.id);
  if (!submission || submission.status !== 'archived' || submission.updated_at !== payload.expectedUpdatedAt) {
    return reject('restore-version-conflict');
  }
  const metadata = JSON.parse(submission.metadata || '{}');
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || (metadata.dealHunter != null && (typeof metadata.dealHunter !== 'object' || Array.isArray(metadata.dealHunter)))) {
    return reject('restore-identity-conflict');
  }
  const direct = submission.deal_hunter_opportunity_id || '';
  const metadataOwner = metadata.dealHunter?.opportunityId ?? '';
  if (typeof metadataOwner !== 'string') return reject('restore-identity-conflict');
  const candidates = new Set([direct, metadataOwner].filter(Boolean));
  for (const row of database.prepare('SELECT opportunity_id FROM deal_hunter_opportunities WHERE primary_submission_id = ?').all(payload.id)) {
    candidates.add(row.opportunity_id);
  }
  const keyOwners = (key) => new Set([
    ...database.prepare(`SELECT opportunity_id FROM deal_hunter_opportunity_aliases
      WHERE alias_type = 'deal-key' AND alias_value = ?`).all(key),
    ...database.prepare('SELECT opportunity_id FROM deal_hunter_opportunity_scores WHERE deal_key = ?').all(key),
  ].map((row) => row.opportunity_id));
  const metadataKey = metadata.dealHunter?.dealKey ?? '';
  if (typeof metadataKey !== 'string') return reject('restore-identity-conflict');
  if (metadataKey) {
    const owners = keyOwners(metadataKey);
    if (owners.size !== 1) return reject('restore-identity-conflict');
    candidates.add([...owners][0]);
  }
  const boundPasses = database.prepare(`SELECT * FROM deal_hunter_dispositions
    WHERE submission_id = ? AND disposition = 'dismissed' ORDER BY id`).all(payload.id);
  for (const row of boundPasses) {
    const owners = keyOwners(row.deal_key);
    if (owners.size !== 1) return reject('restore-identity-conflict');
    candidates.add([...owners][0]);
  }
  if (candidates.size > 1) return reject('restore-identity-conflict');
  const opportunityId = [...candidates][0] || null;
  let dispositions = [];
  if (opportunityId) {
    const opportunity = database.prepare('SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ?').get(opportunityId);
    if (!opportunity || opportunity.status !== 'active' || opportunity.primary_submission_id !== payload.id) {
      return reject('restore-identity-conflict');
    }
    const keys = new Set([
      ...database.prepare(`SELECT alias_value AS deal_key FROM deal_hunter_opportunity_aliases
        WHERE opportunity_id = ? AND alias_type = 'deal-key'`).all(opportunityId),
      ...database.prepare('SELECT deal_key FROM deal_hunter_opportunity_scores WHERE opportunity_id = ?').all(opportunityId),
    ].map((row) => row.deal_key).filter(Boolean));
    for (const key of keys) {
      if ([...keyOwners(key)].some((id) => id !== opportunityId)) return reject('restore-identity-conflict');
      const disposition = database.prepare('SELECT * FROM deal_hunter_dispositions WHERE deal_key = ?').get(key);
      if (disposition?.disposition === 'dismissed') {
        if (disposition.submission_id && disposition.submission_id !== payload.id) return reject('restore-identity-conflict');
        dispositions.push(disposition);
      }
    }
  } else if (boundPasses.length) return reject('restore-identity-conflict');

  dispositions.sort((left, right) => left.id.localeCompare(right.id));
  const previousCommand = metadata.acquisitionCommand;
  const commandTime = passProjectionTime(previousCommand?.updatedAt);
  // Only clear the projection generated by one of the exact Passes restored
  // here. Other feedback, diligence decisions and metadata remain unchanged.
  if (previousCommand?.pipelineStage === 'passed' && Number.isFinite(commandTime) && dispositions.some((row) => (
    row.reason === previousCommand.passReason && passProjectionTime(row.dismissed_at) === commandTime
  ))) {
    metadata.acquisitionCommand = { ...previousCommand };
    delete metadata.acquisitionCommand.pipelineStage;
    delete metadata.acquisitionCommand.passReason;
    if (metadata.acquisitionCommand.fitFeedback === 'false-positive') delete metadata.acquisitionCommand.fitFeedback;
  }
  for (const row of dispositions) database.prepare(`UPDATE deal_hunter_dispositions
    SET disposition = 'restored', updated_at = ?, updated_by = ?, restored_at = ?, restored_by = ?
    WHERE id = ? AND disposition = 'dismissed'`)
    .run(activity.created_at, activity.actor, activity.created_at, activity.actor, row.id);
  database.prepare(`UPDATE contact_submissions SET status = ?, updated_at = ?, status_updated_at = ?,
    restored_at = ?, restored_by = ?, follow_up_state = 'completed', next_action_at = NULL, metadata = ?
    WHERE id = ? AND status = 'archived' AND updated_at = ?`)
    .run(payload.status, activity.created_at, activity.created_at, activity.created_at, activity.actor,
      JSON.stringify(metadata), payload.id, payload.expectedUpdatedAt);
  return { applied: true, opportunityId,
    record: database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(payload.id),
    metadata: { ...activity.metadata, restoredCanonicalOpportunityId: opportunityId,
      restoredDispositionIds: dispositions.map((row) => row.id),
      previousAcquisitionCommand: previousCommand || null, outreachRestarted: false, permissionChanged: false },
  };
}
