# Team <-> conference lookup, used by the Picks page's team/conference
# search box (app.py). Kept in its own module since it's mostly static data;
# docs/js/conferences.js is the PWA's mirror of the exact same mapping --
# keep both in sync if conferences realign again.
#
# Matching strategy: for a full ESPN-style display name like
# "Georgia Bulldogs" or "Miami (OH) RedHawks", find the LONGEST known school
# name that's a substring of it (case-insensitive). This avoids "Georgia"
# wrongly matching "Georgia Tech Yellow Jackets" -- "Georgia Tech" (longer,
# also a match) wins instead. NFL team names are each unique full franchise
# names, so no ambiguity there.

# (school/team name, conference) -- CFB, 2026 alignment.
_CFB_TEAMS = [
    # SEC
    ("Alabama", "SEC"), ("Arkansas", "SEC"), ("Auburn", "SEC"), ("Florida", "SEC"),
    ("Georgia", "SEC"), ("Kentucky", "SEC"), ("LSU", "SEC"), ("Mississippi State", "SEC"),
    ("Missouri", "SEC"), ("Oklahoma", "SEC"), ("Ole Miss", "SEC"), ("South Carolina", "SEC"),
    ("Tennessee", "SEC"), ("Texas A&M", "SEC"), ("Texas", "SEC"), ("Vanderbilt", "SEC"),
    # Big Ten
    ("Illinois", "Big Ten"), ("Indiana", "Big Ten"), ("Iowa", "Big Ten"), ("Maryland", "Big Ten"),
    ("Michigan State", "Big Ten"), ("Michigan", "Big Ten"), ("Minnesota", "Big Ten"),
    ("Nebraska", "Big Ten"), ("Northwestern", "Big Ten"), ("Ohio State", "Big Ten"),
    ("Oregon", "Big Ten"), ("Penn State", "Big Ten"), ("Purdue", "Big Ten"), ("Rutgers", "Big Ten"),
    ("UCLA", "Big Ten"), ("USC", "Big Ten"), ("Washington", "Big Ten"), ("Wisconsin", "Big Ten"),
    # ACC
    ("Boston College", "ACC"), ("California", "ACC"), ("Clemson", "ACC"), ("Duke", "ACC"),
    ("Florida State", "ACC"), ("Georgia Tech", "ACC"), ("Louisville", "ACC"), ("Miami", "ACC"),
    ("NC State", "ACC"), ("North Carolina", "ACC"), ("Pittsburgh", "ACC"), ("SMU", "ACC"),
    ("Stanford", "ACC"), ("Syracuse", "ACC"), ("Virginia Tech", "ACC"), ("Virginia", "ACC"),
    ("Wake Forest", "ACC"),
    # Big 12
    ("Arizona State", "Big 12"), ("Arizona", "Big 12"), ("Baylor", "Big 12"), ("BYU", "Big 12"),
    ("Cincinnati", "Big 12"), ("Colorado", "Big 12"), ("Houston", "Big 12"), ("Iowa State", "Big 12"),
    ("Kansas State", "Big 12"), ("Kansas", "Big 12"), ("Oklahoma State", "Big 12"), ("TCU", "Big 12"),
    ("Texas Tech", "Big 12"), ("UCF", "Big 12"), ("Utah", "Big 12"), ("West Virginia", "Big 12"),
    # American (AAC)
    ("Army", "American"), ("Charlotte", "American"), ("East Carolina", "American"),
    ("Florida Atlantic", "American"), ("Memphis", "American"), ("Navy", "American"),
    ("North Texas", "American"), ("Rice", "American"), ("South Florida", "American"),
    ("Temple", "American"), ("Tulane", "American"), ("Tulsa", "American"), ("UAB", "American"),
    ("UTSA", "American"),
    # Mountain West
    ("Air Force", "Mountain West"), ("Hawai'i", "Mountain West"), ("Hawaii", "Mountain West"),
    ("Nevada", "Mountain West"), ("New Mexico", "Mountain West"),
    ("North Dakota State", "Mountain West"), ("San Jose State", "Mountain West"),
    ("UNLV", "Mountain West"), ("Wyoming", "Mountain West"), ("UTEP", "Mountain West"),
    ("Northern Illinois", "Mountain West"),
    # Pac-12 (rebuilt for 2026)
    ("Boise State", "Pac-12"), ("Colorado State", "Pac-12"), ("Fresno State", "Pac-12"),
    ("Oregon State", "Pac-12"), ("San Diego State", "Pac-12"), ("Texas State", "Pac-12"),
    ("Utah State", "Pac-12"), ("Washington State", "Pac-12"),
    # Sun Belt
    ("Appalachian State", "Sun Belt"), ("Arkansas State", "Sun Belt"),
    ("Coastal Carolina", "Sun Belt"), ("Georgia Southern", "Sun Belt"),
    ("Georgia State", "Sun Belt"), ("James Madison", "Sun Belt"), ("Louisiana Tech", "Sun Belt"),
    ("Louisiana-Monroe", "Sun Belt"), ("Louisiana Monroe", "Sun Belt"), ("ULM", "Sun Belt"),
    ("Louisiana", "Sun Belt"), ("Marshall", "Sun Belt"), ("Old Dominion", "Sun Belt"),
    ("South Alabama", "Sun Belt"), ("Southern Miss", "Sun Belt"), ("Troy", "Sun Belt"),
    # MAC
    ("Akron", "MAC"), ("Ball State", "MAC"), ("Bowling Green", "MAC"), ("Buffalo", "MAC"),
    ("Central Michigan", "MAC"), ("Eastern Michigan", "MAC"), ("Kent State", "MAC"),
    ("Miami (OH)", "MAC"), ("Miami (Ohio)", "MAC"), ("UMass", "MAC"), ("Massachusetts", "MAC"),
    ("Ohio", "MAC"), ("Sacramento State", "MAC"), ("Toledo", "MAC"), ("Western Michigan", "MAC"),
    # Conference USA
    ("Liberty", "Conference USA"), ("Jacksonville State", "Conference USA"),
    ("Kennesaw State", "Conference USA"), ("Middle Tennessee", "Conference USA"),
    ("Delaware", "Conference USA"), ("Western Kentucky", "Conference USA"),
    ("Missouri State", "Conference USA"), ("Florida International", "Conference USA"),
    ("FIU", "Conference USA"), ("New Mexico State", "Conference USA"),
    ("Sam Houston", "Conference USA"),
    # Independents
    ("Notre Dame", "FBS Independents"), ("UConn", "FBS Independents"),
]

# (full franchise name, conference, division) -- NFL, unchanged for years.
_NFL_TEAMS = [
    ("Buffalo Bills", "AFC", "AFC East"), ("Miami Dolphins", "AFC", "AFC East"),
    ("New England Patriots", "AFC", "AFC East"), ("New York Jets", "AFC", "AFC East"),
    ("Baltimore Ravens", "AFC", "AFC North"), ("Cincinnati Bengals", "AFC", "AFC North"),
    ("Cleveland Browns", "AFC", "AFC North"), ("Pittsburgh Steelers", "AFC", "AFC North"),
    ("Houston Texans", "AFC", "AFC South"), ("Indianapolis Colts", "AFC", "AFC South"),
    ("Jacksonville Jaguars", "AFC", "AFC South"), ("Tennessee Titans", "AFC", "AFC South"),
    ("Denver Broncos", "AFC", "AFC West"), ("Kansas City Chiefs", "AFC", "AFC West"),
    ("Las Vegas Raiders", "AFC", "AFC West"), ("Los Angeles Chargers", "AFC", "AFC West"),
    ("Dallas Cowboys", "NFC", "NFC East"), ("New York Giants", "NFC", "NFC East"),
    ("Philadelphia Eagles", "NFC", "NFC East"), ("Washington Commanders", "NFC", "NFC East"),
    ("Chicago Bears", "NFC", "NFC North"), ("Detroit Lions", "NFC", "NFC North"),
    ("Green Bay Packers", "NFC", "NFC North"), ("Minnesota Vikings", "NFC", "NFC North"),
    ("Atlanta Falcons", "NFC", "NFC South"), ("Carolina Panthers", "NFC", "NFC South"),
    ("New Orleans Saints", "NFC", "NFC South"), ("Tampa Bay Buccaneers", "NFC", "NFC South"),
    ("Arizona Cardinals", "NFC", "NFC West"), ("Los Angeles Rams", "NFC", "NFC West"),
    ("San Francisco 49ers", "NFC", "NFC West"), ("Seattle Seahawks", "NFC", "NFC West"),
]

# Aliases a user might actually type -> canonical conference key(s). A query
# matches a key if it's a (min 2-char) PREFIX of one of that key's aliases.
_ALIASES = {
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
}

# Longest school/team name first, so "Georgia Tech" is tried before "Georgia".
_SCHOOL_LOOKUP = sorted(
    [(name, conf) for name, conf in _CFB_TEAMS] + [(name, conf) for name, conf, _div in _NFL_TEAMS],
    key=lambda pair: len(pair[0]), reverse=True,
)
_DIVISION_LOOKUP = {name: div for name, _conf, div in _NFL_TEAMS}


def conference_of(display_name):
    """Best-guess conference (or NFL conference) for a team's ESPN-style
    display name, e.g. 'Georgia Bulldogs' -> 'SEC'. Returns None if no known
    school/team name is found in it."""
    if not display_name:
        return None
    lowered = display_name.lower()
    for name, conf in _SCHOOL_LOOKUP:
        if name.lower() in lowered:
            return conf
    return None


def division_of(display_name):
    """NFL division, e.g. 'Kansas City Chiefs' -> 'AFC West'. None for CFB
    teams or anything unrecognized."""
    if not display_name:
        return None
    lowered = display_name.lower()
    for name, div in _DIVISION_LOOKUP.items():
        if name.lower() in lowered:
            return div
    return None


def match_conference_query(query):
    """If `query` looks like it's naming a conference (or NFL division) --
    typed in full or as a recognizable prefix -- return the set of matching
    conference/division keys. Otherwise return an empty set."""
    q = (query or "").strip().lower()
    if len(q) < 2:
        return set()
    matches = set()
    for key, aliases in _ALIASES.items():
        if any(alias.startswith(q) for alias in aliases):
            matches.add(key)
    return matches


def team_matches_query(fav_name, und_name, query):
    """True if either team's name contains `query` as a substring, or
    either team's conference/division matches `query` as a conference
    search term."""
    q = (query or "").strip().lower()
    if not q:
        return True
    if q in (fav_name or "").lower() or q in (und_name or "").lower():
        return True
    conf_matches = match_conference_query(q)
    if not conf_matches:
        return False
    for name in (fav_name, und_name):
        if conference_of(name) in conf_matches or division_of(name) in conf_matches:
            return True
    return False
