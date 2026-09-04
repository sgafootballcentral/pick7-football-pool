import streamlit as st
import pandas as pd
from supabase import create_client, Client

SUPABASE_URL = st.secrets.get("SUPABASE_URL")
SUPABASE_KEY = st.secrets.get("SUPABASE_KEY")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

st.title("🏆 League Standings & Leaderboard")
st.write("Running tab of each participant's record week over week.")

try:
    # 1. Gather all historical picks and all completed game grading attributes
    picks_data = supabase.table("picks").select("username, week_number, game_id, selected_team").execute().data
    games_data = supabase.table("games").select("game_id, week_number, display_text, winning_team").eq("status", "final").execute().data
    
    if not picks_data:
        st.info("No player picks have been submitted yet in this league.")
    else:
        df_picks = pd.DataFrame(picks_data)
        
        if not games_data:
            st.info("🏈 Total standings will update here as soon as the commissioner grades completed games.")
            # Display a basic roster of active players if no games are graded yet
            st.subheader("Active League Roster")
            st.dataframe(df_picks[['username']].drop_duplicates().reset_index(drop=True))
        else:
            df_games = pd.DataFrame(games_data)
            
            # 2. Compute correct picks by mapping individual choices to the team that covered
            grading_map = dict(zip(df_games['game_id'], df_games['winning_team']))
            df_picks['winning_team'] = df_picks['game_id'].map(grading_map)
            df_picks['is_correct'] = df_picks['selected_team'] == df_picks['winning_team']
            
            # 3. Calculate running win subtotals grouped by player nickname
            standings = df_picks.groupby('username')['is_correct'].sum().reset_index()
            standings.columns = ['Player Nickname', 'Total Wins']
            standings = standings.sort_values(by='Total Wins', ascending=False).reset_index(drop=True)
            
            # Display leaderboard data grid
            st.subheader("🔥 Current Standings")
            st.dataframe(standings, use_container_width=True)
            
except Exception as e:
    st.error(f"Error building standings board: {e}")
