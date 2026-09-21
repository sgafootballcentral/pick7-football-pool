// Sends a real OS-level Web Push notification to every subscribed admin
// whenever a new row lands in `feature_requests` -- i.e. whenever a player
// submits a feature/idea request. Triggered by a Supabase Database Webhook
// (Database > Webhooks) on `public.feature_requests` INSERT -- see
// README.md in this folder for the one-time setup steps.
//
// Reuses the same VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY function secrets
// already set up for send-chat-push (Edge Function secrets are shared
// across all functions in the project, so nothing new to configure there).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by
// the Supabase Edge Functions runtime.

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
    if (!record || !record.id) {
      return new Response(JSON.stringify({ skipped: "no record" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Who submitted it -- feature_requests only stores requester_id, so look
    // up their display name for the notification body.
    let requesterName = "Someone";
    if (record.requester_id) {
      const { data: requester } = await supabase
        .from("players")
        .select("username")
        .eq("id", record.requester_id)
        .maybeSingle();
      if (requester?.username) requesterName = requester.username;
    }

    // Admins are whoever has role = 'admin' in league_users. Exclude the
    // requester themselves, in case an admin is the one submitting the idea.
    const { data: admins, error: adminErr } = await supabase
      .from("league_users")
      .select("id")
      .eq("role", "admin")
      .neq("id", record.requester_id ?? "");
    if (adminErr) throw adminErr;

    const adminIds = (admins || []).map((a) => a.id);
    if (adminIds.length === 0) {
      return new Response(JSON.stringify({ skipped: "no other admins" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: subs, error: subErr } = await supabase
      .from("push_subscriptions")
      .select("endpoint,p256dh,auth")
      .in("user_id", adminIds);
    if (subErr) throw subErr;

    const title = record.title ? String(record.title).slice(0, 120) : "New feature request";
    const notifPayload = JSON.stringify({
      title: "\u{1F4DD} New feature request",
      body: `${requesterName}: ${title}`,
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
