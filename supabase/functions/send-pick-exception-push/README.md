# send-pick-exception-push

Sends a real OS-level Web Push notification to every subscribed admin
whenever a player requests an exception to a pick lock.

## Deploy

1. Supabase dashboard -> **Edge Functions** -> **Create a new function**
   -> name it `send-pick-exception-push`.
2. Paste in the contents of `index.ts`.
3. Deploy. No new secrets needed -- it reuses the `VAPID_PUBLIC_KEY` /
   `VAPID_PRIVATE_KEY` secrets already set up for `send-chat-push`.

## Wire up the Database Webhook

Database -> **Webhooks** -> **Create a new hook**:
- Name: `pick_exception_push`
- Table: `public.pick_lock_exceptions`
- Events: `Insert`
- Type: `Supabase Edge Functions`
- Edge Function: `send-pick-exception-push`

## Who gets notified

Every other admin (the requester is excluded, matching how
`send-request-push` handles feature requests).
