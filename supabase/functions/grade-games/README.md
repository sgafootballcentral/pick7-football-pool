# grade-games Edge Function

Automated version of the "🔄 Refresh Scores & Grade" button on the
Admin page's Grading tab. Runs on a schedule (see Cron Job setup below) so
the picks page's ✅ "covered" checkmark and the leaderboard/standings stay
current without an admin having to click the button by hand.

This mirrors the Python grading logic in `pages/1_⚙️_Admin.py` exactly
(same spread-margin math, same "grade each pick against the spread it
actually saw" rule) -- a game graded here comes out identical to one graded
manually. It does **not** touch the live score display on the picks page
(that's a separate, always-fresh fetch done on every page load and needs no
automation) -- this only writes `games.status` / `games.winning_team` and
`picks.result`.

## Deploy it (one-time)

1. Supabase dashboard -> **Edge Functions** -> **Deploy a new function**.
2. Name it `grade-games`.
3. Paste in the contents of `index.ts` from this folder.
4. Deploy. No new secrets needed -- `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` are provided automatically by the Edge
   Functions runtime, same as `send-picks-push`.

## Schedule it to run automatically

Supabase dashboard -> **Integrations** -> **Cron Jobs** -> **Create a new
cron job**:
- Name: `grade-games-hourly`
- Schedule: `0 * * * *` (every hour, on the hour, every day)
- Type: **Supabase Edge Functions**
- Edge Function: `grade-games`
- HTTP Method: `POST`
- HTTP Headers: include `Authorization: Bearer <service_role key>` (the
  Cron Jobs UI has a built-in picker for this that pulls the key from the
  Vault -- don't paste the raw key into the job definition yourself)

### Why hourly, every day (not just "game days")

The cron schedule itself has no idea what week it is or when your games
kick off -- it just fires on a fixed clock. But the function itself only
ever touches games where `kickoff_time <= now()` AND `status != 'final'` --
so outside an actual game window there's simply nothing that matches, and
the run exits instantly with no ESPN calls and no writes. Restricting the
cron to specific days/hours would risk missing an early Saturday game or a
random weekday bowl game later in the season, so it's simpler and safer to
just let it run continuously and let the function's own query do the
filtering. At hourly cadence that's ~730 invocations/month, well under
Supabase's free-tier 500,000/month invocation allowance.

Similarly, there's no separate "wait 4-5 hours after kickoff" timer -- a
game just keeps showing up as pending on each hourly run until ESPN itself
reports it as `state: "post"` (actually over), at which point the very next
hourly run grades it -- so a late West Coast game ending at 1am just gets
picked up on the 1am or 2am run, automatically.

## Verify it works

After deploying, trigger it once by hand (or wait for the first scheduled
run) and check **Edge Functions -> grade-games -> Logs**, or call the
function's URL directly with the anon/service key in the `apikey` header.
The response looks like:
```json
{ "graded": 2, "stillPending": 5, "gradedGames": ["..."], "datesFetched": {"CFB": ["20260920"]}, "warnings": [] }
```

## Adjusting the cadence

Every hour was Trent's choice (he checks standings maybe 3-4 times per
Saturday himself, so hourly already beats that). To change it, edit the
cron job's schedule in the dashboard -- e.g. `*/30 * * * *` for every 30
minutes, `*/15 * * * *` for every 15. No code change needed.

## Notes
- Only processes games with `kickoff_time` already in the past and
  `status != 'final'` -- it never touches future weeks or games that are
  already graded, so it's safe to run as often as you like.
- If ESPN ever changes their API shape again, this is one of four places
  that fetch from it (the others: `app.py`'s `fetch_live_scores()`, the
  Admin page's Grading tab and Weekly Setup importer, and the
  `get-live-scores` function) -- all four use the same per-date-loop +
  `limit: 500` pattern for consistency.
