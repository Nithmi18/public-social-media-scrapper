# News feed API

Read API for apps connected to the public social collector. Each app only sees the channels it has been granted. It serves what the collector gathers from those channels: posts with their latest counts, comment text, and channels. Today that is Instagram and YouTube; Facebook, X and TikTok will appear as new `platform` values when they are added, without changes to the API.

Base URL: `https://qyeaiqpvqecyapovcwox.supabase.co/functions/v1/news-feed`

## Authentication

Every request sends the app's key in the `x-consumer-key` header. Keys are 64 hex characters, one per app, and are only stored as a hash. Call the API from your server: never put the key in a browser page or mobile app.

```
curl -H "x-consumer-key: $NEWS_FEED_KEY" "$BASE/posts?limit=100"
```

## Endpoints

### `GET /posts`

Posts from every tracked channel, with the latest counts.

| Query | Meaning |
|---|---|
| `cursor` | `next_cursor` from your previous call. Leave out on the first call. |
| `limit` | 1–100, default 100. |
| `platform` | `instagram` or `youtube`. |
| `outlet` | Outlet name, e.g. `Daily Mirror`. |

Each post: `id`, `outlet`, `platform`, `handle`, `external_id`, `url`, `title`, `caption`, `media_type`, `thumbnail_url`, `published_at`, `first_seen_at`, `updated_at`, `metrics` (`likes`, `comments`, `views`, `captured_at`), `comments_stored`.

`thumbnail_url` is the post's image: the YouTube video thumbnail, or the Instagram photo or video cover. It is `null` until the collector has refreshed the post. Instagram image links expire after a few days, so download the image when you receive the post and serve your own copy; do not store the link itself. Only links on `cdninstagram.com`, `fbcdn.net` and `ytimg.com` are ever sent.

### `GET /comments`

Comment text. YouTube comments and replies are collected automatically; Instagram comments are captured by an operator and arrive later.

| Query | Meaning |
|---|---|
| `cursor` | As above. |
| `limit` | 1–500, default 100. |
| `platform` | `instagram` or `youtube`. |
| `post_id` | Only comments on this post (the post's `id`). |

Each comment: `id`, `post_id`, `platform`, `external_id`, `parent_external_id` (set on replies), `text`, `author`, `likes`, `reply_count`, `published_at`, `first_seen_at`, `updated_at`.

### `GET /channels`

Tracked channels with their latest `metrics` (`followers`, `post_count`, `views`, `captured_at`). No paging.

## Syncing

`/posts` and `/comments` are change feeds ordered by `updated_at`. A row comes back whenever the collector refreshes it, for example with new counts.

1. Call without a cursor, then keep calling with `next_cursor` while `has_more` is `true`.
2. Upsert every row by `id`. Delivery is at least once, so the same row can arrive twice.
3. Store the last `next_cursor` and start from it next time.

The collector runs at 06:00 and 18:00 Sri Lanka time (00:30 and 12:30 UTC), so syncing about 30 minutes after each run is enough. Rows appear about 5 minutes after they are collected.

## Data rules

- **YouTube:** YouTube's developer policies require data to be refreshed or deleted within 30 days. The collector deletes YouTube posts and comments it has not refreshed for 29 days. Do the same in your app: delete YouTube rows whose `updated_at` is older than 30 days.
- **Instagram:** comment counts come from Meta's API; comment text is captured by hand and may lag behind the counts.
- Counts can be `null` when a platform hides them.

## Errors

| Status | `error` |
|---|---|
| 400 | `invalid_cursor`, `invalid_limit`, `invalid_platform`, `invalid_outlet`, `invalid_post_id` |
| 401 | `unauthorized`, `invalid_consumer_key` |
| 404 | `not_found` |
| 500 | anything else; retry later |

## Creating a key (collector operator)

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
```sql
insert into public.integration_clients(name,key_hash,purpose)
values ('<app name>', encode(sha256(convert_to('<key>','UTF8')),'hex'), 'feed');
```
A new key reads nothing until it is granted channels. Grant only the channels the app needs:
```sql
insert into public.integration_client_channels(client_id, channel_id)
select i.id, c.id from public.integration_clients i, public.channels c
where i.name = '<app name>' and c.handle in ('dailymirrorlk', '@Dailymirror0', 'newswirelk', '@NewsWireSL');
```
To see what an app can read:
```sql
select c.platform, c.handle from public.integration_client_channels g
join public.integration_clients i on i.id = g.client_id join public.channels c on c.id = g.channel_id
where i.name = '<app name>';
```
To remove a channel: `delete from public.integration_client_channels g using public.integration_clients i, public.channels c where g.client_id = i.id and g.channel_id = c.id and i.name = '<app name>' and c.handle = '<handle>';`

Send the key to the app's technical contact once, privately. To revoke it: `update public.integration_clients set enabled = false where name = '<app name>';`
