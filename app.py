import streamlit as st
from supabase import create_client, Client
from datetime import datetime, timezone

# 1. Connection settings
SUPABASE_URL = st.secrets.get("SUPABASE_URL", "YOUR_SUPABASE_URL")
SUPABASE_KEY = st.secrets.get("SUPABASE_KEY", "YOUR_SUPABASE_ANON_KEY")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

st.set_page_config(page_title="Football Pick-7 Pool", page_icon="🏈")
st.title("🏈 Pick 7 Against The Spread")

# 2. Track user sessions
if "user" not in st.session_state:
    st.session_state.user = None

# 3. Simple Authentication Forms
if not st.session_state.user:
    tab1, tab2 = st.tabs(["Log In", "Sign Up"])
    
    with tab1:
        login_email = st.text_input("Email", key="l_email")
        login_pass = st.text_input("Password", type="password", key="l_pass")
        if st.button("Log In"):
            try:
                res = supabase.auth.sign_in_with_password({"email": login_email, "password": login_pass})
                st.session_state.user = res.user
                st.rerun()
            except Exception as e:
                st.error(f"Login failed: {e.message if hasattr(e, 'message') else e}")
                
    with tab2:
        signup_email = st.text_input("Email", key="s_email")
        signup_pass = st.text_input("Password", type="password", key="s_pass")
        signup_user = st.text_input("League Display Name / Nickname", key="s_user")
        if st.button("Create Account"):
            try:
                res = supabase.auth.sign_up({
                    "email": signup_email, 
                    "password": signup_pass,
                    "options": {"data": {"username": signup_user}}
                })
                st.success("Account created! Check your email for a confirmation link, then log in.")
            except Exception as e:
                st.error(f"Sign up failed: {e.message if hasattr(e, 'message') else e}")
    st.stop()

# --- Authenticated User Hub ---
user = st.session_state.user
username = user.user_metadata.get("username", user.email)
st.sidebar.write(f"Logged in as: **{username}**")
if st.sidebar.button("Log Out"):
    supabase.auth.sign_out()
    st.session_state.user = None
    st.rerun()

CURRENT_WEEK = 1 
st.header(f"Week {CURRENT_WEEK} Master Slate")

# 4. Pull Games from Supabase
now = datetime.now(timezone.utc)
try:
    games_response = supabase.table("games").select("*").execute()
    all_games = games_response.data
except Exception as e:
    st.error("Could not fetch games from database.")
    all_games = []

if not all_games:
    st.info("No games have been loaded yet for this week by the league administrator.")
    st.stop()

# 5. Render games and capture selections
chosen_picks = []

nfl_games = [g for g in all_games if g['league'] == 'NFL']
cfb_games = [g for g in all_games if g['league'] == 'CFB']

def display_slate(game_list, category):
    st.subheader(category)
    for game in game_list:
        kickoff = datetime.fromisoformat(game['kickoff_time'].replace('Z', '+00:00'))
        is_locked = now >= kickoff
        
        col1, col2 = st.columns()
        with col1:
            st.write(f"{game['display_text']}")
        with col2:
            if is_locked:
                st.button("🔒 Locked", key=f"lock_{game['game_id']}", disabled=True)
            else:
                text = game['display_text']
                teams = text.split(" vs ") if " vs " in text else text.split(" @ ")
                team_a = teams[0].split(" (")[0].strip()
                team_b = teams[1].split(" (")[0].strip() if len(teams) > 1 else "Home Team"
                
                pick = st.selectbox(
                    "Choose", 
                    options=["-- Select --", team_a, team_b], 
                    key=f"sel_{game['game_id']}",
                    label_visibility="collapsed"
                )
                if pick != "-- Select --":
                    chosen_picks.append({"game_id": game['game_id'], "selected_team": pick})

if nfl_games: display_slate(nfl_games, "NFL Matchups")
if cfb_games: display_slate(cfb_games, "College Football Matchups")

# 6. Check constraints and save
st.divider()
st.subheader("Your Submission Status")
st.write(f"Total Games Picked: **{len(chosen_picks)} / 7**")

if st.button("Lock In Weekly Picks", type="primary"):
    if len(chosen_picks) != 7:
        st.error(f"Validation Error: You must pick exactly 7 games. You currently have {len(chosen_picks)} selected.")
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
            st.success("Boom! Your 7 picks are saved securely for Week 1.")
        except Exception as e:
            st.error(f"Database error saving picks: {e}")
