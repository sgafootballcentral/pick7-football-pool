# send-request-decision-push

Sends a real OS-level Web Push notification to the player who submitted a
feature request, once an admin accepts or denies it. If denied, the
admin's comment (if they left one) is included in the notification.

## Deploy

1. Supabase dashboard -> **Edge Functions** -> **Create a new function**
   -> name it `send-request-decision-push`.
2. Paste in the contents of `index.ts`.
3. Deploy. No new secrets needed -- it reuses the `VAPID_PUBLIC_KEY` /
   `VAPID_PRIVATE_KEY` secrets already set up for `send-chat-push`.

## Wire up the Database Webhook

Database -> **Webhooks** -> **Create a new hook**:
- Name: `request_decision_push`
- Table: `public.feature_requests`
- Events: `Update`
- Type: `Supabase Edge Functions`
- Edge Function: `send-request-decision-push`

A feature_requests UPDATE fires on any edit to the row -- the function
itself checks that this specific update is the pending -> accepted/denied
transition before sending anything, so it's a safe no-op on other updates.

## Who gets notified

Only the player who submitted the request (`requester_id`), not admins.
