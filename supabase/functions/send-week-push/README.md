# send-week-push

Sends a real OS-level Web Push notification to every subscribed player
(not just admins) the first time a given week's games are pulled from ESPN
on the Admin page.

## Deploy

1. Supabase dashboard -> **Edge Functions** -> **Create a new function**
   -> name it `send-week-push`.
2. Paste in the contents of `index.ts`.
3. Deploy. No new secrets needed -- it reuses the `VAPID_PUBLIC_KEY` /
   `VAPID_PRIVATE_KEY` secrets already set up for `send-chat-push`.

## One-time database setup

Run `week_announcements.sql` (in this folder) in the Supabase SQL editor
first -- it creates the `week_announcements` table the Admin page writes
to and this function's webhook listens on, plus its RLS policies.

## Wire up the Database Webhook

Database -> **Webhooks** -> **Create a new hook**:
- Name: `week_announcement_push`
- Table: `public.week_announcements`
- Events: `Insert`
- Type: `Supabase Edge Functions`
- Edge Function: `send-week-push`

## Why a separate `week_announcements` table

Pulling a week inserts one row per game into `games` -- dozens of them.
Hooking the webhook directly to `games` would fire a notification per
game. The Admin page instead inserts exactly one row here right after a
sync succeeds, and `week_number` is UNIQUE, so re-pulling a week that's
already been announced (to fix a line, add a game, etc.) just hits a
duplicate-key error that's caught and ignored -- nobody gets re-notified
for a week they already heard about.

## Who gets notified

Everyone with push enabled, minus whoever ran the sync (same pattern as
`send-poll-open-push`).

## Starting a new season

`week_number` is unique forever, so if you ever reuse week numbers for a
new season, either `delete from public.week_announcements;` first or the
re-used week numbers won't re-announce.
