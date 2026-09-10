import streamlit as st
import pandas as pd
import io
from supabase import create_client, Client
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, PatternFill
from openpyxl.utils import get_column_letter

SUPABASE_URL = st.secrets.get("SUPABASE_URL")
SUPABASE_KEY = st.secrets.get("SUPABASE_KEY")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

if st.session_state.get("access_token"):
    try:
        supabase.auth.set_session(st.session_state.access_token, st.session_state.refresh_token)
    except Exception:
        pass

is_admin = False
if st.session_state.get("user"):
    try:
        role_resp = supabase.table("league_users").select("role").eq("id", st.session_state.user.id).execute()
        if role_resp.data and role_resp.data[0].get("role") == "admin":
            is_admin = True
    except Exception:
        pass

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

            # Rank by total WINS (not win %) -- someone who skips a week shouldn't
            # rank higher just for having fewer picks. Ties share the same place,
            # same as "1-2-2-4" scoring: method="min" matches Excel's RANK().
            standings["Place"] = standings["Wins"].rank(method="min", ascending=False).astype(int)
            standings = standings.sort_values(["Wins", "Losses"], ascending=[False, True]).reset_index(drop=True)

            medals = {1: "🥇", 2: "🥈", 3: "🥉"}
            standings["Rank"] = standings["Place"].map(lambda p: medals.get(p, str(p)))
            standings = standings.rename(columns={"username": "Player"})
            display_standings = standings[["Rank", "Player", "Wins", "Losses", "Win %"]]

            st.subheader("🔥 Current Standings")
            st.dataframe(display_standings, use_container_width=True, hide_index=True)

            if is_admin:
                players_rows = supabase.table("players").select("username, paid").execute().data
                paid_by_username = {p["username"]: bool(p.get("paid")) for p in players_rows}

                def build_leaderboard_workbook(standings_df):
                    wb = Workbook()
                    ws = wb.active
                    ws.title = "Season Standings"
                    headers = ["Player", "Wins", "Losses", "Rank", "Paid"]
                    ws.append(headers)
                    for col_idx in range(1, len(headers) + 1):
                        cell = ws.cell(row=1, column=col_idx)
                        cell.font = Font(name="Arial", bold=True, color="FFFFFF")
                        cell.fill = PatternFill(start_color="1F4E78", end_color="1F4E78", fill_type="solid")
                        cell.alignment = Alignment(horizontal="center")

                    medal_colors = {1: "FFD700", 2: "C0C0C0", 3: "CD7F32"}

                    for _, row in standings_df.iterrows():
                        paid = paid_by_username.get(row["Player"], False)
                        ws.append([row["Player"], int(row["Wins"]), int(row["Losses"]), row["Rank"], "Yes" if paid else "No"])
                        r_idx = ws.max_row
                        name_cell = ws.cell(row=r_idx, column=1)
                        name_cell.font = Font(name="Arial", bold=True)
                        paid_color = "FF00B050" if paid else "FFFF0000"
                        name_cell.fill = PatternFill(start_color=paid_color, end_color=paid_color, fill_type="solid")
                        for col_idx in (2, 3, 4, 5):
                            ws.cell(row=r_idx, column=col_idx).font = Font(name="Arial")

                        if int(row["Place"]) in medal_colors:
                            rank_cell = ws.cell(row=r_idx, column=4)
                            rank_cell.font = Font(name="Arial", bold=True)
                            rank_color = medal_colors[int(row["Place"])]
                            rank_cell.fill = PatternFill(start_color=rank_color, end_color=rank_color, fill_type="solid")

                    for col_idx, header in enumerate(headers, start=1):
                        col_letter = get_column_letter(col_idx)
                        longest = max(
                            [len(str(header))] +
                            [len(str(ws.cell(row=r, column=col_idx).value or "")) for r in range(2, ws.max_row + 1)]
                        )
                        ws.column_dimensions[col_letter].width = min(longest + 3, 22)
                    ws.freeze_panes = "A2"

                    buffer = io.BytesIO()
                    wb.save(buffer)
                    buffer.seek(0)
                    return buffer

                leaderboard_buffer = build_leaderboard_workbook(standings)
                st.download_button(
                    "⬇️ Export Leaderboard (.xlsx)",
                    data=leaderboard_buffer,
                    file_name="season_leaderboard.xlsx",
                    mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )

except Exception as e:
    st.error(f"Error building standings board: {e}")
