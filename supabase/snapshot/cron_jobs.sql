-- Scheduled jobs as they exist on the live project (captured 2026-10-28).
-- Not a migration: cron jobs embed the project URL. cron.schedule() upserts by
-- job name, so this file can be re-run safely after editing.
--
-- Requires a Vault secret named 'scraper_collector_secret' whose value matches
-- the COLLECTOR_SECRET Edge Function secret (at least 32 characters):
--   select vault.create_secret('<secret>', 'scraper_collector_secret');
--
-- Times are UTC. 00:30 and 12:30 UTC = 06:00 and 18:00 in Sri Lanka.

select cron.schedule('social-collector-twice-daily', '30 0,12 * * *', $cron$
 do $dispatch$
 declare collector_secret text; channel_row record;
 begin
  select decrypted_secret into strict collector_secret from vault.decrypted_secrets where name='scraper_collector_secret';
  if collector_secret is null or length(collector_secret)<32 then raise exception 'scraper_collector_secret is missing or invalid'; end if;
  for channel_row in select id from public.channels where enabled and platform in ('instagram','youtube') loop
   perform net.http_post(
    url:='https://qyeaiqpvqecyapovcwox.supabase.co/functions/v1/collect-channel',
    headers:=jsonb_build_object('Content-Type','application/json','x-collector-secret',collector_secret),
    body:=jsonb_build_object('channel_id',channel_row.id),
    timeout_milliseconds:=180000
   );
  end loop;
 end $dispatch$;
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
