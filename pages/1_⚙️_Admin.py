import streamlit as st
import pandas as pd
from io import StringIO
from supabase import create_client, Client

# 1. Connection and Secrets Verification
SUPABASE_URL = st.secrets.get("SUPABASE_URL")
SUPABASE_KEY = st.secrets.get("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    st.error("Missing critical Supabase connection variables in Streamlit Secrets.")
    st.stop()

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

st.title("⚙️ League Admin Panel")

# 2. DYNAMIC LIVE ROLE DATABASE CHECK (FIXED LIST READER)
if "user" not in st.session_state or not st.session_state.user:
    st.warning("Please log in on the home page first.")
    st.stop()

user_id = st.session_state.user.id
is_admin = False

try:
    # Query your live database view to find your true role bypassing cookie lag
    current_user_record = supabase.table("league_users").select("role").eq("id", user_id).execute().data
    
    # Corrected row array indexing check
    if current_user_record and len(current_user_record) > 0:
        if current_user_record[0].get("role") == "admin":
            is_admin = True
except Exception as e:
    is_admin = False

if not is_admin:
    st.error("🚫 Access Denied: Only the league commissioner can access this page.")
    st.stop()

st.success("🔓 Commissioner Dashboard Unlocked!")
st.write("---")

active_week = st.number_input("Target Input Week Number:", min_value=1, max_value=18, value=1, step=1)
st.write("---")

# 3. ADVANCED NUMBERED CLIPBOARD IMPORTER
st.subheader("📋 Bulk-Upload Slate Layout from Spreadsheet")
st.write("In Excel or Google Sheets, structure columns exactly as: **`game_number`**, **`league`**, **`favorite`**, **`underdog`**, **`spread`**, **`kickoff_time`**")

pasted_data = st.text_area("Paste Layout Rows Here:", height=200, placeholder="game_number\tleague\tfavorite\tunderdog\tspread\tkickoff_time\n1\tCFB\tWest Virginia\tCoastal Carolina\t-20.5\t2026-09-05T16:00:00Z")

if st.button("🚀 Wipe Old Slate & Upload New Grid Layout", type="primary"):
    if not pasted_data.strip():
        st.error("Box is empty.")
    else:
        with st.spinner("Processing lines..."):
            try:
                df = pd.read_csv(StringIO(pasted_data), sep="\t")
                required = ['game_number', 'league', 'favorite', 'underdog', 'spread', 'kickoff_time']
                if not all(col in df.columns for col in required):
                    st.error("Data error! Headers must be labeled exactly: game_number, league, favorite, underdog, spread, kickoff_time")
                    st.stop()
                
                supabase.table("games").delete().eq("week_number", active_week).execute()
                
                count = 0
                for _, row in df.iterrows():
                    fav = str(row['favorite']).strip()
                    und = str(row['underdog']).strip()
                    spr = str(row['spread']).strip()
                    
                    display_text = f"{fav} at {und} ({spr})"
                    
                    supabase.table("games").insert({
                        "game_id": f"g_w{active_week}_{str(row['game_number']).strip()}",
                        "game_number": int(row['game_number']),
                        "league": str(row['league']).strip(),
                        "favorite_team": fav,
                        "underdog_team": und,
                        "spread_value": spr,
                        "display_text": display_text,
                        "kickoff_time": str(row['kickoff_time']).strip(),
                        "week_number": int(active_week)
                    }).execute()
                    count += 1
                st.success(f"Loaded {count} layout grid rows successfully!")
            except Exception as e: st.error(f"Failed to read paste format layout: {e}")

st.write("---")

# 4. GRADING MODULE
st.subheader("🏈 Grade Completed Game Results")
try:
    ungraded = supabase.table("games").select("*").eq("week_number", active_week).eq("status", "scheduled").order("game_number").execute().data
    if not ungraded: st.info("All games graded.")
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
