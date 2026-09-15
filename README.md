# pick7-football-pool

Weekly college football + NFL against-the-spread pick'em pool.

- `app.py`, `pages/` — the Streamlit web app (login, picks, leaderboard, chat, admin).
- `docs/` — an installable, app-like version of the player-facing pages (picks, live
  scores, standings, chat), talking to the same Supabase backend. Runs alongside the
  Streamlit app rather than replacing it. See `docs/README.md` to set it up.
- `supabase/functions/` — a small server-side Edge Function the PWA uses to fetch
  live scores (ESPN blocks direct browser calls). See its README to deploy it.
