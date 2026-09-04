import streamlit as st
import requests
from supabase import create_client, Client

SUPABASE_URL = st.secrets.get("SUPABASE_URL")
SUPABASE_KEY = st.secrets.get("SUPABASE_KEY")
ODDS_API_KEY = st.secrets.get("ODDS_API_KEY")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

st.title("⚙️ League Admin Panel")
st.write("Automatically clean the current database tables and load this weekend's entire college football slate.")

if st.button("🔄 Auto-Fetch 72+ Game Slate", type="primary"):
    if not ODDS_API_KEY:
        st.error("Odds API Key missing from settings Secrets.")
    else:
        with st.spinner("Downloading live spreads from sportsbooks..."):
            try:
                # 1. Clear out old schedule data
                supabase.table("games").delete().neq("id", 0).execute()
                
                # 2. Corrected up-to-date API url endpoint for NCAA Football
                url = "https://the-odds-api.com"
                params = {
                    "apiKey": ODDS_API_KEY, 
                    "regions": "us", 
                    "markets": "spreads", 
                    "oddsFormat": "american"
                }
                headers = {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                }
                
                api_call = requests.get(url, params=params, headers=headers)
                
                # If there's an API problem, this prints the exact helpful error text on screen
                if api_call.status_code != 200:
                    st.error(f"API Connection Error (Code {api_call.status_code}): {api_call.text}")
                    st.stop()
                    
                response = api_call.json()
                
                # 3. Parse matches safely
                count = 0
                for match in response:
                    game_id = match.get("id")
                    home_team = match.get("home_team")
                    away_team = match.get("away_team")
                    kickoff_time = match.get("commence_time")
                    display_text = f"{away_team} at {home_team}"
                    
                    bookmakers = match.get("bookmakers", [])
                    if bookmakers and len(bookmakers) > 0:
                        markets = bookmakers[0].get("markets", [])
                        if markets and len(markets) > 0:
                            outcomes = markets[0].get("outcomes", [])
                            if len(outcomes) >= 2:
                                home_o = next((o for o in outcomes if o.get("name") == home_team), None)
                                away_o = next((o for o in outcomes if o.get("name") == away_team), None)
                                if home_o and away_o:
                                    s_h, s_a = home_o.get("point", 0), away_o.get("point", 0)
                                    display_text = f"{away_team} ({'+' if s_a > 0 else ''}{s_a}) at {home_team} ({'+' if s_h > 0 else ''}{s_h})"
                    
                    # Save rows directly into your database 
                    supabase.table("games").insert({
                        "game_id": game_id, 
                        "league": "CFB", 
                        "display_text": display_text, 
                        "kickoff_time": kickoff_time
                    }).execute()
                    count += 1
                    
                st.success(f"Success! Loaded {count} college football games cleanly into your pool dashboard!")
            except Exception as e:
                st.error(f"Execution structure failure running import task: {e}")
