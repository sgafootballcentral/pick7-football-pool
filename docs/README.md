# Pick 7 PWA

An installable, app-like version of the player-facing side of Pick 7 --
picks, live scores, standings, and chat -- built as a static site that talks
straight to your existing Supabase project. It's meant to run *alongside*
the Streamlit app, not replace it: your friends can keep using the browser
link if they want, or install this to their phone's home screen for a more
native feel. Both read and write the exact same `games` / `picks` / `players`
/ `league_users` / `chat_messages` tables, so picks made in one show up in
the other immediately. The Admin pages stay in Streamlit for now.

## 1. Fill in your Supabase config

Open `docs/js/config.js` and fill in:
- `SUPABASE_URL` and `SUPABASE_ANON_KEY` -- same values from your Streamlit
  secrets (Supabase dashboard -> Project Settings -> API). The anon key is
  safe to ship in client-side code like this; it only grants what your RLS
  policies already allow.
- `LIVE_SCORES_URL` -- set after you deploy the Edge Function, see
  `supabase/functions/get-live-scores/README.md`.

## 2. Allow the reset-password redirect

In the Supabase dashboard: **Authentication -> URL Configuration -> Redirect
URLs**, add the URL you'll host the PWA at (e.g.
`https://sgafootballcentral.github.io/pick7-football-pool/`). Without this,
the "forgot password" email link won't be allowed to redirect back into the
app.

## 3. Deploy the Edge Function for live scores

See `supabase/functions/get-live-scores/README.md`. Skippable if you're
fine without live in-game scores in the PWA for now -- everything else
still works (schedule, spreads, submitting picks, standings, chat).

## 4. Host it (GitHub Pages -- free, and it's already your repo)

1. On GitHub: repo **Settings -> Pages**.
2. Under "Build and deployment", set **Source: Deploy from a branch**.
3. Branch: `main`, folder: `/docs`. Save.
4. GitHub gives you a URL like `https://sgafootballcentral.github.io/pick7-football-pool/`
   -- that's what you share with the group to install.

## 5. Installing it

- **Android / desktop Chrome**: visiting the URL shows an "Install" banner
  in-app (and Chrome's own address-bar install icon).
- **iPhone/iPad (Safari)**: Share icon -> "Add to Home Screen". iOS doesn't
  support the automatic install prompt, so the PWA shows a banner with these
  instructions instead.

## 6. Admin shortcut

If you're an admin, the top bar shows an **Admin ↗** link straight to the
Streamlit Admin app, and it carries your PWA session over so you don't have
to log in a second time (see `admin_sso_at`/`admin_sso_rt` handling in
`app.py`). If the handoff ever fails for some reason, it just falls back to
Streamlit's normal login screen -- nothing breaks.

## 7. Chat: unread badge + push notifications

Two pieces work together so players don't have to keep the Chat tab open to
know someone posted:

- **In-app badge** -- a small red dot on the bottom-nav Chat button,
  entirely client-side. No setup needed.
- **Real OS notifications** -- opt-in per device via the 🔔 button on the
  Chat tab. One-time setup:

  1. **Database** (SQL Editor, run once against your Supabase project):
     ```sql
     create table if not exists push_subscriptions (
       id bigint generated always as identity primary key,
       user_id uuid not null references auth.users(id) on delete cascade,
       endpoint text not null unique,
       p256dh text not null,
       auth text not null,
       created_at timestamptz not null default now()
     );
     alter table push_subscriptions enable row level security;
     drop policy if exists "Users manage their own push subscriptions" on push_subscriptions;
     create policy "Users manage their own push subscriptions"
       on push_subscriptions for all
       using (auth.uid() = user_id)
       with check (auth.uid() = user_id);
     alter table players add column if not exists last_chat_read_at timestamptz;
     ```
  2. **Edge Function + webhook** -- see
     `supabase/functions/send-chat-push/README.md` for deploying the
     function, setting the VAPID secrets, and wiring up the Database
     Webhook that fires it on every new chat message.
  3. `docs/js/config.js`'s `VAPID_PUBLIC_KEY` is already set to match the
     keypair used above -- only change it if you generate a new keypair.

## 8. Admin push notification when picks are submitted

Whenever a player finishes submitting (or resubmitting) their picks for a
week, every admin who has push notifications enabled gets a real OS
notification naming who submitted and for which week. It reuses the exact
same opt-in as chat -- the 🔔 button on the Chat tab -- since a browser's
push subscription isn't tied to one feature. An admin who already turned
on notifications for chat is automatically covered here too; nothing
extra to enable.

Setup (one-time, same pattern as chat push):

1. **Database**: a `pick_submissions` table logs one row per submission
   (not per pick -- a single submission writes 7 rows to `picks`, so this
   table exists purely as a single-row-per-event marker to hook a webhook
   on):
   ```sql
   create table if not exists pick_submissions (
     id bigint generated always as identity primary key,
     user_id uuid not null references auth.users(id) on delete cascade,
     username text not null,
     week_number int not null,
     picks_count int not null default 7,
     created_at timestamptz not null default now()
   );
   alter table pick_submissions enable row level security;
   create policy "Users insert their own pick submissions"
     on pick_submissions for insert
     with check (auth.uid() = user_id);
   create policy "Users read their own pick submissions"
     on pick_submissions for select
     using (auth.uid() = user_id);
   ```
2. **Edge Function + webhook** -- see
   `supabase/functions/send-picks-push/README.md` for deploying the
   function and wiring up the Database Webhook (`pick_submission_push`)
   that fires it on every new `pick_submissions` row. No new secrets
   needed -- it reuses the VAPID keys already set up for chat.

## What's not in v1

- Admin functions (syncing the week's games/spreads, grading, exports) --
  still done from the Streamlit Admin page, same as today.
- Realtime for picks/leaderboard/live scores -- those still poll (matching
  the Streamlit app's own auto-refresh behavior) rather than pushing
  instantly. Chat and picks-submitted admin alerts are the exception --
  both trigger a real push notification, see above.

## Local testing before you deploy

From the `docs/` folder:
```bash
python3 -m http.server 8000
```
Then open `http://localhost:8000` -- note that `resetPasswordForEmail` and
service-worker install prompts behave slightly differently on `localhost`
than on the real HTTPS URL, but login/picks/leaderboard/chat all work fine
for testing.
