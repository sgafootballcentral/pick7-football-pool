import streamlit as st
from supabase import create_client, Client
from datetime import datetime, timezone

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

# 3. Secure Authentication Interface (COMPLETELY ISOLATED)
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
            except Exception as e:
                st.error("Login failed. Check your email or password entries.")
                
    with tab2:
        signup_email = st.text_input("Email", key="s_email")
        signup_pass = st.text_input("Password", type="password", key="s_pass")
        signup_user = st.text_input("League Display Name / Nickname", key="s_user")
        if st.button("Create Account", use_container_width=True):
            try:
                supabase.auth.sign_up({
                    "email": signup_email, 
                    "password": signup_pass,
                    "options": {"data": {"username": signup_user}}
                })
                st.success("Account created successfully! You can now switch to the Log In tab.")
            except Exception as e:
                st.error("Sign up failed. Ensure your password is at least 6 characters.")
    # Stop execution right here so the game engine cannot run until logged in
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

# 4. Pull active week slate
try:
    games_response = supabase.table("games").select("*").eq("week_number", CURRENT_WEEK).order("kickoff_time").execute()
    all_games = games_response.data
except Exception as e:
    all_games = []

if not all_games:
    st.info(f"No games have been loaded yet for Week {CURRENT_WEEK} by the league administrator.")
else:
    # Calculate how many selections are currently active
    current_picks_count = 0
    for game in all_games:
        saved_val = st.session_state.get(f"sel_{game['game_id']}", "-- Select --")
        if saved_val != "-- Select --":
            current_picks_count += 1

    ui_max_reached = current_picks_count >= 7

    chosen_picks = []
    cfb_games = [g for g in all_games if g['league'] == 'CFB']
    nfl_games = [g for g in all_games if g['league'] == 'NFL']

    def display_slate(game_list, category):
        st.subheader(category)
        for game in game_list:
            kickoff = datetime.fromisoformat(game['kickoff_time'].replace('Z', '+00:00'))
            is_time_locked = now >= kickoff
            
            # Bulletproof extraction wrapper fix using a safe try/except fallback
            try:
                text = game['display_text']
                if " at " in text:
                    teams = text.split(" at ")
                elif " vs " in text:
                    teams = text.split(" vs ")
                else:
                    teams = [text, "Home Team"]
                    
                t_a = teams[0].split(" (")[0].strip()
                t_b = teams[1].split(" (")[0].strip() if len(teams) > 1 else "Home Team"
            except Exception:
                t_a, t_b = "Away Team", "Home Team"
            
            col1, col2 = st.columns()
            with col1:
                st.write(f"🏈 {game['display_text']}")
            with col2:
                if is_time_locked:
                    st.button("🔒 Locked", key=f"lock_{game['game_id']}", disabled=True)
                else:
                    is_current_empty = st.session_state.get(f"sel_{game['game_id']}", "-- Select --") == "-- Select --"
                    should_disable = ui_max_reached and is_current_empty
                    
                    pick = st.selectbox(
                        "Choose", 
                        options=["-- Select --", t_a, t_b], 
                        key=f"sel_{game['game_id']}",
                        label_visibility="collapsed",
                        disabled=should_disable
                    )
                    if pick != "-- Select --":
                        chosen_picks.append({"game_id": game['game_id'], "selected_team": pick})

    if cfb_games: display_slate(cfb_games, "College Football Matchups")
    if nfl_games: display_slate(nfl_games, "NFL Matchups")

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
                    supabase.table("picks").insert({
                        "user_id": user.id, 
                        "username": username, 
                        "week_number": CURRENT_WEEK, 
                        "game_id": p["game_id"], 
                        "selected_team": p["selected_team"]
                    }).execute()
                st.success(f"Boom! Your 7 picks are saved securely for Week {CURRENT_WEEK}!")
            except Exception as e: 
                st.error(f"Database error saving picks: {e}")
