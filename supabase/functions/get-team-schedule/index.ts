// Supabase Edge Function: get-team-schedule
//
// Server-side proxy for ESPN's team-schedule API. The gamecast popup's
// "tap a team to see their schedule" feature needs that team's FULL season
// schedule -- every week, not just the weeks this pool's own `games` table
// happens to have synced so far (Admin's Weekly Setup pulls one week's
// slate at a time, so future weeks, byes, and any week not yet set up are
// simply absent from that table). Only ESPN itself has the complete
// picture, so this resolves the team name to an ESPN team id first, then
// fetches that team's schedule for the season.
//
// Request:  GET /get-team-schedule?team=<display name>&league=<cfb|nfl>&season=<YYYY>
// Response: { team: { id, name } | null, games: [{
//   espn_id, week_number, kickoff_time, opponent, opponent_logo, home,
//   state, completed, status_name, clock, team_score, opp_score, venue,
//   broadcasts
// }] }
//
// Same defensive-parsing stance as get-live-scores: ESPN's shape isn't
// guaranteed field-by-field, so every read below is optional-chained and
// the frontend hides whatever a row doesn't have rather than render
// "undefined".

const TEAM_BASE_URL: Record<string, string> = {
  cfb: "https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams",
  nfl: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const ESPN_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Referer: "https://www.espn.com/",
  Accept: "application/json",
};

function normalizeName(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function scoreOf(c: any): number | null {
  const s = c?.score;
  if (s == null) return null;
  if (typeof s === "object") {
    const v = s.displayValue ?? s.value ?? null;
    return v == null ? null : Number(v);
  }
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

// Our games table stores a longer "Ohio State Buckeyes"-style display name
// than ESPN's teams list sometimes uses ("Ohio State") -- match against
// every name ESPN gives us for a team, exact first, then a loose
// contains-either-way fallback for the rest.
async function resolveTeamId(league: "cfb" | "nfl", teamName: string): Promise<{ id: string; name: string } | null> {
  const url = new URL(TEAM_BASE_URL[league]);
  url.searchParams.set("limit", "999");
  if (league === "cfb") url.searchParams.set("groups", "80"); // FBS

  const resp = await fetch(url.toString(), { headers: ESPN_HEADERS });
  if (!resp.ok) return null;
  const data = await resp.json();
  const teams = data?.sports?.[0]?.leagues?.[0]?.teams || [];
  const target = normalizeName(teamName);
  if (!target) return null;

  let looseMatch: { id: string; name: string } | null = null;
  for (const entry of teams) {
    const t = entry?.team;
    if (!t) continue;
    const candidates = [t.displayName, t.shortDisplayName, t.name, t.nickname, t.location]
      .filter(Boolean)
      .map(normalizeName);
    if (candidates.includes(target)) {
      return { id: String(t.id), name: t.displayName || teamName };
    }
    if (!looseMatch && candidates.some((c: string) => c && (target.includes(c) || c.includes(target)))) {
      looseMatch = { id: String(t.id), name: t.displayName || teamName };
    }
  }
  return looseMatch;
}

async function fetchSchedule(league: "cfb" | "nfl", teamId: string, season: string) {
  const schedUrl = new URL(`${TEAM_BASE_URL[league]}/${teamId}/schedule`);
  if (season) schedUrl.searchParams.set("season", season);

  const resp = await fetch(schedUrl.toString(), { headers: ESPN_HEADERS });
  if (!resp.ok) return { games: [], warning: `schedule fetch failed: ${resp.status}` };
  const data = await resp.json();

  const games = (data.events || []).map((event: any) => {
    const competition = event.competitions?.[0] || {};
    const statusType = competition.status?.type || event.status?.type || {};
    const competitors = competition.competitors || [];
    const self = competitors.find((c: any) => String(c.team?.id) === teamId) || {};
    const opp = competitors.find((c: any) => String(c.team?.id) !== teamId) || competitors.find((c: any) => c !== self) || {};

    const venueNode = competition.venue || {};
    const venue = venueNode.fullName
      ? { name: venueNode.fullName, city: venueNode.address?.city || "", state: venueNode.address?.state || "" }
      : null;

    const broadcastNode = competition.broadcasts || event.broadcasts || [];
    const broadcasts = Array.isArray(broadcastNode)
      ? broadcastNode.flatMap((b: any) => b?.names || []).filter(Boolean)
      : [];

    return {
      espn_id: String(event.id),
      week_number: event.week?.number ?? null,
      kickoff_time: event.date || competition.date || null,
      opponent: opp.team?.displayName || null,
      opponent_logo: opp.team?.logo || opp.team?.logos?.[0]?.href || null,
      home: self.homeAway === "home",
      state: statusType.state || "pre",
      completed: Boolean(statusType.completed),
      status_name: String(statusType.name || "").toUpperCase(),
      clock: statusType.shortDetail || statusType.detail || "",
      team_score: scoreOf(self),
      opp_score: scoreOf(opp),
      venue,
      broadcasts,
    };
  }).sort((a: any, b: any) => String(a.kickoff_time || "").localeCompare(String(b.kickoff_time || "")));

  return { games };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const teamName = url.searchParams.get("team") || "";
  const leagueParam = (url.searchParams.get("league") || "").toLowerCase();
  const league: "cfb" | "nfl" = leagueParam === "nfl" ? "nfl" : "cfb";
  const season = url.searchParams.get("season") || "";

  if (!teamName) {
    return new Response(JSON.stringify({ error: "team is required" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  try {
    const resolved = await resolveTeamId(league, teamName);
    if (!resolved) {
      return new Response(JSON.stringify({ team: null, games: [] }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const { games, warning } = await fetchSchedule(league, resolved.id, season);
    return new Response(JSON.stringify({ team: resolved, games, ...(warning ? { warning } : {}) }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
