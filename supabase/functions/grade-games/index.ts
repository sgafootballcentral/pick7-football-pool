// Supabase Edge Function: grade-games
//
// Automated version of the "🔄 Refresh Scores & Grade" button in
// pages/1_⚙️_Admin.py (tab_grading). Meant to be invoked on a schedule
// (Database > Cron Jobs) so games get graded -- and the picks page's ✅
// "covered" checkmark + the leaderboard/standings -- stay current without
// an admin having to click the button by hand.
//
// This mirrors the Python grading logic line-for-line (same spread-margin
// math, same "grade each pick against the spread it actually saw" rule) so
// a game graded here comes out identical to one graded from the Admin page.
// It does NOT touch the live score display on the picks page -- that's a
// separate, always-fresh fetch done independently on every page load
// (fetch_live_scores() in app.py / get-live-scores for the PWA) and needs
// no automation.
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by
// the Supabase Edge Functions runtime -- no new secrets to configure.
//
// Manual trigger (e.g. to test): GET or POST this function's URL with an
// `apikey`/`Authorization` header, same as any other Edge Function call.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const LEAGUE_URLS: Record<string, string> = {
  NFL: "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
  CFB: "https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard",
};

// Per-event lookup, used as a reschedule safety net below -- unlike the
// scoreboard endpoint above, this isn't bucketed by date at all, so it
// still finds a game that moved to a different day than it was originally
// synced for.
const SUMMARY_URLS: Record<string, string> = {
  NFL: "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/summary",
  CFB: "https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/summary",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const ESPN_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Referer: "https://www.espn.com/",
  Accept: "application/json",
};

type EspnScore = { state: string; home_score: number; away_score: number };

// Safety net for a game that got moved to a different day (weather,
// travel, whatever) -- fetchLeagueScores above only ever looks at each
// game's ORIGINALLY SCHEDULED date, so a reschedule silently never shows
// up as final no matter how often this runs (this bit a real Ole Miss @
// Oklahoma game that moved from Saturday to Sunday, and had to be fixed by
// hand). Looked up directly by the game's own ESPN event id instead of a
// date bucket, so it finds the game wherever ESPN actually has it now.
async function fetchEventSummary(
  league: "NFL" | "CFB",
  eventId: string,
): Promise<(EspnScore & { kickoff_time: string | null }) | null> {
  const summaryUrl = SUMMARY_URLS[league];
  if (!summaryUrl) return null;

  const u = new URL(summaryUrl);
  u.searchParams.set("event", eventId);

  const resp = await fetch(u.toString(), { headers: ESPN_HEADERS });
  if (!resp.ok) return null;

  const data = await resp.json();
  const comp = data.header?.competitions?.[0];
  const state = comp?.status?.type?.state || "pre";
  if (state !== "post") return null;

  const competitors = comp.competitors || [];
  const home = competitors.find((c: any) => c.homeAway === "home") || {};
  const away = competitors.find((c: any) => c.homeAway === "away") || {};
  return {
    state: "post",
    home_score: Number(home.score ?? 0) || 0,
    away_score: Number(away.score ?? 0) || 0,
    kickoff_time: comp.date || null,
  };
}

// Same "only a bare YYYYMMDD works, and limit must stay well under 1000 or
// CFB results get silently truncated" fixes applied to app.py / Admin.py /
// get-live-scores this same round.
async function fetchLeagueScores(league: "NFL" | "CFB", dates: string[]): Promise<Record<string, EspnScore>> {
  const scores: Record<string, EspnScore> = {};
  const url = LEAGUE_URLS[league];

  await Promise.all(dates.map(async (dateStr) => {
    const u = new URL(url);
    u.searchParams.set("limit", "500");
    u.searchParams.set("dates", dateStr);
    if (league === "CFB") u.searchParams.set("groups", "80");

    const resp = await fetch(u.toString(), { headers: ESPN_HEADERS });
    if (!resp.ok) {
      console.warn(`${league} score fetch failed for ${dateStr}: HTTP ${resp.status}`);
      return;
    }
    const data = await resp.json();
    for (const event of data.events || []) {
      const gid = `espn_${event.id}`;
      const state = event.status?.type?.state || "pre";
      const competitors = event.competitions?.[0]?.competitors || [];
      const home = competitors.find((c: any) => c.homeAway === "home") || {};
      const away = competitors.find((c: any) => c.homeAway === "away") || {};
      scores[gid] = {
        state,
        home_score: Number(home.score ?? 0) || 0,
        away_score: Number(away.score ?? 0) || 0,
      };
    }
  }));

  return scores;
}

// ESPN's scoreboard "dates" param buckets a game by its Eastern calendar
// date, not its raw UTC date -- a night game (e.g. an 8:15pm ET kickoff,
// already past midnight UTC) needs to be queried under the Eastern date, or
// it's silently never found (no error, no warning -- it just never shows up
// in the response, so the game sits "stillPending" forever). en-CA gives
// YYYY-MM-DD ordering directly.
const EASTERN_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});
function toEasternDateStr(isoTimestamp: string): string {
  return EASTERN_DATE_FMT.format(new Date(isoTimestamp)).replace(/-/g, "");
}

function parseTrailingSpreadNumber(spreadStr: string | null | undefined): number {
  if (!spreadStr) return 0.0;
  const parts = spreadStr.trim().split(" ");
  const num = parseFloat(parts[parts.length - 1]);
  return Number.isNaN(num) ? 0.0 : num;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const warnings: string[] = [];

  try {
    // Only games that have kicked off and aren't graded yet -- keeps this
    // cheap (no ESPN calls at all when nothing is pending) and means it
    // doesn't need to know which week is "active".
    const nowIso = new Date().toISOString();
    const { data: pendingGames, error: gamesErr } = await supabase
      .from("games")
      .select("*")
      .neq("status", "final")
      .lte("kickoff_time", nowIso);
    if (gamesErr) throw gamesErr;

    if (!pendingGames || pendingGames.length === 0) {
      return new Response(JSON.stringify({ graded: 0, stillPending: 0, message: "No ungraded, already-kicked-off games." }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const gamesByLeague: Record<string, any[]> = {};
    for (const g of pendingGames) {
      (gamesByLeague[g.league] ||= []).push(g);
    }

    const espnScores: Record<string, EspnScore> = {};
    const datesFetched: Record<string, string[]> = {};

    for (const [league, leagueGames] of Object.entries(gamesByLeague)) {
      if (!LEAGUE_URLS[league]) continue;
      const uniqueDates = Array.from(new Set(
        leagueGames.map((g) => toEasternDateStr(g.kickoff_time)),
      )).sort();
      if (uniqueDates.length === 0) continue;

      datesFetched[league] = uniqueDates;
      const leagueScores = await fetchLeagueScores(league as "NFL" | "CFB", uniqueDates);
      Object.assign(espnScores, leagueScores);
    }

    // Any game that's more than 4 hours past its recorded kickoff -- long
    // enough to have finished if it actually kicked off then -- but still
    // isn't "post" gets one direct, date-independent lookup by its own
    // ESPN event id instead of a date bucket. This only runs for games
    // that are overdue and still ungraded, so a normal run with nothing
    // rescheduled makes no extra ESPN calls.
    const correctedKickoffs: Record<string, string> = {};
    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
    const nowMs = Date.now();

    const fallbackCandidates = pendingGames.filter((g) => {
      const live = espnScores[g.game_id];
      if (live && live.state === "post") return false;
      if (!LEAGUE_URLS[g.league]) return false;
      const kickoffMs = new Date(g.kickoff_time).getTime();
      if (Number.isNaN(kickoffMs)) return false;
      return nowMs - kickoffMs >= FOUR_HOURS_MS;
    });

    await Promise.all(fallbackCandidates.map(async (g) => {
      try {
        const eventId = String(g.game_id).replace(/^espn_/, "");
        const result = await fetchEventSummary(g.league as "NFL" | "CFB", eventId);
        if (!result) return; // really hasn't been played yet, not a reschedule

        espnScores[g.game_id] = {
          state: result.state,
          home_score: result.home_score,
          away_score: result.away_score,
        };
        if (result.kickoff_time && result.kickoff_time !== g.kickoff_time) {
          correctedKickoffs[g.game_id] = result.kickoff_time;
        }
      } catch (e) {
        warnings.push(`summary fallback failed for ${g.game_id}: ${String((e as any)?.message || e)}`);
      }
    }));

    let stillPendingCount = 0;
    const gamesToGrade: any[] = [];

    for (const g of pendingGames) {
      const live = espnScores[g.game_id];
      if (!live || live.state !== "post") {
        stillPendingCount++;
        continue;
      }
      gamesToGrade.push(g);
    }

    // Grade every finished game (and all of its picks) in parallel rather
    // than one game/pick at a time -- the cron job that invokes this caps
    // its own wait at 5s, so a busy hour with several games finishing at
    // once needs to fan out, not queue sequentially.
    const gradeResults = await Promise.all(gamesToGrade.map(async (g) => {
      const live = espnScores[g.game_id];
      const { home_score, away_score } = live;
      const spreadNum = parseTrailingSpreadNumber(g.spread_value);
      const favIsHome = Boolean(g.favorite_team_home);
      const favScore = favIsHome ? home_score : away_score;
      const undScore = favIsHome ? away_score : home_score;
      const margin = favScore + spreadNum - undScore;
      const winningTeam = margin > 0 ? g.favorite_team : g.underdog_team;

      const updatePayload: Record<string, any> = {
        status: "final",
        winning_team: winningTeam,
        home_score,
        away_score,
      };
      if (correctedKickoffs[g.game_id]) {
        updatePayload.kickoff_time = correctedKickoffs[g.game_id];
      }

      const { error: updateErr } = await supabase.from("games").update(updatePayload).eq("id", g.id);
      if (updateErr) {
        return { graded: false, warning: `games update failed for ${g.game_id}: ${updateErr.message}` };
      }

      // Grade each pick against the spread IT actually saw, not necessarily
      // today's spread_value -- protects anyone who picked before a re-sync.
      const { data: picksForGame, error: picksErr } = await supabase
        .from("picks")
        .select("*")
        .eq("game_id", g.game_id);

      const pickWarnings: string[] = [];
      if (picksErr) {
        pickWarnings.push(`picks fetch failed for ${g.game_id}: ${picksErr.message}`);
      } else {
        await Promise.all((picksForGame || []).map(async (p) => {
          const lockedSpreadNum = p.spread_at_pick
            ? parseTrailingSpreadNumber(p.spread_at_pick)
            : spreadNum;
          const pickMargin = favScore + lockedSpreadNum - undScore;
          const pickWinningTeam = pickMargin > 0 ? g.favorite_team : g.underdog_team;
          const pickResult = p.selected_team === pickWinningTeam ? "win" : "loss";
          const { error: pickUpdateErr } = await supabase
            .from("picks")
            .update({ result: pickResult })
            .eq("id", p.id);
          if (pickUpdateErr) {
            pickWarnings.push(`pick update failed for pick ${p.id}: ${pickUpdateErr.message}`);
          }
        }));
      }

      return {
        graded: true,
        gameLabel: `${g.favorite_team} vs ${g.underdog_team} (Week ${g.week_number})`,
        warnings: pickWarnings,
      };
    }));

    let gradedCount = 0;
    const gradedGames: string[] = [];
    for (const r of gradeResults) {
      if (r.warning) warnings.push(r.warning);
      if (r.warnings) warnings.push(...r.warnings);
      if (r.graded) {
        gradedCount++;
        gradedGames.push(r.gameLabel!);
      }
    }

    return new Response(JSON.stringify({
      graded: gradedCount,
      stillPending: stillPendingCount,
      gradedGames,
      datesFetched,
      warnings,
    }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e), warnings }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
