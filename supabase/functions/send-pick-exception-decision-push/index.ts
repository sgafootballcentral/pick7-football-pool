// Sends a real OS-level Web Push notification to the player who requested a
// pick lock exception, once an admin approves or denies it -- triggered by
// a Supabase Database Webhook (Database > Webhooks) on
// `public.pick_lock_exceptions` UPDATE -- see README.md in this folder for
// the one-time setup steps.
//
// A pick_lock_exceptions UPDATE fires on ANY change to a request row, so
// this only actually sends a notification when the update is the specific
// pending -> approved/denied transition; anything else is a no-op.
//
// Reuses the same VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY function secrets
// already set up for send-chat-push. SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided automatically by the Supabase
// Edge Functions runtime.

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
    const record = payload.record ?? payload;
    const oldRecord = payload.old_record ?? {};

    const isDecision =
      record &&
      (record.status === "approved" || record.status === "denied") &&
      oldRecord.status === "pending";

    if (!isDecision || !record.user_id) {
      return new Response(JSON.stringify({ skipped: "not a decision transition" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: subs, error: subErr } = await supabase
      .from("push_subscriptions")
      .select("endpoint,p256dh,auth")
      .eq("user_id", record.user_id);
    if (subErr) throw subErr;

    if (!subs || subs.length === 0) {
      return new Response(JSON.stringify({ skipped: "requester has no subscriptions" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const weekLabel = record.week_number ? `Week ${record.week_number}` : "your request";

    let notifTitle;
    let body;
    if (record.status === "approved") {
      notifTitle = "✅ Pick lock exception approved";
      body = `You're cleared to submit/change picks for ${weekLabel}.`;
    } else {
      notifTitle = "❌ Pick lock exception denied";
      const reason = record.denial_reason ? String(record.denial_reason).trim().slice(0, 150) : "";
      body = reason ? `${weekLabel}: ${reason}` : `Your request for ${weekLabel} was denied.`;
    }

    const notifPayload = JSON.stringify({ title: notifTitle, body, url: "./" });

    const results = await Promise.allSettled(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            notifPayload,
          );
        } catch (err) {
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
