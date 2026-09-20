# grade-games Edge Function

Automated version of the "🔄 Refresh Scores & Grade" button on the Admin
page's Grading tab. Runs on a schedule (see Cron Job setup below) so the
picks page's ✅ "covered" checkmark and the leaderboard/standings stay
current without an admin having to click the button by hand.

This mirrors the Python grading logic in `pages/1_⚙️_Admin.py` exactly
(same spread-margin math, same "grade each pick against the spread it
actually saw" rule) -- a game graded here comes out identical to one graded
manually. It does **not** touch the live score display on the picks page
(that's a separate, always-fresh fetch done on every page load and needs no
automation) -- this only writes `games.status` / `games.winning_team` and
`picks.result`.

Games and their picks are graded in parallel (`Promise.all`), not one at a
time -- a typical run finishes in ~1 second, comfortably inside the 5-second
timeout cap the Cron Jobs UI allows for an HTTP-triggered job.

## Deploy it (one-time)

1. Supabase dashboard -> **Edge Functions** -> **Deploy a new function**.
2. Name it `grade-games`.
3. Paste in the contents of `index.ts` from this folder.
4. Deploy. No new secrets needed -- `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` are provided automatically by the Edge
   Functions runtime, same as `send-picks-push`.

## Schedule it to run automatically

The Cron integration isn't enabled by default -- check **Database ->
Extensions** and toggle **pg_cron** on first (one-time; installs it into
the `pg_catalog` schema) if **Integrations -> Cron** doesn't already show
as "Installed". Skipping this step makes the "Create cron job" dialog
appear to work but the job silently never gets saved.

Then: Supabase dashboard -> **Integrations** -> **Cron** -> **Jobs** ->
**Create job**:
- Name: `grade-games-hourly` (cron jobs can't be renamed later, but the
  name is just a label -- it's fine even if you pick a different interval)
- Schedule: a cron expression, e.g. `*/30 * * * *` for every 30 minutes
  (this pool currently runs every 30 minutes) or `0 * * * *` for hourly
- Type: **Supabase Edge Function**
- Method: `POST`
- Edge Function: `grade-games`
- Timeout: `5000` ms (5000 is the max the UI allows; the function itself
  typically finishes in ~1s)
- HTTP Headers: add both
  - `Authorization: Bearer <anon/publishable key>`
  - `apikey: <anon/publishable key>`

  (The publishable key is enough -- it satisfies this function's JWT
  verification, and the function uses the service-role key internally for
  the actual database writes, so nothing more privileged needs to go in
  the cron job definition itself.)

That's it. Each run is cheap: if there are no ungraded, already-kicked-off
games, it makes zero ESPN calls and returns immediately.

## Verify it works

After creating the job, check **Integrations -> Cron -> Jobs** to confirm
it's listed with the right "Next run" time, or trigger the function once by
hand and check **Edge Functions -> grade-games -> Logs**. Calling the
function's URL directly with the publishable key in both the `apikey` and
`Authorization: Bearer` headers returns:
```json
{ "graded": 2, "stillPending": 5, "gradedGames": ["..."], "datesFetched": {"CFB": ["20260920"]}, "warnings": [] }
```

## Adjusting the cadence

Edit the cron job's schedule in the dashboard (Integrations -> Cron ->
Jobs) -- e.g. `0 * * * *` for hourly, `*/15 * * * *` for every 15 minutes.
No code change needed. Invocation count isn't a real constraint here --
even every-minute is only ~43,000/month, well under Supabase's free-tier
500,000/month Edge Function allowance -- the only reason to not go that
aggressive is that ESPN's own data doesn't update meaningfully faster than
every 15-30 minutes anyway.

## Notes
- Only processes games with `kickoff_time` already in the past and
  `status != 'final'` -- it never touches future weeks or games that are
  already graded, so it's safe to run as often as you like.
- If ESPN ever changes their API shape again, this is one of four places
  that fetch from it (the others: `app.py`'s `fetch_live_scores()`, the
  Admin page's Grading tab and Weekly Setup importer, and the
  `get-live-scores` function) -- all four use the same per-date-loop +
  `limit: 500` pattern for consistency.
