-- A post is pending when the collector's comment count rises above the count at the
-- last capture. The collector only runs twice a day, so a capture often sees more
-- comments than its last count. Record the larger of the two, so comments already
-- saved do not flag the post again after the next collection.
begin;

create or replace function public.save_comment_capture(p_key text, p_shortcode text, p_comments jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare client uuid; pid uuid; item jsonb; n integer:=0; count_now bigint; stored bigint;
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
 select count(*) into stored from public.post_comments where post_id=pid;
 insert into public.comment_captures(post_id,client_id,comments_count_at_capture,comments_saved)
 values(pid,client,greatest(coalesce(count_now,0),stored),n);
 return jsonb_build_object('post_id',pid,'comments_saved',n,'comments_count_at_capture',count_now,'comments_stored',stored);
end $$;

-- Captures made before this change.
update public.comment_captures k set comments_count_at_capture=greatest(coalesce(k.comments_count_at_capture,0),
 (select count(*) from public.post_comments c where c.post_id=k.post_id));

commit;
