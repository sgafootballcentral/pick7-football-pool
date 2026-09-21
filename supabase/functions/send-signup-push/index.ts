// Sends a real OS-level Web Push notification to every subscribed admin
// whenever a new row lands in `players` -- i.e. whenever someone finishes
// signing up, on either the Streamlit app or the PWA. Triggered by a
// Supabase Database Webhook (Database > Webhooks) on `public.players`
// INSERT -- see README.md in this folder for the one-time setup steps.
//
// `players` is the right table to hook: both app.py and the PWA's
// refreshIdentity() insert exactly one row here, right after a successful
// signup, regardless of which client created the account -- so this fires
// once per new player no matter where they signed up.
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

    // Admins are whoever has role = 'admin' in league_users. Exclude the
    // new signup themselves, in case an admin account is the one being
    // created (e.g. setting up a second commish) -- no need to notify
    // yourself about your own signup.
    const { data: admins, error: adminErr } = await supabase
      .from("league_users")
      .select("id")
      .eq("role", "admin")
      .neq("id", record.id);
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
    const notifPayload = JSON.stringify({
      title: "\u{1F195} New signup",
      body: `${who} just signed up for Pick 7.`,
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
