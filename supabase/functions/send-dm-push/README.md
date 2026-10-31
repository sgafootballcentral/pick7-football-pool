# send-dm-push

Sends a real push notification to a player when someone DMs them, unlike
`send-chat-push` this only ever targets the one recipient, never a
broadcast. Deployed the same way as `send-chat-push`.

## 1. Deploy the function
Dashboard > Edge Functions > Deploy a new function > name it
`send-dm-push` > paste in `index.ts`.

## 2. VAPID secrets
No new secrets needed -- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` are
already set at the project level for `send-chat-push` and every Edge
Function in this project shares them.

## 3. Create the Database Webhook
Dashboard > Database > Webhooks > Create a new webhook:
- Table: `direct_messages`
- Events: `Insert`
- Type: `Supabase Edge Functions`
- Edge Function: `send-dm-push`

Supabase signs the request with the project's service role key
automatically when you pick "Supabase Edge Functions" as the webhook type,
so no extra headers are needed.
