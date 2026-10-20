# send-picks-push

Sends a real OS-level Web Push notification whenever a player finishes
submitting (or resubmitting) their picks for a week:

1. Every admin (subscribed via the same 🔔 button) gets a short "someone
   submitted" alert.
2. The player themselves gets a confirmation push listing exactly what
   they just picked, by number (e.g. `Week 5: #3 Alabama, #8 Georgia, ...`)
   -- the same numbering shown in the app's "pick by number" feature and
   in the on-screen recap right after submitting.

Both fire on every submission, including resubmits/changes to an
already-submitted week.

## Deploy

1. Supabase dashboard -> **Edge Functions** -> **Create a new function**
   -> name it `send-picks-push`.
2. Paste in the contents of `index.ts`.
3. Deploy. No new secrets needed -- it reuses the `VAPID_PUBLIC_KEY` /
   `VAPID_PRIVATE_KEY` secrets already set up for `send-chat-push` (Edge
   Function secrets are shared across every function in the project).

## Wire up the Database Webhook

Database -> **Webhooks** -> **Create a new hook**:
- Name: `pick_submission_push`
- Table: `public.pick_submissions`
- Events: `Insert`
- Type: `Supabase Edge Functions`
- Edge Function: `send-picks-push`

That's it -- `pg_net` and the `supabase_functions` schema are already
provisioned from setting up the chat webhook.

## Why a separate `pick_submissions` table

A single pick submission writes 7 rows to `picks` (one per game). Hooking
the webhook directly to `picks` would fire 7 notifications per submission.
The app instead writes one row to `pick_submissions` right after the 7
picks are saved, so this function fires exactly once per submission.

## Who gets notified

**Admins:** whoever has `role = 'admin'` in `league_users` AND has
enabled push notifications (the 🔔 button, now on the Picks tab -- a
browser's push subscription isn't tied to a single feature, so anyone
who already turned on notifications is automatically covered here too,
no extra opt-in needed). The submitter themselves is excluded from this
admin alert, in case an admin submits their own picks.

**The submitter:** whoever just submitted, if they have push
notifications enabled. Their confirmation is built by looking up their
own rows in `picks` for that week and the matching `games` rows, so it
always reflects exactly what was actually saved -- not whatever was on
screen at the moment they clicked submit. If they don't have push
enabled, this part is silently skipped (they still see the on-screen
recap modal immediately after submitting either way).
