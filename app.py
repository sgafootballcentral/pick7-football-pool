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
    with tab2:
        signup_email = st.text_input("Email", key="s_email")
        signup_pass = st.text_input("Password", type="password", key="s_pass")
        signup_user = st.text_input("League Display Name / Nickname", key="s_user")
        if st.button("Create Account", use_container_width=True):
            try:
                supabase.auth.sign_up({"email": signup_email, "password": signup_pass, "options": {"data": {"username": signup_user}}})
                st.success("Account created! Switch to Log In.")
            except Exception: st.error("Sign up failed. Use a 6+ character password.")
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

# 4. 🌐 FREE ESPN LIVE SCOREBOARD PIPELINE
espn_scores = {}
try:
    # Pull directly from ESPN's public live feed (Completely free, no limits)
    espn_url = "https://espn.com"
    espn_data = requests.get(espn_url, headers={"User-Agent": "Mozilla/5.0"}).json()
    
    for event in espn_data.get("events", []):
        status_info = event.get("status", {})
        state = status_info.get("type", {}).get("state", "scheduled")
        detail_clock = status_info.get("type", {}).get("detail", "")
        
        competitors = event.get("competitions", [{}])[0].get("competitors", [])
        
        match_info = {}
        for team in competitors:
            t_name = team.get("team", {}).get("displayName", "")
            t_score = team.get("score", "0")
            is_home = team.get("homeAway") == "home"
            match_info[t_name] = {"score": t_score, "is_home": is_home, "state": state, "clock": detail_clock}
            
        for team in competitors:
            t_name = team.get("team", {}).get("displayName", "")
            espn_scores[t_name] = match_info
except Exception:
    pass

# Smart matcher to pair long spreadsheet names to ESPN live rows
def find_espn_data(t1, t2):
    for key_name, data in espn_scores.items():
        if key_name in t1 or t1 in key_name or key_name in t2 or t2 in key_name:
            return data
    return None

# 5. Pull active week slate from database rows
try:
    games_response = supabase.table("games").select("*").eq("week_number", CURRENT_WEEK).execute()
    all_games = games_response.data
except Exception:
    all_games = []

if not all_games:
    st.info(f"No games have been loaded yet for Week {CURRENT_WEEK}.")
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
            
            fav_team = game.get("favorite_team") or game.get("favorite") or "Favorite"
            und_team = game.get("underdog_team") or game.get("underdog") or "Underdog"
            spread_val = game.get("spread_value") or game.get("spread") or "0.0"

            fav_label, und_label = fav_team, und_team
            fav_score_text, und_score_text = "", ""
            status_ticker = f"`🕒 {time_str}`"

            # 🌐 LOOKUP ESPN LIVE DATA STREAM FOR HOME TEAMS & SCOREBOARDS
            game_data = find_espn_data(fav_team, und_team)
            
            if game_data:
                # Find which team is hosting dynamically from ESPN
                fav_espn = next((k for k in game_data.keys() if k in fav_team or fav_team in k), None)
                und_espn = next((k for k in game_data.keys() if k in und_team or und_team in k), None)
                
                if fav_espn and game_data[fav_espn]["is_home"]: fav_label = f"{fav_team} 🏠"
                if und_espn and game_data[und_espn]["is_home"]: und_label = f"{und_team} 🏠"
                
                # Fetch scores and match clock states
                if fav_espn and und_espn:
                    f_state = game_data[fav_espn]["state"]
                    if f_state != "scheduled":
                        fav_score_text = f"  \n**Score: {game_data[fav_espn]['score']}**"
                        und_score_text = f"  \n**Score: {game_data[und_espn]['score']}**"
                        status_ticker = f"`🔴 LIVE - {game_data[fav_espn]['clock']}`" if f_state == "in" else "`🏁 FINAL`"

            c_num, c_fav, c_und, c_spr, c_pck = st.columns(5)
            with c_num: st.write(f"**{g_num}**")
            with c_fav: st.markdown(f"**{fav_label}**{fav_score_text}  \n{status_ticker}")
            with c_und: st.markdown(f"**{und_label}**{und_score_text}")
            with c_spr: st.markdown(f"`{spread_val}`")
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
            st.error(f"Validation Error: You must pick exactly 7 games to submit. You currently have {len(chosen_picks)} selected.")
        else:
            try:
                supabase.table("picks").delete().eq("user_id", user.id).eq("week_number", CURRENT_WEEK).execute()
                for p in chosen_picks:
                    supabase.table("picks").insert({"user_id": user.id, "username": username, "week_number": CURRENT_WEEK, "game_id": p["game_id"], "selected_team": p["selected_team"]}).execute()
                st.success("Boom! Your 7 picks are saved securely.")
            except Exception as e: st.error(f"Database error: {e}")
