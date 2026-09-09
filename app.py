import streamlit as st
import requests
from supabase import create_client, Client
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

# 1. Connection and Secrets Verification
SUPABASE_URL = st.secrets.get("SUPABASE_URL")
SUPABASE_KEY = st.secrets.get("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    st.error("Missing critical Supabase connection variables in Streamlit Secrets.")
    st.stop()

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


def nudge_off_whole_number(odds_string: str) -> str:
    """Same rule as the Admin page -- keeps a live-refreshed line from reintroducing
    a whole-number spread that could push."""
    if not odds_string or odds_string == "0.0" or " " not in odds_string:
        return odds_string
    team_abbr, number_str = odds_string.rsplit(" ", 1)
    try:
        value = float(number_str)
    except ValueError:
        return odds_string
    if value != 0 and value == int(value):
        value += 0.5 if value < 0 else -0.5
    return f"{team_abbr} {value:.1f}"


@st.dialog("🔒 Your Picks Are Locked In!")
def show_picks_recap(recap_rows):
    st.write("Here's what you picked for this week:")
    for item in recap_rows:
        st.markdown(f"- **{item['selected_team']}** — {item['matchup']}  (`{item['spread']}`)")
    if st.button("Got it!", use_container_width=True):
        st.rerun()


@st.dialog("⚠️ You've Already Submitted This Week")
def confirm_resubmit(existing_picks_raw, new_picks, game_lookup):
    st.write("Here's how your on-file picks compare to your new selections:")

    existing_map = {p["game_id"]: p["selected_team"] for p in existing_picks_raw}
    new_map = {p["game_id"]: p["selected_team"] for p in new_picks}
    all_game_ids = set(existing_map) | set(new_map)

    comparison_rows = []
    for gid in all_game_ids:
        g = game_lookup.get(gid, {})
        on_file = existing_map.get(gid, "—")
        new_pick = new_map.get(gid, "—")
        comparison_rows.append({
            "_kickoff": g.get("kickoff_time", ""),
            "Matchup": g.get("display_text", gid),
            "Spread": g.get("spread_value", ""),
            "On File": on_file,
            "New Selection": new_pick,
            "": "🔄" if on_file != new_pick else "",
        })
    comparison_rows.sort(key=lambda r: r["_kickoff"])
    for r in comparison_rows:
        r.pop("_kickoff")

    st.dataframe(comparison_rows, use_container_width=True, hide_index=True)
    st.write("Replace your on-file picks with the new selections above?")

    col_yes, col_no = st.columns(2)
    with col_yes:
        if st.button("Yes, resubmit", type="primary", use_container_width=True):
            try:
                supabase.table("picks").delete().eq("user_id", user.id).eq("week_number", CURRENT_WEEK).execute()
                for p in new_picks:
                    supabase.table("picks").insert({
                        "user_id": user.id, "username": username, "week_number": CURRENT_WEEK,
                        "game_id": p["game_id"], "selected_team": p["selected_team"],
                        "spread_at_pick": game_lookup.get(p["game_id"], {}).get("spread_value", ""),
                    }).execute()
                st.session_state.pending_resubmit = None
                st.rerun()
            except Exception as e:
                st.error(f"Database error: {e}")
    with col_no:
        if st.button("Cancel", use_container_width=True):
            st.session_state.pending_resubmit = None
            st.rerun()

st.set_page_config(page_title="Football Pick-7 Pool", page_icon="🏈", layout="wide")
st.title("🏈 Pick 7 Against The Spread")

# 2. Track user sessions
if "user" not in st.session_state:
    st.session_state.user = None

# 3. Secure Authentication Interface
if not st.session_state.user:
    tab1, tab2 = st.tabs(["Log In", "Sign Up"])
    with tab1:
        login_email = st.text_input("Email", key="l_email")
        login_pass = st.text_input("Password", type="password", key="l_pass")
        if st.button("Log In", use_container_width=True):
            try:
                res = supabase.auth.sign_in_with_password({"email": login_email, "password": login_pass})
                st.session_state.user = res.user
                st.session_state.access_token = res.session.access_token
                st.session_state.refresh_token = res.session.refresh_token
                st.rerun()
            except Exception: st.error("Login failed. Check entries.")
    st.stop()

# --- Authenticated User Area Hub ---
user = st.session_state.user
if st.session_state.get("access_token"):
    try:
        supabase.auth.set_session(st.session_state.access_token, st.session_state.refresh_token)
    except Exception:
        # token expired or invalid -- force a fresh login
        st.session_state.user = None
        st.session_state.access_token = None
        st.rerun()
username = user.user_metadata.get("username", user.email)
try:
    supabase.table("players").upsert({"id": user.id, "username": username}).execute()
except Exception:
    pass  # non-critical -- don't block the session over this
st.sidebar.write(f"Logged in as: **{username}**")
if st.sidebar.button("Log Out", use_container_width=True):
    supabase.auth.sign_out()
    st.session_state.user = None
    st.rerun()

available_week_rows = supabase.table("games").select("week_number").execute().data
available_weeks = sorted({w["week_number"] for w in available_week_rows}, reverse=True)

if not available_weeks:
    st.info("No games have been loaded yet. Check back once the admin sets up a week.")
    st.stop()

CURRENT_WEEK = st.selectbox("Select Week:", available_weeks, index=0)
st.header(f"Week {CURRENT_WEEK} Master Slate")
now = datetime.now(timezone.utc)
EASTERN_TZ = ZoneInfo("America/New_York")

# 4. 🌐 LIVE SCOREBOARD FEED FROM THE INTERNET
espn_scores = {}
try:
    url = "https://espn.com"
    response = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}).json()
    for event in response.get("events", []):
        g_id = f"espn_{event.get('id')}"
        status_info = event.get("status", {})
        state = status_info.get("type", {}).get("state", "scheduled")
        detail_clock = status_info.get("type", {}).get("detail", "")
        
        competitors = event.get("competitions", [{}]).get("competitors", [])
        home_node = next((c for c in competitors if c.get("homeAway") == "home"), competitors)
        away_node = next((c for c in competitors if c.get("homeAway") == "away"), competitors)
        
        # Safely parse the live game-line odds string directly from the data wire
        odds_node = event.get("competitions", [{}])[0].get("odds", [{}])
        odds_line = odds_node[0].get("details", "0.0") if isinstance(odds_node, list) and odds_node else "0.0"
        odds_line = nudge_off_whole_number(odds_line)
        
        espn_scores[g_id] = {
            "home_score": home_node.get("score", "0"),
            "away_score": away_node.get("score", "0"),
            "state": state,
            "clock": detail_clock,
            "line": odds_line
        }
except Exception:
    pass

# 5. Pull active week slate from database rows
try:
    all_games = supabase.table("games").select("*").eq("week_number", CURRENT_WEEK).execute().data
except Exception:
    all_games = []

if not all_games:
    st.info(f"No games loaded yet for Week {CURRENT_WEEK}.")
else:
    all_games = sorted(all_games, key=lambda x: x.get("game_number") or 999)
    # Sort chronologically first so the day groups come out in calendar order below
    games_chronological = sorted(all_games, key=lambda g: g["kickoff_time"])

    current_picks_count = sum(1 for g in all_games if st.session_state.get(f"sel_{g['game_id']}", "-- Select --") != "-- Select --")
    ui_max_reached = current_picks_count >= 7
    chosen_picks = []

    pct = min(current_picks_count / 7 * 100, 100)
    st.markdown(f"""
        <style>
        .sticky-ticker {{
            position: fixed;
            top: 3.7rem;
            left: 0;
            right: 0;
            z-index: 999;
            background-color: var(--background-color);
            border-bottom: 1px solid var(--secondary-background-color);
            padding: 8px 16px;
            text-align: center;
            font-weight: 600;
        }}
        .sticky-ticker-track {{
            background-color: var(--secondary-background-color);
            border-radius: 6px;
            height: 8px;
            width: 100%;
            max-width: 500px;
            margin: 6px auto 0 auto;
            overflow: hidden;
        }}
        .sticky-ticker-fill {{
            background-color: var(--primary-color);
            height: 100%;
            width: {pct}%;
        }}
        </style>
        <div class="sticky-ticker">
            🏈 {current_picks_count} of 7 games selected
            <div class="sticky-ticker-track"><div class="sticky-ticker-fill"></div></div>
        </div>
        <div style="margin-top: 3.2rem;"></div>
    """, unsafe_allow_html=True)

    grouped_by_date = {}
    for game in games_chronological:
        kickoff_utc = datetime.fromisoformat(game['kickoff_time'].replace('Z', '+00:00'))
        kickoff_est = kickoff_utc.astimezone(EASTERN_TZ)
        date_str = kickoff_est.strftime("%A, %b %d")
        if date_str not in grouped_by_date:
            grouped_by_date[date_str] = []
        grouped_by_date[date_str].append((game, kickoff_est, kickoff_utc))

    for date_header, games_in_day in grouped_by_date.items():
        st.write("")
        st.markdown(f"### 📅 {date_header}")
        
        hdr_fav, hdr_und, hdr_spr, hdr_pck = st.columns(4)
        with hdr_fav: st.markdown("**FAVORITE**")
        with hdr_und: st.markdown("**UNDERDOG**")
        with hdr_spr: st.markdown("**SPREAD**")
        with hdr_pck: st.markdown("**YOUR SELECTION**")
        st.divider()

        for game, kickoff_est, kickoff_utc in games_in_day:
            is_time_locked = now >= kickoff_utc
            time_str = kickoff_est.strftime("%I:%M %p ET").lstrip("0")
            
            fav_team = game.get("favorite_team", "Away Team")
            und_team = game.get("underdog_team", "Home Team")
            
            fav_label = f"{fav_team} 🏠" if game.get("favorite_team_home") else fav_team
            und_label = f"{und_team} 🏠" if game.get("underdog_team_home") else und_team

            fav_score_text = ""
            und_score_text = ""
            status_ticker = f"`🕒 {time_str}`"
            live_line = game.get("spread_value", "0.0")

            live_data = espn_scores.get(game["game_id"])
            if live_data:
                # Update spreads dynamically from the live internet wire if present
                if live_data.get("line") and live_data["line"] != "0.0":
                    live_line = live_data["line"]
                
                state = live_data["state"]
                if state != "scheduled":
                    fav_score_text = f"  \n**Score: {live_data['away_score']}**"
                    und_score_text = f"  \n**Score: {live_data['home_score']}**"
                    status_ticker = f"`🔴 LIVE - {live_data['clock']}`" if state == "in" else "`🏁 FINAL`"

            c_fav, c_und, c_spr, c_pck = st.columns(4)
            with c_fav: st.markdown(f"**{fav_label}**{fav_score_text}  \n{status_ticker}")
            with c_und: st.markdown(f"**{und_label}**{und_score_text}")
            with c_spr: st.markdown(f"`{live_line}`")
            with c_pck:
                if is_time_locked:
                    st.button("🔒 Locked", key=f"lock_{game['game_id']}", disabled=True, use_container_width=True)
                else:
                    is_current_empty = st.session_state.get(f"sel_{game['game_id']}", "-- Select --") == "-- Select --"
                    should_disable = ui_max_reached and is_current_empty
                    
                    pick = st.selectbox(
                        "Choose", options=["-- Select --", fav_team, und_team], 
                        key=f"sel_{game['game_id']}", label_visibility="collapsed", disabled=should_disable
                    )
                    if pick != "-- Select --":
                        chosen_picks.append({"game_id": game['game_id'], "selected_team": pick})

    st.divider()
    st.subheader("Your Submission Status")
    st.write(f"Total Games Selected: **{len(chosen_picks)} / 7**")

    game_lookup = {g["game_id"]: g for g in all_games}
    existing_picks = supabase.table("picks").select("*").eq("user_id", user.id).eq("week_number", CURRENT_WEEK).execute().data
    already_submitted = bool(existing_picks)

    if st.button("Lock In Weekly Picks", type="primary"):
        if len(chosen_picks) != 7:
            st.error(f"Validation Error: You must pick exactly 7 games.")
        elif already_submitted:
            st.session_state.pending_resubmit = {
                "existing_picks": existing_picks,
                "new_picks": chosen_picks,
                "game_lookup": game_lookup,
            }
            st.rerun()
        else:
            try:
                supabase.table("picks").delete().eq("user_id", user.id).eq("week_number", CURRENT_WEEK).execute()
                for p in chosen_picks:
                    supabase.table("picks").insert({
                        "user_id": user.id, "username": username, "week_number": CURRENT_WEEK,
                        "game_id": p["game_id"], "selected_team": p["selected_team"],
                        "spread_at_pick": game_lookup.get(p["game_id"], {}).get("spread_value", ""),
                    }).execute()
                st.success("Boom! Your 7 picks are saved securely.")

                recap_rows = [
                    {
                        "selected_team": p["selected_team"],
                        "matchup": game_lookup.get(p["game_id"], {}).get("display_text", p["game_id"]),
                        "spread": game_lookup.get(p["game_id"], {}).get("spread_value", ""),
                    }
                    for p in chosen_picks
                ]
                show_picks_recap(recap_rows)
            except Exception as e: st.error(f"Database error: {e}")

    # Checked every rerun (not just on the button click above) so the dialog's own
    # Yes/Cancel buttons get a chance to actually be detected as clicked.
    if st.session_state.get("pending_resubmit"):
        confirm_resubmit(
            st.session_state.pending_resubmit["existing_picks"],
            st.session_state.pending_resubmit["new_picks"],
            st.session_state.pending_resubmit["game_lookup"],
        )
