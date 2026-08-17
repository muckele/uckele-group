create or replace function public.get_crm_follow_up_operational_metrics(
  p_since timestamptz default '1970-01-01T00:00:00Z'::timestamptz
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'windowStartedAt', p_since,
    'outbox', jsonb_build_object(
      'queued', (select count(*) from public.crm_email_outbox where created_at >= p_since and state = 'queued'),
      'sending', (select count(*) from public.crm_email_outbox where created_at >= p_since and state = 'sending'),
      'accepted', (select count(*) from public.crm_email_outbox where created_at >= p_since and state = 'accepted'),
      'ambiguous', (select count(*) from public.crm_email_outbox where created_at >= p_since and state = 'ambiguous'),
      'retryableFailed', (select count(*) from public.crm_email_outbox where created_at >= p_since and state = 'retryable_failed'),
      'permanentFailed', (select count(*) from public.crm_email_outbox where created_at >= p_since and state = 'permanent_failed'),
      'cancelled', (select count(*) from public.crm_email_outbox where created_at >= p_since and state = 'cancelled')
    ),
    'delivery', jsonb_build_object(
      'delivered', (select count(*) from public.crm_communications where occurred_at >= p_since and kind = 'crm-follow-up' and direction = 'outbound' and delivery_state = 'delivered'),
      'delayed', (select count(*) from public.crm_communications where occurred_at >= p_since and kind = 'crm-follow-up' and direction = 'outbound' and delivery_state = 'delayed'),
      'bounced', (select count(*) from public.crm_communications where occurred_at >= p_since and kind = 'crm-follow-up' and direction = 'outbound' and delivery_state = 'bounced'),
      'complained', (select count(*) from public.crm_communications where occurred_at >= p_since and kind = 'crm-follow-up' and direction = 'outbound' and delivery_state = 'complained'),
      'failed', (select count(*) from public.crm_communications where occurred_at >= p_since and kind = 'crm-follow-up' and direction = 'outbound' and delivery_state = 'failed'),
      'replied', (
        select count(*) from public.crm_communications as outbound
        where outbound.occurred_at >= p_since and outbound.kind = 'crm-follow-up' and outbound.direction = 'outbound'
          and exists (
            select 1 from public.crm_communications as inbound
            where inbound.direction = 'inbound'
              and inbound.submission_id = outbound.submission_id
              and inbound.occurred_at >= outbound.occurred_at
              and (
                inbound.parent_communication_id = outbound.id
                or (outbound.message_id is not null and inbound.in_reply_to = outbound.message_id)
                or (outbound.thread_key is not null and inbound.thread_key = outbound.thread_key)
              )
          )
      )
    ),
    'recommendations', jsonb_build_object(
      'current', (select count(*) from public.crm_follow_up_recommendations where created_at >= p_since and status = 'current'),
      'accepted', (select count(*) from public.crm_follow_up_recommendations where created_at >= p_since and status = 'accepted'),
      'editedAndAccepted', (select count(*) from public.crm_follow_up_recommendations where created_at >= p_since and status = 'edited_and_accepted'),
      'dismissed', (select count(*) from public.crm_follow_up_recommendations where created_at >= p_since and status = 'dismissed'),
      'superseded', (select count(*) from public.crm_follow_up_recommendations where created_at >= p_since and status = 'superseded'),
      'failed', (select count(*) from public.crm_follow_up_recommendations where created_at >= p_since and status = 'failed'),
      'aiUsed', (select count(*) from public.crm_follow_up_recommendations where created_at >= p_since and model_provider is not null),
      'aiFallback', (select count(*) from public.crm_follow_up_recommendations where created_at >= p_since and metadata ->> 'aiRequested' = 'true' and metadata ->> 'aiUsed' = 'false')
    ),
    'ai', jsonb_build_object(
      'fallbackReasons', (
        select coalesce(jsonb_object_agg(reason, total), '{}'::jsonb)
        from (
          select metadata ->> 'aiFallbackReason' as reason, count(*) as total
          from public.crm_follow_up_recommendations
          where created_at >= p_since
            and metadata ->> 'aiRequested' = 'true'
            and nullif(metadata ->> 'aiFallbackReason', '') is not null
          group by metadata ->> 'aiFallbackReason'
        ) as reasons
      ),
      'responseStates', (
        select coalesce(jsonb_object_agg(response_state, total), '{}'::jsonb)
        from (
          select metadata ->> 'aiResponseState' as response_state, count(*) as total
          from public.crm_follow_up_recommendations
          where created_at >= p_since
            and metadata ->> 'aiRequested' = 'true'
            and nullif(metadata ->> 'aiResponseState', '') is not null
          group by metadata ->> 'aiResponseState'
        ) as states
      ),
      'latencyMs', (
        select jsonb_build_object(
          'observed', count(value),
          'average', case when count(value) > 0 then round(avg(value), 1) else null end,
          'minimum', min(value),
          'maximum', max(value),
          'total', sum(value)
        )
        from (
          select case
            when metadata ->> 'aiLatencyMs' ~ '^[0-9]+$' then (metadata ->> 'aiLatencyMs')::numeric
            else null
          end as value
          from public.crm_follow_up_recommendations
          where created_at >= p_since and metadata ->> 'aiRequested' = 'true'
        ) as latency
      ),
      'tokens', (
        select jsonb_build_object(
          'observed', count(*) filter (where input_tokens is not null or output_tokens is not null),
          'inputTotal', sum(input_tokens),
          'outputTotal', sum(output_tokens),
          'cachedTotal', sum(cached_tokens),
          'reasoningTotal', sum(reasoning_tokens)
        )
        from (
          select
            case when metadata ->> 'aiInputTokens' ~ '^[0-9]+$' then (metadata ->> 'aiInputTokens')::bigint else null end as input_tokens,
            case when metadata ->> 'aiOutputTokens' ~ '^[0-9]+$' then (metadata ->> 'aiOutputTokens')::bigint else null end as output_tokens,
            case when metadata ->> 'aiCachedTokens' ~ '^[0-9]+$' then (metadata ->> 'aiCachedTokens')::bigint else null end as cached_tokens,
            case when metadata ->> 'aiReasoningTokens' ~ '^[0-9]+$' then (metadata ->> 'aiReasoningTokens')::bigint else null end as reasoning_tokens
          from public.crm_follow_up_recommendations
          where created_at >= p_since and metadata ->> 'aiRequested' = 'true'
        ) as usage
      )
    ),
    'suppressions', jsonb_build_object(
      'active', (select count(*) from public.email_suppressions where lifted_at is null)
    )
  );
$$;

revoke all on function public.get_crm_follow_up_operational_metrics(timestamptz) from public, anon, authenticated;
grant execute on function public.get_crm_follow_up_operational_metrics(timestamptz) to service_role;
