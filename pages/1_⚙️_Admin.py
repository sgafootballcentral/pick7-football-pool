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

# 2. SECURE METADATA ROLE CHECK
if "user" not in st.session_state or not st.session_state.user:
    st.warning("Please log in on the home page first.")
    st.stop()

user_role = st.session_state.user.app_metadata.get("role")

if user_role != "admin":
    st.error("🚫 Access Denied: Only the league commissioner can access this page.")
    st.stop()

st.success(f"🔓 Commissioner Dashboard Unlocked! (Role: {user_role})")
st.write("---")

# 3. SET THE TARGET WEEK DYNAMICALLY
st.subheader("🗓️ Slate Management Settings")
active_week = st.number_input("Target Input Week Number:", min_value=1, max_value=18, value=1, step=1)
st.write("---")

# 4. EXCEL BULK UPLOADER
st.subheader("📋 Bulk-Upload Slate from Excel")
st.write("In Excel, select all your rows (including headers), **Copy (Ctrl+C)** them, and **Paste (Ctrl+V)** them into the box below:")

pasted_data = st.text_area("Paste Excel Rows Here:", height=150, placeholder="game_id\tleague\tdisplay_text\tkickoff_time\ncfb_01\tCFB\tClemson (+10) at LSU (-10)\t2026-09-05T19:30:00Z")

if st.button("🚀 Upload New Slate for Selected Week", type="primary"):
    if not pasted_data.strip():
        st.error("The input box is empty. Please paste your Excel rows first.")
    else:
        with st.spinner("Processing lines and building your board..."):
            try:
                # Parse Excel clipboard text layout structure cleanly into rows
                df = pd.read_csv(StringIO(pasted_data), sep="\t")
                
                # Check for correctly spelled grid headers
                required = ['game_id', 'league', 'display_text', 'kickoff_time']
                if not all(col in df.columns for col in required):
                    st.error("Data error! Your Excel headers must be labeled exactly: game_id, league, display_text, kickoff_time")
                    st.stop()
                
                # Clear only the games belonging to the specific week you are replacing
                supabase.table("games").delete().eq("week_number", active_week).execute()
                
                # Stream data rows right into Supabase
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
                    
                st.success(f"Boom! {count} games have been successfully loaded for Week {active_week}!")
            except Exception as e:
                st.error(f"Failed to read paste format layout: {e}")

st.write("---")

# 5. ADMINISTRATIVE GAME GRADING SYSTEM
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
        team_b = teams[1].split(" (")[0].strip() if len(teams) > 1 else "Home Team"
        
        covering_team = st.radio("Which team covered the spread?", options=[team_a, team_b])
        
        if st.button("💾 Submit Final Score & Grade Picks"):
            supabase.table("games").update({"status": "final", "winning_team": covering_team}).eq("game_id", game_record['game_id']).execute()
            st.success(f"Graded! {covering_team} marked as the winner against the spread. Standings updated!")
            st.rerun()
except Exception as e: 
    st.error(f"Grading Panel Error: {e}")

st.write("---")

# 6. USER PERMISSIONS MANAGEMENT PANEL
st.subheader("👥 League Administrator Permissions")
st.write("Promote a league member to co-commissioner or revoke their admin rights:")

try:
    # Fetch all members from your database view
    members = supabase.table("league_users").select("*").execute().data

    if not members:
        st.info("No active users found in database profiles.")
    else:
        # Create user selection mapping: "Nickname (email) [Current Role]" -> record
        member_options = {
            f"{m.get('username') or 'No Name'} ({m.get('email')}) - [Role: {m.get('role')}]": m 
            for m in members
        }

        selected_label = st.selectbox("Select a League Member:", options=list(member_options.keys()))
        selected_user = member_options[selected_label]

        # Checkbox that mirrors their current admin status
        is_currently_admin = selected_user.get("role") == "admin"
        toggle_admin = st.checkbox("Grant Commissioner / Admin Privileges", value=is_currently_admin)

        # Save button to execute the database RPC function
        if st.button("💾 Update Member Permissions"):
            supabase.rpc(
                "set_user_admin_status",
                {"target_user_id": selected_user["id"], "make_admin": toggle_admin}
            ).execute()

            status_text = "promoted to Admin" if toggle_admin else "demoted to Member"
            st.success(f"Permissions updated! {selected_user.get('email')} is now {status_text}.")
            st.rerun()
except Exception as e:
    st.error(f"Could not load member permissions tool: {e}. Ensure you ran Step 1 SQL functions.")
