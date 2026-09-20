// Supabase Edge Function: get-live-scores
//
// Server-side proxy for ESPN's hidden scoreboard API, so the PWA (running in
// a browser, subject to CORS) can get live scores the same way the Streamlit
// admin/app pages already do from Python. Mirrors the nudge/parsing logic in
// app.py's fetch_live_scores() and the Admin page's ESPN sync, so a line
// pulled live here matches what the rest of the app expects.
//
// Request:  GET /get-live-scores?nfl_dates=YYYYMMDD-YYYYMMDD&cfb_dates=YYYYMMDD-YYYYMMDD
//           (include whichever league params are relevant; both are optional)
// Response: { "scores": { "espn_<id>": { home_score, away_score, state, completed, status_name, clock, line } } }

const LEAGUE_URLS: Record<string, string> = {
  nfl: "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
  cfb: "https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function nudgeOffWholeNumber(oddsString: string): string {
  if (!oddsString || oddsString === "0.0" || !oddsString.includes(" ")) return oddsString;
  const lastSpace = oddsString.lastIndexOf(" ");
  const teamAbbr = oddsString.slice(0, lastSpace);
  const numberStr = oddsString.slice(lastSpace + 1);
  const value = parseFloat(numberStr);
  if (Number.isNaN(value)) return oddsString;
  let adjusted = value;
  if (value !== 0 && value === Math.trunc(value)) {
    adjusted += value < 0 ? 0.5 : -0.5;
  }
  return `${teamAbbr} ${adjusted.toFixed(1)}`;
}

// ESPN's scoreboard endpoint used to accept a "YYYYMMDD-YYYYMMDD" date range
// in its `dates` param, but it now rejects any hyphenated range with an HTTP
// 400 ("Failed to get events endpoint.") -- only a single bare date works.
// The callers (picks.js, app.py) still hand this function a range string, so
// expand it into individual calendar dates here and fetch/merge each one,
// rather than changing every caller's query params.
function expandDateRange(dateRange: string): string[] {
  const [startStr, endStr] = dateRange.includes("-") && dateRange.length > 8
    ? [dateRange.slice(0, 8), dateRange.slice(-8)]
    : [dateRange, dateRange];

  const parse = (s: string) => new Date(
    Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)))
  );
  const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

  const start = parse(startStr);
  const end = parse(endStr);
  const dates: string[] = [];
  for (let d = start; d <= end; d = new Date(d.getTime() + 24 * 60 * 60 * 1000)) {
    dates.push(fmt(d));
  }
  return dates.length ? dates : [startStr];
}

async function fetchLeague(league: "nfl" | "cfb", dateRange: string, scores: Record<string, unknown>) {
  const dates = expandDateRange(dateRange);

  await Promise.all(dates.map(async (dateStr) => {
    const url = new URL(LEAGUE_URLS[league]);
    url.searchParams.set("limit", "500");
    url.searchParams.set("dates", dateStr);
    if (league === "cfb") url.searchParams.set("groups", "80");

    const resp = await fetch(url.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://www.espn.com/",
        Accept: "application/json",
      },
    });
    if (!resp.ok) return;
    const data = await resp.json();

    for (const event of data.events || []) {
      const gId = `espn_${event.id}`;
      const statusType = event.status?.type || {};
      const state = statusType.state || "pre";
      const completed = Boolean(statusType.completed);
      const statusName = String(statusType.name || "").toUpperCase();
      const clock = statusType.shortDetail || statusType.detail || "";

      const competition = event.competitions?.[0] || {};
      const competitors = competition.competitors || [];
      const home = competitors.find((c: any) => c.homeAway === "home") || {};
      const away = competitors.find((c: any) => c.homeAway === "away") || {};

      const oddsNode = competition.odds?.[0];
      let line = oddsNode?.details || "0.0";
      line = nudgeOffWholeNumber(line);

      scores[gId] = {
        home_score: home.score ?? "0",
        away_score: away.score ?? "0",
        state,
        completed,
        status_name: statusName,
        clock,
        line,
      };
    }
  }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const nflDates = url.searchParams.get("nfl_dates");
  const cfbDates = url.searchParams.get("cfb_dates");

  const scores: Record<string, unknown> = {};
  try {
    const tasks: Promise<void>[] = [];
    if (nflDates) tasks.push(fetchLeague("nfl", nflDates, scores));
    if (cfbDates) tasks.push(fetchLeague("cfb", cfbDates, scores));
    await Promise.all(tasks);
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ scores }), {
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
});
