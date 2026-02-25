-- Migration 005: Task Tracker
-- Adds a Microsoft To-Do style task system with checklists, due dates, and assignees

create table if not exists tasks (
  id text primary key,
  title text not null,
  body text default '',

  -- Source context (where the task came from)
  chat_id text,
  chat_name text default '',
  sender text default '',
  source_type text default 'manual' check (source_type in ('question', 'mention', 'feed', 'manual')),
  source_id text,

  -- Status & priority
  status text default 'open' check (status in ('open', 'in_progress', 'completed', 'cancelled')),
  priority text default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  category text default 'general',

  -- Assignment & completion
  assigned_to text,
  completed_by text,
  completed_at bigint,

  -- Scheduling
  due_date bigint,
  my_day boolean default false,

  -- Checklist steps: [{text: "Do X", done: false}, ...]
  steps jsonb default '[]'::jsonb,
  tags text[] default '{}',

  -- Media
  has_media boolean default false,
  media_type text default 'chat',

  -- Timestamps
  timestamp bigint not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Indexes for common queries
create index if not exists idx_tasks_status on tasks(status);
create index if not exists idx_tasks_assigned_to on tasks(assigned_to) where assigned_to is not null;
create index if not exists idx_tasks_due_date on tasks(due_date) where due_date is not null;
create index if not exists idx_tasks_chat_id on tasks(chat_id);
create index if not exists idx_tasks_created on tasks(created_at desc);
create index if not exists idx_tasks_my_day on tasks(my_day) where my_day = true;
