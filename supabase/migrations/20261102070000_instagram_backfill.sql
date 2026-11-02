-- Instagram history backfill. The twice-daily collector only refreshes the last 7 days,
-- so older posts are fetched by the backfill-instagram function, which pages back through
-- Business Discovery from a saved cursor a few pages at a time and stores only the posts
-- published inside the job's window.
--
-- Counts stored for backfilled posts are what Instagram showed on the day of the backfill
-- (post_metrics_daily.captured_on is that day), not what the post had at the time.
-- Backfilled posts are marked with posts.backfilled_at and are left out of the news feed,
-- so connected apps don't receive old posts as new ones.
begin;

alter table public.posts add column if not exists backfilled_at timestamptz;

create table public.instagram_backfills (
  channel_id uuid primary key references public.channels(id) on delete cascade,
  window_start timestamptz not null,
  window_end timestamptz not null,
  status text not null default 'pending' check (status in ('pending','running','done','failed')),
  cursor text,
  pages_read integer not null default 0,
  posts_scanned integer not null default 0,
  posts_stored integer not null default 0,
  newest_seen timestamptz,
  oldest_seen timestamptz,
  lease_until timestamptz,
  next_attempt_at timestamptz,
  failures integer not null default 0,
  last_error text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint instagram_backfills_window_check check (window_start < window_end),
  constraint instagram_backfills_cursor_check check (cursor is null or cursor ~ '^[A-Za-z0-9_=-]{1,2048}$')
);
alter table public.instagram_backfills enable row level security;
revoke all on public.instagram_backfills from public,anon,authenticated;
grant all on public.instagram_backfills to service_role;

-- Takes a 3-minute lease on a channel's backfill. Returns the job, or null when it is
-- done, failed, paused after a rate limit, or another call holds the lease.
create function public.claim_backfill(p_channel uuid) returns jsonb
language plpgsql set search_path='' as $$
declare job public.instagram_backfills;
begin
 select * into job from public.instagram_backfills where channel_id=p_channel for update;
 if not found or job.status in ('done','failed') then return null; end if;
 if job.lease_until>now() or job.next_attempt_at>now() then return null; end if;
 update public.instagram_backfills set status='running',lease_until=now()+interval '3 minutes',updated_at=now()
 where channel_id=p_channel returning * into job;
 return to_jsonb(job);
end $$;

-- Saves one page: stores the page's posts that fall inside the window and moves the cursor.
-- p_done finishes the job; p_note records why (window reached, or Instagram had no more pages).
create function public.save_backfill_page(p_channel uuid, p_posts jsonb, p_cursor text, p_scanned integer,
 p_newest timestamptz, p_oldest timestamptz, p_done boolean, p_note text default null) returns integer
language plpgsql set search_path='' as $$
declare job public.instagram_backfills; item jsonb; pid uuid; n integer:=0;
begin
 select * into job from public.instagram_backfills where channel_id=p_channel and status='running' for update;
 if not found then raise exception 'backfill_not_running'; end if;
 if jsonb_typeof(p_posts) is distinct from 'array' or jsonb_array_length(p_posts)>200 then raise exception 'invalid_payload'; end if;
 for item in select value from jsonb_array_elements(p_posts) loop
  continue when (item->>'published_at')::timestamptz<job.window_start or (item->>'published_at')::timestamptz>=job.window_end;
  insert into public.posts(channel_id,external_id,url,title,caption,media_type,published_at,thumbnail_url,backfilled_at)
  values(p_channel,item->>'external_id',item->>'url',item->>'title',item->>'caption',item->>'media_type',
   (item->>'published_at')::timestamptz,item->>'thumbnail_url',now())
  on conflict(channel_id,external_id) do update set url=excluded.url,caption=excluded.caption,
   media_type=excluded.media_type,published_at=excluded.published_at,
   thumbnail_url=coalesce(excluded.thumbnail_url,public.posts.thumbnail_url)
  returning id into pid;
  insert into public.post_metrics_daily(post_id,likes,comments,views)
  values(pid,(item->>'likes')::bigint,(item->>'comments')::bigint,(item->>'views')::bigint)
  on conflict(post_id,captured_on) do update set captured_at=now(),likes=excluded.likes,comments=excluded.comments,views=excluded.views;
  n:=n+1;
 end loop;
 update public.instagram_backfills set cursor=p_cursor,pages_read=pages_read+1,posts_scanned=posts_scanned+coalesce(p_scanned,0),
  posts_stored=posts_stored+n,newest_seen=greatest(newest_seen,p_newest),oldest_seen=least(oldest_seen,p_oldest),
  failures=0,last_error=null,note=nullif(concat_ws(';',note,p_note),''),updated_at=now(),
  status=case when p_done then 'done' else status end,finished_at=case when p_done then now() end,
  lease_until=case when p_done then null else lease_until end
 where channel_id=p_channel;
 return n;
end $$;

-- Ends a call: releases the lease, and on an error counts it and optionally pauses the job.
-- After 8 failures in a row the job stops as 'failed' until someone resets it.
create function public.release_backfill(p_channel uuid, p_error text default null, p_pause_seconds integer default null)
returns void language plpgsql set search_path='' as $$
begin
 update public.instagram_backfills set lease_until=null,updated_at=now(),
  failures=case when p_error is null then failures else failures+1 end,
  last_error=coalesce(p_error,last_error),
  next_attempt_at=case when p_pause_seconds>0 then now()+make_interval(secs=>least(p_pause_seconds,86400)) else next_attempt_at end,
  status=case when p_error is not null and failures+1>=8 then 'failed' else 'pending' end,
  finished_at=case when p_error is not null and failures+1>=8 then now() end
 where channel_id=p_channel and status='running';
end $$;

revoke all on function public.claim_backfill(uuid),
 public.save_backfill_page(uuid,jsonb,text,integer,timestamptz,timestamptz,boolean,text),
 public.release_backfill(uuid,text,integer) from public,anon,authenticated;
grant execute on function public.claim_backfill(uuid),
 public.save_backfill_page(uuid,jsonb,text,integer,timestamptz,timestamptz,boolean,text),
 public.release_backfill(uuid,text,integer) to service_role;

-- Keep backfilled posts out of the news feed.
create or replace function public.read_feed_posts(p_key text, p_after_time timestamptz, p_after_id uuid, p_limit integer,
 p_platform text default null, p_outlet text default null) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare client uuid; result jsonb;
begin
 client:=public.feed_client(p_key);
 if client is null then raise exception 'invalid_consumer_key'; end if;
 select coalesce(jsonb_agg(row order by (row->>'updated_at')::timestamptz,(row->>'id')::uuid),'[]') into result from (
  select jsonb_build_object(
   'id',p.id,'outlet',o.name,'platform',c.platform,'handle',c.handle,'external_id',p.external_id,'url',p.url,
   'title',p.title,'caption',p.caption,'media_type',p.media_type,'thumbnail_url',p.thumbnail_url,'published_at',p.published_at,
   'first_seen_at',p.first_seen_at,'updated_at',p.refreshed_at,
   'metrics',jsonb_build_object('likes',m.likes,'comments',m.comments,'views',m.views,'captured_at',m.captured_at),
   'comments_stored',(select count(*) from public.post_comments pc where pc.post_id=p.id)) as row
  from public.posts p join public.channels c on c.id=p.channel_id join public.outlets o on o.id=c.outlet_id
  left join lateral (select x.likes,x.comments,x.views,x.captured_at from public.post_metrics_daily x
   where x.post_id=p.id order by x.captured_at desc limit 1) m on true
  join public.integration_client_channels g on g.channel_id=c.id and g.client_id=client
  where c.enabled and p.backfilled_at is null and (p_platform is null or c.platform=p_platform) and (p_outlet is null or o.name=p_outlet)
   and p.refreshed_at<now()-interval '5 minutes'
   and (p.refreshed_at,p.id)>(p_after_time,p_after_id)
  order by p.refreshed_at,p.id limit least(greatest(p_limit,1),100)
 ) page;
 return result;
end $$;

commit;
