# send-request-push

Sends a real OS-level Web Push notification to every admin (subscribed via
the same 🔔 button used for chat) whenever a player submits a new feature
request, telling you who it was and what they asked for.

## Deploy

1. Supabase dashboard -> **Edge Functions** -> **Create a new function**
   -> name it `send-request-push`.
2. Paste in the contents of `index.ts`.
3. Deploy. No new secrets needed -- it reuses the `VAPID_PUBLIC_KEY` /
   `VAPID_PRIVATE_KEY` secrets already set up for `send-chat-push`.

## Wire up the Database Webhook

Database -> **Webhooks** -> **Create a new hook**:
- Name: `request_push`
- Table: `public.feature_requests`
- Events: `Insert`
- Type: `Supabase Edge Functions`
- Edge Function: `send-request-push`

## Who gets notified

Whoever has `role = 'admin'` in `league_users` and has push enabled, minus
the requester themselves (in case an admin submits an idea).
