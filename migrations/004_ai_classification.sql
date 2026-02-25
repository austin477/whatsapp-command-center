-- Migration 004: Add AI classification columns
-- Enables hybrid regex+AI classification with confidence tracking

-- Add AI classification columns to questions
alter table questions add column if not exists classified_by text default 'regex';
alter table questions add column if not exists ai_confidence real;
alter table questions add column if not exists ai_intent text;
alter table questions add column if not exists ai_summary text;
alter table questions add column if not exists ai_is_actionable boolean;

-- Add AI classification to messages table for general classification
alter table messages add column if not exists ai_intent text;
alter table messages add column if not exists ai_confidence real;
alter table messages add column if not exists ai_summary text;
alter table messages add column if not exists ai_is_actionable boolean;
alter table messages add column if not exists classified_by text default 'none';

-- Index for finding unclassified messages (for bulk reclassification)
create index if not exists idx_messages_unclassified on messages(classified_by) where classified_by = 'none';
create index if not exists idx_questions_classified_by on questions(classified_by);
