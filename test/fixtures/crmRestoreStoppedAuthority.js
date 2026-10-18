// Synthetic, terminal authority shared by SQLite and disposable PostgreSQL tests.
export const restoreProtectedTables = [
  'email_suppressions', 'deal_hunter_owner_decision_events', 'deal_hunter_pursuit_enrollments',
  'deal_hunter_broker_conversations', 'deal_hunter_cim_campaigns', 'deal_hunter_cim_requests',
  'deal_hunter_cim_capability_activations', 'deal_hunter_cim_capacity_reservations',
  'deal_hunter_cim_live_provider_authorizations', 'deal_hunter_cim_transmissions', 'crm_email_outbox',
];

export function stoppedRestoreAuthoritySql(submissionId, opportunityId) {
  const submission = `'${submissionId.replaceAll("'", "''")}'`;
  const opportunity = `'${opportunityId.replaceAll("'", "''")}'`;
  const digest = `'${'a'.repeat(64)}'`;
  const at = "'2026-10-18T10:00:00.000Z'";
  return `
    INSERT INTO deal_hunter_owner_decision_events
      (id,idempotency_key,request_digest,opportunity_id,action,actor,expected_discovery_revision,
       expected_material_revision,observed_discovery_revision,observed_material_revision,policy_version,created_at)
      VALUES ('retained-decision','11111111-3333-4333-8333-111111111111',${digest},${opportunity},
        'pursue','fixture-owner',0,0,0,0,'synthetic',${at});
    INSERT INTO deal_hunter_pursuit_enrollments
      (id,decision_event_id,opportunity_id,state,reason_code,authority_digest,created_at,updated_at)
      VALUES ('retained-enrollment','retained-decision',${opportunity},'campaign-created','crm_archived',${digest},${at},${at});
    INSERT INTO deal_hunter_opportunity_timezone_revisions
      (opportunity_id,revision,state,iana_timezone,evidence_type,evidence_id,evidence_digest,
       resolver_version,dataset_digest,actor,created_at)
      VALUES (${opportunity},1,'verified','America/Chicago','operator-verified','synthetic-timezone',
        ${digest},'synthetic',${digest},'fixture-owner',${at});
    INSERT INTO deal_hunter_broker_conversations
      (id,recipient_authority_id,recipient_fingerprint,recipient_address,sender_policy_version,
       reply_policy_version,reply_alias_token_digest,rfc_thread_key,state,terminal_revision,
       batching_policy_version,created_at,updated_at)
      VALUES ('retained-conversation','synthetic-contact',${digest},'broker@example.test',
        'synthetic','synthetic',${digest},'synthetic-thread','stopped',1,'synthetic',${at},${at});
    INSERT INTO deal_hunter_cim_campaigns
      (id,opportunity_id,generation,enrollment_id,decision_event_id,policy_version,template_version,
       template_digest,permission_version,permission_digest,permission_revision,permission_scope,
       canonical_revision,crm_submission_id,crm_ownership_revision,recipient_authority_id,
       recipient_fingerprint,freshness_authority_digest,discovery_revision,material_revision,
       timezone_revision,conversation_id,state,reason_code,terminal_revision,created_at,updated_at)
      VALUES ('retained-campaign',${opportunity},1,'retained-enrollment','retained-decision',
        'synthetic','synthetic',${digest},'synthetic-permission',${digest},1,'synthetic-scope',
        0,${submission},1,'synthetic-contact',${digest},${digest},0,0,1,'retained-conversation',
        'stopped','crm_archived',1,${at},${at});
    INSERT INTO deal_hunter_cim_requests
      (id,created_at,updated_at,opportunity_id,deal_key,recipient_email,status,submission_id,
       request_state,delivery_state,follow_up_state,follow_up_count,first_requested_at,metadata)
      VALUES ('retained-request',${at},${at},${opportunity},'retained-request-key','broker@example.test',
        'sent',${submission},'stopped','accepted','stopped',5,${at},'{}');
    INSERT INTO deal_hunter_cim_capability_activations
      (id,capability,mode,status,policy_hash,config_hash,actor,reason,confirmation,daily_cap,
       recipient_cap,provider_profile,created_at,updated_at)
      VALUES ('retained-permission','fl04a-safety','off','current',${digest},${digest},'fixture-owner',
        'Synthetic offline authority only','synthetic',2,1,'synthetic',${at},${at});
    INSERT INTO email_suppressions
      (id,normalized_email,reason,source,created_at,created_by,metadata)
      VALUES ('11111111-4444-4444-8444-111111111111','broker@example.test','unsubscribed',
        'synthetic-fixture',${at},'fixture-owner','{"optOutEvidence":"retained"}');
  `;
}
