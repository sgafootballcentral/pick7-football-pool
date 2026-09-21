// Sends a real OS-level Web Push notification to every subscribed admin
// when a poll closes and its result is in -- whether it closed itself on
// a timer (see close_expired_polls() in the database) or an admin closed
// it manually from the app. Triggered by a Supabase Database Webhook
// (Database > Webhooks) on `public.polls` UPDATE -- see README.md in this
// folder for the one-time setup steps.
//
// A polls UPDATE webhook fires on ANY change to a poll row, so this only
// actually sends a notification when the update is the specific
// open -> closed transition; anything else is a no-op.
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

    // Only fire on the open -> closed transition, not every poll edit.
    if (!record || record.status !== "closed" || oldRecord.status === "closed") {
      return new Response(JSON.stringify({ skipped: "not a close transition" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    let resultLabel = "no votes were cast";
    if (record.result_option_id) {
      const { data: option } = await supabase
        .from("poll_options")
        .select("label")
        .eq("id", record.result_option_id)
        .maybeSingle();
      if (option?.label) resultLabel = option.label;
    }

    const { data: admins, error: adminErr } = await supabase
      .from("league_users")
      .select("id")
      .eq("role", "admin");
    if (adminErr) throw adminErr;

    const adminIds = (admins || []).map((a) => a.id);
    if (adminIds.length === 0) {
      return new Response(JSON.stringify({ skipped: "no admins" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: subs, error: subErr } = await supabase
      .from("push_subscriptions")
      .select("endpoint,p256dh,auth")
      .in("user_id", adminIds);
    if (subErr) throw subErr;

    const title = record.title ? String(record.title).slice(0, 100) : "A vote";
    const notifPayload = JSON.stringify({
      title: "\u{1F3C1} Voting closed",
      body: `${title}: ${resultLabel}`,
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
