import streamlit as st
import requests
import pandas as pd
import time as time_module
import io
from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo
from supabase import create_client, Client
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, PatternFill
from openpyxl.utils import get_column_letter

# 1. Connection and Secrets Verification
SUPABASE_URL = st.secrets.get("SUPABASE_URL")
SUPABASE_KEY = st.secrets.get("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    st.error("Missing critical Supabase connection variables in Streamlit Secrets.")
    st.stop()

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

st.title("⚙️ League Admin Panel")


def nudge_off_whole_number(odds_string: str) -> str:
    """'PHI -6' -> 'PHI -5.5' -- shifts a whole-number spread half a point toward
    zero so a final margin can never land exactly on the spread (no pushes)."""
    if not odds_string or odds_string == "0.0" or " " not in odds_string:
        return odds_string
    team_abbr, number_str = odds_string.rsplit(" ", 1)
    try:
        value = float(number_str)
    except ValueError:
        return odds_string
    if value != 0 and value == int(value):
        value += 0.5 if value < 0 else -0.5
    return f"{team_abbr} {value:.1f}"


@st.dialog("⚠️ Confirm Removal")
def confirm_removal(info):
    st.write(f"Remove **{info['player']}**'s picks for **Week {info['week']}**? This cannot be undone.")

    col_yes, col_no = st.columns(2)
    with col_yes:
        remove_clicked = st.button("Yes, remove", type="primary", use_container_width=True)
    with col_no:
        cancel_clicked = st.button("Cancel", use_container_width=True)

    if remove_clicked:
        if not info.get("user_id"):
            st.error("Couldn't find that player's user ID -- nothing was removed.")
        else:
            try:
                supabase.table("picks").delete().eq("user_id", info["user_id"]).eq("week_number", info["week"]).execute()
                st.session_state.pending_removal = None
                st.rerun()
            except Exception as e:
                st.error(f"Database error: {e}")
    elif cancel_clicked:
        st.session_state.pending_removal = None
        st.rerun()

# 2. USER ACCESSIBILITY ROLE DATABASE CHECK
if "user" not in st.session_state or not st.session_state.user:
    st.warning("Please log in on the home page first.")
    st.stop()

if st.session_state.get("access_token"):
    try:
        supabase.auth.set_session(st.session_state.access_token, st.session_state.refresh_token)
    except Exception:
        st.session_state.user = None
        st.session_state.access_token = None
        st.warning("Your session expired -- please log in again on the home page.")
        st.stop()

user_id = st.session_state.user.id
is_admin = False

try:
    response = supabase.table("league_users").select("role").eq("id", user_id).execute()
    current_user_records = response.data
    if current_user_records and len(current_user_records) > 0:
        if current_user_records[0].get("role") == "admin":
            is_admin = True
except Exception as e:
    st.error(f"Database security check failed: {e}")
    is_admin = False

if not is_admin:
    st.error("🚫 Access Denied. Your profile role must be set to 'admin' in your database.")
    st.stop()

st.success("🔓 Commissioner Dashboard Unlocked!")
active_week = st.number_input("Target Grouping Week Number (For Player Submissions):", min_value=1, max_value=18, value=1, step=1)

# 📅 3. CALENDAR DATE SELECTOR
st.subheader("📆 Select Custom Game Extraction Windows")
selected_range = st.date_input(
    "Select Date Boundaries:",
    value=(datetime.today().date(), datetime.today().date()),
    help="Choose two specific calendar dates to set your pool window."
)

st.write("---")

# 4. CHRONOLOGICAL DATE-DRIVEN AUTOMATED SYNCER
def run_espn_sync(target_week: int, start_date, end_date):
    start_utc_str = datetime.combine(start_date, time.min).replace(tzinfo=timezone.utc).strftime("%Y%m%d")
    end_utc_str = datetime.combine(end_date, time.max).replace(tzinfo=timezone.utc).strftime("%Y%m%d")

    with st.spinner(f"Downloading game schedules from {start_date} to {end_date}..."):
        try:
            # Wipe previous entries for the selected grouping week to avoid duplication
            supabase.table("games").delete().eq("week_number", target_week).execute()

            date_range = f"{start_utc_str}-{end_utc_str}"
            leagues_to_fetch = [
                {
                    "name": "NFL",
                    "url": "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
                    "params": {"limit": 1000, "dates": date_range},
                },
                {
                    "name": "CFB",
                    "url": "https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard",
                    "params": {"limit": 1000, "groups": 80, "dates": date_range},
                },
            ]

            total_games_inserted = 0
            skipped_no_line = 0
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://www.espn.com/",
                "Accept": "application/json",
            }

            for target_league in leagues_to_fetch:
                api_call = requests.get(target_league["url"], params=target_league["params"], headers=headers, timeout=15)
                if api_call.status_code != 200:
                    st.warning(f"{target_league['name']} request failed: HTTP {api_call.status_code}")
                    continue
                time_module.sleep(2)  # ESPN's hidden API has been rate-limiting back-to-back requests

                response_data = api_call.json()

                for event in response_data.get("events", []):
                    game_id = event.get("id")
                    kickoff_time = event.get("date")

                    # Target index array zero nodes safely
                    competitions = event.get("competitions", [{}])[0]
                    competitors = competitions.get("competitors", [])

                    # FIX: Safely read list array nodes for opening Vegas spreads
                    odds_array = competitions.get("odds", [])
                    has_line = bool(odds_array) and isinstance(odds_array, list)

                    home_node = next((c for c in competitors if c.get("homeAway") == "home"), competitors[0])
                    away_node = next((c for c in competitors if c.get("homeAway") == "away"), competitors[1])

                    home_team = home_node.get("team", {}).get("displayName", "Home Team")
                    away_team = away_node.get("team", {}).get("displayName", "Away Team")
                    home_abbr = home_node.get("team", {}).get("abbreviation", "").strip().upper()

                    broadcasts = competitions.get("broadcasts") or event.get("broadcasts") or []
                    tv_names = broadcasts[0].get("names", []) if broadcasts and isinstance(broadcasts, list) else []
                    tv_network = ", ".join(tv_names)

                    if not has_line:
                        skipped_no_line += 1
                        continue  # no book has posted a spread for this one -- leave it out of the pool

                    odds_string = odds_array[0].get("details", "0.0")

                    fav_team, und_team = away_team, home_team
                    fav_home, und_home = False, True

                    if odds_string != "0.0" and " " in odds_string:
                        line_parts = odds_string.split(" ")
                        fav_abbr_extracted = line_parts[0].strip().upper()

                        if fav_abbr_extracted == home_abbr:
                            fav_team, und_team = home_team, away_team
                            fav_home, und_home = True, False

                    # A genuine POSTED pick'em (0-point) line -- keep the game, just default
                    # the home team to -0.5 so it can't push.
                    spread_is_zero = True
                    if odds_string != "0.0" and " " in odds_string:
                        try:
                            spread_is_zero = float(odds_string.rsplit(" ", 1)[1]) == 0
                        except ValueError:
                            spread_is_zero = True
                    if spread_is_zero:
                        fav_team, und_team = home_team, away_team
                        fav_home, und_home = True, False
                        odds_string = f"{home_abbr} -0.5"

                    total_games_inserted += 1

                    # Save clean rows straight to your Supabase tables
                    supabase.table("games").insert({
                        "game_id": f"espn_{game_id}",
                        "game_number": total_games_inserted,
                        "league": target_league["name"],
                        "favorite_team": fav_team,
                        "underdog_team": und_team,
                        "favorite_team_home": fav_home,
                        "underdog_team_home": und_home,
                        "spread_value": nudge_off_whole_number(odds_string),
                        "display_text": f"{away_team} at {home_team}",
                        "kickoff_time": kickoff_time,
                        "tv_network": tv_network,
                        "week_number": target_week
                    }).execute()

            st.success(
                f"Success! Pulled {total_games_inserted} games with a posted line "
                f"(skipped {skipped_no_line} with no spread) from {start_date} to {end_date} into Week {target_week}!"
            )
            st.session_state.pending_refetch = None
            st.rerun()
        except Exception as e:
            st.error(f"ESPN Date Sync Failed: {e}")


if st.button("🔄 Auto-Fetch Games by Selected Dates", type="primary"):
    if not (isinstance(selected_range, tuple) and len(selected_range) == 2):
        st.error("Validation Error: Please select both a start date and an end date on the calendar.")
    else:
        start_date, end_date = selected_range
        existing_picks = supabase.table("picks").select("user_id").eq("week_number", int(active_week)).execute().data
        if existing_picks:
            st.session_state.pending_refetch = {
                "week": int(active_week),
                "start": start_date,
                "end": end_date,
                "player_count": len(set(p["user_id"] for p in existing_picks)),
            }
            st.rerun()
        else:
            run_espn_sync(int(active_week), start_date, end_date)

pending = st.session_state.get("pending_refetch")
if pending and pending["week"] == int(active_week):
    st.warning(
        f"⚠️ {pending['player_count']} player(s) have already submitted picks for Week {pending['week']}. "
        "Re-pulling will refresh the spreads for this week. If a line moved, an already-submitted pick "
        "could end up graded against a different number than what that person actually saw."
    )
    col_go, col_cancel = st.columns(2)
    with col_go:
        if st.button("Yes, re-pull anyway", type="primary", key="confirm_refetch"):
            run_espn_sync(pending["week"], pending["start"], pending["end"])
    with col_cancel:
        if st.button("Cancel", key="cancel_refetch"):
            st.session_state.pending_refetch = None
            st.rerun()

st.write("---")

# 5. VIEW SUBMITTED PICKS
st.subheader("📋 Submitted Picks")
view_week = st.number_input("Week to view picks for:", min_value=1, max_value=18, value=int(active_week), step=1, key="view_week_picks")

picks_rows = supabase.table("picks").select("*").eq("week_number", view_week).execute().data
games_rows = supabase.table("games").select("game_id, display_text, favorite_team, underdog_team, spread_value") \
    .eq("week_number", view_week).execute().data
game_lookup = {g["game_id"]: g for g in games_rows}

if not picks_rows:
    st.info(f"No picks submitted yet for Week {view_week}.")
else:
    display_rows = []
    for p in picks_rows:
        g = game_lookup.get(p["game_id"], {})
        display_rows.append({
            "Player": p.get("username", "Unknown"),
            "Matchup": g.get("display_text", p["game_id"]),
            "Pick": p.get("selected_team"),
            "Spread": g.get("spread_value", ""),
        })
    df_picks_view = pd.DataFrame(display_rows)

    counts = df_picks_view.groupby("Player").size().reset_index(name="Picks Submitted")
    counts["Status"] = counts["Picks Submitted"].apply(lambda n: "✅ Complete" if n == 7 else f"⏳ {n}/7")
    st.dataframe(counts, use_container_width=True, hide_index=True)

    players = sorted(df_picks_view["Player"].unique())
    selected_player = st.selectbox("View picks for:", players, key="selected_picks_player")
    player_df = df_picks_view[df_picks_view["Player"] == selected_player].sort_values("Matchup")
    st.dataframe(player_df.drop(columns=["Player"]), use_container_width=True, hide_index=True)

    user_id_by_username = {p["username"]: p["user_id"] for p in picks_rows}

    if st.button(f"🗑️ Remove {selected_player}'s picks for Week {view_week}", key="remove_picks_btn"):
        st.session_state.pending_removal = {
            "week": view_week,
            "player": selected_player,
            "user_id": user_id_by_username.get(selected_player),
        }
        st.rerun()

# Checked every rerun so the dialog's own buttons get a chance to be detected as clicked.
if st.session_state.get("pending_removal"):
    confirm_removal(st.session_state.pending_removal)

st.write("---")

# 6. GRADE FINISHED GAMES
st.subheader("🏁 Grade Finished Games")
grade_week_num = st.number_input("Week to grade:", min_value=1, max_value=18, value=int(active_week), step=1, key="grade_week")

if st.button("🔄 Refresh Scores & Grade", type="primary"):
    games_in_week = supabase.table("games").select("*").eq("week_number", grade_week_num).execute().data

    if not games_in_week:
        st.warning(f"No games found for Week {grade_week_num}.")
    else:
        with st.spinner("Pulling final scores from ESPN..."):
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://www.espn.com/",
                "Accept": "application/json",
            }
            league_url_map = {
                "NFL": "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
                "CFB": "https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard",
            }

            games_by_league = {}
            for g in games_in_week:
                games_by_league.setdefault(g["league"], []).append(g)

            espn_scores = {}  # game_id -> {"state": ..., "home_score": ..., "away_score": ...}

            for league_name, league_games in games_by_league.items():
                url = league_url_map.get(league_name)
                if not url:
                    continue

                kickoff_dates = []
                for g in league_games:
                    try:
                        kickoff_dates.append(datetime.fromisoformat(g["kickoff_time"].replace("Z", "+00:00")))
                    except (ValueError, AttributeError, TypeError):
                        pass
                if not kickoff_dates:
                    continue

                params = {
                    "limit": 1000,
                    "dates": f"{min(kickoff_dates):%Y%m%d}-{max(kickoff_dates):%Y%m%d}",
                }
                if league_name == "CFB":
                    params["groups"] = 80

                try:
                    resp = requests.get(url, params=params, headers=headers, timeout=15)
                    if resp.status_code != 200:
                        st.warning(f"{league_name} score refresh failed: HTTP {resp.status_code}")
                        continue
                    data = resp.json()
                    time_module.sleep(2)  # same rate-limit courtesy as the sync
                except Exception as e:
                    st.warning(f"{league_name} score refresh error: {e}")
                    continue

                for event in data.get("events", []):
                    gid = f"espn_{event.get('id')}"
                    state = event.get("status", {}).get("type", {}).get("state", "pre")

                    competitions = event.get("competitions", [{}])[0]
                    competitors = competitions.get("competitors", [])
                    home_node = next((c for c in competitors if c.get("homeAway") == "home"), {})
                    away_node = next((c for c in competitors if c.get("homeAway") == "away"), {})
                    try:
                        home_score = int(home_node.get("score", 0))
                        away_score = int(away_node.get("score", 0))
                    except (TypeError, ValueError):
                        home_score, away_score = 0, 0

                    espn_scores[gid] = {"state": state, "home_score": home_score, "away_score": away_score}

            graded_count = 0
            already_final_count = 0
            still_pending_count = 0

            for g in games_in_week:
                if g.get("status") == "final":
                    already_final_count += 1
                    continue

                live = espn_scores.get(g["game_id"])
                if not live or live["state"] != "post":
                    still_pending_count += 1
                    continue

                home_score, away_score = live["home_score"], live["away_score"]

                # The stored spread is always relative to the FAVORITE (see nudge_off_whole_number),
                # and every spread has been shifted off whole numbers, so a tie is not possible.
                spread_num_str = (g.get("spread_value") or "").rsplit(" ", 1)[-1]
                try:
                    spread_num = float(spread_num_str)
                except ValueError:
                    spread_num = 0.0

                fav_is_home = bool(g.get("favorite_team_home"))
                fav_score = home_score if fav_is_home else away_score
                und_score = away_score if fav_is_home else home_score

                margin = (fav_score + spread_num) - und_score
                winning_team = g.get("favorite_team") if margin > 0 else g.get("underdog_team")

                supabase.table("games").update({
                    "status": "final",
                    "winning_team": winning_team,
                }).eq("id", g["id"]).execute()
                graded_count += 1

        st.success(
            f"Graded {graded_count} newly-final game(s) for Week {grade_week_num}. "
            f"{already_final_count} were already graded, {still_pending_count} still in progress or not yet started."
        )

st.write("---")

# 7. EXPORT SLATE TO EXCEL
st.subheader("📊 Export Slate to Excel")
export_week = st.number_input("Week to export:", min_value=1, max_value=18, value=int(active_week), step=1, key="export_week")

export_games = supabase.table("games").select("*").eq("week_number", export_week).execute().data

if not export_games:
    st.info(f"No games found for Week {export_week}.")
else:
    def build_slate_workbook(games_rows, week_number):
        wb = Workbook()
        ws = wb.active
        ws.title = f"Week {week_number}"[:31]

        headers = ["#", "FAVORITE", "#", "UNDERDOG", "SPREAD", "KICKOFF (ET)", "TV"]
        ws.append(headers)
        for col_idx in range(1, len(headers) + 1):
            cell = ws.cell(row=1, column=col_idx)
            cell.font = Font(name="Arial", bold=True, color="FFFFFF")
            cell.fill = PatternFill(start_color="1F4E78", end_color="1F4E78", fill_type="solid")
            cell.alignment = Alignment(horizontal="center")

        sorted_games = sorted(games_rows, key=lambda g: g.get("kickoff_time") or "")
        for i, g in enumerate(sorted_games, start=1):
            fav_num = 2 * i - 1  # favorites get odd numbers
            und_num = 2 * i      # underdogs get even numbers

            fav_team = g.get("favorite_team", "")
            und_team = g.get("underdog_team", "")
            fav_team = f"{fav_team} (Home)" if g.get("favorite_team_home") else fav_team
            und_team = f"{und_team} (Home)" if g.get("underdog_team_home") else und_team
            spread_number = (g.get("spread_value") or "").rsplit(" ", 1)[-1]

            kickoff_display = g.get("kickoff_time", "") or ""
            try:
                kickoff_dt = datetime.fromisoformat(kickoff_display.replace("Z", "+00:00")).astimezone(ZoneInfo("America/New_York"))
                kickoff_display = kickoff_dt.strftime("%a %m/%d %I:%M %p ET").replace(" 0", " ")
            except (ValueError, AttributeError):
                pass

            tv_network = g.get("tv_network", "") or ""

            ws.append([fav_num, fav_team, und_num, und_team, spread_number, kickoff_display, tv_network])
            for col_idx in range(1, len(headers) + 1):
                ws.cell(row=i + 1, column=col_idx).font = Font(name="Arial")

        for col_idx, header in enumerate(headers, start=1):
            col_letter = get_column_letter(col_idx)
            longest = max(
                [len(str(header))] +
                [len(str(ws.cell(row=r, column=col_idx).value or "")) for r in range(2, ws.max_row + 1)]
            )
            ws.column_dimensions[col_letter].width = longest + 4

        ws.freeze_panes = "A2"

        buffer = io.BytesIO()
        wb.save(buffer)
        buffer.seek(0)
        return buffer

    excel_buffer = build_slate_workbook(export_games, export_week)
    st.download_button(
        "⬇️ Download Week's Slate (.xlsx)",
        data=excel_buffer,
        file_name=f"week_{export_week}_slate.xlsx",
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
