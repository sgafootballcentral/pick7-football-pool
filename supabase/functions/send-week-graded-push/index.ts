// Sends a real OS-level Web Push notification to every subscribed player
// when an admin manually confirms a week is fully graded and ready to
// announce -- the "📢 Notify Players -- Week N Results Are In" button on
// the Leaderboard page (admin-only, next to Current Standings). Triggered
// by a Supabase Database Webhook (Database > Webhooks) on
// week_graded_announcements INSERT -- see README.md in this folder.
//
// Deliberately separate from send-week-push (new week posted) and
// send-picks-push (someone submitted picks) -- this one is never
// automatic. Grading itself runs on its own schedule (see
// supabase/functions/grade-games), so there's no single moment code can
// reliably call "the week just finished" -- a human has to look at the
// results and decide to send.
//
// Reuses the same VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY secrets already set
// up for send-chat-push (Edge Function secrets are shared across every
// function in the project). SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
// provided automatically by the Supabase Edge Functions runtime.

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
    if (!record || !record.week_number) {
      return new Response(JSON.stringify({ skipped: "no record" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Everyone with push enabled -- not just admins, not excluding whoever
    // clicked the button. This is pool-wide news.
    const { data: subs, error: subErr } = await supabase
      .from("push_subscriptions")
      .select("endpoint,p256dh,auth");
    if (subErr) throw subErr;

    const notifPayload = JSON.stringify({
      title: `🏁 Week ${record.week_number} is final!`,
      body: "Final results and standings are in -- check the app!",
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
