create index if not exists idx_contact_submissions_follow_up_queue
  on public.contact_submissions (status, follow_up_state, next_action_at, updated_at desc);

create or replace function public.count_crm_follow_up_sends(
  p_recipient text default '',
  p_since timestamptz default null
)
returns bigint
language sql
stable
security invoker
set search_path = public
as $$
  select count(*)::bigint
  from public.crm_email_outbox as outbox
  join public.crm_communications as communication on communication.id = outbox.communication_id
  where communication.kind = 'crm-follow-up'
    and outbox.state not in ('permanent_failed', 'cancelled')
    and (p_since is null or outbox.created_at >= p_since)
    and (
      btrim(coalesce(p_recipient, '')) = ''
      or exists (
        select 1
        from jsonb_array_elements_text(coalesce(communication.to_addresses, '[]'::jsonb)) as recipient(value)
        where lower(recipient.value) = lower(btrim(p_recipient))
      )
    );
$$;

revoke all on function public.count_crm_follow_up_sends(text, timestamptz) from public, anon, authenticated;
grant execute on function public.count_crm_follow_up_sends(text, timestamptz) to service_role;

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
    'suppressions', jsonb_build_object(
      'active', (select count(*) from public.email_suppressions where lifted_at is null)
    )
  );
$$;

revoke all on function public.get_crm_follow_up_operational_metrics(timestamptz) from public, anon, authenticated;
grant execute on function public.get_crm_follow_up_operational_metrics(timestamptz) to service_role;

create or replace function public.list_follow_up_submissions_page(
  p_limit integer default 25,
  p_page integer default 1,
  p_search text default '',
  p_view text default 'crm-actions',
  p_sort text default 'urgency',
  p_direction text default 'desc',
  p_now timestamptz default now(),
  p_today_start timestamptz default now(),
  p_today_end timestamptz default now()
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with parameters as (
    select
      greatest(1, least(coalesce(p_limit, 25), 100)) as page_limit,
      greatest(0, coalesce(p_page, 1) - 1)::bigint
        * greatest(1, least(coalesce(p_limit, 25), 100))::bigint as page_offset,
      lower(trim(coalesce(p_search, ''))) as search_text,
      lower(trim(coalesce(p_view, 'crm-actions'))) as selected_view,
      lower(trim(coalesce(p_sort, 'urgency'))) as selected_sort,
      case when lower(p_direction) = 'asc' then 'asc' else 'desc' end as selected_direction
  ),
  base as (
    select
      submission.*,
      latest_communication.subject as follow_up_latest_subject,
      latest_communication.direction as follow_up_latest_direction,
      latest_outbound.delivery_state as follow_up_latest_delivery_state,
      latest_communication.occurred_at as follow_up_latest_communication_at,
      latest_deal.deal_key as follow_up_deal_key,
      current_recommendation.id as follow_up_recommendation_id,
      current_recommendation.action_type as follow_up_recommendation_action,
      current_recommendation.conversation_state as follow_up_conversation_state,
      current_recommendation.priority_score as follow_up_priority_score,
      current_recommendation.confidence as follow_up_confidence
    from public.contact_submissions as submission
    left join lateral (
      select communication.subject, communication.direction, communication.occurred_at
      from public.crm_communications as communication
      where communication.submission_id = submission.id
      order by communication.occurred_at desc, communication.id desc
      limit 1
    ) as latest_communication on true
    left join lateral (
      select communication.delivery_state
      from public.crm_communications as communication
      where communication.submission_id = submission.id
        and communication.direction = 'outbound'
      order by communication.occurred_at desc, communication.id desc
      limit 1
    ) as latest_outbound on true
    left join lateral (
      select communication.deal_key
      from public.crm_communications as communication
      where communication.submission_id = submission.id
        and communication.deal_key is not null
      order by communication.occurred_at desc, communication.id desc
      limit 1
    ) as latest_deal on true
    left join lateral (
      select recommendation.id, recommendation.action_type, recommendation.conversation_state,
        recommendation.priority_score, recommendation.confidence
      from public.crm_follow_up_recommendations as recommendation
      where recommendation.submission_id = submission.id
        and recommendation.status = 'current'
        and (recommendation.expires_at is null or recommendation.expires_at > p_now)
      order by recommendation.created_at desc, recommendation.id desc
      limit 1
    ) as current_recommendation on true
  ),
  filtered as (
    select base.*
    from base cross join parameters
    where base.status not in ('archived', 'spam')
      and case parameters.selected_view
        when 'completed' then base.follow_up_state = 'completed'
        when 'due-today' then base.follow_up_state <> 'completed'
          and base.next_action_at >= p_today_start and base.next_action_at < p_today_end
        when 'overdue' then base.follow_up_state <> 'completed'
          and base.next_action_at is not null and base.next_action_at < p_today_start
        when 'awaiting-reply' then base.follow_up_state <> 'completed'
          and (base.follow_up_state = 'waiting-on-owner' or base.follow_up_latest_direction = 'outbound')
        when 'inbound-reply' then base.follow_up_state <> 'completed'
          and base.follow_up_latest_direction = 'inbound'
        when 'delivery-problem' then base.follow_up_state <> 'completed'
          and base.follow_up_latest_delivery_state in ('delayed', 'bounced', 'failed', 'complained', 'suppressed')
        when 'manual-review' then base.follow_up_state <> 'completed'
          and base.follow_up_recommendation_action = 'manual_review'
        when 'email-triage' then base.follow_up_state <> 'completed'
          and (
            base.follow_up_latest_direction = 'inbound'
            or base.follow_up_latest_delivery_state in ('delayed', 'bounced', 'failed', 'complained', 'suppressed')
          )
        when 'all' then true
        else base.follow_up_state <> 'completed'
      end
      and (
        parameters.search_text = ''
        or position(parameters.search_text in lower(concat_ws(' ',
          base.company, base.name, base.email, base.broker_name, base.broker_email,
          base.seller_name, base.seller_email, base.listing_url,
          base.follow_up_latest_subject, base.follow_up_deal_key
        ))) > 0
        or exists (
          select 1
          from public.crm_communications as search_communication
          where search_communication.submission_id = base.id
            and position(parameters.search_text in lower(concat_ws(' ',
              search_communication.subject, search_communication.deal_key
            ))) > 0
        )
      )
  ),
  ordered as (
    select
      filtered.*,
      row_number() over (
        order by
          case when parameters.selected_sort = 'urgency' then
            case
              when filtered.follow_up_latest_delivery_state in ('bounced', 'failed', 'complained', 'suppressed') then 4
              when filtered.follow_up_latest_direction = 'inbound' then 3
              when filtered.next_action_at is not null and filtered.next_action_at < p_now then 2
              else 1
            end
          end desc nulls last,
          case when parameters.selected_sort = 'urgency' then coalesce(filtered.follow_up_priority_score, 0) end desc nulls last,
          case when parameters.selected_sort = 'next_action_at' and parameters.selected_direction = 'asc' then filtered.next_action_at end asc nulls last,
          case when parameters.selected_sort = 'next_action_at' and parameters.selected_direction = 'desc' then filtered.next_action_at end desc nulls last,
          case when parameters.selected_sort = 'updated_at' and parameters.selected_direction = 'asc' then filtered.updated_at end asc,
          case when parameters.selected_sort = 'updated_at' and parameters.selected_direction = 'desc' then filtered.updated_at end desc,
          case when parameters.selected_sort = 'company' and parameters.selected_direction = 'asc' then lower(coalesce(filtered.company, filtered.name, '')) end asc,
          case when parameters.selected_sort = 'company' and parameters.selected_direction = 'desc' then lower(coalesce(filtered.company, filtered.name, '')) end desc,
          case when parameters.selected_sort = 'priority' and parameters.selected_direction = 'asc' then
            case filtered.priority when 'urgent' then 5 when 'high' then 4 when 'medium' then 3 when 'normal' then 2 when 'low' then 1 else 0 end
          end asc,
          case when parameters.selected_sort = 'priority' and parameters.selected_direction = 'desc' then
            case filtered.priority when 'urgent' then 5 when 'high' then 4 when 'medium' then 3 when 'normal' then 2 when 'low' then 1 else 0 end
          end desc,
          case when parameters.selected_sort = 'created_at' and parameters.selected_direction = 'asc' then filtered.created_at end asc,
          case when parameters.selected_sort = 'created_at' and parameters.selected_direction = 'desc' then filtered.created_at end desc,
          filtered.next_action_at asc nulls last,
          filtered.updated_at desc,
          filtered.id asc
      ) as page_position
    from filtered cross join parameters
  ),
  paged as (
    select ordered.*
    from ordered cross join parameters
    order by ordered.page_position
    limit greatest(1, least(coalesce(p_limit, 25), 100))
    offset greatest(0, coalesce(p_page, 1) - 1)::bigint
      * greatest(1, least(coalesce(p_limit, 25), 100))::bigint
  )
  select jsonb_build_object(
    'rows', coalesce(
      (select jsonb_agg(to_jsonb(paged) - 'page_position' order by page_position) from paged),
      '[]'::jsonb
    ),
    'total', (select count(*) from filtered)
  );
$$;

revoke all on function public.list_follow_up_submissions_page(
  integer, integer, text, text, text, text, timestamptz, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.list_follow_up_submissions_page(
  integer, integer, text, text, text, text, timestamptz, timestamptz, timestamptz
) to service_role;
