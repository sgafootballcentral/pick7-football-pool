# get-live-scores Edge Function

A small server-side proxy for ESPN's scoreboard API. The PWA (running in a
browser) can't call ESPN directly -- ESPN's API doesn't allow cross-origin
browser requests (no CORS headers), which is why only the Python/Streamlit
side of the app has been able to pull live scores until now. This function
runs the same request server-side, inside your Supabase project, and hands
the result back to the PWA.

## Deploy it (one-time, ~5 minutes)

**Option A -- Supabase Dashboard (no install needed)**
1. Go to your project at supabase.com/dashboard -> **Edge Functions** -> **Deploy a new function**.
2. Name it `get-live-scores`.
3. Paste in the contents of `index.ts` from this folder.
4. Deploy. Supabase will give you a URL like:
   `https://YOUR-PROJECT-REF.supabase.co/functions/v1/get-live-scores`
5. Put that URL into `docs/js/config.js` as `LIVE_SCORES_URL`.

**Option B -- Supabase CLI**
```bash
npm install -g supabase
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase functions deploy get-live-scores
```

## Verify it works
Once deployed, open this in a browser (swap in a real date range, e.g. this
coming Sunday, format YYYYMMDD):
```
https://YOUR-PROJECT-REF.supabase.co/functions/v1/get-live-scores?nfl_dates=20260920-20260922
```
You should get back `{"scores": {...}}` (empty object is fine/expected if
there are no games in that date range yet).

## Notes
- This function does not touch your database or require any secrets -- it's
  a read-only pass-through to ESPN's own public (if undocumented) API, same
  endpoints your Admin page already calls.
- If ESPN ever changes their API shape, this is the one place to fix it
  (mirrors the same parsing logic as `fetch_live_scores()` in `app.py`).
- No need to redeploy this when you update the PWA's HTML/CSS/JS -- they're
  independent.
