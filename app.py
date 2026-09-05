import streamlit as st
import requests
from supabase import create_client, Client
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

# 1. Connection and Secrets Verification
SUPABASE_URL = st.secrets.get("SUPABASE_URL")
SUPABASE_KEY = st.secrets.get("SUPABASE_KEY")
ODDS_API_KEY = st.secrets.get("ODDS_API_KEY")

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

# 4. LIVE SPORTS SCOREBOARD PIPELINE WITH SMART PARTIAL-NAME MATCHING
live_scores_list = []
if ODDS_API_KEY:
    try:
        score_url = "https://the-odds-api.com"
        score_params = {"apiKey": ODDS_API_KEY, "daysFrom": 3}
        score_headers = {"User-Agent": "Mozilla/5.0"}
        score_call = requests.get(score_url, params=score_params, headers=score_headers)
        if score_call.status_code == 200:
            live_scores_list = score_call.json()
    except Exception:
        pass

# Helper tool to scan the API scores list using partial string comparisons
def find_live_score(team_name):
    for match in live_scores_list:
        home_api = match.get("home_team", "")
        away_api = match.get("away_team", "")
        # If the database team name contains or matches the API team name
        if home_api in team_name or team_name in home_api or away_api in team_name or team_name in away_api:
            scores = match.get("scores")
            score_dict = {s["name"]: int(s["score"]) for s in scores} if scores else {}
            
            # Extract scores safely using partial matching loops
            h_pts = next((val for name, val in score_dict.items() if name in home_api or home_api in name), 0)
            a_pts = next((val for name, val in score_dict.items() if name in away_api or away_api in name), 0)
            
            return {
                "home_api_name": home_api,
                "away_api_name": away_api,
                "home_score": h_pts,
                "away_score": a_pts,
                "completed": match.get("completed", False)
            }
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

    # Group matches by Eastern Time calendar dates
    grouped_by_date = {}
    for game in all_games:
        kickoff_utc = datetime.fromisoformat(game['kickoff_time'].replace('Z', '+00:00'))
        kickoff_est = kickoff_utc.astimezone(EASTERN_TZ)
        date_str = kickoff_est.strftime("%A, %b %d")
        if date_str not in grouped_by_date:
            grouped_by_date[date_str] = []
        grouped_by_date[date_str].append((game, kickoff_est, kickoff_utc))

    # Render Grid Output Layout matching spreadsheet style
    for date_header, games_in_day in grouped_by_date.items():
        st.write("")
        st.markdown(f"### 📅 {date_header}")
        
        # Grid Title Column Labels
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

            # 🏠 CORRECTED HOME TEAM LOOKUP LOGIC
            # In your "Away at Home" sheet layout, the team on the RIGHT side is ALWAYS the home team
            # We match the underdog vs favorite string to see which one was listed on the right side of the sheet row
            d_text = game.get("display_text", "")
            is_fav_home = False
            is_und_home = False
            
            if " at " in d_text:
                parts = d_text.split(" at ")
                home_side_text = parts[1] if len(parts) > 1 else ""
                if fav_team in home_side_text: is_fav_home = True
                if und_team in home_side_text: is_und_home = True

            fav_label = f"{fav_team} 🏠" if is_fav_home else fav_team
            und_label = f"{und_team} 🏠" if is_und_home else und_team

            # 🕒 REAL-TIME IN-GAME SCORE MATCHING LOGIC
            fav_score_text = ""
            und_score_text = ""
            status_ticker = f"`🕒 {time_str}`"
            
            # Query our smart parser tool using the raw team values
            score_record = find_live_score(fav_team) or find_live_score(und_team)
            
            if score_record:
                # Dynamically assign matching score numbers to the right rows
                if score_record["home_api_name"] in fav_team or fav_team in score_record["home_api_name"]:
                    f_pts, u_pts = score_record["home_score"], score_record["away_score"]
                else:
                    u_pts, f_pts = score_record["home_score"], score_record["away_score"]
                    
                fav_score_text = f"  \n**Score: {f_pts}**"
                und_score_text = f"  \n**Score: {u_pts}**"
                status_ticker = "`🔴 LIVE IN-PROGRESS`" if not score_record["completed"] else "`🏁 FINAL`"

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
                        "Choose", 
                        options=["-- Select --", fav_team, und_team], 
                        key=f"sel_{game['game_id']}",
                        label_visibility="collapsed",
                        disabled=should_disable
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
