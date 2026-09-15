// Sends a real OS-level Web Push notification to every subscribed admin
// whenever a new row lands in pick_submissions -- i.e. whenever a player
// finishes submitting (or resubmitting) their picks for a week. Triggered
// by a Supabase Database Webhook (Database > Webhooks) on pick_submissions
// INSERT -- see README.md in this folder for the one-time setup steps.
//
// pick_submissions exists purely as a single-row-per-submission marker
// (the actual picks land as 7 separate rows in the `picks` table) so this
// fires once per submission instead of once per pick.
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
    if (!record || !record.user_id || !record.week_number) {
      return new Response(JSON.stringify({ skipped: "no record" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Admins are whoever has role = 'admin' in league_users. Exclude the
    // submitter themselves in case an admin is submitting their own picks --
    // no need to notify yourself.
    const { data: admins, error: adminErr } = await supabase
      .from("league_users")
      .select("id")
      .eq("role", "admin")
      .neq("id", record.user_id);
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

    const who = record.username || "Someone";
    const count = record.picks_count || 7;
    const notifPayload = JSON.stringify({
      title: "🏈 Picks submitted",
      body: `${who} submitted ${count} pick(s) for Week ${record.week_number}.`,
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
