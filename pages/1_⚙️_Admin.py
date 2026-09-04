import streamlit as st
import pandas as pd
from io import StringIO
from supabase import create_client, Client

SUPABASE_URL = st.secrets.get("SUPABASE_URL")
SUPABASE_KEY = st.secrets.get("SUPABASE_KEY")
ADMIN_EMAIL = st.secrets.get("ADMIN_EMAIL")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

st.title("⚙️ League Admin Panel")

if "user" not in st.session_state or not st.session_state.user or st.session_state.user.email != ADMIN_EMAIL:
    st.error("🚫 Access Denied.")
    st.stop()

# 1. SET THE TARGET WEEK DYNAMICALLY
st.subheader("🗓️ Slate Management Settings")
active_week = st.number_input("Target Input Week Number:", min_value=1, max_value=18, value=1, step=1)
st.write("---")

st.subheader("📋 Bulk-Upload Slate from Excel")
pasted_data = st.text_area("Paste Excel Rows Here:", height=150)

if st.button("🚀 Upload New Slate for Selected Week", type="primary"):
    if pasted_data.strip():
        try:
            df = pd.read_csv(StringIO(pasted_data), sep="\t")
            # Clear only the games belonging to the specific week you are replacing
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
            st.success(f"Successfully loaded {count} games for Week {active_week}!")
        except Exception as e: st.error(f"Error: {e}")

st.write("---")
# 2. EASY ADMINISTRATIVE GAME GRADING SYSTEM
st.subheader("🏈 Grade Completed Game Results")
try:
    ungraded = supabase.table("games").select("game_id", "display_text").eq("week_number", active_week).eq("status", "scheduled").execute().data
    if not ungraded:
        st.info(f"All loaded games for Week {active_week} have been completely graded.")
    else:
        target_game = st.selectbox("Select Game to Grade:", options=[g['display_text'] for g in ungraded])
        game_record = next(g for g in ungraded if g['display_text'] == target_game)
        
        # Parse the team choices out of the display text layout string
        teams = target_game.split(" at ") if " at " in target_game else target_game.split(" vs ")
        team_a = teams[0].split(" (")[0].strip()
        team_b = teams[1].split(" (")[0].strip() if len(teams) > 1 else "Home"
        
        covering_team = st.radio("Which team covered the spread?", options=[team_a, team_b])
        
        if st.button("💾 Submit Final Score & Grade Picks"):
            supabase.table("games").update({"status": "final", "winning_team": covering_team}).eq("game_id", game_record['game_id']).execute()
            st.success(f"Graded! {covering_team} marked as the winner against the spread. Standings updated!")
            st.rerun()
except Exception as e: st.error(f"Grading Panel Error: {e}")
