-- Manual Instagram comment capture.
-- The Graph API gives comment counts but no comment text for other accounts, so an
-- operator opens posts in a browser and the capture extension sends the visible
-- comments here. The collector's comment counts decide which posts need a visit.
begin;

-- How often the operator should capture comments for a channel (null = not scheduled).
alter table public.channels add column comment_capture_every text
 check (comment_capture_every in ('daily','weekly'));

-- 'feed' keys read news-feed; 'capture' keys belong to capture extensions.
alter table public.integration_clients add column purpose text not null default 'feed'
 check (purpose in ('feed','capture'));

create table public.comment_captures (
 id uuid primary key default gen_random_uuid(),
 post_id uuid not null references public.posts(id) on delete cascade,
 client_id uuid references public.integration_clients(id) on delete set null,
 captured_at timestamptz not null default now(),
 -- The collector's comment count for the post at capture time. The post is pending
 -- again once a later collection reports more comments than this.
 comments_count_at_capture bigint check(comments_count_at_capture>=0),
 comments_saved integer not null default 0
);
create index comment_captures_post_idx on public.comment_captures(post_id,captured_at desc);
alter table public.comment_captures enable row level security;
revoke all on public.comment_captures from public,anon,authenticated;
grant all on public.comment_captures to service_role;

-- Retention was written when only YouTube had comments; keep it YouTube-only.
create or replace function public.prune_youtube_comments() returns void
language plpgsql security invoker set search_path='' as $$
begin
 delete from public.post_comments pc using public.posts p,public.channels c
 where pc.post_id=p.id and p.channel_id=c.id and c.platform='youtube' and pc.refreshed_at<now()-interval '29 days';
 delete from public.comment_runs where status<>'running' and started_at<now()-interval '29 days';
end $$;

-- Capture keys must not read the feed.
CREATE OR REPLACE FUNCTION public.read_news_feed(p_key text, p_after_time timestamp with time zone, p_after_id uuid, p_limit integer DEFAULT 50)
 RETURNS TABLE(id uuid, outlet text, platform text, handle text, url text, title text, caption text, media_type text, published_at timestamp with time zone, first_seen_at timestamp with time zone, refreshed_at timestamp with time zone)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
 if not exists(select 1 from public.integration_clients where enabled and purpose='feed' and
 key_hash=encode(sha256(convert_to(p_key,'UTF8')),'hex')) then raise exception 'invalid_consumer_key'; end if;
 return query select p.id,o.name,c.platform,c.handle,p.url,p.title,p.caption,p.media_type,p.published_at,p.first_seen_at,p.refreshed_at
 from public.posts p join public.channels c on c.id=p.channel_id join public.outlets o on o.id=c.outlet_id
 where c.platform='instagram' and c.enabled
 and (p.first_seen_at,p.id)>(p_after_time,p_after_id)
 order by p.first_seen_at,p.id limit least(greatest(p_limit,1),100);
end $function$;

create function public.capture_client(p_key text) returns uuid
language sql stable security invoker set search_path='' as $$
 select id from public.integration_clients
 where enabled and purpose='capture' and key_hash=encode(sha256(convert_to(p_key,'UTF8')),'hex');
$$;

-- Dashboard data: each Instagram channel with its schedule, and its recent posts
-- with the collector's comment count against the count at the last capture.
create function public.comment_capture_queue(p_key text, p_days integer default 7) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare days integer:=least(greatest(coalesce(p_days,7),1),30); result jsonb;
begin
 if public.capture_client(p_key) is null then raise exception 'invalid_capture_key'; end if;
 with recent as (
  select p.id,p.channel_id,p.url,p.caption,p.media_type,p.published_at,
   (select m.comments from public.post_metrics_daily m where m.post_id=p.id order by m.captured_at desc limit 1) as comments_now,
   cap.captured_at as last_captured_at,cap.comments_count_at_capture as comments_at_capture
  from public.posts p
  left join lateral (select k.captured_at,k.comments_count_at_capture from public.comment_captures k
   where k.post_id=p.id order by k.captured_at desc limit 1) cap on true
  where p.published_at>now()-make_interval(days=>days)
 ), posts as (
  select r.*,greatest(coalesce(r.comments_now,0)-coalesce(r.comments_at_capture,0),0) as new_comments,
   coalesce(r.comments_now,0)>coalesce(r.comments_at_capture,0) as pending
  from recent r where coalesce(r.comments_now,0)>0 or r.last_captured_at is not null
 ), chans as (
  select c.id,o.name as outlet,c.handle,c.comment_capture_every as every,
   (select max(k.captured_at) from public.comment_captures k join public.posts p on p.id=k.post_id where p.channel_id=c.id) as last_capture_at
  from public.channels c join public.outlets o on o.id=c.outlet_id
  where c.platform='instagram' and c.enabled
 )
 select coalesce(jsonb_agg(jsonb_build_object(
  'channel_id',ch.id,'outlet',ch.outlet,'handle',ch.handle,'every',ch.every,'last_capture_at',ch.last_capture_at,
  'next_due_at',case ch.every when 'daily' then ch.last_capture_at+interval '1 day' when 'weekly' then ch.last_capture_at+interval '7 days' end,
  'due',ch.every is not null and (ch.last_capture_at is null or ch.last_capture_at<=now()-case ch.every when 'daily' then interval '1 day' else interval '7 days' end),
  'pending_posts',(select count(*) from posts p where p.channel_id=ch.id and p.pending),
  'new_comments',(select coalesce(sum(p.new_comments),0) from posts p where p.channel_id=ch.id),
  'posts',(select coalesce(jsonb_agg(jsonb_build_object(
    'post_id',p.id,'url',p.url,'caption',left(p.caption,140),'media_type',p.media_type,'published_at',p.published_at,
    'comments_now',p.comments_now,'comments_at_capture',p.comments_at_capture,'new_comments',p.new_comments,
    'pending',p.pending,'last_captured_at',p.last_captured_at)
    order by p.pending desc,p.new_comments desc,p.published_at desc),'[]')
   from (select * from posts p where p.channel_id=ch.id order by p.pending desc,p.new_comments desc,p.published_at desc limit 200) p)
 ) order by ch.outlet,ch.handle),'[]') into result from chans ch;
 return jsonb_build_object('generated_at',now(),'days',days,'channels',result);
end $$;

-- Saves the comments the extension read from one post page and records the capture.
create function public.save_comment_capture(p_key text, p_shortcode text, p_comments jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare client uuid; pid uuid; item jsonb; n integer:=0; count_now bigint;
begin
 client:=public.capture_client(p_key);
 if client is null then raise exception 'invalid_capture_key'; end if;
 if p_shortcode !~ '^[A-Za-z0-9_-]{5,64}$' then raise exception 'invalid_shortcode'; end if;
 if jsonb_typeof(p_comments) is distinct from 'array' or jsonb_array_length(p_comments)>2000 then raise exception 'invalid_comments'; end if;
 select p.id into pid from public.posts p join public.channels c on c.id=p.channel_id
 where c.platform='instagram' and p.url ~ ('^https://www\.instagram\.com/(p|reels?|tv)/'||p_shortcode||'/')
 order by p.published_at desc limit 1;
 if pid is null then raise exception 'post_not_collected'; end if;
 for item in select value from jsonb_array_elements(p_comments) loop
  if coalesce(item->>'external_id','') !~ '^\d{1,30}$' or coalesce(item->>'text_content','')=''
   or (item->>'published_at') is null then continue; end if;
  insert into public.post_comments(post_id,external_id,parent_external_id,text_content,author_display_name,likes,published_at)
  values(pid,item->>'external_id',nullif(item->>'parent_external_id',''),left(item->>'text_content',5000),
   left(item->>'author_display_name',100),(item->>'likes')::bigint,(item->>'published_at')::timestamptz)
  on conflict(post_id,external_id) do update set parent_external_id=excluded.parent_external_id,
   text_content=excluded.text_content,author_display_name=excluded.author_display_name,
   likes=coalesce(excluded.likes,public.post_comments.likes),refreshed_at=now();
  n:=n+1;
 end loop;
 select m.comments into count_now from public.post_metrics_daily m where m.post_id=pid order by m.captured_at desc limit 1;
 insert into public.comment_captures(post_id,client_id,comments_count_at_capture,comments_saved) values(pid,client,count_now,n);
 return jsonb_build_object('post_id',pid,'comments_saved',n,'comments_count_at_capture',count_now);
end $$;

revoke all on function public.capture_client(text),public.comment_capture_queue(text,integer),public.save_comment_capture(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.capture_client(text),public.comment_capture_queue(text,integer),public.save_comment_capture(text,text,jsonb) to service_role;

commit;
