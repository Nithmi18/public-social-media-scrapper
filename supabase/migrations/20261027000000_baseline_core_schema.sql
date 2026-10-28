-- Baseline of the core schema, which was first created in the Supabase SQL editor
-- (outside migrations). Captured from the live database on 2026-10-28 so the
-- project can be rebuilt from this repo. On the live project, mark it as applied
-- instead of running it:
--   supabase migration repair --status applied 20261027000000

create extension if not exists pgcrypto;

create table public.outlets (
  id uuid default gen_random_uuid() not null,
  name text not null,
  country text default 'LK'::text not null,
  created_at timestamp with time zone default now() not null,
  constraint outlets_name_key UNIQUE (name),
  constraint outlets_pkey PRIMARY KEY (id)
);

create table public.channels (
  id uuid default gen_random_uuid() not null,
  outlet_id uuid not null,
  platform text not null,
  handle text not null,
  external_id text,
  enabled boolean default false not null,
  metadata jsonb default '{}'::jsonb not null,
  refreshed_at timestamp with time zone,
  constraint channels_platform_handle_key UNIQUE (platform, handle),
  constraint channels_pkey PRIMARY KEY (id),
  constraint channels_handle_check CHECK ((handle ~ '^[A-Za-z0-9_.@-]+$'::text)),
  constraint channels_platform_check CHECK ((platform = ANY (ARRAY['instagram'::text, 'youtube'::text])))
);

create table public.posts (
  id uuid default gen_random_uuid() not null,
  channel_id uuid not null,
  external_id text not null,
  url text not null,
  title text,
  caption text,
  media_type text,
  published_at timestamp with time zone not null,
  first_seen_at timestamp with time zone default now() not null,
  refreshed_at timestamp with time zone default now() not null,
  constraint posts_channel_id_external_id_key UNIQUE (channel_id, external_id),
  constraint posts_pkey PRIMARY KEY (id)
);

create table public.post_metrics_daily (
  post_id uuid not null,
  captured_on date default ((now() AT TIME ZONE 'Asia/Colombo'::text))::date not null,
  captured_at timestamp with time zone default now() not null,
  likes bigint,
  comments bigint,
  views bigint,
  constraint post_metrics_daily_pkey PRIMARY KEY (post_id, captured_on),
  constraint post_metrics_daily_comments_check CHECK ((comments >= 0)),
  constraint post_metrics_daily_likes_check CHECK ((likes >= 0)),
  constraint post_metrics_daily_views_check CHECK ((views >= 0))
);

create table public.channel_metrics_daily (
  channel_id uuid not null,
  captured_on date default ((now() AT TIME ZONE 'Asia/Colombo'::text))::date not null,
  captured_at timestamp with time zone default now() not null,
  followers bigint,
  post_count bigint,
  views bigint,
  constraint channel_metrics_daily_pkey PRIMARY KEY (channel_id, captured_on),
  constraint channel_metrics_daily_followers_check CHECK ((followers >= 0)),
  constraint channel_metrics_daily_post_count_check CHECK ((post_count >= 0)),
  constraint channel_metrics_daily_views_check CHECK ((views >= 0))
);

create table public.runs (
  id uuid default gen_random_uuid() not null,
  channel_id uuid not null,
  started_at timestamp with time zone default now() not null,
  finished_at timestamp with time zone,
  status text default 'running'::text not null,
  posts_seen integer default 0 not null,
  error_code text,
  warnings jsonb default '[]'::jsonb not null,
  constraint runs_pkey PRIMARY KEY (id),
  constraint runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'success'::text, 'partial'::text, 'failed'::text])))
);

create table public.integration_clients (
  id uuid default gen_random_uuid() not null,
  name text not null,
  key_hash text not null,
  enabled boolean default true not null,
  created_at timestamp with time zone default now() not null,
  constraint integration_clients_key_hash_key UNIQUE (key_hash),
  constraint integration_clients_name_key UNIQUE (name),
  constraint integration_clients_pkey PRIMARY KEY (id),
  constraint integration_clients_key_hash_check CHECK ((key_hash ~ '^[a-f0-9]{64}$'::text))
);

alter table public.channel_metrics_daily add constraint channel_metrics_daily_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;
alter table public.channels add constraint channels_outlet_id_fkey FOREIGN KEY (outlet_id) REFERENCES public.outlets(id);
alter table public.post_metrics_daily add constraint post_metrics_daily_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE;
alter table public.posts add constraint posts_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;
alter table public.runs add constraint runs_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;

CREATE INDEX channels_outlet_idx ON public.channels USING btree (outlet_id);
CREATE INDEX posts_channel_published_idx ON public.posts USING btree (channel_id, published_at DESC);
CREATE INDEX posts_feed_idx ON public.posts USING btree (first_seen_at, id);
CREATE INDEX posts_refresh_idx ON public.posts USING btree (refreshed_at);
CREATE INDEX runs_channel_started_idx ON public.runs USING btree (channel_id, started_at DESC);
CREATE UNIQUE INDEX runs_one_active_idx ON public.runs USING btree (channel_id) WHERE (status = 'running'::text);

-- Locked down: no RLS policies, no anon/authenticated grants. Only the service role
-- (used by the Edge Functions) can read or write.
do $$ declare t text; begin
 foreach t in array array['outlets','channels','posts','post_metrics_daily','channel_metrics_daily','runs','integration_clients'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;

CREATE OR REPLACE FUNCTION public.claim_collection(p_channel uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare r uuid;
begin
 perform 1 from public.channels where id=p_channel and enabled for update;
 if not found then raise exception 'channel_disabled_or_missing'; end if;
 update public.runs set status='failed',finished_at=now(),error_code='lease_expired'
 where channel_id=p_channel and status='running' and started_at < now()-interval '10 minutes';
 if exists(select 1 from public.runs where channel_id=p_channel and status='running') then return null; end if;
 insert into public.runs(channel_id) values(p_channel) returning id into r;
 return r;
end $function$;

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
 if jsonb_array_length(p_payload->'posts')>500 then raise exception 'invalid_payload'; end if;
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

-- YouTube API policy: statistics and other non-authorized data are refreshed or deleted within 30 days.
CREATE OR REPLACE FUNCTION public.prune_api_data()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
 delete from public.post_metrics_daily m using public.posts p,public.channels c
 where m.post_id=p.id and p.channel_id=c.id and c.platform='youtube' and m.captured_at<now()-interval '29 days';
 delete from public.channel_metrics_daily m using public.channels c
 where m.channel_id=c.id and c.platform='youtube' and m.captured_at<now()-interval '29 days';
 delete from public.posts p using public.channels c where p.channel_id=c.id and c.platform='youtube'
 and p.refreshed_at<now()-interval '29 days';
 update public.channels set metadata='{}',external_id=null,refreshed_at=null
 where platform='youtube' and refreshed_at<now()-interval '29 days';
 delete from public.runs where status<>'running' and started_at<now()-interval '90 days';
end $function$;

CREATE OR REPLACE FUNCTION public.read_news_feed(p_key text, p_after_time timestamp with time zone, p_after_id uuid, p_limit integer DEFAULT 50)
 RETURNS TABLE(id uuid, outlet text, platform text, handle text, url text, title text, caption text, media_type text, published_at timestamp with time zone, first_seen_at timestamp with time zone, refreshed_at timestamp with time zone)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
 if not exists(select 1 from public.integration_clients where enabled and
 key_hash=encode(sha256(convert_to(p_key,'UTF8')),'hex')) then raise exception 'invalid_consumer_key'; end if;
 return query select p.id,o.name,c.platform,c.handle,p.url,p.title,p.caption,p.media_type,p.published_at,p.first_seen_at,p.refreshed_at
 from public.posts p join public.channels c on c.id=p.channel_id join public.outlets o on o.id=c.outlet_id
 where c.platform='instagram' and c.enabled
 and (p.first_seen_at,p.id)>(p_after_time,p_after_id)
 order by p.first_seen_at,p.id limit least(greatest(p_limit,1),100);
end $function$;

revoke all on function public.claim_collection(uuid),public.finish_collection(uuid,jsonb),public.prune_api_data(),public.read_news_feed(text,timestamptz,uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_collection(uuid),public.finish_collection(uuid,jsonb),public.prune_api_data(),public.read_news_feed(text,timestamptz,uuid,integer) to service_role;
