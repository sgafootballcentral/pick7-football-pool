# send-poll-open-push

Sends a real OS-level Web Push notification to every subscribed player
(not just admins) whenever a new poll opens -- an accepted feature request
pushed out for a vote, or an admin-initiated vote like a payout split.

## Deploy

1. Supabase dashboard -> **Edge Functions** -> **Create a new function**
   -> name it `send-poll-open-push`.
2. Paste in the contents of `index.ts`.
3. Deploy. No new secrets needed -- it reuses the `VAPID_PUBLIC_KEY` /
   `VAPID_PRIVATE_KEY` secrets already set up for `send-chat-push`.

## Wire up the Database Webhook

Database -> **Webhooks** -> **Create a new hook**:
- Name: `poll_open_push`
- Table: `public.polls`
- Events: `Insert`
- Type: `Supabase Edge Functions`
- Edge Function: `send-poll-open-push`

## Who gets notified

Everyone with push enabled, minus whoever created the poll (an admin
doesn't need to be told about their own vote).
