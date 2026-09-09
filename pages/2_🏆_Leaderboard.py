import streamlit as st
import pandas as pd
from supabase import create_client, Client

SUPABASE_URL = st.secrets.get("SUPABASE_URL")
SUPABASE_KEY = st.secrets.get("SUPABASE_KEY")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

st.title("🏆 League Standings & Leaderboard")
st.write("Running tab of each participant's record week over week.")

try:
    # Pull every pick's graded result -- this is now written directly onto each pick
    # by the Admin "Grade Finished Games" step, using the spread that pick actually
    # locked in, so it stays correct even if a week's games get re-synced later.
    picks_data = supabase.table("picks").select("username, result").execute().data

    if not picks_data:
        st.info("No player picks have been submitted yet in this league.")
    else:
        df_picks = pd.DataFrame(picks_data)
        df_graded = df_picks[df_picks["result"].isin(["win", "loss"])]

        if df_graded.empty:
            st.info("🏈 Total standings will update here as soon as the commissioner grades completed games.")
            st.subheader("Active League Roster")
            st.dataframe(df_picks[["username"]].drop_duplicates().reset_index(drop=True), use_container_width=True)
        else:
            standings = df_graded.groupby("username")["result"].agg(
                Wins=lambda r: (r == "win").sum(),
                Losses=lambda r: (r == "loss").sum(),
            ).reset_index()
            standings["Win %"] = (standings["Wins"] / (standings["Wins"] + standings["Losses"])).round(3)
            standings = standings.sort_values(["Win %", "Wins"], ascending=False).reset_index(drop=True)
            standings.index = standings.index + 1

            medals = {1: "🥇", 2: "🥈", 3: "🥉"}
            standings.insert(0, "Rank", [medals.get(i, str(i)) for i in standings.index])
            standings = standings.rename(columns={"username": "Player"})

            st.subheader("🔥 Current Standings")
            st.dataframe(standings, use_container_width=True, hide_index=True)

except Exception as e:
    st.error(f"Error building standings board: {e}")
