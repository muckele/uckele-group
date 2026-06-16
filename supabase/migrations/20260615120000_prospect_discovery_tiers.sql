alter table public.prospect_discoveries add column if not exists lead_tier text not null default 'unclassified';
alter table public.prospect_discoveries add column if not exists business_quality_score integer not null default 0;
alter table public.prospect_discoveries add column if not exists presence_gap_score integer not null default 0;
alter table public.prospect_discoveries add column if not exists recommended_action text;
alter table public.prospect_discoveries add column if not exists outreach_angle text;

create index if not exists idx_prospect_discoveries_lead_tier on public.prospect_discoveries (lead_tier, score desc);
