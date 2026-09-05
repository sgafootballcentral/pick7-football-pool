import streamlit as st
import pandas as pd
import requests
from io import StringIO
from supabase import create_client, Client
from datetime import datetime, timezone

# 1. Connection and Secrets Verification
SUPABASE_URL = st.secrets.get("SUPABASE_URL")
SUPABASE_KEY = st.secrets.get("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    st.error("Missing critical Supabase connection variables in Streamlit Secrets.")
    st.stop()

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

st.title("⚙️ League Admin Panel")

# 2. DYNAMIC LIVE ROLE DATABASE CHECK
if "user" not in st.session_state or not st.session_state.user:
    st.warning("Please log in on the home page first.")
    st.stop()

user_id = st.session_state.user.id
try:
    current_user_record = supabase.table("league_users").select("role").eq("id", user_id).execute().data
    is_admin = current_user_record and current_user_record[0].get("role") == "admin"
except Exception:
    is_admin = False

if not is_admin:
    st.error("🚫 Access Denied.")
    st.stop()

st.success("🔓 Commissioner Dashboard Unlocked!")
active_week = st.number_input("Target Input Week Number:", min_value=1, max_value=18, value=1, step=1)
st.write("---")

# 3. DIRECT 100% ESPN AUTOMATED SYNCER
st.subheader("🏈 Live ESPN Board Auto-Fetcher")
st.write("Wipe the board for the selected week and instantly pull the live college football slate directly from ESPN's master wire:")

if st.button("🔄 Auto-Fetch Live ESPN Slate", type="primary"):
    with st.spinner("Downloading live schedule from ESPN..."):
        try:
            # Wipe previous schedules for the active target week
            supabase.table("games").delete().eq("week_number", active_week).execute()
            
            # Fetch directly from ESPN public scoreboard networks
            url = "https://espn.com"
            response = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}).json()
            
            count = 0
            for idx, event in enumerate(response.get("events", [])):
                game_number = idx + 1
                game_id = event.get("id")
                kickoff_time = event.get("date") # Raw UTC timestamp directly from ESPN
                
                competitors = event.get("competitions", [{}])[0].get("competitors", [])
                
                # ESPN always lists Home on row index 0 or explicit homeAway string
                home_node = next((c for c in competitors if c.get("homeAway") == "home"), competitors[0])
                away_node = next((c for c in competitors if c.get("homeAway") == "away"), competitors[1])
                
                home_team = home_node.get("team", {}).get("displayName", "Home Team")
                away_team = away_node.get("team", {}).get("displayName", "Away Team")
                
                # We save who the official Home Team is directly inside your database table!
                supabase.table("games").insert({
                    "game_id": f"espn_{game_id}",
                    "game_number": game_number,
                    "league": "CFB",
                    "favorite_team": away_team,  # Renders on the left side
                    "underdog_team": home_team,  # Renders on the right side
                    "favorite_team_home": False,
                    "underdog_team_home": True,  # Stamped explicitly as the home team host
                    "spread_value": "Line Live",
                    "display_text": f"{away_team} at {home_team}",
                    "kickoff_time": kickoff_time,
                    "week_number": int(active_week)
                }).execute()
                count += 1
                
            st.success(f"Success! Pulled {count} official games cleanly from ESPN into Week {active_week}!")
            st.rerun()
        except Exception as e:
            st.error(f"ESPN Sync Failed: {e}")
