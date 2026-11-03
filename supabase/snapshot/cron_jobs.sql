-- Scheduled jobs as they exist on the live project (updated 2026-11-03).
-- Not a migration: cron jobs embed the project URL. cron.schedule() upserts by
-- job name, so this file can be re-run safely after editing.
--
-- Requires a Vault secret named 'scraper_collector_secret' whose value matches
-- the COLLECTOR_SECRET Edge Function secret (at least 32 characters):
--   select vault.create_secret('<secret>', 'scraper_collector_secret');
--
-- Times are UTC. 00:30 and 12:30 UTC = 06:00 and 18:00 in Sri Lanka.

-- Collector, every 30 minutes. At 00:30 and 12:30 UTC (06:00 and 18:00 in Sri Lanka) it
-- refreshes the full window (Instagram 7 days, YouTube 14 days). The other runs refresh
-- Instagram posts from the last 2 days only, to stay well inside Meta's rate limits (about
-- 4 Business Discovery requests per run instead of 10-12). YouTube always refreshes 14 days,
-- which costs up to about 11 quota units per channel per run (~800 of the 10,000 a day).
select cron.unschedule('social-collector-twice-daily') where exists(select 1 from cron.job where jobname='social-collector-twice-daily');
select cron.schedule('social-collector', '0,30 * * * *', $cron$
 do $dispatch$
 declare collector_secret text; channel_row record; full_run boolean;
 begin
  select decrypted_secret into strict collector_secret from vault.decrypted_secrets where name='scraper_collector_secret';
  if collector_secret is null or length(collector_secret)<32 then raise exception 'scraper_collector_secret is missing or invalid'; end if;
  full_run:=extract(hour from now() at time zone 'UTC') in (0,12) and extract(minute from now() at time zone 'UTC')>=30;
  for channel_row in select id,platform from public.channels where enabled and platform in ('instagram','youtube') loop
   perform net.http_post(
    url:='https://qyeaiqpvqecyapovcwox.supabase.co/functions/v1/collect-channel',
    headers:=jsonb_build_object('Content-Type','application/json','x-collector-secret',collector_secret),
    body:=jsonb_build_object('channel_id',channel_row.id)
     ||case when channel_row.platform='instagram' and not full_run then jsonb_build_object('refresh_days',2) else '{}'::jsonb end,
    timeout_milliseconds:=180000
   );
  end loop;
 end $dispatch$;
$cron$);

-- Pushes each collection to the newsroom app, 10 minutes after each collector run (the feed
-- holds rows back for 5 minutes after they change). It calls the app's /api/sync-social
-- route, which pulls what changed from the news feed. Does nothing until both Vault secrets
-- exist:
--   select vault.create_secret('https://<newsroom app domain>/api/sync-social', 'newsroom_sync_url');
--   select vault.create_secret('<the app''s CRON_SECRET>', 'newsroom_sync_token');
-- To connect another app the same way, copy this job with its own job name and secrets.
select cron.schedule('newsroom-sync', '10,40 * * * *', $cron$
 do $push$
 declare sync_url text; sync_token text;
 begin
  select decrypted_secret into sync_url from vault.decrypted_secrets where name='newsroom_sync_url';
  select decrypted_secret into sync_token from vault.decrypted_secrets where name='newsroom_sync_token';
  if sync_url is null or sync_token is null then return; end if;
  if sync_url !~ '^https://[^/@[:space:]]+/' then raise exception 'newsroom_sync_url must be an https URL'; end if;
  perform net.http_get(
   url:=sync_url,
   headers:=jsonb_build_object('Authorization','Bearer '||sync_token),
   timeout_milliseconds:=60000
  );
 end $push$;
$cron$);

select cron.schedule('social-api-retention', '10 0 * * *', $cron$select public.prune_api_data();$cron$);

select cron.schedule('youtube-comments-twice-daily', '45 0,12 * * *', $cron$
 do $dispatch$
 declare collector_secret text; video_row record;
 begin
  select decrypted_secret into strict collector_secret from vault.decrypted_secrets where name='scraper_collector_secret';
  if collector_secret is null or length(collector_secret)<32 then raise exception 'scraper_collector_secret is missing or invalid'; end if;
  for video_row in
   select ranked.id from (
    select p.id,row_number() over(partition by p.channel_id order by s.last_attempt_at asc nulls first,p.published_at desc,p.id) as priority
    from public.posts p join public.channels c on c.id=p.channel_id
    left join public.youtube_comment_sync s on s.post_id=p.id
    where c.enabled and c.platform='youtube' and (s.last_attempt_at is null or s.last_attempt_at<now()-interval '8 hours')
   ) ranked where priority<=50
  loop
   perform net.http_post(
    url:='https://qyeaiqpvqecyapovcwox.supabase.co/functions/v1/collect-youtube-comments',
    headers:=jsonb_build_object('Content-Type','application/json','x-collector-secret',collector_secret),
    body:=jsonb_build_object('post_id',video_row.id),timeout_milliseconds:=180000
   );
  end loop;
 end $dispatch$;
$cron$);

select cron.schedule('youtube-comment-retention', '15 0 * * *', $cron$select public.prune_youtube_comments();$cron$);

-- Instagram history backfill (supabase/functions/backfill-instagram). Both jobs from
-- November 2026 are done, so the job is off. To run a new backfill, schedule it again with
-- the definition in git history (commit 72534b5), every 2 minutes, then unschedule it once
-- every job in public.instagram_backfills is done.
select cron.unschedule('instagram-backfill') where exists(select 1 from cron.job where jobname='instagram-backfill');
