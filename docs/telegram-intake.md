# Telegram Gateway — Photo Intake (phase 1)

Source of truth: the "Telegram Gateway — Photo Intake Spec" in Master Chief (Process Notes).
This page covers what was built, every setting (names only, never values), Chris's setup
steps, the kill switch and how to roll back.

## Safety switch

All new intake behaviour is **off** unless the Netlify env var `INTAKE_ENABLED` is exactly `true`
**and** every required intake setting below exists. While it is off:

- Photos and videos from the roster get one line: "Photo intake is paused." (or "Photos aren't
  handled yet." for roster people who aren't set up for intake). Nothing is downloaded or stored.
- Business (Secretary Mode) updates are dropped completely: no reply, no log, no storage.
- The background worker exits immediately and the sweeper only prunes old de-dupe markers.
- Plain text from the roster still gets the existing "Got it, <name>. Message logged." reply, but the
  log line no longer contains the message text (only its length).

## What runs where

| File | What it does |
| --- | --- |
| `netlify/functions/telegram-gateway.mts` | Webhook at `/telegram-gateway` (route unchanged). Secret check, update_id de-dupe, privacy filter, media intake, button answers. |
| `netlify/functions/photo-intake-background.mts` | Background worker (up to 15 min). Album grouping, getFile, download, metadata, Drive upload + JSON sidecar, log row, "Filed" reply. |
| `netlify/functions/photo-intake-sweeper.mts` | Scheduled every 5 min (production only). Reminders (4 h), timeouts to Unsorted (24 h), restarts a stuck worker, writes the Daily tab row, prunes markers. |
| `lib/intake/*` | Small shared modules (config, roster, caption, mapping, naming, media, metadata, mp4, google, telegram, store, state, resolve, worker, sweeper, sheet, sidecar, changeRequests). |
| `scripts/intake-oauth-refresh-token.ts` | One-time: gets the Google refresh token (drive.file scope). Run by Chris on his computer. |
| `scripts/intake-setup.ts` | One-time: creates the intake folders and the "Telegram Intake Log" Sheet. Run by Chris on his computer. |

State lives in Netlify Blobs (site-wide stores): `intake-queue`, `intake-pending`, `intake-seen`,
`intake-caps`, `intake-lock`, `intake-incoming` (album buffer), `intake-groups`. No media bytes are
stored outside Drive; a pending item holds only Telegram's file_id and the redacted caption.

Metadata: images are read with `exifr` (pure JavaScript; EXIF, GPS, XMP, IPTC; JPEG/HEIC/PNG/WebP).
Videos are read by a small built-in MP4/MOV box reader (`lib/intake/mp4.ts`): duration, resolution,
frame rate, codec, creation time, and make/model/location from QuickTime keys or `©xyz`-style tags.
No native tools (ffmpeg/exiftool) are needed on Netlify. GPS goes only into the JSON sidecar; the log
row records `gps_present` yes/no.

## Environment variables (names only)

Set in Netlify → site heroes-draft-review → Environment variables, scope **Functions**, marked
**secret** where they hold credentials. Netlify functions only see env var changes after a new deploy.

Existing:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `ROSTER_JSON` (new fields, see "Roster" below)

Required before intake can run:
- `INTAKE_ENABLED` — kill switch, `true` to run, anything else = off
- `INTAKE_WORKER_SECRET` — long random string; the webhook and sweeper use it to start the worker
- `CHRIS_TELEGRAM_USER_ID` — Chris's numeric Telegram id
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REFRESH_TOKEN`
- `DRIVE_FOLDER_HEROES`, `DRIVE_FOLDER_TFC`, `DRIVE_FOLDER_KRAKEN`, `DRIVE_FOLDER_UNSORTED` — printed by the setup script
- `INTAKE_LOG_SHEET_ID` — printed by the setup script

Optional (defaults in brackets; all pending Chris's confirmation):
- `INTAKE_ENABLED_CHAT_IDS` [empty] — comma list of business chats where Chris's own outgoing media is filed
- `INTAKE_MAX_BYTES` [20971520]
- `INTAKE_DEFAULT_DAILY_CAP` [30], `INTAKE_OWNER_DAILY_CAP` [100], `INTAKE_GLOBAL_DAILY_CAP` [200]
- `INTAKE_REMINDER_HOURS` [4], `INTAKE_TIMEOUT_HOURS` [24]
- `INTAKE_ALBUM_SETTLE_MS` [5000]
- `INTAKE_ASK_PERSON` [true] — ask "Who's in it?" when the caption names nobody
- `INTAKE_MINORS_PROJECTS` [heroes,kraken] — projects that always get the under-18 question
- `ROSTER_LEGACY_USERNAME_MATCH` [true] — lets roster entries that don't have `user_id` yet keep getting
  the plain-text reply. Never used for intake or business messages. Set `false` once every entry has `user_id`.
- `INTAKE_BLOBS_PREFIX` [empty] — e.g. `staging-` on a staging branch so it doesn't share Blobs with production

Provided by Netlify: `URL`.

Keep the 4 KB combined env var limit for functions in mind (spec F6). The full set above is well under it.

## Roster

Intake matches people by numeric Telegram id (`user_id`), never by username. Example shape
(placeholder values):

```json
[
  { "name": "Chris Magyar", "user_id": 111111111, "role": "owner", "authorized": true, "intake": true, "default_project": null },
  { "name": "Example Coach", "key": "example-coach", "user_id": 222222222, "role": "coach", "authorized": true, "intake": true,
    "default_project": "kraken", "allowed_projects": ["kraken"], "daily_cap": 30, "is_minor": false }
]
```

Capability tiers (one shared bot): the owner gets everything; authorized coaches get own bio proposal,
photo intake, doctrine question and course PDF; everyone else gets nothing. Only photo intake is wired
up in this phase. No phone numbers or ages in the roster.

## Chris's setup steps (before turning intake on)

1. **Google Cloud project (free).** In console.cloud.google.com create a project, then enable the
   **Google Drive API** and **Google Sheets API**.
2. **OAuth consent screen.** User type External. Add the scope `.../auth/drive.file` only. Add yourself
   as a test user, then click **Publish app** so the status is **In production** (in "Testing" the
   refresh token dies after 7 days). No verification is needed for personal use.
3. **OAuth client.** Credentials → Create credentials → OAuth client ID → type **Desktop app**. Keep the
   client ID and secret.
4. **Refresh token.** On your own computer: `git clone`, `npm install`, then
   `GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... npm run intake:oauth`. Open the link, sign in,
   accept the one-time "unverified app" warning (Advanced → continue), approve. The terminal prints the
   refresh token once. Clear the terminal afterwards.
5. **Create folders and the log Sheet.** `GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... GOOGLE_OAUTH_REFRESH_TOKEN=... npm run intake:setup`
   (add `-- --dry-run` first to see the plan). It prints the `DRIVE_FOLDER_*` and `INTAKE_LOG_SHEET_ID`
   values. Under drive.file the app can't create things inside folders it didn't make, so everything is
   created at the top of My Drive; then drag each "<Project> Photo Intake — Telegram" folder to its home
   from spec section 7 (the app keeps access after a move). Never share these folders or the Sheet.
6. **Your Telegram numeric id.** Get it (for example from a Telegram id bot, or from the gateway's first
   update once logging is on) and put it in `CHRIS_TELEGRAM_USER_ID` and your roster entry's `user_id`.
7. **Roster.** Update `ROSTER_JSON`: your entry gets `user_id`, `role: "owner"`, `authorized: true`,
   `intake: true`. Coaches get `user_id`, `role: "coach"`, `intake: true` and their project(s).
8. **Netlify env vars.** Add everything in "Required before intake can run" (Functions scope, secret).
   Make `INTAKE_WORKER_SECRET` a long random value (for example `openssl rand -hex 32`).
9. **Telegram webhook.** Check with getWebhookInfo. If it was registered with an explicit
   `allowed_updates` list, re-register it including `message`, `callback_query` and `business_message`
   (buttons need `callback_query`). The URL stays `/telegram-gateway`.
10. **(Recommended) Narrow Secretary Mode** in Telegram Business settings to selected chats only.
11. **(Recommended) Staging first.** A second bot pointed at a branch deploy, branch-scoped env vars,
    `INTAKE_BLOBS_PREFIX=staging-`, and test folders from a separate setup run. Note: scheduled functions
    don't run on branch deploys, so reminders/timeouts/worker restarts only happen in production.
12. **Turn it on.** Set `INTAKE_ENABLED=true` and trigger a deploy (env changes need a deploy). Send one
    photo with `#kraken who: Test Person drill` and check the file, sidecar and log row.
13. **Before the first coach:** rotate `TELEGRAM_WEBHOOK_SECRET` and re-run setWebhook (spec decision 12).

## Kill switch and rollback

- **Pause intake:** set `INTAKE_ENABLED=false` (or delete it) and trigger a deploy. Queued jobs and open
  questions stay in Blobs and resume when it's switched back on.
- **Stop the Google access entirely:** remove the app at myaccount.google.com/permissions. The worker
  then keeps jobs queued and tells Chris once a day; nothing is lost.
- **Roll back the code:** Netlify → Deploys → pick the deploy before this change → "Publish deploy"
  (instant), or revert the merge commit on main. The webhook route is unchanged, so Telegram needs no
  change either way.
- **Clean up:** the Blobs stores listed above can be deleted from the Netlify UI; Drive files stay
  Chris-owned in the intake folders.

## Tests

`npm test` (vitest, everything mocked: Telegram, Google, Blobs) and `npm run typecheck`.
