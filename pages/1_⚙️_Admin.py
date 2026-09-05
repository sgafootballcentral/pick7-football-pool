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

# 3. DIRECT 100% ESPN AUTOMATED SYNCER WITH SECURITY HEADERS
st.subheader("🏈 Live ESPN Board Auto-Fetcher")
st.write("Wipe the board for the selected week and instantly pull the live college football slate directly from ESPN:")

if st.button("🔄 Auto-Fetch Live ESPN Slate", type="primary"):
    with st.spinner("Downloading live schedule from ESPN..."):
        try:
            supabase.table("games").delete().eq("week_number", active_week).execute()
            
            url = "https://espn.com"
            
            # 🌐 CRUCIAL SECURITY HEADERS MASK
            # This disguises the script as a regular Google Chrome browser to slide past firewalls
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "application/json"
            }
            
            api_call = requests.get(url, headers=headers)
            
            if api_call.status_code != 200:
                st.error(f"ESPN Server Error (Code {api_call.status_code}): {api_call.text}")
                st.stop()
                
            response = api_call.json()
            count = 0
            for idx, event in enumerate(response.get("events", [])):
                game_number = idx + 1
                game_id = event.get("id")
                kickoff_time = event.get("date")
                
                competitions = event.get("competitions", [{}])[0]
                competitors = competitions.get("competitors", [])
                
                # Safely extract point spreads embedded directly in ESPN's odds node
                odds_list = competitions.get("odds", [{}])
                odds_string = odds_list[0].get("details", "0.0") if odds_list else "0.0"
                
                home_node = next((c for c in competitors if c.get("homeAway") == "home"), competitors[0])
                away_node = next((c for c in competitors if c.get("homeAway") == "away"), competitors[1])
                
                home_team = home_node.get("team", {}).get("displayName", "Home Team")
                away_team = away_node.get("team", {}).get("displayName", "Away Team")
                
                supabase.table("games").insert({
                    "game_id": f"espn_{game_id}",
                    "game_number": game_number,
                    "league": "CFB",
                    "favorite_team": away_team,  
                    "underdog_team": home_team,  
                    "favorite_team_home": False,
                    "underdog_team_home": True,  
                    "spread_value": odds_string, 
                    "display_text": f"{away_team} at {home_team}",
                    "kickoff_time": kickoff_time,
                    "week_number": int(active_week)
                }).execute()
                count += 1
                
            st.success(f"Success! Pulled {count} official games with live lines cleanly from ESPN into Week {active_week}!")
            st.rerun()
        except Exception as e:
            st.error(f"ESPN Sync Failed: {e}")
