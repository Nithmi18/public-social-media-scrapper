-- Sri Lanka government budget 2026 posts (1 Nov - 31 Dec 2025): Daily Mirror vs Newswire.
-- For the 2025 budget version, see budget_posts_comparison.sql.
-- A post counts when its caption contains "budget" (not "budget-friendly"), "2026", and at
-- least one politics word: government, parliament, minister, MP, president, cabinet,
-- opposition, debate, reading, vote, finance, treasury or appropriation. Every word is
-- matched in English, Sinhala or Tamil, and the languages can be mixed in one caption.
-- The budget word must also be in the headline (first 250 characters), so long articles that
-- only mention the budget in passing are left out, and local council budgets are left out.
-- Likes and comments are the counts on the day the post was collected, not in 2025.
-- Posts come from the Nov-Dec 2025 backfill.

-- Query 1: every budget post, with its link, likes, comments and engagement.
with budget_posts as (
  select o.name as outlet,
         (p.published_at at time zone 'Asia/Colombo')::date as published_on,
         p.url,
         left(regexp_replace(p.caption, '\s+', ' ', 'g'), 150) as caption,
         coalesce(m.likes, 0) as likes,
         coalesce(m.comments, 0) as comments,
         coalesce(m.likes, 0) + coalesce(m.comments, 0) as engagement
  from public.posts p
  join public.channels c on c.id = p.channel_id and c.platform = 'instagram'
  join public.outlets o on o.id = c.outlet_id
  left join lateral (select x.likes, x.comments from public.post_metrics_daily x
                     where x.post_id = p.id order by x.captured_at desc limit 1) m on true
  where c.handle in ('dailymirrorlk', 'newswirelk')
    and p.published_at >= '2025-11-01 00:00+05:30' and p.published_at < '2026-01-01 00:00+05:30'
    -- Each line accepts English, Sinhala or Tamil.
    and p.caption ~* '(\mbudget\M(?![- ]?friendly)|අයවැය|வரவு\s*செலவு|பாதீடு|பட்ஜெட்)'   -- budget
    and p.caption ~ '(2026|௨௦௨௬)'                                                  -- 2026
    -- Budget must be the topic: the budget word appears in the headline / first 250 characters.
    and left(p.caption, 250) ~* '(\mbudget\M(?![- ]?friendly)|අයවැය|வரவு\s*செலவு|பாதீடு|பட்ஜெட்)'
    -- Leave out local council budgets (Municipal, Urban, Pradeshiya, Provincial councils).
    and p.caption !~* '(municipal|urban council|pradeshiya|provincial council|\mMC\M|නගර සභා|ප්‍රාදේශීය සභා|மாநகர சபை|பிரதேச சபை)'
    and p.caption ~* '(\mgov(ernment|t)\M|parliament|\mministers?\M|\mministry\M|\mMPs?\M|president|cabinet|opposition|\mdebate|\mreading\M|\mvot(e|ed|es|ing)\M|finance|treasury|appropriation|රජය|ආණ්ඩු|පාර්ලිමේන්තු|ඇමති|ජනාධිපති|அரசாங்க|அரசு|நாடாளுமன்ற|பாராளுமன்ற|அமைச்சர்|ஜனாதிபதி)' -- politics word
)
select * from budget_posts
order by outlet, published_on;

-- Query 2 (run on its own): totals per outlet over the same posts.
with budget_posts as (
  select o.name as outlet,
         coalesce(m.likes, 0) as likes,
         coalesce(m.comments, 0) as comments
  from public.posts p
  join public.channels c on c.id = p.channel_id and c.platform = 'instagram'
  join public.outlets o on o.id = c.outlet_id
  left join lateral (select x.likes, x.comments from public.post_metrics_daily x
                     where x.post_id = p.id order by x.captured_at desc limit 1) m on true
  where c.handle in ('dailymirrorlk', 'newswirelk')
    and p.published_at >= '2025-11-01 00:00+05:30' and p.published_at < '2026-01-01 00:00+05:30'
    -- Each line accepts English, Sinhala or Tamil.
    and p.caption ~* '(\mbudget\M(?![- ]?friendly)|අයවැය|வரவு\s*செலவு|பாதீடு|பட்ஜெட்)'   -- budget
    and p.caption ~ '(2026|௨௦௨௬)'                                                  -- 2026
    -- Budget must be the topic: the budget word appears in the headline / first 250 characters.
    and left(p.caption, 250) ~* '(\mbudget\M(?![- ]?friendly)|අයවැය|வரவு\s*செலவு|பாதீடு|பட்ஜெட்)'
    -- Leave out local council budgets (Municipal, Urban, Pradeshiya, Provincial councils).
    and p.caption !~* '(municipal|urban council|pradeshiya|provincial council|\mMC\M|නගර සභා|ප්‍රාදේශීය සභා|மாநகர சபை|பிரதேச சபை)'
    and p.caption ~* '(\mgov(ernment|t)\M|parliament|\mministers?\M|\mministry\M|\mMPs?\M|president|cabinet|opposition|\mdebate|\mreading\M|\mvot(e|ed|es|ing)\M|finance|treasury|appropriation|රජය|ආණ්ඩු|පාර්ලිමේන්තු|ඇමති|ජනාධිපති|அரசாங்க|அரசு|நாடாளுமன்ற|பாராளுமன்ற|அமைச்சர்|ஜனாதிபதி)' -- politics word
)
select outlet,
       count(*)                          as budget_posts,
       sum(likes)                        as total_likes,
       sum(comments)                     as total_comments,
       sum(likes + comments)             as total_engagement,
       round(avg(likes + comments), 1)   as avg_engagement_per_post,
       max(likes + comments)             as best_post_engagement
from budget_posts
group by outlet
order by outlet;
