# public-social-media-scrapper
A tool for collecting and organizing publicly available social media data for analytics, and monitoring.

It reads the public Instagram and YouTube pages of news outlets (currently Newswire and Daily Mirror, Sri Lanka) every 30 minutes through the official APIs and stores posts, engagement and YouTube comments in Supabase.

## How it works

| Piece | What it does |
| --- | --- |
| `supabase/functions/collect-channel` | Collects one channel: Instagram via Graph API Business Discovery, YouTube via Data API v3. Upserts posts and today's metrics. |
| `supabase/functions/backfill-instagram` | Pages back through an Instagram account's older posts and stores the ones inside a date window (see below). |
| `supabase/functions/collect-youtube-comments` | Pages through comment threads and replies for one YouTube video, resumable across runs. |
| `supabase/functions/comment-capture` | Backend for the comment capture extension: the dashboard queue and saving captured Instagram comments. |
| `extension/comment-capture` | Chrome extension for reading Instagram comments by hand (see below). |
| `supabase/functions/news-feed` | Read API for connected apps: posts with counts, comments and channels, keyed by an `x-consumer-key`. See [docs/news-feed-api.md](docs/news-feed-api.md). |
| `supabase/migrations` | Database schema. `20261027000000_baseline_core_schema.sql` captures tables first made in the SQL editor. |
| `supabase/snapshot/cron_jobs.sql` | The pg_cron jobs: collector every 30 minutes, newsroom push 10 minutes after each run, YouTube comments at 00:45 and 12:45 UTC, retention daily. |

All tables have RLS on with no policies, and the database functions are executable only by `service_role`, so nothing is readable with the public anon key.

YouTube data from channels that have not authorised us is pruned after 29 days, as YouTube's API policies require.

## Schedule

The collector runs every 30 minutes, on the hour and half hour (UTC):

- **00:30 and 12:30** (06:00 and 18:00 in Sri Lanka): full refresh. Instagram posts from the last 7 days and YouTube videos from the last 14 days.
- **Every other run:** new posts plus Instagram posts from the last 2 days (`refresh_days: 2`), and YouTube's full 14 days. Older Instagram posts change slowly, and this keeps each run to about 4 Business Discovery requests, well inside Meta's rate limits.
- **:10 and :40:** the `newsroom-sync` job calls the newsroom app's `/api/sync-social` route, so it picks up each run's new posts and counts. It needs two Vault secrets, `newsroom_sync_url` and `newsroom_sync_token` (the app's `CRON_SECRET`); see `supabase/snapshot/cron_jobs.sql`.

`post_metrics_daily` keeps one row per post per day, so each run overwrites that day's counts and the history holds the day's last reading.

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
npx supabase functions deploy comment-capture --no-verify-jwt
npx supabase functions deploy backfill-instagram --no-verify-jwt
```

The functions check their own secret header, so JWT verification is off.

## Instagram history backfill

The collector only refreshes the last 7 days. To fetch older Instagram posts, add a job per channel and let the `instagram-backfill` cron job (in `supabase/snapshot/cron_jobs.sql`) run it:

```sql
insert into public.instagram_backfills(channel_id,window_start,window_end)
select id,'2024-12-01 00:00+05:30','2025-04-01 00:00+05:30' from public.channels
where platform='instagram' and handle in ('dailymirrorlk','newswirelk');
```

Each call reads up to 6 pages of 50 posts from a saved cursor and stores only posts published inside the window, so a job pages through every newer post first (roughly 60 posts a day per outlet). It pauses for an hour when Meta reports a rate limit or usage above 75%, and stops as `failed` after 8 errors in a row (reset with `update public.instagram_backfills set status='pending',failures=0 where ...`). A job ends as `done` with note `reached_window_start`, or `instagram_returned_no_more_pages` if Business Discovery stops paging before the window.

- Likes, comments and views of backfilled posts are the values on the day they were fetched, not the values at the time.
- Backfilled posts have `posts.backfilled_at` set and are not served by the news feed.
- `docs/budget_engagement_comparison.sql` compares the two outlets' engagement over the window.

## Instagram comment capture

Meta's API returns comment counts but not comment text for other accounts' posts. Comment text is collected by hand with the extension in `extension/comment-capture`, run by whoever operates this collector:

1. Click the extension icon to open the dashboard. Each Instagram channel has a tab showing whether its capture is due and the posts whose comment count has gone up since the last capture.
2. Click **Open** (or **Open next post**). Posts open in post view (`/p/<code>/`) in one reused tab, with the comments beside the post.
3. Let the comments load (scroll, expand replies if you need them). The button at the bottom right counts the comments read so far, including ones Instagram has scrolled away, then click **Save N comments**. If a reel opens with a pop-up comment panel instead, saving still works, and the button offers to reopen the reel in post view if it finds no comments.
4. The comments are stored in `post_comments` against the collected post, and the post shows as done until the collector sees more comments.

The extension never scrolls, clicks or visits pages by itself. Use a separate Instagram account in that browser, not the one connected to the Meta app.

**Setup**

- Install: `chrome://extensions` → Developer mode → **Load unpacked** → choose `extension/comment-capture`.
- Create a capture key (keep the printed key; only its hash is stored):
  ```
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
  ```sql
  insert into public.integration_clients(name,key_hash,purpose)
  values ('comment-capture-<who>', encode(sha256(convert_to('<key>','UTF8')),'hex'), 'capture');
  ```
- In the dashboard's Settings, enter the project URL (`https://<ref>.supabase.co`) and the key.
- Set how often each channel should be captured (`daily`, `weekly`, or null for not scheduled):
  ```sql
  update public.channels set comment_capture_every = 'daily' where platform = 'instagram';
  ```

The page reader keys on Instagram's comment permalinks (`/p/<code>/c/<id>/`) rather than class names. If Instagram changes its markup and saves start coming back empty, `extension/comment-capture/parse.js` is the file to adjust.
