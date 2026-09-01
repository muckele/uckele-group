-- Per-opportunity complete source replacement has no collector-private
-- admission proof. Retire the previously installed service-role RPC without
-- touching any durable source-observation rows. Complete Google Sheet
-- reconciliation remains available only through the admitted source-wide RPC.

revoke all privileges on function public.replace_deal_hunter_opportunity_source_snapshot(
  text, text, text, jsonb
) from public, anon, authenticated, service_role;

drop function if exists public.replace_deal_hunter_opportunity_source_snapshot(
  text, text, text, jsonb
);
