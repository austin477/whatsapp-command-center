-- ══════════════════════════════════════════════════
-- Migration 002: Enhanced Question Tracking System
-- ══════════════════════════════════════════════════

-- 1. Add new columns to questions table
alter table questions add column if not exists msg_id text;
alter table questions add column if not exists priority text default 'normal' check (priority in ('low', 'normal', 'high', 'urgent'));
alter table questions add column if not exists category text default 'general';
alter table questions add column if not exists context_messages jsonb default '[]';
alter table questions add column if not exists dismissed boolean default false;
alter table questions add column if not exists dismissed_by text;
alter table questions add column if not exists dismissed_at bigint;
alter table questions add column if not exists manually_resolved boolean default false;
alter table questions add column if not exists answer_id text;
alter table questions add column if not exists keywords text[] default '{}';
alter table questions add column if not exists question_type text default 'general';

-- Allow 'dismissed' as a status
alter table questions drop constraint if exists questions_status_check;
alter table questions add constraint questions_status_check
  check (status in ('open', 'answered', 'dismissed'));

-- 2. Answer candidates table — tracks every potential answer to a question
create table if not exists answer_candidates (
  id text primary key,
  question_id text not null references questions(id) on delete cascade,
  chat_id text not null,
  msg_id text,
  sender text not null,
  body text default '',
  timestamp bigint not null,
  confidence numeric not null default 0,
  signals jsonb default '{}',
  is_quoted_reply boolean default false,
  is_accepted boolean default false,
  created_at timestamptz default now()
);

create index if not exists idx_answer_candidates_question on answer_candidates(question_id);
create index if not exists idx_answer_candidates_confidence on answer_candidates(confidence desc);

-- 3. Question context — stores nearby messages for thread reconstruction
create table if not exists question_context (
  id serial primary key,
  question_id text not null references questions(id) on delete cascade,
  msg_id text,
  chat_id text not null,
  sender text not null,
  body text default '',
  timestamp bigint not null,
  is_before boolean default true,
  position integer default 0,
  created_at timestamptz default now()
);

create index if not exists idx_question_context_question on question_context(question_id);

-- 4. Enable RLS on new tables
alter table answer_candidates enable row level security;
alter table question_context enable row level security;

-- RLS policies
create policy "Read answer_candidates" on answer_candidates for select using (true);
create policy "Write answer_candidates" on answer_candidates for insert with check (true);
create policy "Update answer_candidates" on answer_candidates for update using (true);

create policy "Read question_context" on question_context for select using (true);
create policy "Write question_context" on question_context for insert with check (true);

-- 5. Enable real-time on answer_candidates
alter publication supabase_realtime add table answer_candidates;
