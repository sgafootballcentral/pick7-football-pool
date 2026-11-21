// Team <-> conference lookup for the Picks page's team/conference search
// box. Mirrors conferences.py (the Streamlit site's copy of this same
// mapping) line-for-line -- keep both in sync if conferences realign again.
//
// Matching strategy: for a full ESPN-style display name like
// "Georgia Bulldogs" or "Miami (OH) RedHawks", find the LONGEST known
// school name that's a substring of it (case-insensitive). This avoids
// "Georgia" wrongly matching "Georgia Tech Yellow Jackets" -- "Georgia
// Tech" (longer, also a match) wins instead. NFL team names are each
// unique full franchise names, so no ambiguity there.

// ESPN's own conferenceId -> our canonical conference name, for CFB. This
// is what the sync in pages/1_Admin.py now reads straight off each team
// object in ESPN's scoreboard response (team.conferenceId) when it pulls
// in a week's games, and stores on the game row (favorite_conference /
// underdog_conference) -- the same source the spreads and kickoff times
// already come from. These ids are ESPN's internal group ids and don't
// change even when conference membership does (confirmed against ESPN's
// own groups API: .../leagues/college-football/seasons/<yr>/types/2/groups
// -> group 80 (FBS) -> its 11 conference children).
const ESPN_CONFERENCE_ID_TO_NAME = {
  "151": "American",
  "1": "ACC",
  "4": "Big 12",
  "5": "Big Ten",
  "12": "Conference USA",
  "18": "FBS Independents",
  "15": "MAC",
  "17": "Mountain West",
  "9": "Pac-12",
  "8": "SEC",
  "37": "Sun Belt",
};

/** Resolve ESPN's own numeric conferenceId (as a string or number, e.g.
 * 8 or "8") to our canonical conference name ("SEC"). null if missing or
 * unrecognized (e.g. NFL teams, which ESPN's scoreboard doesn't tag with
 * a conferenceId at all -- the static NFL table below covers those). */
export function conferenceNameFromEspnId(conferenceId) {
  if (conferenceId === null || conferenceId === undefined) return null;
  return ESPN_CONFERENCE_ID_TO_NAME[String(conferenceId)] ?? null;
}

// Name-based fallback used only when a game has no stored ESPN conference
// (games synced before this field existed, manually-added games, and all
// NFL games -- ESPN's scoreboard doesn't tag NFL teams with a
// conferenceId, so NFL search always uses this static AFC/NFC/division
// table; that's fine since NFL alignment hasn't changed in decades).
//
// [schoolOrTeamName, conference] -- CFB, 2026 alignment.
const CFB_TEAMS = [
  // SEC
  ["Alabama", "SEC"], ["Arkansas", "SEC"], ["Auburn", "SEC"], ["Florida", "SEC"],
  ["Georgia", "SEC"], ["Kentucky", "SEC"], ["LSU", "SEC"], ["Mississippi State", "SEC"],
  ["Missouri", "SEC"], ["Oklahoma", "SEC"], ["Ole Miss", "SEC"], ["South Carolina", "SEC"],
  ["Tennessee", "SEC"], ["Texas A&M", "SEC"], ["Texas", "SEC"], ["Vanderbilt", "SEC"],
  // Big Ten
  ["Illinois", "Big Ten"], ["Indiana", "Big Ten"], ["Iowa", "Big Ten"], ["Maryland", "Big Ten"],
  ["Michigan State", "Big Ten"], ["Michigan", "Big Ten"], ["Minnesota", "Big Ten"],
  ["Nebraska", "Big Ten"], ["Northwestern", "Big Ten"], ["Ohio State", "Big Ten"],
  ["Oregon", "Big Ten"], ["Penn State", "Big Ten"], ["Purdue", "Big Ten"], ["Rutgers", "Big Ten"],
  ["UCLA", "Big Ten"], ["USC", "Big Ten"], ["Washington", "Big Ten"], ["Wisconsin", "Big Ten"],
  // ACC
  ["Boston College", "ACC"], ["California", "ACC"], ["Clemson", "ACC"], ["Duke", "ACC"],
  ["Florida State", "ACC"], ["Georgia Tech", "ACC"], ["Louisville", "ACC"], ["Miami", "ACC"],
  ["NC State", "ACC"], ["North Carolina", "ACC"], ["Pittsburgh", "ACC"], ["SMU", "ACC"],
  ["Stanford", "ACC"], ["Syracuse", "ACC"], ["Virginia Tech", "ACC"], ["Virginia", "ACC"],
  ["Wake Forest", "ACC"],
  // Big 12
  ["Arizona State", "Big 12"], ["Arizona", "Big 12"], ["Baylor", "Big 12"], ["BYU", "Big 12"],
  ["Cincinnati", "Big 12"], ["Colorado", "Big 12"], ["Houston", "Big 12"], ["Iowa State", "Big 12"],
  ["Kansas State", "Big 12"], ["Kansas", "Big 12"], ["Oklahoma State", "Big 12"], ["TCU", "Big 12"],
  ["Texas Tech", "Big 12"], ["UCF", "Big 12"], ["Utah", "Big 12"], ["West Virginia", "Big 12"],
  // American (AAC)
  ["Army", "American"], ["Charlotte", "American"], ["East Carolina", "American"],
  ["Florida Atlantic", "American"], ["Memphis", "American"], ["Navy", "American"],
  ["North Texas", "American"], ["Rice", "American"], ["South Florida", "American"],
  ["Temple", "American"], ["Tulane", "American"], ["Tulsa", "American"], ["UAB", "American"],
  ["UTSA", "American"],
  // Mountain West
  ["Air Force", "Mountain West"], ["Hawai'i", "Mountain West"], ["Hawaii", "Mountain West"],
  ["Nevada", "Mountain West"], ["New Mexico", "Mountain West"],
  ["North Dakota State", "Mountain West"], ["San Jose State", "Mountain West"],
  ["UNLV", "Mountain West"], ["Wyoming", "Mountain West"], ["UTEP", "Mountain West"],
  ["Northern Illinois", "Mountain West"],
  // Pac-12 (rebuilt for 2026)
  ["Boise State", "Pac-12"], ["Colorado State", "Pac-12"], ["Fresno State", "Pac-12"],
  ["Oregon State", "Pac-12"], ["San Diego State", "Pac-12"], ["Texas State", "Pac-12"],
  ["Utah State", "Pac-12"], ["Washington State", "Pac-12"],
  // Sun Belt
  ["Appalachian State", "Sun Belt"], ["Arkansas State", "Sun Belt"],
  ["Coastal Carolina", "Sun Belt"], ["Georgia Southern", "Sun Belt"],
  ["Georgia State", "Sun Belt"], ["James Madison", "Sun Belt"], ["Louisiana Tech", "Sun Belt"],
  ["Louisiana-Monroe", "Sun Belt"], ["Louisiana Monroe", "Sun Belt"], ["ULM", "Sun Belt"],
  ["Louisiana", "Sun Belt"], ["Marshall", "Sun Belt"], ["Old Dominion", "Sun Belt"],
  ["South Alabama", "Sun Belt"], ["Southern Miss", "Sun Belt"], ["Troy", "Sun Belt"],
  // MAC
  ["Akron", "MAC"], ["Ball State", "MAC"], ["Bowling Green", "MAC"], ["Buffalo", "MAC"],
  ["Central Michigan", "MAC"], ["Eastern Michigan", "MAC"], ["Kent State", "MAC"],
  ["Miami (OH)", "MAC"], ["Miami (Ohio)", "MAC"], ["UMass", "MAC"], ["Massachusetts", "MAC"],
  ["Ohio", "MAC"], ["Sacramento State", "MAC"], ["Toledo", "MAC"], ["Western Michigan", "MAC"],
  // Conference USA
  ["Liberty", "Conference USA"], ["Jacksonville State", "Conference USA"],
  ["Kennesaw State", "Conference USA"], ["Middle Tennessee", "Conference USA"],
  ["Delaware", "Conference USA"], ["Western Kentucky", "Conference USA"],
  ["Missouri State", "Conference USA"], ["Florida International", "Conference USA"],
  ["FIU", "Conference USA"], ["New Mexico State", "Conference USA"],
  ["Sam Houston", "Conference USA"],
  // Independents
  ["Notre Dame", "FBS Independents"], ["UConn", "FBS Independents"],
];

// [fullFranchiseName, conference, division] -- NFL, unchanged for years.
const NFL_TEAMS = [
  ["Buffalo Bills", "AFC", "AFC East"], ["Miami Dolphins", "AFC", "AFC East"],
  ["New England Patriots", "AFC", "AFC East"], ["New York Jets", "AFC", "AFC East"],
  ["Baltimore Ravens", "AFC", "AFC North"], ["Cincinnati Bengals", "AFC", "AFC North"],
  ["Cleveland Browns", "AFC", "AFC North"], ["Pittsburgh Steelers", "AFC", "AFC North"],
  ["Houston Texans", "AFC", "AFC South"], ["Indianapolis Colts", "AFC", "AFC South"],
  ["Jacksonville Jaguars", "AFC", "AFC South"], ["Tennessee Titans", "AFC", "AFC South"],
  ["Denver Broncos", "AFC", "AFC West"], ["Kansas City Chiefs", "AFC", "AFC West"],
  ["Las Vegas Raiders", "AFC", "AFC West"], ["Los Angeles Chargers", "AFC", "AFC West"],
  ["Dallas Cowboys", "NFC", "NFC East"], ["New York Giants", "NFC", "NFC East"],
  ["Philadelphia Eagles", "NFC", "NFC East"], ["Washington Commanders", "NFC", "NFC East"],
  ["Chicago Bears", "NFC", "NFC North"], ["Detroit Lions", "NFC", "NFC North"],
  ["Green Bay Packers", "NFC", "NFC North"], ["Minnesota Vikings", "NFC", "NFC North"],
  ["Atlanta Falcons", "NFC", "NFC South"], ["Carolina Panthers", "NFC", "NFC South"],
  ["New Orleans Saints", "NFC", "NFC South"], ["Tampa Bay Buccaneers", "NFC", "NFC South"],
  ["Arizona Cardinals", "NFC", "NFC West"], ["Los Angeles Rams", "NFC", "NFC West"],
  ["San Francisco 49ers", "NFC", "NFC West"], ["Seattle Seahawks", "NFC", "NFC West"],
];

// Aliases a user might actually type -> canonical conference key(s). A
// query matches a key if it's a (min 2-char) PREFIX of one of that key's
// aliases.
const ALIASES = {
  "SEC": ["sec", "southeastern"],
  "Big Ten": ["big ten", "b1g"],
  "ACC": ["acc", "atlantic coast"],
  "Big 12": ["big 12", "big twelve"],
  "American": ["american", "aac"],
  "Mountain West": ["mountain west", "mwc", "mw"],
  "Pac-12": ["pac-12", "pac 12", "pac12"],
  "Sun Belt": ["sun belt", "sunbelt"],
  "MAC": ["mac", "mid-american", "mid american"],
  "Conference USA": ["conference usa", "c-usa", "cusa"],
  "FBS Independents": ["independent", "independents"],
  "AFC": ["afc"],
  "NFC": ["nfc"],
  "AFC East": ["afc east"], "AFC North": ["afc north"],
  "AFC South": ["afc south"], "AFC West": ["afc west"],
  "NFC East": ["nfc east"], "NFC North": ["nfc north"],
  "NFC South": ["nfc south"], "NFC West": ["nfc west"],
};

// Longest school/team name first, so "Georgia Tech" is tried before
// "Georgia".
const SCHOOL_LOOKUP = [...CFB_TEAMS, ...NFL_TEAMS.map(([name, conf]) => [name, conf])]
  .sort((a, b) => b[0].length - a[0].length);
const DIVISION_LOOKUP = new Map(NFL_TEAMS.map(([name, , div]) => [name, div]));

/** Best-guess conference (or NFL conference) for a team's ESPN-style
 * display name, e.g. "Georgia Bulldogs" -> "SEC". Returns null if no known
 * school/team name is found in it. */
export function conferenceOf(displayName) {
  if (!displayName) return null;
  const lowered = displayName.toLowerCase();
  for (const [name, conf] of SCHOOL_LOOKUP) {
    if (lowered.includes(name.toLowerCase())) return conf;
  }
  return null;
}

/** NFL division, e.g. "Kansas City Chiefs" -> "AFC West". null for CFB
 * teams or anything unrecognized. */
export function divisionOf(displayName) {
  if (!displayName) return null;
  const lowered = displayName.toLowerCase();
  for (const [name, div] of DIVISION_LOOKUP) {
    if (lowered.includes(name.toLowerCase())) return div;
  }
  return null;
}

/** If `query` looks like it's naming a conference (or NFL division) --
 * typed in full or as a recognizable prefix -- return the Set of matching
 * conference/division keys. Otherwise an empty Set. */
export function matchConferenceQuery(query) {
  const q = (query || "").trim().toLowerCase();
  const matches = new Set();
  if (q.length < 2) return matches;
  for (const [key, aliases] of Object.entries(ALIASES)) {
    if (aliases.some((alias) => alias.startsWith(q))) matches.add(key);
  }
  return matches;
}

/** True if either team's name contains `query` as a substring, or either
 * team's conference/division matches `query` as a conference search
 * term.
 *
 * favConference/undConference are the ESPN-sourced conference names
 * stored on the game row, when present (see conferenceNameFromEspnId
 * above) -- preferred over the static name-based guess below, which is
 * only a fallback for games that predate that column, manual games, and
 * NFL games (no conferenceId from ESPN for those). */
export function teamMatchesQuery(favName, undName, query, favConference = null, undConference = null) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return true;
  if ((favName || "").toLowerCase().includes(q) || (undName || "").toLowerCase().includes(q)) return true;
  const confMatches = matchConferenceQuery(q);
  if (!confMatches.size) return false;
  for (const [name, storedConf] of [[favName, favConference], [undName, undConference]]) {
    const conf = storedConf || conferenceOf(name);
    if (confMatches.has(conf) || confMatches.has(divisionOf(name))) return true;
  }
  return false;
}
