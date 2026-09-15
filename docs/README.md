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

## What's not in v1

- Admin functions (syncing the week's games/spreads, grading, exports) --
  still done from the Streamlit Admin page, same as today.
- Realtime push for chat/scores -- this polls (matching the Streamlit app's
  own auto-refresh behavior) rather than pushing instantly, to avoid
  needing extra Supabase Realtime configuration.

## Local testing before you deploy

From the `docs/` folder:
```bash
python3 -m http.server 8000
```
Then open `http://localhost:8000` -- note that `resetPasswordForEmail` and
service-worker install prompts behave slightly differently on `localhost`
than on the real HTTPS URL, but login/picks/leaderboard/chat all work fine
for testing.
