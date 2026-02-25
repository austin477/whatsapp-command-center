-- Migration 003: Add resolved status to mentions and direct_messages
-- This enables the end-to-end action loop in the dashboard

-- Add resolved columns to mentions
alter table mentions add column if not exists resolved boolean default false;
alter table mentions add column if not exists resolved_by text;
alter table mentions add column if not exists resolved_at bigint;

-- Add resolved columns to direct_messages
alter table direct_messages add column if not exists resolved boolean default false;
alter table direct_messages add column if not exists resolved_by text;
alter table direct_messages add column if not exists resolved_at bigint;

-- Add answered questions count to dashboard stats
-- (We'll track this via a simple count query, no schema change needed)

-- Indexes for filtering by resolved status
create index if not exists idx_mentions_resolved on mentions(resolved);
create index if not exists idx_dms_resolved on direct_messages(resolved);
