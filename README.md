# public-social-media-scrapper
A tool for collecting and organizing publicly available social media data for analytics, and monitoring.

It reads the public Instagram and YouTube pages of news outlets (currently Newswire and Daily Mirror, Sri Lanka) twice a day through the official APIs and stores posts, engagement and YouTube comments in Supabase.

## How it works

| Piece | What it does |
| --- | --- |
| `supabase/functions/collect-channel` | Collects one channel: Instagram via Graph API Business Discovery, YouTube via Data API v3. Upserts posts and today's metrics. |
| `supabase/functions/collect-youtube-comments` | Pages through comment threads and replies for one YouTube video, resumable across runs. |
| `supabase/functions/news-feed` | Read API for other tools: new posts in order, keyed by an `x-consumer-key` (hash stored in `integration_clients`). |
| `supabase/migrations` | Database schema. `20261027000000_baseline_core_schema.sql` captures tables first made in the SQL editor. |
| `supabase/snapshot/cron_jobs.sql` | The pg_cron jobs: collector at 00:30 and 12:30 UTC, comments at :45, retention daily. |

All tables have RLS on with no policies, and the database functions are executable only by `service_role`, so nothing is readable with the public anon key.

YouTube data from channels that have not authorised us is pruned after 29 days, as YouTube's API policies require.

## Deploying

```
npx supabase login
npx supabase link --project-ref qyeaiqpvqecyapovcwox
npx supabase migration repair --status applied 20261027000000   # once, on the live project
npx supabase db push
npx supabase secrets set --env-file .env
npx supabase functions deploy collect-channel --no-verify-jwt
npx supabase functions deploy collect-youtube-comments --no-verify-jwt
npx supabase functions deploy news-feed --no-verify-jwt
```

The functions check their own secret header, so JWT verification is off.
