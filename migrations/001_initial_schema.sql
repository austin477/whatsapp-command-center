-- WhatsApp Command Center - Initial Database Schema
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New Query)

-- ══════════════════════════════════════════════════
-- 1. USER PROFILES (extends Supabase Auth)
-- ══════════════════════════════════════════════════
create table if not exists profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  name text,
  track_name text default '',
  theme text default 'system' check (theme in ('light', 'dark', 'system')),
  is_admin boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Auto-create profile when a user signs up
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)));
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ══════════════════════════════════════════════════
-- 2. GROUPS
-- ══════════════════════════════════════════════════
create table if not exists groups (
  chat_id text primary key,
  name text not null,
  last_message text default '',
  last_message_time bigint default 0,
  message_count integer default 0,
  today_count integer default 0,
  today_date text default '',
  members text[] default '{}',
  is_ignored boolean default false,
  is_partner boolean default false,
  settings jsonb default '{}',
  backfilled_at timestamptz,
  created_at timestamptz default now()
);

-- ══════════════════════════════════════════════════
-- 3. MESSAGES (raw message store for analytics)
-- ══════════════════════════════════════════════════
create table if not exists messages (
  id bigserial primary key,
  chat_id text not null,
  chat_name text not null,
  sender text not null,
  body text default '',
  timestamp bigint not null,
  has_media boolean default false,
  media_type text default 'chat',
  created_at timestamptz default now()
);

create index if not exists idx_messages_chat_id on messages(chat_id);
create index if not exists idx_messages_timestamp on messages(timestamp desc);
create index if not exists idx_messages_sender on messages(sender);

-- ══════════════════════════════════════════════════
-- 4. QUESTIONS
-- ══════════════════════════════════════════════════
create table if not exists questions (
  id text primary key,
  chat_id text not null,
  chat_name text not null,
  sender text not null,
  body text default '',
  timestamp bigint not null,
  directed_at_me boolean default false,
  status text default 'open' check (status in ('open', 'answered')),
  answered_by text,
  answered_at bigint,
  answer_confidence numeric,
  answer_reason text,
  answer_preview text,
  has_media boolean default false,
  media_type text default 'chat',
  created_at timestamptz default now()
);

create index if not exists idx_questions_status on questions(status);
create index if not exists idx_questions_chat_id on questions(chat_id);
create index if not exists idx_questions_timestamp on questions(timestamp desc);

-- ══════════════════════════════════════════════════
-- 5. MENTIONS
-- ══════════════════════════════════════════════════
create table if not exists mentions (
  id text primary key,
  chat_id text not null,
  chat_name text not null,
  sender text not null,
  body text default '',
  timestamp bigint not null,
  has_media boolean default false,
  media_type text default 'chat',
  created_at timestamptz default now()
);

create index if not exists idx_mentions_timestamp on mentions(timestamp desc);

-- Per-user read status for mentions
create table if not exists mention_reads (
  mention_id text references mentions(id) on delete cascade,
  user_id uuid references auth.users on delete cascade,
  read_at timestamptz default now(),
  primary key (mention_id, user_id)
);

-- ══════════════════════════════════════════════════
-- 6. DIRECT MESSAGES
-- ══════════════════════════════════════════════════
create table if not exists direct_messages (
  id text primary key,
  chat_id text not null,
  chat_name text default '',
  sender text not null,
  body text default '',
  timestamp bigint not null,
  from_me boolean default false,
  has_media boolean default false,
  media_type text default 'chat',
  created_at timestamptz default now()
);

create index if not exists idx_dms_timestamp on direct_messages(timestamp desc);

-- Per-user read status for DMs
create table if not exists dm_reads (
  dm_id text references direct_messages(id) on delete cascade,
  user_id uuid references auth.users on delete cascade,
  read_at timestamptz default now(),
  primary key (dm_id, user_id)
);

-- ══════════════════════════════════════════════════
-- 7. ACTIVITY FEED
-- ══════════════════════════════════════════════════
create table if not exists activity_feed (
  id bigserial primary key,
  type text not null check (type in ('message', 'mention', 'question', 'dm')),
  chat_id text not null,
  chat_name text not null,
  sender text not null,
  body text default '',
  timestamp bigint not null,
  has_media boolean default false,
  media_type text default 'chat',
  created_at timestamptz default now()
);

create index if not exists idx_feed_timestamp on activity_feed(timestamp desc);
create index if not exists idx_feed_type on activity_feed(type);

-- ══════════════════════════════════════════════════
-- 8. MESSAGE VOLUME (hourly + daily aggregates)
-- ══════════════════════════════════════════════════
create table if not exists message_volume (
  key text primary key,  -- "hourly:2026-02-25-14" or "daily:2026-02-25"
  count integer default 0,
  updated_at timestamptz default now()
);

-- ══════════════════════════════════════════════════
-- 9. SENDER STATS
-- ══════════════════════════════════════════════════
create table if not exists sender_stats (
  sender text primary key,
  message_count integer default 0,
  last_seen bigint default 0,
  groups text[] default '{}',
  updated_at timestamptz default now()
);

-- ══════════════════════════════════════════════════
-- 10. APP SETTINGS (shared, team-wide)
-- ══════════════════════════════════════════════════
create table if not exists app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);

-- Insert defaults
insert into app_settings (key, value) values
  ('partner_groups', '[]'::jsonb),
  ('internal_staff', '[]'::jsonb),
  ('setup_complete', 'false'::jsonb),
  ('catch_up_enabled', 'true'::jsonb),
  ('catch_up_limit', '100'::jsonb)
on conflict (key) do nothing;

-- ══════════════════════════════════════════════════
-- 11. ENABLE REALTIME on key tables
-- ══════════════════════════════════════════════════
alter publication supabase_realtime add table questions;
alter publication supabase_realtime add table mentions;
alter publication supabase_realtime add table direct_messages;
alter publication supabase_realtime add table activity_feed;
alter publication supabase_realtime add table groups;

-- ══════════════════════════════════════════════════
-- 12. ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════

-- Enable RLS on all tables
alter table profiles enable row level security;
alter table groups enable row level security;
alter table messages enable row level security;
alter table questions enable row level security;
alter table mentions enable row level security;
alter table mention_reads enable row level security;
alter table direct_messages enable row level security;
alter table dm_reads enable row level security;
alter table activity_feed enable row level security;
alter table message_volume enable row level security;
alter table sender_stats enable row level security;
alter table app_settings enable row level security;

-- Profiles: users can read all, update own
create policy "Profiles are viewable by authenticated users" on profiles
  for select to authenticated using (true);
create policy "Users can update own profile" on profiles
  for update to authenticated using (auth.uid() = id);

-- Shared data: all authenticated users can read
-- Server (service_role) handles inserts via the service key
create policy "Authenticated users can read groups" on groups
  for select to authenticated using (true);
create policy "Authenticated users can read messages" on messages
  for select to authenticated using (true);
create policy "Authenticated users can read questions" on questions
  for select to authenticated using (true);
create policy "Authenticated users can update questions" on questions
  for update to authenticated using (true);
create policy "Authenticated users can read mentions" on mentions
  for select to authenticated using (true);
create policy "Authenticated users can read DMs" on direct_messages
  for select to authenticated using (true);
create policy "Authenticated users can read feed" on activity_feed
  for select to authenticated using (true);
create policy "Authenticated users can read volume" on message_volume
  for select to authenticated using (true);
create policy "Authenticated users can read sender stats" on sender_stats
  for select to authenticated using (true);
create policy "Authenticated users can read settings" on app_settings
  for select to authenticated using (true);
create policy "Authenticated users can update settings" on app_settings
  for update to authenticated using (true);

-- Per-user read tracking: users manage their own
create policy "Users can read own mention_reads" on mention_reads
  for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own mention_reads" on mention_reads
  for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can read own dm_reads" on dm_reads
  for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own dm_reads" on dm_reads
  for insert to authenticated with check (auth.uid() = user_id);
