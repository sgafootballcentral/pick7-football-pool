# send-signup-push

Sends a real OS-level Web Push notification to every admin (subscribed via
the same \u0001F514 button used for chat) whenever someone signs up -- on
either the Streamlit app or the PWA -- telling you who it was.

## Deploy

1. Supabase dashboard -> **Edge Functions** -> **Create a new function**
   -> name it `send-signup-push`.
2. Paste in the contents of `index.ts`.
3. Deploy. No new secrets needed -- it reuses the `VAPID_PUBLIC_KEY` /
   `VAPID_PRIVATE_KEY` secrets already set up for `send-chat-push` (Edge
   Function secrets are shared across every function in the project).

## Wire up the Database Webhook

Database -> **Webhooks** -> **Create a new hook**:
- Name: `signup_push`
- Table: `public.players`
- Events: `Insert`
- Type: `Supabase Edge Functions`
- Edge Function: `send-signup-push`

That's it -- `pg_net` and the `supabase_functions` schema are already
provisioned from setting up the chat webhook.

## Why `players` and not `auth.users`

Both app.py and the PWA insert exactly one row into `players` right after
a signup succeeds -- that's also where the display name comes from --
regardless of which app someone signed up on. Hooking here instead of
Supabase's own `auth.users` table means this fires once per real new
player, with their chosen display name already attached, and needs no
extra lookup.

## Who gets notified

Whoever has `role = 'admin'` in `league_users` AND has enabled push
notifications (the same \u0001F514 button on the Chat tab -- a browser's
push subscription isn't tied to a single feature, so an admin who already
turned on chat or picks-submitted notifications is automatically covered
here too, no extra opt-in). The new signup themselves is excluded, in
case the new account happens to be another admin.

## Notes

- Only the display name is included in the notification, not email --
  that's already the piece an admin actually needs to recognize who joined.
  If you ever want the email too, it's one extra lookup in `index.ts` via
  `supabase.auth.admin.getUserById(record.id)` (needs the service-role
  client, which this function already has).
