-- PostgreSQL regular expressions allow at most 255 repetitions, so the original
-- {1,2048} cursor check failed on every save ("invalid repetition count(s)").
alter table public.instagram_backfills drop constraint instagram_backfills_cursor_check;
alter table public.instagram_backfills add constraint instagram_backfills_cursor_check
  check (cursor is null or (cursor ~ '^[A-Za-z0-9_=-]+$' and length(cursor) <= 2048));
-- Clear the failures the bug caused so the jobs carry on straight away.
update public.instagram_backfills set failures=0, last_error=null, next_attempt_at=null, status='pending'
where status in ('pending','failed') and pages_read=0;
