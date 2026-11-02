-- Daily Mirror vs Newswire Instagram engagement, Sri Lanka 2025 budget period
-- (1 Dec 2024 to 31 Mar 2025, Sri Lanka time). Run in the Supabase SQL Editor after the
-- backfill has finished (instagram_backfills.status = 'done' for both channels).
--
-- Counts are what Instagram showed on the day of the backfill, not what the posts had in 2025.
-- "Budget posts" are posts whose caption mentions the budget in English, Sinhala or Tamil.
-- Change the dates or the pattern in the params CTE to look at another period or topic.

with params as (
  select timestamptz '2024-12-01 00:00+05:30' as from_ts,
         timestamptz '2025-04-01 00:00+05:30' as to_ts,
         '(budget|appropriation bill|අයවැය|வரவு\s*செலவு)' as topic
), latest as (
  select o.name as outlet, c.handle, p.id, p.published_at, p.media_type, p.caption,
         coalesce(m.likes,0) as likes, coalesce(m.comments,0) as comments, m.views,
         p.caption ~* (select topic from params) as budget_post
  from public.posts p
  join public.channels c on c.id = p.channel_id and c.platform = 'instagram'
  join public.outlets o on o.id = c.outlet_id
  left join lateral (select x.likes, x.comments, x.views from public.post_metrics_daily x
                     where x.post_id = p.id order by x.captured_at desc limit 1) m on true
  where c.handle in ('dailymirrorlk','newswirelk')
    and p.published_at >= (select from_ts from params) and p.published_at < (select to_ts from params)
)
select outlet,
       case when grouping(budget_post) = 1 then 'all posts'
            when budget_post then 'budget posts' else 'other posts' end as posts,
       count(*)                                              as post_count,
       sum(likes)                                            as total_likes,
       sum(comments)                                         as total_comments,
       sum(likes + comments)                                 as total_engagement,
       round(avg(likes), 1)                                  as avg_likes,
       round(avg(comments), 1)                               as avg_comments,
       round(avg(likes + comments), 1)                       as avg_engagement,
       percentile_cont(0.5) within group (order by likes + comments) as median_engagement,
       max(likes + comments)                                 as best_post_engagement,
       round(avg(views) filter (where views is not null), 0) as avg_views_reels
from latest
group by grouping sets ((outlet), (outlet, budget_post))
order by posts, outlet;

-- Month by month: run this second query on its own.
with latest as (
  select o.name as outlet, p.published_at,
         coalesce(m.likes,0) + coalesce(m.comments,0) as engagement,
         p.caption ~* '(budget|appropriation bill|අයවැය|வரவு\s*செலவு)' as budget_post
  from public.posts p
  join public.channels c on c.id = p.channel_id and c.platform = 'instagram'
  join public.outlets o on o.id = c.outlet_id
  left join lateral (select x.likes, x.comments from public.post_metrics_daily x
                     where x.post_id = p.id order by x.captured_at desc limit 1) m on true
  where c.handle in ('dailymirrorlk','newswirelk')
    and p.published_at >= '2024-12-01 00:00+05:30' and p.published_at < '2025-04-01 00:00+05:30'
)
select date_trunc('month', published_at at time zone 'Asia/Colombo')::date as month, outlet,
       count(*) as posts, sum(engagement) as engagement, round(avg(engagement),1) as avg_engagement,
       count(*) filter (where budget_post) as budget_posts,
       round(avg(engagement) filter (where budget_post),1) as avg_engagement_budget_posts
from latest
group by 1, 2
order by 1, 2;
