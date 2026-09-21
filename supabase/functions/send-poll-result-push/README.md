# send-poll-result-push

Sends a real OS-level Web Push notification to every admin once a poll
closes, with the winning answer -- whether it closed itself on a timer
(`close_expired_polls()`, scheduled via pg_cron -- see the main repo's SQL
notes) or an admin closed it manually from the app.

## Deploy

1. Supabase dashboard -> **Edge Functions** -> **Create a new function**
   -> name it `send-poll-result-push`.
2. Paste in the contents of `index.ts`.
3. Deploy. No new secrets needed -- it reuses the `VAPID_PUBLIC_KEY` /
   `VAPID_PRIVATE_KEY` secrets already set up for `send-chat-push`.

## Wire up the Database Webhook

Database -> **Webhooks** -> **Create a new hook**:
- Name: `poll_result_push`
- Table: `public.polls`
- Events: `Update`
- Type: `Supabase Edge Functions`
- Edge Function: `send-poll-result-push`

A polls UPDATE fires on any edit to the row -- the function itself checks
that this specific update is the open -> closed transition before sending
anything, so it's a safe no-op on other updates.

## Who gets notified

Whoever has `role = 'admin'` in `league_users` and has push enabled.
