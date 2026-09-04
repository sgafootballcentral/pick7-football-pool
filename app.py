import streamlit as st
import requests
from supabase import create_client, Client
from datetime import datetime, timezone

# 1. Connection settings
SUPABASE_URL = st.secrets.get("SUPABASE_URL")
SUPABASE_KEY = st.secrets.get("SUPABASE_KEY")
ODDS_API_KEY = st.secrets.get("ODDS_API_KEY")
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
                st.error("Login failed.")
                
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
                st.success("Account created! Refresh and log in.")
            except Exception as e:
                st.error("Sign up failed.")
    st.stop()

# --- Authenticated User Hub ---
user = st.session_state.user
username = user.user_metadata.get("username", user.email)
st.sidebar.write(f"Logged in as: **{username}**")

# Log Out Button
if st.sidebar.button("Log Out"):
    supabase.auth.sign_out()
    st.session_state.user = None
    st.rerun()

CURRENT_WEEK = 1 

# Create Main Tabs
main_tab, admin_tab = st.tabs(["📊 Make Your Picks", "⚙️ Admin Controls"])

# ==================== MAIN PICKS TAB ====================
with main_tab:
    st.header(f"Week {CURRENT_WEEK} Master Slate")
    now = datetime.now(timezone.utc)
    
    try:
        games_response = supabase.table("games").select("*").execute()
        all_games = games_response.data
    except Exception as e:
        all_games = []

    if not all_games:
        st.info("No games have been loaded yet for this week.")
    else:
        chosen_picks = []
        cfb_games = [g for g in all_games if g['league'] == 'CFB']
        nfl_games = [g for g in all_games if g['league'] == 'NFL']

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
                        team_b = teams[1].split(" (")[0].strip() if len(teams) > 1 else "Home"
                        
                        pick = st.selectbox(
                            "Choose", 
                            options=["-- Select --", team_a, team_b], 
                            key=f"sel_{game['game_id']}",
                            label_visibility="collapsed"
                        )
                        if pick != "-- Select --":
                            chosen_picks.append({"game_id": game['game_id'], "selected_team": pick})

        if cfb_games: display_slate(cfb_games, "🏈 College Football Matchups")
        if nfl_games: display_slate(nfl_games, "🏈 NFL Matchups")

        st.divider()
        st.write(f"Total Games Picked: **{len(chosen_picks)} / 7**")

        if st.button("Lock In Weekly Picks", type="primary"):
            if len(chosen_picks) != 7:
                st.error(f"You must pick exactly 7 games. You currently have {len(chosen_picks)} selected.")
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
                    st.success("Boom! Your 7 picks are saved securely.")
                except Exception as e:
                    st.error("Database error saving picks.")

# ==================== ADMIN CONTROLS TAB ====================
with admin_tab:
    st.header("League Admin Panel")
    st.write("Click below to clear the current slate and automatically pull the entire college football slate via API.")
    
    if st.button("🔄 Auto-Fetch 72+ Game Slate", type="primary"):
        if not ODDS_API_KEY:
            st.error("Odds API Key missing from settings Secrets.")
        else:
            with st.spinner("Fetching live point spreads..."):
                try:
                    # Clear out the database table
                    supabase.table("games").delete().neq("id", 0).execute()
                    
                    # Request general consensus spreads via The Odds API
                    url = "https://the-odds-api.com"
                    params = {
                        "apiKey": ODDS_API_KEY,
                        "regions": "us",
                        "markets": "spreads",
                        "oddsFormat": "american"
                    }
                    response = requests.get(url, params=params).json()
                    
                    count = 0
                    for match in response:
                        game_id = match["id"]
                        home_team = match["home_team"]
                        away_team = match["away_team"]
                        kickoff_time = match["commence_time"]
                        
                        # Extract point spreads dynamically from available bookmakers
                        try:
                            bookmakers = match["bookmakers"]
                            # Grab spreads from the first available bookmaker returned
                            market = bookmakers[0]["markets"][0]
                            outcomes = market["outcomes"]
                            
                            spread_home = next(o["point"] for o in outcomes if o["name"] == home_team)
                            spread_away = next(o["point"] for o in outcomes if o["name"] == away_team)
                            
                            sign_h = "+" if spread_home > 0 else ""
                            sign_a = "+" if spread_away > 0 else ""
                            
                            display_text = f"{away_team} ({sign_a}{spread_away}) @ {home_team} ({sign_h}{spread_home})"
                        except:
                            display_text = f"{away_team} @ {home_team} (Spread Offline)"
                        
                        # Save directly into Supabase
                        supabase.table("games").insert({
                            "game_id": game_id,
                            "league": "CFB",
                            "display_text": display_text,
                            "kickoff_time": kickoff_time
                        }).execute()
                        count += 1
                        
                    st.success(f"Successfully loaded {count} college football games into your app!")
                    st.rerun()
                except Exception as e:
                    st.error(f"Failed to load slate: {e}")
