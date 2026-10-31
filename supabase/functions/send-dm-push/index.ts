// Sends a real OS-level Web Push notification to the RECIPIENT of a direct
// message whenever a new row lands in direct_messages. Unlike
// send-chat-push (which notifies everyone except the sender), this only
// ever notifies the one player the message was actually sent to. Triggered
// by a Supabase Database Webhook (Database > Webhooks) on direct_messages
// INSERT -- see README.md in this folder for the one-time setup steps.
//
// Requires two function secrets (Edge Functions > Secrets), NOT committed
// to git -- same project-level secrets send-chat-push already uses:
//   VAPID_PUBLIC_KEY
//   VAPID_PRIVATE_KEY
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by
// the Supabase Edge Functions runtime -- no need to set them.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails("mailto:noreply@pick7.app", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      throw new Error("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY secrets are not set");
    }

    const payload = await req.json();
    // Database Webhooks POST { type, table, record, old_record, schema }.
    const record = payload.record ?? payload;
    if (!record || !record.sender_id || !record.recipient_id) {
      return new Response(JSON.stringify({ skipped: "no record" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Only the recipient's own subscriptions -- never a broadcast like chat.
    const { data: subs, error } = await supabase
      .from("push_subscriptions")
      .select("endpoint,p256dh,auth")
      .eq("user_id", record.recipient_id);
    if (error) throw error;

    // record.username isn't a column on direct_messages -- look the
    // sender's current display name up so a rename doesn't leave stale
    // notification text, same reasoning as the chat UI's own live lookup.
    let senderName = "Someone";
    try {
      const { data: sender } = await supabase
        .from("players")
        .select("username")
        .eq("id", record.sender_id)
        .single();
      if (sender?.username) senderName = sender.username;
    } catch (_) {
      /* fall back to "Someone" */
    }

    const body = record.message ? String(record.message).slice(0, 140) : "sent you a message";
    const notifPayload = JSON.stringify({
      title: `${senderName} sent you a message`,
      body,
      url: "./",
    });

    const results = await Promise.allSettled(
      (subs || []).map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            notifPayload,
          );
        } catch (err) {
          // Subscription is gone (browser uninstalled it, permission revoked, etc) -- clean it up.
          const statusCode = err?.statusCode;
          if (statusCode === 404 || statusCode === 410) {
            await supabase.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
          }
          throw err;
        }
      }),
    );

    const sent = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.length - sent;
    return new Response(JSON.stringify({ sent, failed }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
