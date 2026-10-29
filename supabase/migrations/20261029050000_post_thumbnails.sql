-- Post thumbnails. The collector stores the image link the platform gives for each post
-- (YouTube: the video thumbnail; Instagram: the photo, or the cover image of a video or reel),
-- and the feed serves it as thumbnail_url. Instagram links are signed and expire after a few
-- days, so connected apps copy the image when they receive it. A run that gets no link keeps
-- the last one.
begin;

alter table public.posts add column if not exists thumbnail_url text;

CREATE OR REPLACE FUNCTION public.finish_collection(p_run uuid, p_payload jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare ch uuid; item jsonb; pid uuid; n integer:=0;
begin
 select channel_id into ch from public.runs where id=p_run and status='running' for update;
 if ch is null then raise exception 'run_not_active'; end if;
 if jsonb_typeof(p_payload->'posts') is distinct from 'array' then raise exception 'invalid_payload'; end if;
 if jsonb_array_length(p_payload->'posts')>1000 then raise exception 'invalid_payload'; end if;
 for item in select value from jsonb_array_elements(p_payload->'posts') loop
 insert into public.posts(channel_id,external_id,url,title,caption,media_type,published_at,thumbnail_url)
 values(ch,item->>'external_id',item->>'url',item->>'title',item->>'caption',item->>'media_type',(item->>'published_at')::timestamptz,item->>'thumbnail_url')
 on conflict(channel_id,external_id) do update set url=excluded.url,title=excluded.title,
 caption=excluded.caption,media_type=excluded.media_type,published_at=excluded.published_at,
 thumbnail_url=coalesce(excluded.thumbnail_url,public.posts.thumbnail_url),refreshed_at=now()
 returning id into pid;
 insert into public.post_metrics_daily(post_id,likes,comments,views)
 values(pid,(item->>'likes')::bigint,(item->>'comments')::bigint,(item->>'views')::bigint)
 on conflict(post_id,captured_on) do update set captured_at=now(),likes=excluded.likes,comments=excluded.comments,views=excluded.views;
 n:=n+1;
 end loop;
 update public.channels set metadata=coalesce(p_payload->'metadata','{}'),
 external_id=coalesce(p_payload->>'external_id',external_id),refreshed_at=now() where id=ch;
 insert into public.channel_metrics_daily(channel_id,followers,post_count,views)
 values(ch,(p_payload->>'followers')::bigint,(p_payload->>'post_count')::bigint,(p_payload->>'views')::bigint)
 on conflict(channel_id,captured_on) do update set captured_at=now(),followers=excluded.followers,post_count=excluded.post_count,views=excluded.views;
 update public.runs set status=case when jsonb_array_length(coalesce(p_payload->'warnings','[]'))>0 then 'partial' else 'success' end,
 posts_seen=n,warnings=coalesce(p_payload->'warnings','[]'),finished_at=now() where id=p_run;
 return n;
end $function$;;

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
  where c.enabled and (p_platform is null or c.platform=p_platform) and (p_outlet is null or o.name=p_outlet)
   and p.refreshed_at<now()-interval '5 minutes'
   and (p.refreshed_at,p.id)>(p_after_time,p_after_id)
  order by p.refreshed_at,p.id limit least(greatest(p_limit,1),100)
 ) page;
 return result;
end $$;

commit;
