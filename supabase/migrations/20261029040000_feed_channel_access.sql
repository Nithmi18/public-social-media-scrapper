-- Each connected app only reads the channels it has been granted. A feed key with no
-- grants reads nothing, so a new key must be granted channels before it sees data.
begin;

create table public.integration_client_channels (
 client_id uuid not null references public.integration_clients(id) on delete cascade,
 channel_id uuid not null references public.channels(id) on delete cascade,
 granted_at timestamptz not null default now(),
 primary key (client_id,channel_id)
);
create index integration_client_channels_channel_idx on public.integration_client_channels(channel_id);
alter table public.integration_client_channels enable row level security;
revoke all on public.integration_client_channels from public,anon,authenticated;
grant all on public.integration_client_channels to service_role;

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
   'title',p.title,'caption',p.caption,'media_type',p.media_type,'published_at',p.published_at,
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

create or replace function public.read_feed_comments(p_key text, p_after_time timestamptz, p_after_id uuid, p_limit integer,
 p_platform text default null, p_post_id uuid default null) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare client uuid; result jsonb;
begin
 client:=public.feed_client(p_key);
 if client is null then raise exception 'invalid_consumer_key'; end if;
 select coalesce(jsonb_agg(row order by (row->>'updated_at')::timestamptz,(row->>'id')::uuid),'[]') into result from (
  select jsonb_build_object(
   'id',pc.id,'post_id',pc.post_id,'platform',c.platform,'external_id',pc.external_id,
   'parent_external_id',pc.parent_external_id,'text',pc.text_content,'author',pc.author_display_name,
   'likes',pc.likes,'reply_count',pc.reply_count,'published_at',pc.published_at,
   'first_seen_at',pc.first_seen_at,'updated_at',pc.refreshed_at) as row
  from public.post_comments pc join public.posts p on p.id=pc.post_id join public.channels c on c.id=p.channel_id
  join public.integration_client_channels g on g.channel_id=c.id and g.client_id=client
  where c.enabled and (p_platform is null or c.platform=p_platform) and (p_post_id is null or pc.post_id=p_post_id)
   and pc.refreshed_at<now()-interval '5 minutes'
   and (pc.refreshed_at,pc.id)>(p_after_time,p_after_id)
  order by pc.refreshed_at,pc.id limit least(greatest(p_limit,1),500)
 ) page;
 return result;
end $$;

create or replace function public.read_feed_channels(p_key text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare client uuid; result jsonb;
begin
 client:=public.feed_client(p_key);
 if client is null then raise exception 'invalid_consumer_key'; end if;
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',c.id,'outlet',o.name,'platform',c.platform,'handle',c.handle,'updated_at',c.refreshed_at,
  'metrics',jsonb_build_object('followers',m.followers,'post_count',m.post_count,'views',m.views,'captured_at',m.captured_at))
  order by o.name,c.platform,c.handle),'[]') into result
 from public.channels c join public.outlets o on o.id=c.outlet_id
 join public.integration_client_channels g on g.channel_id=c.id and g.client_id=client
 left join lateral (select x.followers,x.post_count,x.views,x.captured_at from public.channel_metrics_daily x
  where x.channel_id=c.id order by x.captured_at desc limit 1) m on true
 where c.enabled;
 return result;
end $$;

commit;
