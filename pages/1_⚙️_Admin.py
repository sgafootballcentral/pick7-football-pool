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

# 2. DYNAMIC LIVE ROLE DATABASE CHECK
if "user" not in st.session_state or not st.session_state.user:
    st.warning("Please log in on the home page first.")
    st.stop()

user_id = st.session_state.user.id

try:
    current_user_record = supabase.table("league_users").select("role").eq("id", user_id).execute().data
    # Check if any matching rows were returned and verify the role string value safely
    if current_user_record and current_user_record[0].get("role") == "admin":
        is_admin = True
    else:
        is_admin = False
except Exception:
    is_admin = False

if not is_admin:
    st.error("🚫 Access Denied: Only the league commissioner can access this page.")
    st.stop()

st.success("🔓 Commissioner Dashboard Unlocked! (Live Database Admin Token Verified)")
st.write("---")

# 3. SET THE TARGET WEEK DYNAMICALLY
st.subheader("🗓️ Slate Management Settings")
active_week = st.number_input("Target Input Week Number:", min_value=1, max_value=18, value=1, step=1)
st.write("---")

# 4. AUTOMATED DRAFTKINGS SPORTSBOOK SYNCER
st.subheader("🦊 Live DraftKings / ESPN Odds Sync")
st.write("Clicking below will clear the board for the selected week and instantly pull down the live college football spreads directly from DraftKings:")

if st.button("🔄 Auto-Fetch Live DraftKings Slate", type="primary"):
    if not ODDS_API_KEY:
        st.error("Odds API Key missing from settings Secrets.")
    else:
        with st.spinner("Downloading live spreads from DraftKings Sportsbook..."):
            try:
                # Wipe previous schedules for the active target week
                supabase.table("games").delete().eq("week_number", active_week).execute()
                
                # Official endpoint path using the updated NCAA FBS league code identifier
                url = "https://the-odds-api.com"
                params = {
                    "apiKey": ODDS_API_KEY, 
                    "regions": "us", 
                    "markets": "spreads", 
                    "bookmakers": "draftkings", # Hard-locked to extract DraftKings Sportsbook data directly
                    "oddsFormat": "american"
                }
                headers = {"User-Agent": "Mozilla/5.0"}
                
                api_call = requests.get(url, params=params, headers=headers)
                if api_call.status_code != 200:
                    st.error(f"API Error {api_call.status_code}: {api_call.text}")
                    st.stop()
                    
                response = api_call.json()
                count = 0
                for match in response:
                    game_id = match.get("id")
                    home_team = match.get("home_team")
                    away_team = match.get("away_team")
                    kickoff_time = match.get("commence_time")
                    display_text = f"{away_team} at {home_team}"
                    
                    # Target and unpack the specific DraftKings outcome arrays safely
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
                    
                    supabase.table("games").insert({
                        "game_id": game_id, 
                        "league": "CFB", 
                        "display_text": display_text, 
                        "kickoff_time": kickoff_time,
                        "week_number": int(active_week)
                    }).execute()
                    count += 1
                    
                st.success(f"Success! Loaded {count} college football games cleanly from DraftKings into Week {active_week}!")
                st.rerun()
            except Exception as e:
                st.error(f"Failed to load slate: {e}")

st.write("---")

# 5. EXCEL / SHEET CLIPBOARD BACKUP FALLBACK BOX
st.subheader("📋 Manual Bulk-Upload Spreadsheet Fallback")
st.write("If you ever want to write your own custom games or force custom point lines, paste them manually below:")
pasted_data = st.text_area("Paste Rows Here:", height=100)

if st.button("🚀 Upload Manual Paste Sheet"):
    if pasted_data.strip():
        try:
            df = pd.read_csv(StringIO(pasted_data), sep="\t")
            supabase.table("games").delete().eq("week_number", active_week).execute()
            count = 0
            for _, row in df.iterrows():
                supabase.table("games").insert({
                    "game_id": str(row['game_id']).strip(),
                    "league": str(row['league']).strip(),
                    "display_text": str(row['display_text']).strip(),
                    "kickoff_time": str(row['kickoff_time']).strip(),
                    "week_number": int(active_week)
                }).execute()
                count += 1
            st.success(f"Manually loaded {count} games for Week {active_week}!")
            st.rerun()
        except Exception as e: st.error(f"Error: {e}")

st.write("---")

# 6. ADMINISTRATIVE GAME GRADING SYSTEM
st.subheader("🏈 Grade Completed Game Results")
try:
    ungraded = supabase.table("games").select("game_id", "display_text").eq("week_number", active_week).eq("status", "scheduled").execute().data
    if not ungraded:
        st.info(f"All loaded games for Week {active_week} have been completely graded.")
    else:
        target_game = st.selectbox("Select Game to Grade:", options=[g['display_text'] for g in ungraded])
        game_record = next(g for g in ungraded if g['display_text'] == target_game)
        
        if " at " in target_game: 
            teams = target_game.split(" at ")
        elif " vs " in target_game: 
            teams = target_game.split(" vs ")
        else: 
            teams = [target_game, "Home Team"]

        team_a = teams[0].split(" (")[0].strip()
        team_b = teams[1].split(" (")[0].strip() if len(teams) > 1 else "Home Team"
        covering_team = st.radio("Which team covered the spread?", options=[team_a, team_b])
        
        if st.button("💾 Submit Final Score & Grade Picks"):
            supabase.table("games").update({"status": "final", "winning_team": covering_team}).eq("game_id", game_record['game_id']).execute()
            st.success(f"Graded! {covering_team} marked as winner.")
            st.rerun()
except Exception as e: st.error(f"Grading Panel Error: {e}")

st.write("---")

# 7. USER PERMISSIONS MANAGEMENT PANEL
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
            st.success("Permissions updated!")
            st.rerun()
except Exception as e: st.error(f"Could not load member panel: {e}")
