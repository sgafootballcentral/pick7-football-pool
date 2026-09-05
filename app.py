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
                st.rerun()
            except Exception: st.error("Login failed. Check entries.")
    st.stop()

# --- Authenticated User Area Hub ---
user = st.session_state.user
username = user.user_metadata.get("username", user.email)
st.sidebar.write(f"Logged in as: **{username}**")
if st.sidebar.button("Log Out", use_container_width=True):
    supabase.auth.sign_out()
    st.session_state.user = None
    st.rerun()

CURRENT_WEEK = 1 
st.header(f"Week {CURRENT_WEEK} Master Slate")
now = datetime.now(timezone.utc)
EASTERN_TZ = ZoneInfo("America/New_York")

# 4. FETCH LIVE SCORES DIRECTLY VIA ESPN WIRE
espn_scores = {}
try:
    url = "https://espn.com"
    response = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}).json()
    for event in response.get("events", []):
        g_id = f"espn_{event.get('id')}"
        status_info = event.get("status", {})
        state = status_info.get("type", {}).get("state", "scheduled")
        detail_clock = status_info.get("type", {}).get("detail", "")
        
        competitors = event.get("competitions", [{}])[0].get("competitors", [])
        home_node = next((c for c in competitors if c.get("homeAway") == "home"), competitors[0])
        away_node = next((c for c in competitors if c.get("homeAway") == "away"), competitors[1])
        
        espn_scores[g_id] = {
            "home_score": home_node.get("score", "0"),
            "away_score": away_node.get("score", "0"),
            "state": state,
            "clock": detail_clock
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
    current_picks_count = sum(1 for g in all_games if st.session_state.get(f"sel_{g['game_id']}", "-- Select --") != "-- Select --")
    ui_max_reached = current_picks_count >= 7
    chosen_picks = []

    grouped_by_date = {}
    for game in all_games:
        kickoff_utc = datetime.fromisoformat(game['kickoff_time'].replace('Z', '+00:00'))
        kickoff_est = kickoff_utc.astimezone(EASTERN_TZ)
        date_str = kickoff_est.strftime("%A, %b %d")
        if date_str not in grouped_by_date:
            grouped_by_date[date_str] = []
        grouped_by_date[date_str].append((game, kickoff_est, kickoff_utc))

    for date_header, games_in_day in grouped_by_date.items():
        st.write("")
        st.markdown(f"### 📅 {date_header}")
        
        hdr_num, hdr_fav, hdr_und, hdr_spr, hdr_pck = st.columns(5)
        with hdr_num: st.markdown("**#**")
        with hdr_fav: st.markdown("**FAVORITE**")
        with hdr_und: st.markdown("**UNDERDOG**")
        with hdr_spr: st.markdown("**SPREAD**")
        with hdr_pck: st.markdown("**YOUR SELECTION**")
        st.divider()

        for game, kickoff_est, kickoff_utc in games_in_day:
            is_time_locked = now >= kickoff_utc
            time_str = kickoff_est.strftime("%I:%M %p ET").lstrip("0")
            g_num = game.get("game_number") or ""
            
            fav_team = game.get("favorite_team", "Away Team")
            und_team = game.get("underdog_team", "Home Team")
            
            # Explicitly layout home team labels directly based on database stamps
            fav_label = f"{fav_team} 🏠" if game.get("favorite_team_home") else fav_team
            und_label = f"{und_team} 🏠" if game.get("underdog_team_home") else und_team

            fav_score_text = ""
            und_score_text = ""
            status_ticker = f"`🕒 {time_str}`"

            # Connect database items to live scores instantly using explicit ESPN game IDs
            live_data = espn_scores.get(game["game_id"])
            if live_data:
                state = live_data["state"]
                if state != "scheduled":
                    fav_score_text = f"  \n**Score: {live_data['away_score']}**"
                    und_score_text = f"  \n**Score: {live_data['home_score']}**"
                    status_ticker = f"`🔴 LIVE - {live_data['clock']}`" if state == "in" else "`🏁 FINAL`"

            c_num, c_fav, c_und, c_spr, c_pck = st.columns(5)
            with c_num: st.write(f"**{g_num}**")
            with c_fav: st.markdown(f"**{fav_label}**{fav_score_text}  \n{status_ticker}")
            with c_und: st.markdown(f"**{und_label}**{und_score_text}")
            with c_spr: st.markdown("`DK Line`")
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

    if st.button("Lock In Weekly Picks", type="primary"):
        if len(chosen_picks) != 7:
            st.error(f"Validation Error: You must pick exactly 7 games.")
        else:
            try:
                supabase.table("picks").delete().eq("user_id", user.id).eq("week_number", CURRENT_WEEK).execute()
                for p in chosen_picks:
                    supabase.table("picks").insert({"user_id": user.id, "username": username, "week_number": CURRENT_WEEK, "game_id": p["game_id"], "selected_team": p["selected_team"]}).execute()
                st.success("Boom! Your 7 picks are saved securely.")
            except Exception as e: st.error(f"Database error: {e}")
