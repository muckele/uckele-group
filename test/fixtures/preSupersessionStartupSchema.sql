-- Exact empty SQLite startup schema captured from runtime baseline cec88c5a37a5dc433896ee5fd737d606691a3f31.

-- Generated with Node v22.23.2 and the repository lockfile; supersession objects do not exist yet.

PRAGMA foreign_keys = OFF;

CREATE TABLE admin_audit_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      request_id TEXT,
      actor TEXT NOT NULL,
      role TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

CREATE TABLE admin_magic_links (
      token_hash TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      requested_ip_hash TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

CREATE TABLE admin_onboarding_progress (
      principal_id TEXT NOT NULL,
      tour_key TEXT NOT NULL,
      tour_version INTEGER NOT NULL CHECK (tour_version > 0),
      status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'skipped')),
      last_completed_step_id TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      skipped_at TEXT,
      PRIMARY KEY (principal_id, tour_key, tour_version),
      CHECK (
        (status = 'in_progress' AND completed_at IS NULL AND skipped_at IS NULL)
        OR (status = 'completed' AND completed_at IS NOT NULL AND skipped_at IS NULL)
        OR (status = 'skipped' AND completed_at IS NULL AND skipped_at IS NOT NULL)
      )
    );

CREATE TABLE admin_sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT,
      username TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_ip_hash TEXT,
      user_agent TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

CREATE TABLE analytics_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      event_name TEXT NOT NULL,
      path TEXT NOT NULL,
      referrer_host TEXT NOT NULL DEFAULT '',
      utm_source TEXT NOT NULL DEFAULT '',
      utm_medium TEXT NOT NULL DEFAULT '',
      utm_campaign TEXT NOT NULL DEFAULT '',
      placement TEXT NOT NULL DEFAULT ''
    );

CREATE TABLE contact_rate_limit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bucket TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

CREATE TABLE contact_submissions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      spam_score INTEGER NOT NULL DEFAULT 0,
      spam_reasons TEXT NOT NULL DEFAULT '[]',
      delivery_provider TEXT NOT NULL,
      delivery_status TEXT NOT NULL,
      delivery_error TEXT,
      crm_status TEXT NOT NULL,
      crm_error TEXT,
      source TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      user_agent TEXT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      company TEXT,
      role TEXT,
      message TEXT NOT NULL,
      status_updated_at TEXT,
      listing_url TEXT,
      business_website TEXT,
      prospectus_url TEXT,
      asking_price TEXT,
      ttm_revenue TEXT,
      ttm_ebitda TEXT,
      ebitda_multiple TEXT,
      net_margin TEXT,
      business_age TEXT,
      sba_eligible TEXT NOT NULL DEFAULT 'unknown',
      broker_name TEXT,
      broker_email TEXT,
      broker_phone TEXT,
      seller_name TEXT,
      seller_email TEXT,
      seller_phone TEXT,
      archived_at TEXT,
      archived_by TEXT,
      archive_reason TEXT,
      archive_note TEXT,
      archive_communication_id TEXT,
      restored_at TEXT,
      restored_by TEXT,
      deal_hunter_opportunity_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    , lead_type TEXT NOT NULL DEFAULT 'owner', priority TEXT NOT NULL DEFAULT 'normal', tags TEXT NOT NULL DEFAULT '[]', assigned_to TEXT, notes TEXT, follow_up_state TEXT NOT NULL DEFAULT 'needs-response', next_action_at TEXT, last_contacted_at TEXT);

CREATE TABLE crm_activity_events (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      actor TEXT NOT NULL,
      role TEXT NOT NULL,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    , opportunity_id TEXT);

CREATE TABLE crm_communications (
      id TEXT PRIMARY KEY,
      submission_id TEXT,
      deal_key TEXT,
      cim_request_id TEXT,
      direction TEXT NOT NULL,
      channel TEXT NOT NULL,
      source TEXT NOT NULL,
      kind TEXT,
      provider TEXT,
      provider_message_id TEXT,
      source_event_id TEXT,
      idempotency_key TEXT,
      message_id TEXT,
      in_reply_to TEXT,
      references_json TEXT NOT NULL DEFAULT '[]',
      parent_communication_id TEXT,
      thread_key TEXT,
      legacy_content_unavailable INTEGER NOT NULL DEFAULT 0,
      content_redaction_state TEXT NOT NULL DEFAULT 'none',
      recommendation_id TEXT,
      outbox_id TEXT,
      headers_json TEXT NOT NULL DEFAULT '{}',
      reply_to_address TEXT,
      from_address TEXT,
      to_addresses TEXT NOT NULL DEFAULT '[]',
      cc_addresses TEXT NOT NULL DEFAULT '[]',
      bcc_addresses TEXT NOT NULL DEFAULT '[]',
      subject TEXT,
      body_text TEXT NOT NULL DEFAULT '',
      body_html_sanitized TEXT NOT NULL DEFAULT '',
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivery_state TEXT NOT NULL DEFAULT 'not-attempted',
      delivery_state_at TEXT,
      content_state TEXT NOT NULL DEFAULT 'not-applicable',
      content_attempt_count INTEGER NOT NULL DEFAULT 0,
      content_last_error TEXT,
      content_next_attempt_at TEXT,
      attachment_metadata TEXT NOT NULL DEFAULT '[]',
      assigned_at TEXT,
      assigned_by TEXT,
      created_by TEXT NOT NULL DEFAULT 'system',
      updated_by TEXT NOT NULL DEFAULT 'system',
      metadata TEXT NOT NULL DEFAULT '{}'
    , opportunity_id TEXT);

CREATE TABLE crm_email_outbox (
      id TEXT PRIMARY KEY,
      communication_id TEXT NOT NULL UNIQUE,
      submission_id TEXT NOT NULL,
      cim_request_id TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      client_request_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      provider TEXT,
      provider_message_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      claim_token TEXT,
      claimed_at TEXT,
      claim_expires_at TEXT,
      accepted_at TEXT,
      failed_at TEXT,
      ambiguous_at TEXT,
      last_error_category TEXT,
      last_error_message TEXT,
      expected_submission_version TEXT NOT NULL,
      actor TEXT NOT NULL,
      intended_follow_up_state TEXT,
      intended_next_action_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

CREATE TABLE crm_follow_up_recommendations (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      cim_request_id TEXT,
      triggering_communication_id TEXT,
      input_fingerprint TEXT NOT NULL,
      engine_version TEXT NOT NULL,
      rules_version TEXT NOT NULL,
      model_provider TEXT,
      model_id TEXT,
      status TEXT NOT NULL,
      conversation_state TEXT NOT NULL,
      intent TEXT NOT NULL,
      action_type TEXT NOT NULL,
      priority_score INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0,
      recommended_next_action_at TEXT,
      thread_parent_communication_id TEXT,
      rationale TEXT NOT NULL DEFAULT '',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      signals_json TEXT NOT NULL DEFAULT '[]',
      commitments_json TEXT NOT NULL DEFAULT '[]',
      questions_json TEXT NOT NULL DEFAULT '[]',
      blockers_json TEXT NOT NULL DEFAULT '[]',
      safety_flags_json TEXT NOT NULL DEFAULT '[]',
      draft_subject TEXT NOT NULL DEFAULT '',
      draft_body_text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      expires_at TEXT,
      acted_on_at TEXT,
      superseded_at TEXT,
      acted_on_by TEXT,
      outcome TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

CREATE TABLE deal_hunter_automation_settings (
        id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0,
        updated_by TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

CREATE TABLE deal_hunter_cim_opportunity_claims (
        opportunity_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        recipient_email TEXT NOT NULL,
        state TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

CREATE TABLE deal_hunter_cim_recipient_claims (
        recipient_email TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        opportunity_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

CREATE TABLE deal_hunter_cim_recipient_overrides (
        id TEXT PRIMARY KEY,
        opportunity_id TEXT NOT NULL,
        recipient_email TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_by TEXT NOT NULL,
        reason TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

CREATE TABLE deal_hunter_cim_repair_manifests (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        actor TEXT NOT NULL,
        backup_reference TEXT,
        checksum TEXT NOT NULL,
        manifest TEXT NOT NULL DEFAULT '{}',
        metadata TEXT NOT NULL DEFAULT '{}'
      );

CREATE TABLE deal_hunter_cim_requests (
	      id TEXT PRIMARY KEY,
	      created_at TEXT NOT NULL,
	      updated_at TEXT NOT NULL,
      deal_key TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      requested_by TEXT,
      status TEXT NOT NULL,
      delivery_error TEXT,
      provider_message_id TEXT,
      subject TEXT,
      deal_name TEXT,
      source_name TEXT,
      listing_url TEXT,
      score INTEGER,
      follow_up_count INTEGER NOT NULL DEFAULT 0,
      last_follow_up_at TEXT,
      next_follow_up_at TEXT,
	      responded_at TEXT,
	      submission_id TEXT,
	      request_state TEXT,
	      delivery_state TEXT,
	      delivery_state_at TEXT,
	      follow_up_state TEXT,
	      first_requested_at TEXT,
	      first_provider_accepted_at TEXT,
	      delivered_at TEXT,
	      last_attempt_at TEXT,
	      last_delivery_event_at TEXT,
	      reply_to_address TEXT,
	      retry_of_request_id TEXT,
	      attempt_count INTEGER,
	      last_activity_at TEXT,
		      metadata TEXT NOT NULL DEFAULT '{}'
		    , opportunity_id TEXT);

CREATE TABLE deal_hunter_cim_reviews (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        deal_key TEXT NOT NULL,
        decision TEXT NOT NULL,
        pass_reason TEXT,
        original_recipient_email TEXT,
        final_recipient_email TEXT,
        recipient_edited INTEGER NOT NULL DEFAULT 0,
        score INTEGER,
        actor TEXT,
        automation_stage INTEGER NOT NULL DEFAULT 1,
        metadata TEXT NOT NULL DEFAULT '{}'
      , opportunity_id TEXT, snapshot_digest TEXT, evidence_version TEXT, rule_version TEXT, source_policy_version TEXT, source_policy_hash TEXT, source_ids TEXT NOT NULL DEFAULT '[]', actor_role TEXT, decision_at TEXT);

CREATE TABLE deal_hunter_cim_safety_settings (
        id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        outreach_paused INTEGER NOT NULL DEFAULT 0,
        updated_by TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

CREATE TABLE deal_hunter_cim_stage2_activations (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        confirmation_phrase TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        source_policy_version TEXT NOT NULL,
        source_policy_hash TEXT NOT NULL,
        evidence_checksum TEXT NOT NULL,
        evidence_generated_at TEXT NOT NULL,
        backup_reference TEXT NOT NULL,
        backup_checksum TEXT NOT NULL,
        identity_audit_reference TEXT NOT NULL,
        identity_audit_checksum TEXT NOT NULL,
        compliance_reference TEXT NOT NULL,
        sender_auth_reference TEXT NOT NULL,
        timezone TEXT NOT NULL,
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        weekdays_only INTEGER NOT NULL DEFAULT 1,
        canary_daily_cap INTEGER NOT NULL,
        active_daily_cap INTEGER NOT NULL,
        recipient_cap_24_hours INTEGER NOT NULL,
        recipient_cap_30_days INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        superseded_at TEXT,
        superseded_by TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

CREATE TABLE deal_hunter_cim_stage2_decisions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        opportunity_id TEXT NOT NULL,
        deal_key TEXT NOT NULL,
        decision_state TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        source_policy_hash TEXT NOT NULL,
        activation_id TEXT,
        snapshot_digest TEXT NOT NULL,
        recipient_hash TEXT NOT NULL,
        source_snapshot_digest TEXT NOT NULL,
        reasons TEXT NOT NULL DEFAULT '[]',
        claim_token TEXT,
        claimed_at TEXT,
        consumed_at TEXT,
        cim_request_id TEXT,
        communication_id TEXT,
        provider_state TEXT,
        last_error TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        UNIQUE(run_id, opportunity_id, policy_hash)
      );

CREATE TABLE deal_hunter_cim_stage2_runs (
        id TEXT PRIMARY KEY,
        run_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        pacific_business_date TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        triggered_by TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        source_policy_hash TEXT NOT NULL,
        activation_id TEXT,
        considered_count INTEGER NOT NULL DEFAULT 0,
        eligible_count INTEGER NOT NULL DEFAULT 0,
        would_send_count INTEGER NOT NULL DEFAULT 0,
        attempted_count INTEGER NOT NULL DEFAULT 0,
        accepted_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        ambiguous_count INTEGER NOT NULL DEFAULT 0,
        deferred_count INTEGER NOT NULL DEFAULT 0,
        blocked_counts TEXT NOT NULL DEFAULT '{}',
        last_error TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

CREATE TABLE deal_hunter_crm_imports (
	      id TEXT PRIMARY KEY,
	      created_at TEXT NOT NULL,
	      updated_at TEXT NOT NULL,
	      deal_key TEXT NOT NULL,
	      listing_identity TEXT,
	      listing_url TEXT,
	      submission_id TEXT,
	      status TEXT NOT NULL,
	      source_name TEXT,
		      metadata TEXT NOT NULL DEFAULT '{}'
		    , opportunity_id TEXT);

CREATE TABLE deal_hunter_crm_reconciliation_items (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        opportunity_id TEXT NOT NULL,
        deal_key TEXT,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        submission_id TEXT,
        source_row_numbers TEXT NOT NULL DEFAULT '[]',
        planned_changes TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        UNIQUE(run_id, opportunity_id),
        FOREIGN KEY(run_id) REFERENCES deal_hunter_crm_reconciliation_runs(id) ON DELETE CASCADE
      );

CREATE TABLE deal_hunter_crm_reconciliation_runs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        import_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        plan_digest TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        requested_by TEXT,
        counts TEXT NOT NULL DEFAULT '{}',
        plan TEXT NOT NULL DEFAULT '{}',
        results TEXT NOT NULL DEFAULT '{}',
        last_error TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

CREATE TABLE deal_hunter_deal_os_imports (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      imported_by TEXT NOT NULL,
      exported_at TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      file_sha256 TEXT NOT NULL,
      scope TEXT NOT NULL,
      coverage_label TEXT NOT NULL,
      expected_row_count INTEGER,
      row_count INTEGER NOT NULL,
      source_row_count INTEGER NOT NULL DEFAULT 0,
      accepted_row_count INTEGER NOT NULL DEFAULT 0,
      rejected_row_count INTEGER NOT NULL DEFAULT 0,
      canonical_record_count INTEGER NOT NULL DEFAULT 0,
      parser_version TEXT NOT NULL DEFAULT 'deal-os-export-v1',
      row_accounting TEXT NOT NULL DEFAULT '[]',
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      stable_id_count INTEGER NOT NULL DEFAULT 0,
      listing_url_count INTEGER NOT NULL DEFAULT 0,
      coverage_limit_reached INTEGER NOT NULL DEFAULT 0,
      records TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}'
    );

CREATE TABLE deal_hunter_dispositions (
        id TEXT PRIMARY KEY,
        deal_key TEXT NOT NULL UNIQUE,
        submission_id TEXT,
        communication_id TEXT,
        listing_url TEXT,
        deal_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        disposition TEXT NOT NULL,
        reason TEXT,
        note TEXT,
        dismissed_at TEXT,
        dismissed_by TEXT,
        restored_at TEXT,
        restored_by TEXT,
        created_by TEXT NOT NULL DEFAULT 'system',
        updated_by TEXT NOT NULL DEFAULT 'system',
        metadata TEXT NOT NULL DEFAULT '{}'
      );

CREATE TABLE deal_hunter_identity_exceptions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        observed_deal_key TEXT,
        observed_name TEXT,
        observed_recipient TEXT,
        candidate_opportunity_ids TEXT NOT NULL DEFAULT '[]',
        reason TEXT NOT NULL,
        evidence_version TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        resolution_reason TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

CREATE TABLE deal_hunter_opportunities (
        opportunity_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        canonical_recipient TEXT,
        canonical_location TEXT,
        primary_submission_id TEXT,
        identity_version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        metadata TEXT NOT NULL DEFAULT '{}'
      );

CREATE TABLE deal_hunter_opportunity_aliases (
        id TEXT PRIMARY KEY,
        opportunity_id TEXT NOT NULL,
        alias_type TEXT NOT NULL,
        alias_value TEXT NOT NULL,
        alias_key TEXT NOT NULL UNIQUE,
        source TEXT,
        first_observed_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        evidence_version TEXT NOT NULL,
        resolution_method TEXT NOT NULL,
        confidence_state TEXT NOT NULL,
        resolved_by TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

CREATE TABLE deal_hunter_opportunity_facts (
        id TEXT PRIMARY KEY,
        opportunity_id TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'operator',
        verified INTEGER NOT NULL DEFAULT 0,
        actor TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(
          id = trim(id) AND length(id) BETWEEN 1 AND 240
          AND opportunity_id = trim(opportunity_id) AND length(opportunity_id) BETWEEN 1 AND 200
          AND field IN ('seller_name', 'seller_email', 'seller_phone', 'broker_name', 'broker_company', 'broker_email', 'broker_phone', 'reason_for_sale', 'real_estate_included', 'seller_financing', 'management_structure', 'customer_concentration', 'operator_contact_notes')
          AND value = trim(value) AND length(value) BETWEEN 1 AND 4000
          AND source = 'operator'
          AND verified IN (0, 1)
          AND actor = trim(actor) AND length(actor) BETWEEN 1 AND 200
          AND (note IS NULL OR (note = trim(note) AND length(note) BETWEEN 1 AND 4000))
          AND created_at = trim(created_at) AND length(created_at) BETWEEN 1 AND 80 AND julianday(created_at) IS NOT NULL
          AND updated_at = trim(updated_at) AND length(updated_at) BETWEEN 1 AND 80 AND julianday(updated_at) IS NOT NULL
        ),
        FOREIGN KEY(opportunity_id) REFERENCES deal_hunter_opportunities(opportunity_id) ON DELETE CASCADE
      );

CREATE TABLE deal_hunter_opportunity_scores (
        opportunity_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        -- machine-owned
        scored_at TEXT NOT NULL,
        deal_key TEXT,
        name TEXT,
        state TEXT,
        listing_url TEXT,
        fit_score INTEGER NOT NULL DEFAULT 0,
        score_status TEXT NOT NULL DEFAULT 'provisional',
        confidence TEXT NOT NULL DEFAULT 'low',
        completeness_score INTEGER NOT NULL DEFAULT 0,
        contradiction_count INTEGER NOT NULL DEFAULT 0,
        missing_evidence_count INTEGER NOT NULL DEFAULT 0,
        should_remove INTEGER NOT NULL DEFAULT 0,
        high_fit INTEGER NOT NULL DEFAULT 0,
        gate_count INTEGER NOT NULL DEFAULT 0,
        score_fingerprint TEXT NOT NULL,
        semantic_digest TEXT,
        engine_version TEXT NOT NULL,
        rules_version TEXT NOT NULL,
        profile_version TEXT NOT NULL,
        completeness_policy_version TEXT NOT NULL,
        dimensions TEXT NOT NULL DEFAULT '[]',
        gates TEXT NOT NULL DEFAULT '[]',
        applied_caps TEXT NOT NULL DEFAULT '[]',
        missing_evidence TEXT NOT NULL DEFAULT '[]',
        confidence_reasons TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL DEFAULT '{}',
        -- complete-set reconciliation-owned
        current_triage_eligible INTEGER NOT NULL DEFAULT 0,
        -- operator-owned
        operator_priority TEXT NOT NULL DEFAULT 'normal',
        operator_note TEXT,
        reviewed_at TEXT,
        reviewed_by TEXT,
        reviewed_fingerprint TEXT,
        reviewed_semantic_digest TEXT,
        operator_updated_at TEXT
      );

CREATE TABLE deal_hunter_opportunity_source_observations (
        id TEXT PRIMARY KEY,
        opportunity_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        source_record_id TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(opportunity_id, source_id, source_record_id, field),
        CHECK(
          length(trim(id)) BETWEEN 1 AND 240 AND id = trim(id)
          AND length(trim(opportunity_id)) BETWEEN 1 AND 200 AND opportunity_id = trim(opportunity_id)
          AND length(trim(source_id)) BETWEEN 1 AND 160 AND source_id = trim(source_id)
          AND length(trim(source_name)) BETWEEN 1 AND 220 AND source_name = trim(source_name)
          AND length(trim(source_record_id)) BETWEEN 1 AND 200 AND source_record_id = trim(source_record_id)
          AND field IN (
            'name', 'business_name', 'industry', 'description', 'city', 'county', 'state', 'country', 'location',
            'annual_profit', 'annual_revenue', 'asking_price', 'profit_multiple', 'net_margin', 'years_established',
            'remote_flag', 'franchise_flag', 'five_years_flag', 'broker_name', 'broker_company', 'broker_contact', 'broker_email',
            'broker_phone', 'company', 'role', 'seller_name', 'seller_email', 'seller_phone', 'reason_for_sale', 'real_estate_included',
            'seller_financing', 'management_structure', 'customer_concentration', 'operator_contact_notes', 'listing_url',
            'listing_source', 'listing_id', 'deal_key', 'source_identity', 'date_added', 'last_updated',
            'business_website', 'prospectus_url', 'ttm_revenue', 'ttm_ebitda', 'ebitda_multiple', 'business_age',
            'sba_eligible', 'lead_type'
          )
          AND length(trim(value)) BETWEEN 1 AND 5000 AND value = trim(value)
        ),
        FOREIGN KEY(opportunity_id) REFERENCES deal_hunter_opportunities(opportunity_id) ON DELETE CASCADE
      );

CREATE TABLE deal_hunter_score_evidence (
        id TEXT PRIMARY KEY,
        opportunity_id TEXT NOT NULL,
        score_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        dimension TEXT,
        rule_id TEXT NOT NULL,
        rule_label TEXT NOT NULL,
        evidence_class TEXT NOT NULL,
        field TEXT,
        value TEXT,
        observed_value TEXT,
        terms TEXT NOT NULL DEFAULT '[]',
        source_id TEXT,
        source_name TEXT,
        source_record_id TEXT,
        listing_url TEXT,
        observed_at TEXT,
        FOREIGN KEY(opportunity_id) REFERENCES deal_hunter_opportunity_scores(opportunity_id) ON DELETE CASCADE
      );

CREATE TABLE deal_hunter_seen_deals (
      id TEXT PRIMARY KEY,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      source_id TEXT,
      source_name TEXT,
      source_mode TEXT,
      external_id TEXT,
      listing_url TEXT,
      name TEXT NOT NULL,
      industry TEXT,
      location TEXT,
      annual_profit REAL,
      annual_revenue REAL,
      asking_price REAL,
      score INTEGER,
      should_remove INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

CREATE TABLE email_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      provider TEXT NOT NULL,
      event_type TEXT NOT NULL,
      message_id TEXT,
      provider_event_id TEXT,
      event_key TEXT,
      recipient_email TEXT,
      subject TEXT,
      submission_id TEXT,
      communication_id TEXT,
      source TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    , opportunity_id TEXT);

CREATE TABLE email_suppressions (
      id TEXT PRIMARY KEY,
      normalized_email TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      source_event_id TEXT,
      source_communication_id TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      lifted_at TEXT,
      lifted_by TEXT,
      lift_reason TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

CREATE TABLE scheduled_job_runs (
      job_key TEXT PRIMARY KEY,
      job_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      triggered_by TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      provider_message_id TEXT,
      last_error TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

CREATE TABLE secure_document_cleanup_jobs (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      trash_directory TEXT,
      files TEXT NOT NULL DEFAULT '[]',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      lease_claimed_at TEXT,
      lease_expires_at TEXT,
      lease_token TEXT
    );

CREATE TABLE secure_documents (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      submission_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      document_type TEXT NOT NULL,
      file_name TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      uploaded_by_email TEXT,
      note TEXT,
      nda_accepted_at TEXT
    );

CREATE TABLE secure_upload_requests (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      email TEXT NOT NULL,
      contact_name TEXT,
      requested_by TEXT,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      nda_required INTEGER NOT NULL DEFAULT 1,
      nda_accepted_at TEXT,
      last_uploaded_at TEXT,
      note TEXT,
      requested_documents TEXT NOT NULL DEFAULT '[]',
      revoked_at TEXT,
      closed_at TEXT,
      upload_batch_count INTEGER NOT NULL DEFAULT 0
    );

CREATE TABLE source_health_snapshots (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      healthy INTEGER NOT NULL DEFAULT 0,
      source_count INTEGER NOT NULL DEFAULT 0,
      issue_count INTEGER NOT NULL DEFAULT 0,
      snapshot TEXT NOT NULL DEFAULT '{}'
    );

CREATE INDEX idx_admin_audit_events_created_at ON admin_audit_events(created_at DESC);

CREATE INDEX idx_admin_magic_links_expires_at ON admin_magic_links(expires_at);

CREATE INDEX idx_admin_onboarding_progress_principal_updated
		  ON admin_onboarding_progress(principal_id, updated_at DESC);

CREATE INDEX idx_admin_sessions_expires_at ON admin_sessions(expires_at);

CREATE INDEX idx_admin_sessions_principal
      ON admin_sessions(principal_id, created_at DESC);

CREATE INDEX idx_admin_sessions_username ON admin_sessions(username, created_at DESC);

CREATE INDEX idx_analytics_events_created_at ON analytics_events(created_at DESC);

CREATE INDEX idx_analytics_events_name_created ON analytics_events(event_name, created_at DESC);

CREATE INDEX idx_analytics_events_path_created ON analytics_events(path, created_at DESC);

CREATE INDEX idx_cim_stage2_activations_created ON deal_hunter_cim_stage2_activations(created_at DESC);

CREATE UNIQUE INDEX idx_cim_stage2_active_opportunity_claim ON deal_hunter_cim_stage2_decisions(opportunity_id)
	      WHERE decision_state IN ('claimed', 'attempting', 'ambiguous');

CREATE INDEX idx_cim_stage2_decisions_evidence ON deal_hunter_cim_stage2_decisions(policy_hash, source_policy_hash, decision_state);

CREATE INDEX idx_cim_stage2_decisions_opportunity ON deal_hunter_cim_stage2_decisions(opportunity_id, created_at DESC);

CREATE INDEX idx_cim_stage2_decisions_run ON deal_hunter_cim_stage2_decisions(run_id, decision_state);

CREATE UNIQUE INDEX idx_cim_stage2_one_current_activation ON deal_hunter_cim_stage2_activations(status) WHERE status = 'current';

CREATE INDEX idx_cim_stage2_runs_date_mode ON deal_hunter_cim_stage2_runs(pacific_business_date DESC, mode, status);

CREATE INDEX idx_cim_stage2_runs_policy ON deal_hunter_cim_stage2_runs(policy_hash, created_at DESC);

CREATE INDEX idx_contact_rate_limit_events_bucket ON contact_rate_limit_events(bucket, created_at DESC);

CREATE INDEX idx_contact_submissions_broker_email_lower ON contact_submissions(LOWER(broker_email));

CREATE INDEX idx_contact_submissions_created_at ON contact_submissions(created_at DESC);

CREATE UNIQUE INDEX idx_contact_submissions_deal_hunter_opportunity
      ON contact_submissions(deal_hunter_opportunity_id)
      WHERE deal_hunter_opportunity_id IS NOT NULL AND deal_hunter_opportunity_id <> '';

CREATE INDEX idx_contact_submissions_email ON contact_submissions(email);

CREATE INDEX idx_contact_submissions_follow_up_queue ON contact_submissions(status, follow_up_state, next_action_at, updated_at DESC);

CREATE INDEX idx_contact_submissions_ip_hash ON contact_submissions(ip_hash);

CREATE INDEX idx_contact_submissions_seller_email_lower ON contact_submissions(LOWER(seller_email));

CREATE INDEX idx_contact_submissions_status ON contact_submissions(status);

CREATE INDEX idx_crm_activity_opportunity ON crm_activity_events(opportunity_id, created_at DESC);

CREATE INDEX idx_crm_activity_submission_created ON crm_activity_events(submission_id, created_at DESC);

CREATE INDEX idx_crm_activity_type_created ON crm_activity_events(event_type, created_at DESC);

CREATE INDEX idx_crm_communications_cim_occurred ON crm_communications(cim_request_id, occurred_at DESC, id DESC);

CREATE INDEX idx_crm_communications_content_retry ON crm_communications(content_state, content_next_attempt_at) WHERE content_state IN ('pending', 'failed');

CREATE INDEX idx_crm_communications_deal_occurred ON crm_communications(deal_key, occurred_at DESC, id DESC);

CREATE UNIQUE INDEX idx_crm_communications_idempotency ON crm_communications(idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';

CREATE UNIQUE INDEX idx_crm_communications_message_id ON crm_communications(message_id) WHERE message_id IS NOT NULL AND message_id <> '';

CREATE INDEX idx_crm_communications_opportunity ON crm_communications(opportunity_id, occurred_at DESC);

CREATE INDEX idx_crm_communications_parent ON crm_communications(parent_communication_id);

CREATE UNIQUE INDEX idx_crm_communications_provider_message ON crm_communications(provider, provider_message_id, direction) WHERE provider IS NOT NULL AND provider_message_id IS NOT NULL AND provider_message_id <> '';

CREATE UNIQUE INDEX idx_crm_communications_source_event ON crm_communications(provider, source_event_id) WHERE provider IS NOT NULL AND source_event_id IS NOT NULL AND source_event_id <> '';

CREATE INDEX idx_crm_communications_submission_occurred ON crm_communications(submission_id, occurred_at DESC, id DESC);

CREATE INDEX idx_crm_communications_thread_occurred ON crm_communications(thread_key, occurred_at DESC, id DESC);

CREATE INDEX idx_crm_communications_unassigned ON crm_communications(occurred_at DESC, id DESC) WHERE submission_id IS NULL AND direction = 'inbound';

CREATE INDEX idx_crm_email_outbox_claimable ON crm_email_outbox(state, next_attempt_at, claim_expires_at);

CREATE INDEX idx_crm_email_outbox_provider_message ON crm_email_outbox(provider_message_id);

CREATE INDEX idx_crm_email_outbox_submission_created ON crm_email_outbox(submission_id, created_at DESC);

CREATE UNIQUE INDEX idx_crm_follow_up_recommendations_cache ON crm_follow_up_recommendations(submission_id, input_fingerprint, engine_version);

CREATE UNIQUE INDEX idx_crm_follow_up_recommendations_one_current
      ON crm_follow_up_recommendations(submission_id) WHERE status = 'current';

CREATE INDEX idx_crm_follow_up_recommendations_submission_created ON crm_follow_up_recommendations(submission_id, created_at DESC);

CREATE INDEX idx_deal_hunter_cim_overrides_lookup ON deal_hunter_cim_recipient_overrides(opportunity_id, recipient_email, expires_at DESC);

CREATE INDEX idx_deal_hunter_cim_requests_deal_key ON deal_hunter_cim_requests(deal_key, updated_at DESC);

CREATE UNIQUE INDEX idx_deal_hunter_cim_requests_deal_recipient ON deal_hunter_cim_requests(deal_key, recipient_email);

CREATE INDEX idx_deal_hunter_cim_requests_delivery_state ON deal_hunter_cim_requests(delivery_state, last_delivery_event_at DESC);

CREATE INDEX idx_deal_hunter_cim_requests_follow_up_state ON deal_hunter_cim_requests(follow_up_state, next_follow_up_at);

CREATE INDEX idx_deal_hunter_cim_requests_opportunity ON deal_hunter_cim_requests(opportunity_id, updated_at DESC);

CREATE UNIQUE INDEX idx_deal_hunter_cim_requests_reply_to ON deal_hunter_cim_requests(LOWER(reply_to_address)) WHERE reply_to_address IS NOT NULL AND reply_to_address <> '';

CREATE INDEX idx_deal_hunter_cim_requests_request_state ON deal_hunter_cim_requests(request_state, first_requested_at DESC);

CREATE INDEX idx_deal_hunter_cim_requests_submission ON deal_hunter_cim_requests(submission_id, last_activity_at DESC);

CREATE INDEX idx_deal_hunter_cim_reviews_created ON deal_hunter_cim_reviews(created_at DESC);

CREATE INDEX idx_deal_hunter_cim_reviews_deal ON deal_hunter_cim_reviews(deal_key, created_at DESC);

CREATE INDEX idx_deal_hunter_cim_reviews_opportunity ON deal_hunter_cim_reviews(opportunity_id, decision_at DESC, created_at DESC);

CREATE INDEX idx_deal_hunter_cim_reviews_policy ON deal_hunter_cim_reviews(rule_version, source_policy_hash, created_at DESC);

CREATE UNIQUE INDEX idx_deal_hunter_crm_imports_deal_key ON deal_hunter_crm_imports(deal_key);

CREATE UNIQUE INDEX idx_deal_hunter_crm_imports_listing_identity ON deal_hunter_crm_imports(listing_identity) WHERE listing_identity IS NOT NULL AND listing_identity <> '';

CREATE INDEX idx_deal_hunter_crm_imports_opportunity ON deal_hunter_crm_imports(opportunity_id, updated_at DESC);

CREATE INDEX idx_deal_hunter_crm_imports_submission_id ON deal_hunter_crm_imports(submission_id);

CREATE UNIQUE INDEX idx_deal_hunter_crm_imports_unique_opportunity
      ON deal_hunter_crm_imports(opportunity_id)
      WHERE opportunity_id IS NOT NULL AND opportunity_id <> '';

CREATE INDEX idx_deal_hunter_crm_reconciliation_items_run
      ON deal_hunter_crm_reconciliation_items(run_id, status, opportunity_id);

CREATE INDEX idx_deal_hunter_crm_reconciliation_runs_import
      ON deal_hunter_crm_reconciliation_runs(import_id, created_at DESC);

CREATE INDEX idx_deal_hunter_deal_os_imports_created_at ON deal_hunter_deal_os_imports(created_at DESC);

CREATE INDEX idx_deal_hunter_deal_os_imports_exported_at ON deal_hunter_deal_os_imports(exported_at DESC);

CREATE INDEX idx_deal_hunter_dispositions_submission ON deal_hunter_dispositions(submission_id, updated_at DESC);

CREATE INDEX idx_deal_hunter_dispositions_updated ON deal_hunter_dispositions(updated_at DESC, id DESC);

CREATE INDEX idx_deal_hunter_identity_exceptions_status ON deal_hunter_identity_exceptions(status, updated_at DESC);

CREATE INDEX idx_deal_hunter_opportunities_recipient ON deal_hunter_opportunities(canonical_recipient, updated_at DESC);

CREATE INDEX idx_deal_hunter_opportunities_updated ON deal_hunter_opportunities(updated_at DESC, opportunity_id);

CREATE INDEX idx_deal_hunter_opportunity_aliases_opportunity ON deal_hunter_opportunity_aliases(opportunity_id, alias_type);

CREATE INDEX idx_deal_hunter_opportunity_facts_history ON deal_hunter_opportunity_facts(opportunity_id, created_at DESC, id DESC);

CREATE INDEX idx_deal_hunter_repair_manifests_created ON deal_hunter_cim_repair_manifests(created_at DESC);

CREATE INDEX idx_deal_hunter_score_evidence_opportunity
      ON deal_hunter_score_evidence(opportunity_id, dimension, evidence_class);

CREATE INDEX idx_deal_hunter_scores_acquisition_priority
      ON deal_hunter_opportunity_scores(
        current_triage_eligible, should_remove, operator_priority, high_fit,
        fit_score DESC, confidence, scored_at DESC, opportunity_id
      );

CREATE INDEX idx_deal_hunter_scores_current_queue
      ON deal_hunter_opportunity_scores(current_triage_eligible, should_remove, fit_score DESC, opportunity_id);

CREATE INDEX idx_deal_hunter_scores_fingerprint
      ON deal_hunter_opportunity_scores(score_fingerprint);

CREATE INDEX idx_deal_hunter_scores_priority
      ON deal_hunter_opportunity_scores(operator_priority, fit_score DESC, opportunity_id);

CREATE INDEX idx_deal_hunter_scores_queue
      ON deal_hunter_opportunity_scores(should_remove, fit_score DESC, confidence, opportunity_id);

CREATE INDEX idx_deal_hunter_seen_deals_last_seen_at ON deal_hunter_seen_deals(last_seen_at DESC);

CREATE INDEX idx_deal_hunter_seen_deals_source_id ON deal_hunter_seen_deals(source_id, last_seen_at DESC);

CREATE INDEX idx_deal_hunter_source_observations_history ON deal_hunter_opportunity_source_observations(opportunity_id, observed_at DESC, id ASC);

CREATE INDEX idx_deal_hunter_source_observations_queue_projection
      ON deal_hunter_opportunity_source_observations(opportunity_id, field, observed_at DESC, id ASC);

CREATE INDEX idx_email_events_communication_id ON email_events(communication_id, created_at DESC);

CREATE UNIQUE INDEX idx_email_events_event_key ON email_events(event_key);

CREATE INDEX idx_email_events_event_type ON email_events(event_type, created_at DESC);

CREATE INDEX idx_email_events_message_id ON email_events(message_id);

CREATE INDEX idx_email_events_opportunity ON email_events(opportunity_id, created_at DESC);

CREATE INDEX idx_email_events_recipient_email ON email_events(recipient_email, created_at DESC);

CREATE INDEX idx_email_events_submission_id ON email_events(submission_id, created_at DESC);

CREATE INDEX idx_email_suppressions_active ON email_suppressions(normalized_email) WHERE lifted_at IS NULL;

CREATE INDEX idx_scheduled_job_runs_name_updated_at ON scheduled_job_runs(job_name, updated_at DESC);

CREATE INDEX idx_secure_document_cleanup_jobs_lease ON secure_document_cleanup_jobs(status, lease_expires_at);

CREATE INDEX idx_secure_document_cleanup_jobs_status ON secure_document_cleanup_jobs(status, updated_at);

CREATE INDEX idx_secure_documents_request_id ON secure_documents(request_id, created_at DESC);

CREATE INDEX idx_secure_documents_submission_id ON secure_documents(submission_id, created_at DESC);

CREATE INDEX idx_secure_upload_requests_submission_id ON secure_upload_requests(submission_id, created_at DESC);

CREATE INDEX idx_source_health_snapshots_created_at ON source_health_snapshots(created_at DESC);

CREATE TRIGGER deal_hunter_opportunity_facts_operator_boundary_insert
      BEFORE INSERT ON deal_hunter_opportunity_facts
      BEGIN
        SELECT CASE WHEN NOT (
          NEW.id = trim(NEW.id) AND length(NEW.id) BETWEEN 1 AND 240
          AND NEW.opportunity_id = trim(NEW.opportunity_id) AND length(NEW.opportunity_id) BETWEEN 1 AND 200
          AND NEW.field IN ('seller_name', 'seller_email', 'seller_phone', 'broker_name', 'broker_company', 'broker_email', 'broker_phone', 'reason_for_sale', 'real_estate_included', 'seller_financing', 'management_structure', 'customer_concentration', 'operator_contact_notes')
          AND NEW.value = trim(NEW.value) AND length(NEW.value) BETWEEN 1 AND 4000
          AND NEW.source = 'operator'
          AND NEW.verified IN (0, 1)
          AND NEW.actor = trim(NEW.actor) AND length(NEW.actor) BETWEEN 1 AND 200
          AND (NEW.note IS NULL OR (NEW.note = trim(NEW.note) AND length(NEW.note) BETWEEN 1 AND 4000))
          AND NEW.created_at = trim(NEW.created_at) AND length(NEW.created_at) BETWEEN 1 AND 80 AND julianday(NEW.created_at) IS NOT NULL
          AND NEW.updated_at = trim(NEW.updated_at) AND length(NEW.updated_at) BETWEEN 1 AND 80 AND julianday(NEW.updated_at) IS NOT NULL
        ) THEN RAISE(ABORT, 'invalid operator opportunity fact') END;
      END;

CREATE TRIGGER deal_hunter_opportunity_facts_operator_boundary_update
      BEFORE UPDATE ON deal_hunter_opportunity_facts
      BEGIN
        SELECT CASE WHEN NOT (
          NEW.id = trim(NEW.id) AND length(NEW.id) BETWEEN 1 AND 240
          AND NEW.opportunity_id = trim(NEW.opportunity_id) AND length(NEW.opportunity_id) BETWEEN 1 AND 200
          AND NEW.field IN ('seller_name', 'seller_email', 'seller_phone', 'broker_name', 'broker_company', 'broker_email', 'broker_phone', 'reason_for_sale', 'real_estate_included', 'seller_financing', 'management_structure', 'customer_concentration', 'operator_contact_notes')
          AND NEW.value = trim(NEW.value) AND length(NEW.value) BETWEEN 1 AND 4000
          AND NEW.source = 'operator'
          AND NEW.verified IN (0, 1)
          AND NEW.actor = trim(NEW.actor) AND length(NEW.actor) BETWEEN 1 AND 200
          AND (NEW.note IS NULL OR (NEW.note = trim(NEW.note) AND length(NEW.note) BETWEEN 1 AND 4000))
          AND NEW.created_at = trim(NEW.created_at) AND length(NEW.created_at) BETWEEN 1 AND 80 AND julianday(NEW.created_at) IS NOT NULL
          AND NEW.updated_at = trim(NEW.updated_at) AND length(NEW.updated_at) BETWEEN 1 AND 80 AND julianday(NEW.updated_at) IS NOT NULL
        ) THEN RAISE(ABORT, 'invalid operator opportunity fact') END;
      END;

PRAGMA foreign_keys = ON;


