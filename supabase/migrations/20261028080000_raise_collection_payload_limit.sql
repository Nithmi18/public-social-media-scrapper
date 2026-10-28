-- Instagram now refreshes 7 days of posts (up to 12 pages x 50 = 600 posts per run),
-- which can exceed the old 500-post payload guard.
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
 insert into public.posts(channel_id,external_id,url,title,caption,media_type,published_at)
 values(ch,item->>'external_id',item->>'url',item->>'title',item->>'caption',item->>'media_type',(item->>'published_at')::timestamptz)
 on conflict(channel_id,external_id) do update set url=excluded.url,title=excluded.title,
 caption=excluded.caption,media_type=excluded.media_type,published_at=excluded.published_at,refreshed_at=now()
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
end $function$;
