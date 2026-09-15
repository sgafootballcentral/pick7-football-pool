# send-picks-push

Sends a real OS-level Web Push notification to every admin (subscribed via
the same 🔔 button used for chat) whenever a player finishes submitting
their picks for a week.

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

Whoever has `role = 'admin'` in `league_users` AND has enabled push
notifications (the same 🔔 button on the Chat tab -- a browser's push
subscription isn't tied to a single feature, so an admin who already
turned on chat notifications is automatically covered here too, no
extra opt-in needed). The submitter themselves is excluded, in case an
admin submits their own picks.
