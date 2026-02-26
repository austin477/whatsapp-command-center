-- 005_user_auth.sql
-- User authentication with password-based login

create table if not exists users (
  id uuid default gen_random_uuid() primary key,
  email text unique not null,
  password_hash text not null,
  name text not null,
  track_name text default '',
  is_admin boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Index for login lookups
create index if not exists idx_users_email on users(email);

-- Enable RLS
alter table users enable row level security;

-- Allow service role full access
create policy "Service role can manage users" on users
  for all using (true) with check (true);
