# send-week-graded-push

Sends a real OS-level Web Push notification to every player with push
enabled, announcing that a week's results are final. Unlike the other push
features in this project, this one is **never automatic** -- grading runs
on its own schedule (`grade-games`, every 15 min via Cron), so there's no
single moment the code can reliably call "the week just finished." Instead,
an admin reviews the Leaderboard page and clicks **📢 Notify Players --
Week N Results Are In** (next to "🔥 Current Standings", only shown once
every game in that week is `status = 'final'`), confirms once, and that's
what triggers this.

## Deploy

1. Supabase dashboard -> **Edge Functions** -> **Create a new function**
   -> name it `send-week-graded-push`.
2. Paste in the contents of `index.ts`.
3. Deploy. No new secrets needed -- it reuses the `VAPID_PUBLIC_KEY` /
   `VAPID_PRIVATE_KEY` secrets already set up for `send-chat-push`.
4. Run `week_graded_announcements.sql` in the SQL Editor (creates the
   table + RLS policies).

## Wire up the Database Webhook

Database -> **Webhooks** -> **Create a new hook**:
- Name: `week_graded_announcement_push`
- Table: `public.week_graded_announcements`
- Events: `Insert`
- Type: `Supabase Edge Functions`
- Edge Function: `send-week-graded-push`

## Who gets notified

Everyone with push notifications enabled (the 🔔 button on the Picks tab)
-- this is pool-wide news, not admin-only, and the admin who clicked the
button isn't excluded.

## Why `week_number` isn't unique here

`week_announcements` (the "new week posted" feature) uses a unique
`week_number` to silently no-op on a re-pull, because that insert happens
automatically as a side effect of syncing. This table is different: every
row here is a deliberate, confirmed admin click, so there's nothing to
de-duplicate -- an admin can send more than once for the same week (e.g.
after correcting a grading mistake) and each click sends a fresh push.
