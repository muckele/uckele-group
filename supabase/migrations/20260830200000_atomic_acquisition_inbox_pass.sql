create or replace function public.pass_deal_hunter_opportunity(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_opportunity public.deal_hunter_opportunities;
  v_score public.deal_hunter_opportunity_scores;
  v_disposition public.deal_hunter_dispositions;
  v_submission public.contact_submissions;
  v_now timestamptz := coalesce(nullif(p_command->>'occurred_at', '')::timestamptz, now());
  v_actor text := coalesce(nullif(p_command->>'actor', ''), 'admin');
  v_reason text := nullif(p_command->>'reason', '');
  v_note text := nullif(p_command->>'note', '');
  v_archived boolean := false;
  v_archive_submission boolean := false;
begin
  if nullif(p_command->>'opportunity_id', '') is null
    or v_reason is null
    or nullif(p_command->>'disposition_id', '') is null
    or nullif(p_command->>'archive_activity_id', '') is null
    or nullif(p_command->>'triage_activity_id', '') is null then
    raise exception 'Atomic opportunity Pass command is incomplete';
  end if;

  select * into v_opportunity
  from public.deal_hunter_opportunities
  where opportunity_id = p_command->>'opportunity_id'
  for update;
  if not found or v_opportunity.status <> 'active' then
    return jsonb_build_object('applied', false, 'reason', 'not-current');
  end if;

  select * into v_score
  from public.deal_hunter_opportunity_scores
  where opportunity_id = v_opportunity.opportunity_id
    and current_triage_eligible = true
  for update;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'not-current');
  end if;
  if v_score.should_remove then
    return jsonb_build_object('applied', false, 'reason', 'not-actionable');
  end if;

  select * into v_disposition
  from public.deal_hunter_dispositions
  where deal_key = v_score.deal_key
  for update;
  if found and v_disposition.disposition = 'dismissed' then
    return jsonb_build_object(
      'applied', false,
      'reason', 'already-passed',
      'disposition', to_jsonb(v_disposition),
      'score', to_jsonb(v_score)
    );
  end if;

  if v_opportunity.primary_submission_id is not null then
    select * into v_submission
    from public.contact_submissions
    where id = v_opportunity.primary_submission_id
    for update;
    if not found then
      return jsonb_build_object('applied', false, 'reason', 'linked-submission-missing');
    end if;
    v_archive_submission := v_submission.status <> 'archived';
    v_archived := true;
  end if;

  if v_archive_submission and exists (
    select 1
    from public.deal_hunter_cim_requests as request
    where request.submission_id = v_submission.id
      and (
        (request.status = 'pending' and request.updated_at > v_now - interval '10 minutes')
        or (request.status = 'follow_up_pending' and request.updated_at > v_now - interval '30 minutes')
      )
  ) then
    return jsonb_build_object('applied', false, 'reason', 'cim-send-in-progress');
  end if;

  if v_archive_submission then
    update public.contact_submissions
    set
      updated_at = v_now,
      status = 'archived',
      status_updated_at = v_now,
      follow_up_state = 'completed',
      next_action_at = null,
      archived_at = v_now,
      archived_by = v_actor,
      archive_reason = v_reason,
      archive_note = v_note,
      archive_communication_id = null,
      metadata = coalesce(v_submission.metadata, '{}'::jsonb) || jsonb_build_object(
        'acquisitionCommand', coalesce(v_submission.metadata->'acquisitionCommand', '{}'::jsonb) || jsonb_build_object(
          'pipelineStage', 'passed',
          'passReason', v_reason,
          'fitFeedback', 'false-positive',
          'updatedAt', v_now,
          'updatedBy', v_actor
        ),
        'leadArchive', jsonb_build_object(
          'previousStatus', v_submission.status,
          'archivedAt', v_now,
          'archivedBy', v_actor,
          'reason', v_reason,
          'communicationId', ''
        )
      )
    where id = v_submission.id
    returning * into v_submission;

    update public.deal_hunter_cim_requests
    set
      request_state = case when request_state = 'responded' then request_state else 'stopped' end,
      follow_up_state = case when request_state = 'responded' then 'completed' else 'stopped' end,
      next_follow_up_at = null,
      updated_at = v_now,
      last_activity_at = v_now
    where submission_id = v_submission.id;
  end if;

  insert into public.deal_hunter_dispositions as disposition (
    id, deal_key, submission_id, communication_id, listing_url, deal_name,
    created_at, updated_at, disposition, reason, note, dismissed_at,
    dismissed_by, restored_at, restored_by, created_by, updated_by, metadata
  ) values (
    (p_command->>'disposition_id')::uuid,
    v_score.deal_key,
    v_opportunity.primary_submission_id,
    null,
    nullif(v_score.listing_url, ''),
    coalesce(nullif(v_score.name, ''), nullif(v_opportunity.canonical_name, '')),
    v_now, v_now, 'dismissed', v_reason, v_note, v_now,
    v_actor, null, null, v_actor, v_actor, '{}'::jsonb
  )
  on conflict (deal_key) do update set
    submission_id = excluded.submission_id,
    communication_id = excluded.communication_id,
    listing_url = coalesce(excluded.listing_url, disposition.listing_url),
    deal_name = coalesce(excluded.deal_name, disposition.deal_name),
    updated_at = excluded.updated_at,
    disposition = excluded.disposition,
    reason = excluded.reason,
    note = excluded.note,
    dismissed_at = coalesce(excluded.dismissed_at, disposition.dismissed_at),
    dismissed_by = coalesce(excluded.dismissed_by, disposition.dismissed_by),
    restored_at = excluded.restored_at,
    restored_by = excluded.restored_by,
    updated_by = excluded.updated_by,
    metadata = excluded.metadata
  returning * into v_disposition;

  update public.deal_hunter_opportunity_scores
  set
    reviewed_at = v_now,
    reviewed_by = v_actor,
    reviewed_fingerprint = score_fingerprint,
    reviewed_semantic_digest = semantic_digest,
    operator_updated_at = v_now
  where opportunity_id = v_opportunity.opportunity_id
    and current_triage_eligible = true
  returning * into v_score;
  if not found then
    raise exception 'Current opportunity score changed during Pass';
  end if;

  if v_opportunity.primary_submission_id is not null then
    if v_archive_submission then
      insert into public.crm_activity_events (
        id, submission_id, opportunity_id, created_at, actor, role, event_type, summary, metadata
      ) values (
        (p_command->>'archive_activity_id')::uuid,
        v_submission.id,
        v_opportunity.opportunity_id,
        v_now,
        v_actor,
        'admin',
        'submission.archived',
        'Lead archived: ' || replace(v_reason, '-', ' ') || '.',
        jsonb_build_object(
          'archiveReason', v_reason,
          'communicationId', '',
          'previousStatus', coalesce(v_submission.metadata->'leadArchive'->>'previousStatus', ''),
          'dealKey', v_score.deal_key,
          'dispositionId', v_disposition.id
        )
      );
    end if;
    insert into public.crm_activity_events (
      id, submission_id, opportunity_id, created_at, actor, role, event_type, summary, metadata
    ) values (
      (p_command->>'triage_activity_id')::uuid,
      v_submission.id,
      v_opportunity.opportunity_id,
      v_now,
      v_actor,
      'admin',
      'opportunity.triaged',
      'Operator triage: marked reviewed, passed.',
      jsonb_build_object(
        'markedReviewed', true,
        'reviewedFingerprint', v_score.reviewed_fingerprint,
        'fitScoreAtDecision', v_score.fit_score,
        'dispositionId', v_disposition.id
      )
    );
  end if;

  return jsonb_build_object(
    'applied', true,
    'reason', '',
    'disposition', to_jsonb(v_disposition),
    'score', to_jsonb(v_score),
    'submission', case when v_opportunity.primary_submission_id is null then null else to_jsonb(v_submission) end,
    'archived', v_archived
  );
end;
$$;

create or replace function public.set_deal_hunter_opportunity_operator_decision(
  p_opportunity_id text,
  p_decision jsonb
)
returns public.deal_hunter_opportunity_scores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_score public.deal_hunter_opportunity_scores;
  v_opportunity_status text;
begin
  select status into v_opportunity_status
  from public.deal_hunter_opportunities
  where opportunity_id = p_opportunity_id
  for update;
  if not found then
    return null;
  end if;
  if v_opportunity_status <> 'active' then
    raise exception 'canonical opportunity is superseded or otherwise not current';
  end if;

  select * into v_score
  from public.deal_hunter_opportunity_scores
  where opportunity_id = p_opportunity_id
  for update;
  if not found then
    return null;
  end if;

  perform 1
  from public.deal_hunter_dispositions as disposition
  where disposition.deal_key = v_score.deal_key
    and disposition.disposition = 'dismissed'
  for update;
  if found then
    raise exception 'This opportunity has already been passed and is durably dismissed';
  end if;

  update public.deal_hunter_opportunity_scores
  set operator_priority = case when p_decision ? 'operator_priority' then p_decision->>'operator_priority' else operator_priority end,
      operator_note = case when p_decision ? 'operator_note' then p_decision->>'operator_note' else operator_note end,
      reviewed_at = case when p_decision ? 'reviewed_at' then (p_decision->>'reviewed_at')::timestamptz else reviewed_at end,
      reviewed_by = case when p_decision ? 'reviewed_by' then p_decision->>'reviewed_by' else reviewed_by end,
      reviewed_fingerprint = case when p_decision ? 'reviewed_fingerprint' then p_decision->>'reviewed_fingerprint' else reviewed_fingerprint end,
      reviewed_semantic_digest = case when p_decision ? 'reviewed_semantic_digest' then p_decision->>'reviewed_semantic_digest' else reviewed_semantic_digest end,
      operator_updated_at = coalesce((p_decision->>'operator_updated_at')::timestamptz, now())
  where opportunity_id = p_opportunity_id
  returning * into v_score;
  return v_score;
end;
$$;

revoke all privileges on function public.pass_deal_hunter_opportunity(jsonb) from public, anon, authenticated;
revoke all privileges on function public.set_deal_hunter_opportunity_operator_decision(text, jsonb) from public, anon, authenticated;
grant execute on function public.pass_deal_hunter_opportunity(jsonb) to service_role;
grant execute on function public.set_deal_hunter_opportunity_operator_decision(text, jsonb) to service_role;
