begin;
create table public.post_comments (
 id uuid primary key default gen_random_uuid(),
 post_id uuid not null references public.posts(id) on delete cascade,
 external_id text not null,
 parent_external_id text,
 text_content text not null,
 author_display_name text,
 author_channel_id text,
 likes bigint check(likes>=0), reply_count integer check(reply_count>=0),
 published_at timestamptz not null, updated_at timestamptz,
 first_seen_at timestamptz not null default now(),
 refreshed_at timestamptz not null default now(),
 unique(post_id,external_id)
);
create index post_comments_refresh_idx on public.post_comments(refreshed_at);
create index post_comments_thread_idx on public.post_comments(post_id,parent_external_id);
create table public.youtube_comment_sync (
 post_id uuid primary key references public.posts(id) on delete cascade,
 thread_page_token text,
 threads_done boolean not null default false,
 pending_replies jsonb not null default '[]' check(jsonb_typeof(pending_replies)='array'),
 last_attempt_at timestamptz, last_completed_at timestamptz,
 last_status text
);
create table public.comment_runs (
 id uuid primary key default gen_random_uuid(),
 post_id uuid not null references public.posts(id) on delete cascade,
 started_at timestamptz not null default now(), finished_at timestamptz,
 status text not null default 'running' check(status in ('running','success','partial','failed','unavailable')),
 comments_seen integer not null default 0,
 error_code text
);
create unique index comment_runs_active_idx on public.comment_runs(post_id) where status='running';
create index comment_runs_post_idx on public.comment_runs(post_id,started_at desc);
do $$ declare t text; begin
 foreach t in array array['post_comments','youtube_comment_sync','comment_runs'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
create function public.claim_comment_sync(p_post uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r uuid; vid text; st public.youtube_comment_sync;
begin
 select p.external_id into vid from public.posts p join public.channels c on c.id=p.channel_id
 where p.id=p_post and c.platform='youtube' and c.enabled;
 if vid is null then raise exception 'youtube_post_missing_or_disabled'; end if;
 insert into public.youtube_comment_sync(post_id) values(p_post) on conflict do nothing;
 select * into st from public.youtube_comment_sync where post_id=p_post for update;
 update public.comment_runs set status='failed',finished_at=now(),error_code='lease_expired'
 where post_id=p_post and status='running' and started_at<now()-interval '10 minutes';
 if exists(select 1 from public.comment_runs where post_id=p_post and status='running') then return null; end if;
 insert into public.comment_runs(post_id) values(p_post) returning id into r;
 update public.youtube_comment_sync set last_attempt_at=now(),last_status='running' where post_id=p_post;
 return jsonb_build_object('run_id',r,'video_id',vid,'state',jsonb_build_object(
 'thread_page_token',st.thread_page_token,'threads_done',st.threads_done,'pending_replies',st.pending_replies));
end $$;
create function public.save_comment_page(p_run uuid,p_comments jsonb,p_state jsonb) returns integer
language plpgsql security invoker set search_path='' as $$
declare pid uuid; item jsonb; n integer:=0;
begin
 select post_id into pid from public.comment_runs where id=p_run and status='running' for update;
 if pid is null then raise exception 'comment_run_not_active'; end if;
 if jsonb_typeof(p_comments) is distinct from 'array' or jsonb_array_length(p_comments)>1000 then raise exception 'invalid_comments'; end if;
 for item in select value from jsonb_array_elements(p_comments) loop
 insert into public.post_comments(post_id,external_id,parent_external_id,text_content,author_display_name,author_channel_id,likes,reply_count,published_at,updated_at)
 values(pid,item->>'external_id',item->>'parent_external_id',item->>'text_content',item->>'author_display_name',item->>'author_channel_id',
 (item->>'likes')::bigint,(item->>'reply_count')::integer,(item->>'published_at')::timestamptz,(item->>'updated_at')::timestamptz)
 on conflict(post_id,external_id) do update set parent_external_id=excluded.parent_external_id,text_content=excluded.text_content,
 author_display_name=excluded.author_display_name,author_channel_id=excluded.author_channel_id,likes=excluded.likes,
 reply_count=excluded.reply_count,published_at=excluded.published_at,updated_at=excluded.updated_at,refreshed_at=now();
 n:=n+1;
 end loop;
 update public.youtube_comment_sync set thread_page_token=p_state->>'thread_page_token',
 threads_done=(p_state->>'threads_done')::boolean,pending_replies=p_state->'pending_replies' where post_id=pid;
 update public.comment_runs set comments_seen=comments_seen+n where id=p_run;
 return n;
end $$;
create function public.finish_comment_sync(p_run uuid,p_status text,p_error text default null) returns void
language plpgsql security invoker set search_path='' as $$
declare pid uuid;
begin
 if p_status not in ('success','partial','failed','unavailable') then raise exception 'invalid_status'; end if;
 select post_id into pid from public.comment_runs where id=p_run and status='running' for update;
 if pid is null then raise exception 'comment_run_not_active'; end if;
 update public.comment_runs set status=p_status,error_code=p_error,finished_at=now() where id=p_run;
 update public.youtube_comment_sync set last_status=p_status where post_id=pid;
 if p_status='success' then
 update public.youtube_comment_sync set last_completed_at=now(),thread_page_token=null,threads_done=false,pending_replies='[]' where post_id=pid;
 elsif p_status='unavailable' then
 -- An explicit disabled/unavailable response makes cached public comments inaccessible.
 delete from public.post_comments where post_id=pid;
 update public.youtube_comment_sync set thread_page_token=null,threads_done=false,pending_replies='[]' where post_id=pid;
 end if;
end $$;
revoke all on function public.claim_comment_sync(uuid),public.save_comment_page(uuid,jsonb,jsonb),public.finish_comment_sync(uuid,text,text) from public,anon,authenticated;
grant execute on function public.claim_comment_sync(uuid),public.save_comment_page(uuid,jsonb,jsonb),public.finish_comment_sync(uuid,text,text) to service_role;
-- Cleanup is scoped exclusively to the NEW comment tables.
create function public.prune_youtube_comments() returns void
language plpgsql security invoker set search_path='' as $$
begin
 delete from public.post_comments where refreshed_at<now()-interval '29 days';
 delete from public.comment_runs where status<>'running' and started_at<now()-interval '29 days';
end $$;
revoke all on function public.prune_youtube_comments() from public,anon,authenticated;
grant execute on function public.prune_youtube_comments() to service_role;
commit;
