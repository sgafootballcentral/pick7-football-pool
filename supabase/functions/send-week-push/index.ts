// Sends a real OS-level Web Push notification to every subscribed player
// (not just admins -- everyone, like send-poll-open-push) whenever a new
// row lands in `week_announcements` -- i.e. the first time a given week's
// games get pulled from ESPN. Triggered by a Supabase Database Webhook
// (Database > Webhooks) on `public.week_announcements` INSERT -- see
// README.md in this folder for the one-time setup steps.
//
// Why a separate `week_announcements` table instead of hooking `games`
// directly: pulling a week inserts one row per game (dozens of them), so a
// webhook on `games` INSERT would fire a separate notification per game.
// The Admin page instead inserts exactly one row here, and only the FIRST
// time a given week_number is ever pulled (a unique constraint on
// week_number makes every later re-pull of the same week -- to fix a line,
// add a game, etc -- a no-op insert that's caught and ignored, so nobody
// gets re-notified just because the admin re-synced).
//
// Reuses the same VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY function secrets
// already set up for send-chat-push (Edge Function secrets are shared
// across every function in the project). SUPABASE_URL and
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
    // Database Webhooks POST { type, table, record, old_record, schema }.
    const record = payload.record ?? payload;
    if (!record || !record.week_number) {
      return new Response(JSON.stringify({ skipped: "no record" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Everyone with push enabled gets this one -- not just admins -- minus
    // whoever ran the sync, same as send-poll-open-push.
    let subsQuery = supabase.from("push_subscriptions").select("endpoint,p256dh,auth");
    if (record.created_by) {
      subsQuery = subsQuery.neq("user_id", record.created_by);
    }
    const { data: subs, error: subErr } = await subsQuery;
    if (subErr) throw subErr;

    if (!subs || subs.length === 0) {
      return new Response(JSON.stringify({ skipped: "no subscribers" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const notifPayload = JSON.stringify({
      title: `\u{1F5D3}️ Week ${record.week_number} picks are up!`,
      body: "This week's games are posted -- go lock in your picks!",
      url: "./",
    });

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
