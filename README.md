# public-social-media-scrapper
A tool for collecting and organizing publicly available social media data for analytics, and monitoring.

It reads the public Instagram and YouTube pages of news outlets (currently Newswire and Daily Mirror, Sri Lanka) twice a day through the official APIs and stores posts, engagement and YouTube comments in Supabase.

## How it works

| Piece | What it does |
| --- | --- |
| `supabase/functions/collect-channel` | Collects one channel: Instagram via Graph API Business Discovery, YouTube via Data API v3. Upserts posts and today's metrics. |
| `supabase/functions/collect-youtube-comments` | Pages through comment threads and replies for one YouTube video, resumable across runs. |
| `supabase/functions/comment-capture` | Backend for the comment capture extension: the dashboard queue and saving captured Instagram comments. |
| `extension/comment-capture` | Chrome extension for reading Instagram comments by hand (see below). |
| `supabase/functions/news-feed` | Read API for connected apps: posts with counts, comments and channels, keyed by an `x-consumer-key`. See [docs/news-feed-api.md](docs/news-feed-api.md). |
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
npx supabase functions deploy comment-capture --no-verify-jwt
```

The functions check their own secret header, so JWT verification is off.

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
