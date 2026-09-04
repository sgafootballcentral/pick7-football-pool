import streamlit as st
from supabase import create_client, Client
from datetime import datetime, timezone

# 1. Connection and Secrets Verification
SUPABASE_URL = st.secrets.get("SUPABASE_URL")
SUPABASE_KEY = st.secrets.get("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    st.error("Missing critical Supabase variables in Streamlit Secrets.")
    st.stop()

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

st.set_page_config(page_title="Football Pick-7 Pool", page_icon="🏈")
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
            except: st.error("Login failed. Check entries.")
    with tab2:
        signup_email = st.text_input("Email", key="s_email")
        signup_pass = st.text_input("Password", type="password", key="s_pass")
        signup_user = st.text_input("League Display Name / Nickname", key="s_user")
        if st.button("Create Account", use_container_width=True):
            try:
                supabase.auth.sign_up({"email": signup_email, "password": signup_pass, "options": {"data": {"username": signup_user}}})
                st.success("Account created successfully! Switch to Log In.")
            except: st.error("Sign up failed. Password must be 6+ characters.")
    st.stop()

# --- Authenticated User Area Hub ---
user = st.session_state.user
username = user.user_metadata.get("username", user.email)
st.sidebar.write(f"Logged in as: **{username}**")
if st.sidebar.button("Log Out"):
    supabase.auth.sign_out()
    st.session_state.user = None
    st.rerun()

CURRENT_WEEK = 1 
st.header(f"Week {CURRENT_WEEK} Master Slate")
now = datetime.now(timezone.utc)

try:
    all_games = supabase.table("games").select("*").order("kickoff_time").execute().data
except:
    all_games = []

if not all_games:
    st.info("No games loaded yet for this week by the league administrator.")
else:
    chosen_picks = []
    for game in all_games:
        kickoff = datetime.fromisoformat(game['kickoff_time'].replace('Z', '+00:00'))
        is_locked = now >= kickoff
        
        col1, col2 = st.columns([3, 1])
        with col1: st.write(f"🏈 {game['display_text']}")
        with col2:
            if is_locked:
                st.button("🔒 Locked", key=f"l_{game['game_id']}", disabled=True)
            else:
                text = game['display_text']
                teams = text.split(" at ") if " at " in text else text.split(" vs ")
                t_a = teams[0].split(" (")[0].strip() if len(teams) > 0 else "Away"
                t_b = teams[1].split(" (")[0].strip() if len(teams) > 1 else "Home"
                pick = st.selectbox("Choose", options=["-- Select --", t_a, t_b], key=f"s_{game['game_id']}", label_visibility="collapsed")
                if pick != "-- Select --":
                    chosen_picks.append({"game_id": game['game_id'], "selected_team": pick})

    st.divider()
    st.write(f"Total Games Picked: **{len(chosen_picks)} / 7**")
    if st.button("Lock In Weekly Picks", type="primary"):
        if len(chosen_picks) != 7:
            st.error(f"You must select exactly 7 games. Currently selected: {len(chosen_picks)}")
        else:
            try:
                supabase.table("picks").delete().eq("user_id", user.id).eq("week_number", CURRENT_WEEK).execute()
                for p in chosen_picks:
                    supabase.table("picks").insert({"user_id": user.id, "username": username, "week_number": CURRENT_WEEK, "game_id": p["game_id"], "selected_team": p["selected_team"]}).execute()
                st.success("Boom! Your 7 picks are saved securely.")
            except Exception as e: st.error(f"Error saving: {e}")
