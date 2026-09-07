import streamlit as st
import requests
from supabase import create_client, Client

# 1. Connection and Secrets Verification
SUPABASE_URL = st.secrets.get("SUPABASE_URL")
SUPABASE_KEY = st.secrets.get("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    st.error("Missing critical Supabase connection variables in Streamlit Secrets.")
    st.stop()

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

st.title("⚙️ League Admin Panel")

# 2. FIXED USER ACCESSIBILITY ROLE DATABASE CHECK
if "user" not in st.session_state or not st.session_state.user:
    st.warning("Please log in on the home page first.")
    st.stop()

user_id = st.session_state.user.id
is_admin = False

try:
    # Fetch user records from your custom league_users table
    response = supabase.table("league_users").select("role").eq("id", user_id).execute()
    current_user_records = response.data
    
    # FIXED: Check if the list contains data first, then pull the index dictionary securely
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
active_week = st.number_input("Target Input Week Number:", min_value=1, max_value=18, value=1, step=1)
st.write("---")

# 3. COMBINED MULTI-LEAGUE AUTOMATED SYNCER
st.subheader("🏈 Live Combined ESPN Board Auto-Fetcher")
st.write("Wipe the board for the selected week and pull the complete NFL and College Football slates with point spreads simultaneously:")

if st.button("🔄 Auto-Fetch Combined NFL & NCAAF Slates", type="primary"):
    with st.spinner("Downloading live schedules from ESPN wires..."):
        try:
            # Clear previous entries for the selected week to avoid duplicates
            supabase.table("games").delete().eq("week_number", active_week).execute()
            
            # We fetch from both master endpoints back-to-back
            leagues_to_fetch = [
                {"name": "NFL", "url": f"https://espn.com{active_week}"},
                {"name": "CFB", "url": "https://espn.com"}
            ]
            
            total_games_inserted = 0
            headers = {"User-Agent": "Mozilla/5.0"}
            
            for target_league in leagues_to_fetch:
                api_call = requests.get(target_league["url"], headers=headers)
                if api_call.status_code != 200:
                    continue
                    
                response_data = api_call.json()
                
                for event in response_data.get("events", []):
                    total_games_inserted += 1
                    game_id = event.get("id")
                    kickoff_time = event.get("date")
                    
                    competitions = event.get("competitions", [{}])
                    competitors = competitions[0].get("competitors", [])
                    
                    # Pull point spreads directly from ESPN's primary Vegas booking node
                    odds_node = competitions[0].get("odds", [])
                    odds_string = odds_node[0].get("details", "0.0") if odds_array else "0.0"
                    
                    home_node = next((c for c in competitors if c.get("homeAway") == "home"), competitors[0])
                    away_node = next((c for c in competitors if c.get("homeAway") == "away"), competitors[1])
                    
                    home_team = home_node.get("team", {}).get("displayName", "Home Team")
                    away_team = away_node.get("team", {}).get("displayName", "Away Team")
                    
                    # Split out the favorites vs underdogs based on the line string (e.g., "MIA -3.5")
                    fav_team = away_team
                    und_team = home_team
                    fav_home = False
                    und_home = True
                    
                    if odds_string != "0.0" and " " in odds_string:
                        line_parts = odds_string.split(" ")
                        home_abbr = home_node.get("team", {}).get("abbreviation", "")
                        if line_parts[0].upper() == home_abbr.upper():
                            fav_team = home_team
                            und_team = away_team
                            fav_home = True
                            und_home = False
                    
                    # Push directly to your Supabase database games record
                    supabase.table("games").insert({
                        "game_id": f"espn_{game_id}",
                        "game_number": total_games_inserted, # Sequential numbering covering both leagues
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
                    
            st.success(f"Success! Imported {total_games_inserted} total games (NFL + CFB) cleanly into Week {active_week}!")
            st.rerun()
            
        except Exception as e:
            st.error(f"ESPN Multi-League Sync Failed: {e}")
