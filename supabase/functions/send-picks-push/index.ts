// Sends a real OS-level Web Push notification to every subscribed admin,
// AND a personal confirmation push back to the player themselves, whenever
// a new row lands in pick_submissions -- i.e. whenever a player finishes
// submitting (or resubmitting) their picks for a week. Triggered by a
// Supabase Database Webhook (Database > Webhooks) on pick_submissions
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

// Same tie-break rule as docs/js/picks.js's computeGameNumbers() and the
// Streamlit app's compute_game_numbers() -- sort by kickoff time, then by
// game_id to deterministically break ties on same-time kickoffs. Every
// caller has to use this exact order or the same game gets numbered
// differently in different places.
function gameSortKey(a: { kickoff_time?: string; game_id?: string }, b: { kickoff_time?: string; game_id?: string }) {
  const t = (a.kickoff_time || "").localeCompare(b.kickoff_time || "");
  if (t !== 0) return t;
  return (a.game_id || "").localeCompare(b.game_id || "");
}

async function sendToSubscriptions(
  supabase: ReturnType<typeof createClient>,
  subs: { endpoint: string; p256dh: string; auth: string }[],
  notifPayload: string,
) {
  const results = await Promise.allSettled(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          notifPayload,
        );
      } catch (err) {
        // Subscription is gone (browser uninstalled it, permission revoked, etc) -- clean it up.
        const statusCode = (err as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await supabase.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
        }
        throw err;
      }
    }),
  );
  const sent = results.filter((r) => r.status === "fulfilled").length;
  return { sent, failed: results.length - sent };
}

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

    // ---- 1. Notify admins (unchanged from before) ----------------------
    // Admins are whoever has role = 'admin' in league_users. Exclude the
    // submitter themselves in case an admin is submitting their own picks --
    // no need to notify yourself.
    const { data: admins, error: adminErr } = await supabase
      .from("league_users")
      .select("id")
      .eq("role", "admin")
      .neq("id", record.user_id);
    if (adminErr) throw adminErr;

    const adminIds = (admins || []).map((a: { id: string }) => a.id);
    let adminResult = { sent: 0, failed: 0 };
    if (adminIds.length > 0) {
      const { data: adminSubs, error: adminSubErr } = await supabase
        .from("push_subscriptions")
        .select("endpoint,p256dh,auth")
        .in("user_id", adminIds);
      if (adminSubErr) throw adminSubErr;

      const who = record.username || "Someone";
      const count = record.picks_count || 7;
      const adminPayload = JSON.stringify({
        title: "🏈 Picks submitted",
        body: `${who} submitted ${count} pick(s) for Week ${record.week_number}.`,
        url: "./",
      });
      adminResult = await sendToSubscriptions(supabase, adminSubs || [], adminPayload);
    }

    // ---- 2. Confirm back to the submitter themselves, with their picks -
    let selfResult = { sent: 0, failed: 0, skipped: undefined as string | undefined };
    try {
      const { data: selfSubs, error: selfSubErr } = await supabase
        .from("push_subscriptions")
        .select("endpoint,p256dh,auth")
        .eq("user_id", record.user_id);
      if (selfSubErr) throw selfSubErr;

      if (!selfSubs || selfSubs.length === 0) {
        selfResult.skipped = "submitter has no push subscription";
      } else {
        const { data: games, error: gamesErr } = await supabase
          .from("games")
          .select("game_id,kickoff_time,favorite_team,underdog_team")
          .eq("week_number", record.week_number);
        if (gamesErr) throw gamesErr;

        const { data: picks, error: picksErr } = await supabase
          .from("picks")
          .select("game_id,selected_team")
          .eq("week_number", record.week_number)
          .eq("user_id", record.user_id);
        if (picksErr) throw picksErr;

        const sortedGames = [...(games || [])].sort(gameSortKey);
        const numbersByGame: Record<string, { favNum: number; undNum: number }> = {};
        sortedGames.forEach((g, i) => {
          numbersByGame[g.game_id] = { favNum: 2 * (i + 1) - 1, undNum: 2 * (i + 1) };
        });
        const gameLookup = Object.fromEntries(sortedGames.map((g) => [g.game_id, g]));

        const pickLines = (picks || [])
          .map((p: { game_id: string; selected_team: string }) => {
            const g = gameLookup[p.game_id];
            const nums = numbersByGame[p.game_id];
            if (!g || !nums) return null;
            const num = p.selected_team === g.favorite_team ? nums.favNum : nums.undNum;
            return { num, text: `#${num} ${p.selected_team}` };
          })
          .filter((x): x is { num: number; text: string } => x !== null)
          .sort((a, b) => a.num - b.num)
          .map((x) => x.text);

        const body = pickLines.length
          ? `Week ${record.week_number}: ${pickLines.join(", ")}`
          : `Your picks for Week ${record.week_number} were submitted.`;

        const selfPayload = JSON.stringify({
          title: "✅ Your picks are in!",
          body,
          url: "./",
        });
        const r = await sendToSubscriptions(supabase, selfSubs, selfPayload);
        selfResult = { sent: r.sent, failed: r.failed, skipped: undefined };
      }
    } catch (e) {
      // Never let a problem building/sending the submitter's own
      // confirmation take down the admin notification above -- that one
      // already succeeded or failed independently by this point.
      selfResult = { sent: 0, failed: 0, skipped: `error: ${String((e as Error)?.message || e)}` };
    }

    return new Response(JSON.stringify({ admin: adminResult, self: selfResult }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
