# send-chat-push

Sends a real push notification to every other player when someone posts in
League Chat. Deployed the same way as `get-live-scores` (Supabase Dashboard
> Edge Functions), and wired up with two extra one-time steps below.

## 1. Deploy the function
Dashboard > Edge Functions > Deploy a new function > name it
`send-chat-push` > paste in `index.ts`.

## 2. Set the VAPID secrets
Dashboard > Edge Functions > Secrets (or Project Settings > Edge Functions),
add:
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`

(Same keypair as `docs/js/config.js`'s `VAPID_PUBLIC_KEY` -- the private
half only ever lives here, never in the repo or the client.)

## 3. Create the Database Webhook
Dashboard > Database > Webhooks > Create a new webhook:
- Table: `chat_messages`
- Events: `Insert`
- Type: `Supabase Edge Functions`
- Edge Function: `send-chat-push`

Supabase signs the request with the project's service role key
automatically when you pick "Supabase Edge Functions" as the webhook type,
so no extra headers are needed.
