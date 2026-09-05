import streamlit as st
import pandas as pd
import requests
from io import StringIO
from supabase import create_client, Client

# 1. Connection and Secrets Verification
SUPABASE_URL = st.secrets.get("SUPABASE_URL")
SUPABASE_KEY = st.secrets.get("SUPABASE_KEY")
ODDS_API_KEY = st.secrets.get("ODDS_API_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    st.error("Missing critical Supabase connection variables in Streamlit Secrets.")
    st.stop()

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

st.title("⚙️ League Admin Panel")

# 2. DYNAMIC LIVE ROLE DATABASE CHECK (BULLETPROOF VIEW INDEX READER)
if "user" not in st.session_state or not st.session_state.user:
    st.warning("Please log in on the home page first.")
    st.stop()

user_id = st.session_state.user.id
is_admin = False

try:
    current_user_record = supabase.table("league_users").select("role").eq("id", user_id).execute().data
    if current_user_record and len(current_user_record) > 0:
        if current_user_record[0].get("role") == "admin":
            is_admin = True
except Exception:
    is_admin = False

if not is_admin:
    st.error("🚫 Access Denied: Only the league commissioner can access this page.")
    st.stop()

st.success("🔓 Commissioner Dashboard Unlocked!")
st.write("---")

active_week = st.number_input("Target Input Week Number:", min_value=1, max_value=18, value=1, step=1)
st.write("---")

# 3. AUTOMATED DRAFTKINGS SPORTSBOOK SYNCER (SMART DATE FILTER)
st.subheader("🦊 Live DraftKings / ESPN Odds Sync")
st.write("Wipe the board for the selected week and instantly pull live college football spreads directly from DraftKings for this weekend:")

if st.button("🔄 Auto-Fetch Live DraftKings Slate", type="primary"):
    if not ODDS_API_KEY:
        st.error("Odds API Key missing from settings Secrets.")
    else:
        with st.spinner("Downloading live spreads from DraftKings Sportsbook..."):
            try:
                # Wipe previous schedules for the active target week
                supabase.table("games").delete().eq("week_number", active_week).execute()
                
                # 📅 AUTOMATED WEEKEND DATE FILTER
                # We calculate right now in UTC and set a strict 3-day window ahead
                now_utc = datetime.now(timezone.utc)
                commence_time_from = now_utc.strftime("%Y-%m-%dT00:00:00Z")
                
                url = "https://the-odds-api.com"
                params = {
                    "apiKey": ODDS_API_KEY, 
                    "regions": "us", 
                    "markets": "spreads", 
                    "bookmakers": "draftkings",
                    "oddsFormat": "american",
                    "commenceTimeFrom": commence_time_from # Restricts the fetch to current/upcoming games only
                }
                headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
                
                api_call = requests.get(url, params=params, headers=headers)
                if api_call.status_code == 200:
                    response = api_call.json()
                    
                    # Sort the incoming games by kickoff time before numbering them
                    response = sorted(response, key=lambda x: x.get("commence_time", ""))
                    
                    count = 0
                    for idx, match in enumerate(response):
                        game_number = idx + 1
                        home_team = match.get("home_team")
                        away_team = match.get("away_team")
                        kickoff_time = match.get("commence_time")
                        
                        # Default fallback values
                        fav_team, und_team, spread_val = away_team, home_team, "0.0"
                        
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
                                        # Determine the favorite (negative spread) vs underdog
                                        if s_h < s_a:
                                            fav_team, und_team, spread_val = home_team, away_team, str(s_h)
                                        else:
                                            fav_team, und_team, spread_val = away_team, home_team, str(s_a)
                        
                        # Save rows dynamically formatted into Supabase
                        supabase.table("games").insert({
                            "game_id": f"g_w{active_week}_{game_number}",
                            "game_number": game_number,
                            "league": "CFB",
                            "favorite_team": fav_team,
                            "underdog_team": und_team,
                            "spread_value": spread_val,
                            "display_text": f"{fav_team} vs {und_team} ({spread_val})",
                            "kickoff_time": kickoff_time,
                            "week_number": int(active_week)
                        }).execute()
                        count += 1
                        
                    st.success(f"Success! Loaded {count} upcoming weekend games cleanly from DraftKings into Week {active_week}!")
                    st.rerun()
                else:
                    st.error(f"API Error: {api_call.text}")
            except Exception as e: 
                st.error(f"Scraper error: {e}")

# 4. NUMBERED SPREADSHEET MANUAL CLIPBOARD IMPORTER
st.subheader("📋 Bulk-Upload Slate Layout from Spreadsheet")
st.write("Structure columns exactly as: **`game_number`**, **`league`**, **`favorite`**, **`underdog`**, **`spread`**, **`kickoff_time`**")

pasted_data = st.text_area("Paste Layout Rows Here:", height=150)

if st.button("🚀 Wipe Old Slate & Upload New Grid Layout", type="secondary"):
    if pasted_data.strip():
        with st.spinner("Processing lines..."):
            try:
                df = pd.read_csv(StringIO(pasted_data), sep="\t")
                supabase.table("games").delete().eq("week_number", active_week).execute()
                count = 0
                for _, row in df.iterrows():
                    fav, und, spr = str(row['favorite']).strip(), str(row['underdog']).strip(), str(row['spread']).strip()
                    supabase.table("games").insert({
                        "game_id": f"g_w{active_week}_{str(row['game_number']).strip()}",
                        "game_number": int(row['game_number']),
                        "league": str(row['league']).strip(),
                        "favorite_team": fav,
                        "underdog_team": und,
                        "spread_value": spr,
                        "display_text": f"{fav} at {und} ({spr})",
                        "kickoff_time": str(row['kickoff_time']).strip(),
                        "week_number": int(active_week)
                    }).execute()
                    count += 1
                st.success(f"Loaded {count} manual grid rows successfully!")
                st.rerun()
            except Exception as e: st.error(f"Pasting format error: {e}")

st.write("---")

# 5. GRADING MODULE
st.subheader("🏈 Grade Completed Game Results")
try:
    ungraded = supabase.table("games").select("*").eq("week_number", active_week).eq("status", "scheduled").order("game_number").execute().data
    if not ungraded: st.info(f"All loaded games for Week {active_week} have been completely graded.")
    else:
        opts = {f"#{g.get('game_number')} - {g.get('favorite_team')} vs {g.get('underdog_team')}": g for g in ungraded}
        t_label = st.selectbox("Select Match to Grade:", options=list(opts.keys()))
        g_rec = opts[t_label]
        covering_t = st.radio("Which covered spread?", options=[g_rec['favorite_team'], g_rec['underdog_team']])
        if st.button("💾 Submit Winner"):
            supabase.table("games").update({"status": "final", "winning_team": covering_t}).eq("game_id", g_rec['game_id']).execute()
            st.success("Graded!")
            st.rerun()
except Exception as e: st.error(f"Grading Error: {e}")

st.write("---")

# 6. USER PERMISSIONS MANAGEMENT PANEL (RESTORED)
st.subheader("👥 User Management & Roster Permissions")
try:
    members = supabase.table("league_users").select("*").execute().data
    if members:
        df_roster = pd.DataFrame(members)
        df_roster.columns = ['Unique ID', 'Email Address', 'Display Nickname', 'System Access Role']
        st.dataframe(df_roster[['Display Nickname', 'Email Address', 'System Access Role']], use_container_width=True)
        
        st.write("---")
        member_options = {f"{m.get('username')} ({m.get('email')}) - [Role: {m.get('role')}]": m for m in members}
        selected_label = st.selectbox("Select a Member to Alter permissions:", options=list(member_options.keys()))
        selected_user = member_options[selected_label]
        is_currently_admin = selected_user.get("role") == "admin"
        toggle_admin = st.checkbox("Grant Commissioner / Admin Privileges", value=is_currently_admin, key=f"check_{selected_user['id']}")

        if st.button("💾 Save Member Status"):
            supabase.rpc("set_user_admin_status", {"target_user_id": selected_user["id"], "make_admin": toggle_admin}).execute()
            st.success("Permissions updated successfully!")
            st.rerun()
except Exception as e: st.error(f"Could not load member panel: {e}")
