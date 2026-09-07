import streamlit as st
import requests
import time as time_module
from datetime import datetime, time, timezone
from supabase import create_client, Client

# 1. Connection and Secrets Verification
SUPABASE_URL = st.secrets.get("SUPABASE_URL")
SUPABASE_KEY = st.secrets.get("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    st.error("Missing critical Supabase connection variables in Streamlit Secrets.")
    st.stop()

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

st.title("⚙️ League Admin Panel")

# 2. USER ACCESSIBILITY ROLE DATABASE CHECK
if "user" not in st.session_state or not st.session_state.user:
    st.warning("Please log in on the home page first.")
    st.stop()

if st.session_state.get("access_token"):
    try:
        supabase.auth.set_session(st.session_state.access_token, st.session_state.refresh_token)
    except Exception:
        st.session_state.user = None
        st.session_state.access_token = None
        st.warning("Your session expired -- please log in again on the home page.")
        st.stop()

user_id = st.session_state.user.id
is_admin = False

try:
    response = supabase.table("league_users").select("role").eq("id", user_id).execute()
    current_user_records = response.data
    if current_user_records and len(current_user_records) > 0:
        if current_user_records[0].get("role") == "admin":
            is_admin = True
except Exception as e:
    st.error(f"Database security check failed: {e}")
    is_admin = False

if not is_admin:
    st.error("🚫 Access Denied. Your profile role must be set to 'admin' in your database.")
    st.stop()

st.success("🔓 Commissioner Dashboard Unlocked!")
active_week = st.number_input("Target Grouping Week Number (For Player Submissions):", min_value=1, max_value=18, value=1, step=1)

# 📅 3. CALENDAR DATE SELECTOR
st.subheader("📆 Select Custom Game Extraction Windows")
selected_range = st.date_input(
    "Select Date Boundaries:",
    value=(datetime.today().date(), datetime.today().date()),
    help="Choose two specific calendar dates to set your pool window."
)

st.write("---")

# 4. CHRONOLOGICAL DATE-DRIVEN AUTOMATED SYNCER
if st.button("🔄 Auto-Fetch Games by Selected Dates", type="primary"):
    if isinstance(selected_range, tuple) and len(selected_range) == 2:
        start_date, end_date = selected_range
        start_utc_str = datetime.combine(start_date, time.min).replace(tzinfo=timezone.utc).strftime("%Y%m%d")
        end_utc_str = datetime.combine(end_date, time.max).replace(tzinfo=timezone.utc).strftime("%Y%m%d")
    else:
        st.error("Validation Error: Please select both a start date and an end date on the calendar.")
        st.stop()

    with st.spinner(f"Downloading game schedules from {start_date} to {end_date}..."):
        try:
            # Wipe previous entries for the selected grouping week to avoid duplication
            supabase.table("games").delete().eq("week_number", active_week).execute()
            
            date_range = f"{start_utc_str}-{end_utc_str}"
            leagues_to_fetch = [
                {
                    "name": "NFL",
                    "url": "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
                    "params": {"limit": 1000, "dates": date_range},
                },
                {
                    "name": "CFB",
                    "url": "https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard",
                    "params": {"limit": 1000, "groups": 80, "dates": date_range},
                },
            ]
            
            total_games_inserted = 0
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://www.espn.com/",
                "Accept": "application/json",
            }

            for target_league in leagues_to_fetch:
                api_call = requests.get(target_league["url"], params=target_league["params"], headers=headers, timeout=15)
                if api_call.status_code != 200:
                    st.warning(f"{target_league['name']} request failed: HTTP {api_call.status_code}")
                    continue
                time_module.sleep(2)  # ESPN's hidden API has been rate-limiting back-to-back requests
                    
                response_data = api_call.json()
                
                for event in response_data.get("events", []):
                    total_games_inserted += 1
                    game_id = event.get("id")
                    kickoff_time = event.get("date")
                    
                    # Target index array zero nodes safely
                    competitions = event.get("competitions", [{}])[0]
                    competitors = competitions.get("competitors", [])
                    
                    # FIX: Safely read list array nodes for opening Vegas spreads
                    odds_array = competitions.get("odds", [])
                    odds_string = odds_array[0].get("details", "0.0") if odds_array and isinstance(odds_array, list) else "0.0"
                    
                    home_node = next((c for c in competitors if c.get("homeAway") == "home"), competitors[0])
                    away_node = next((c for c in competitors if c.get("homeAway") == "away"), competitors[1])
                    
                    home_team = home_node.get("team", {}).get("displayName", "Home Team")
                    away_team = away_node.get("team", {}).get("displayName", "Away Team")
                    
                    fav_team, und_team = away_team, home_team
                    fav_home, und_home = False, True
                    
                    if odds_string != "0.0" and " " in odds_string:
                        line_parts = odds_string.split(" ")
                        fav_abbr_extracted = line_parts[0].strip().upper()
                        home_abbr = home_node.get("team", {}).get("abbreviation", "").strip().upper()
                        
                        if fav_abbr_extracted == home_abbr:
                            fav_team, und_team = home_team, away_team
                            fav_home, und_home = True, False
                    
                    # Save clean rows straight to your Supabase tables
                    supabase.table("games").insert({
                        "game_id": f"espn_{game_id}",
                        "game_number": total_games_inserted, 
                        "league": target_league["name"],
                        "favorite_team": fav_team,  
                        "underdog_team": und_team,  
                        "favorite_team_home": fav_home,
                        "underdog_team_home": und_home,  
                        "spread_value": odds_string, 
                        "display_text": f"{away_team} at {home_team}",
                        "kickoff_time": kickoff_time,
                        "week_number": int(active_week)
                    }).execute()
                    
            st.success(f"Success! Pulled {total_games_inserted} total games cleanly from {start_date} to {end_date} into Week {active_week}!")
            st.rerun()
        except Exception as e:
            st.error(f"ESPN Date Sync Failed: {e}")
