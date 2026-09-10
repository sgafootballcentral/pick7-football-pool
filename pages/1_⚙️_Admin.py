import streamlit as st
import requests
import pandas as pd
import time as time_module
import io
import uuid
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


def compute_game_numbers(week_games):
    """Same odd/even numbering as the weekly slate export: favorite=odd,
    underdog=even, assigned in chronological kickoff order."""
    sorted_games = sorted(week_games, key=lambda g: g.get("kickoff_time") or "")
    numbers = {}
    for i, g in enumerate(sorted_games, start=1):
        numbers[g["game_id"]] = {"fav_num": 2 * i - 1, "und_num": 2 * i}
    return numbers


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


@st.dialog("⚠️ Delete Entire Week?")
def confirm_week_delete(info):
    detail = f"This will permanently delete **{info['games_count']} game(s)** for Week {info['week']}"
    if info["picks_count"]:
        detail += f", along with **{info['picks_count']} pick(s)** from **{info['players_count']} player(s)**"
    detail += ". This cannot be undone."
    st.write(detail)

    col_yes, col_no = st.columns(2)
    with col_yes:
        confirm_clicked = st.button(f"Yes, delete Week {info['week']}", type="primary", use_container_width=True)
    with col_no:
        cancel_clicked = st.button("Cancel", use_container_width=True)

    if confirm_clicked:
        try:
            supabase.table("picks").delete().eq("week_number", info["week"]).execute()
            supabase.table("games").delete().eq("week_number", info["week"]).execute()
            st.session_state.pending_week_delete = None
            st.rerun()
        except Exception as e:
            st.error(f"Database error: {e}")
    elif cancel_clicked:
        st.session_state.pending_week_delete = None
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
        f"⚠️ Spreads for Week {pending['week']} have already been locked in by {pending['player_count']} "
        "player(s)' picks. Re-pulling is safe for them -- each pick keeps grading against the exact spread "
        "it locked in, even if the number changes here. This only affects the spread shown to anyone who "
        "hasn't submitted yet."
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

# 5. ADD A GAME MANUALLY
st.subheader("➕ Add a Game Manually")
st.caption("For games ESPN doesn't have, or a line you want to set yourself.")

with st.form("manual_add_game_form"):
    manual_week = st.number_input("Week number:", min_value=1, max_value=18, value=int(active_week), step=1, key="manual_week")

    col1, col2 = st.columns(2)
    with col1:
        manual_fav_team = st.text_input("Favorite team name")
    with col2:
        manual_und_team = st.text_input("Underdog team name")

    manual_home_side = st.radio("Who's the home team?", ["Favorite", "Underdog"], horizontal=True)
    manual_spread = st.number_input("Spread (favorite's number, e.g. -6.5):", value=-3.0, step=0.5, format="%.1f")

    col3, col4 = st.columns(2)
    with col3:
        manual_kickoff_date = st.date_input("Kickoff date", key="manual_kickoff_date")
    with col4:
        manual_kickoff_time = st.time_input("Kickoff time (Eastern)", key="manual_kickoff_time")

    manual_tv = st.text_input("TV network (optional)")

    manual_submitted = st.form_submit_button("Add Game")

if manual_submitted:
    if not manual_fav_team.strip() or not manual_und_team.strip():
        st.error("Please enter both team names.")
    else:
        fav_team, und_team = manual_fav_team.strip(), manual_und_team.strip()
        fav_home = manual_home_side == "Favorite"
        spread_num = manual_spread

        if spread_num == 0:
            # Match the auto-fetch convention: a true pick'em defaults to the
            # home team as a -0.5 favorite so it can never push.
            if not fav_home:
                fav_team, und_team = und_team, fav_team
                fav_home = True
            spread_str = f"{fav_team} -0.5"
        else:
            spread_str = nudge_off_whole_number(f"{fav_team} {spread_num:.1f}")

        kickoff_dt_eastern = datetime.combine(manual_kickoff_date, manual_kickoff_time, tzinfo=ZoneInfo("America/New_York"))
        kickoff_iso = kickoff_dt_eastern.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

        try:
            supabase.table("games").insert({
                "game_id": f"manual_{uuid.uuid4().hex[:12]}",
                "game_number": 0,
                "league": "MANUAL",
                "favorite_team": fav_team,
                "underdog_team": und_team,
                "favorite_team_home": fav_home,
                "underdog_team_home": not fav_home,
                "spread_value": spread_str,
                "display_text": f"{und_team if fav_home else fav_team} at {fav_team if fav_home else und_team}",
                "kickoff_time": kickoff_iso,
                "tv_network": manual_tv.strip(),
                "week_number": int(manual_week),
            }).execute()
            st.success(f"Added {fav_team} vs {und_team} to Week {manual_week}.")
            st.rerun()
        except Exception as e:
            st.error(f"Database error: {e}")

st.write("---")

# 6. VIEW SUBMITTED PICKS
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

# 7. GRADE FINISHED GAMES
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

                # Grade each pick against the spread IT actually saw, not necessarily
                # today's spread_value -- protects anyone who picked before a re-sync.
                picks_for_game = supabase.table("picks").select("*").eq("game_id", g["game_id"]).execute().data
                for p in picks_for_game:
                    locked_spread_str = (p.get("spread_at_pick") or g.get("spread_value") or "").rsplit(" ", 1)[-1]
                    try:
                        locked_spread_num = float(locked_spread_str)
                    except ValueError:
                        locked_spread_num = spread_num

                    pick_margin = (fav_score + locked_spread_num) - und_score
                    pick_winning_team = g.get("favorite_team") if pick_margin > 0 else g.get("underdog_team")
                    pick_result = "win" if p.get("selected_team") == pick_winning_team else "loss"

                    supabase.table("picks").update({"result": pick_result}).eq("id", p["id"]).execute()

                graded_count += 1

        st.success(
            f"Graded {graded_count} newly-final game(s) for Week {grade_week_num}. "
            f"{already_final_count} were already graded, {still_pending_count} still in progress or not yet started."
        )

st.write("---")

# 8. EXPORT SLATE TO EXCEL
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

        ws.append([f"Week {week_number}"])
        ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(headers))
        title_cell = ws.cell(row=1, column=1)
        title_cell.font = Font(name="Arial", bold=True, size=14)
        title_cell.alignment = Alignment(horizontal="center")

        ws.append(headers)
        for col_idx in range(1, len(headers) + 1):
            cell = ws.cell(row=2, column=col_idx)
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
                ws.cell(row=i + 2, column=col_idx).font = Font(name="Arial")

        for col_idx, header in enumerate(headers, start=1):
            col_letter = get_column_letter(col_idx)
            longest = max(
                [len(str(header))] +
                [len(str(ws.cell(row=r, column=col_idx).value or "")) for r in range(3, ws.max_row + 1)]
            )
            ws.column_dimensions[col_letter].width = longest + 4

        ws.freeze_panes = "A3"

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

st.write("---")

# 9. DELETE WEEK'S SLATE
st.subheader("🗑️ Delete Week's Slate")
delete_week_num = st.number_input("Week to delete:", min_value=1, max_value=18, value=int(active_week), step=1, key="delete_week")

if st.button("Delete This Week's Games", key="delete_week_btn"):
    games_for_delete = supabase.table("games").select("id").eq("week_number", delete_week_num).execute().data
    picks_for_delete = supabase.table("picks").select("user_id").eq("week_number", delete_week_num).execute().data

    st.session_state.pending_week_delete = {
        "week": delete_week_num,
        "games_count": len(games_for_delete),
        "picks_count": len(picks_for_delete),
        "players_count": len(set(p["user_id"] for p in picks_for_delete)),
    }
    st.rerun()

if st.session_state.get("pending_week_delete"):
    confirm_week_delete(st.session_state.pending_week_delete)

st.write("---")

# 10. ADD A PLAYER WITHOUT AN ACCOUNT
st.subheader("➕ Add a Player Without an Account")
st.caption("For someone you're tracking who doesn't log in or have an email on file.")

manual_player_name = st.text_input("Player name:", key="manual_player_name")
if st.button("Add Player", key="add_manual_player_btn"):
    if not manual_player_name.strip():
        st.error("Enter a name.")
    else:
        try:
            supabase.table("players").insert({
                "id": str(uuid.uuid4()),
                "username": manual_player_name.strip(),
            }).execute()
            st.success(f"Added {manual_player_name.strip()}.")
            st.rerun()
        except Exception as e:
            st.error(f"Database error: {e}")

st.write("---")

# 11. MANUALLY ENTER PICKS FOR A PLAYER (BY NUMBER)
st.subheader("✍️ Manually Enter Picks for a Player")
st.caption("For anyone who sent you picks by text instead of using the app -- enter the numbers they gave you.")

manual_pick_week = st.number_input("Week:", min_value=1, max_value=18, value=int(active_week), step=1, key="manual_pick_week")

players_roster = supabase.table("players").select("*").execute().data
if not players_roster:
    st.info("No players found yet -- add one above, or have them log in once.")
else:
    player_options = {p["username"]: p["id"] for p in players_roster}
    selected_manual_player = st.selectbox("Player:", sorted(player_options.keys()), key="manual_pick_player")
    selected_manual_user_id = player_options[selected_manual_player]

    week_games_for_manual = supabase.table("games").select("*").eq("week_number", manual_pick_week).execute().data

    if not week_games_for_manual:
        st.info(f"No games loaded for Week {manual_pick_week} yet.")
    else:
        numbers_map_manual = compute_game_numbers(week_games_for_manual)
        games_by_id_manual = {g["game_id"]: g for g in week_games_for_manual}

        # number -> which game/team that number refers to, same odd/even scheme as the exports
        number_lookup = {}
        for g in week_games_for_manual:
            nums = numbers_map_manual.get(g["game_id"], {})
            number_lookup[nums["fav_num"]] = {"game_id": g["game_id"], "team": g.get("favorite_team", "")}
            number_lookup[nums["und_num"]] = {"game_id": g["game_id"], "team": g.get("underdog_team", "")}

        with st.expander(f"See all game numbers for Week {manual_pick_week}"):
            ref_rows = [
                {
                    "#": num,
                    "Team": info["team"],
                    "Matchup": games_by_id_manual[info["game_id"]].get("display_text", ""),
                    "Spread": games_by_id_manual[info["game_id"]].get("spread_value", ""),
                }
                for num, info in sorted(number_lookup.items())
            ]
            st.dataframe(ref_rows, use_container_width=True, hide_index=True)

        existing_manual_picks = supabase.table("picks").select("*") \
            .eq("user_id", selected_manual_user_id).eq("week_number", manual_pick_week).execute().data

        existing_numbers = []
        for pk in existing_manual_picks:
            g = games_by_id_manual.get(pk["game_id"])
            if not g:
                continue
            nums = numbers_map_manual.get(pk["game_id"], {})
            is_fav = pk["selected_team"] == g.get("favorite_team")
            num = nums.get("fav_num") if is_fav else nums.get("und_num")
            if num is not None:
                existing_numbers.append(num)
        existing_numbers.sort()

        if existing_manual_picks:
            st.caption(f"{selected_manual_player} already has {len(existing_manual_picks)} pick(s) on file for Week {manual_pick_week} -- pre-filled below.")

        numbers_input = st.text_input(
            "Enter their 7 picks by number, comma-separated (e.g. 3,5,11,13,41,45,144):",
            value=",".join(str(n) for n in existing_numbers),
            key="manual_pick_numbers_input",
        )

        if st.button(f"Save Picks for {selected_manual_player}", type="primary", key="save_manual_picks"):
            raw_parts = [p.strip() for p in numbers_input.split(",") if p.strip()]
            try:
                entered_numbers = [int(p) for p in raw_parts]
            except ValueError:
                entered_numbers = None
                st.error("Please enter numbers only, separated by commas.")

            if entered_numbers is not None:
                invalid_numbers = sorted({n for n in entered_numbers if n not in number_lookup})
                duplicate_numbers = sorted({n for n in entered_numbers if entered_numbers.count(n) > 1})

                if invalid_numbers:
                    st.error(f"These numbers don't match any game this week: {invalid_numbers}")
                elif duplicate_numbers:
                    st.error(f"These numbers were entered more than once: {duplicate_numbers}")
                elif len(entered_numbers) != 7:
                    st.error(f"You entered {len(entered_numbers)} number(s) -- exactly 7 are required.")
                else:
                    try:
                        supabase.table("picks").delete().eq("user_id", selected_manual_user_id).eq("week_number", manual_pick_week).execute()
                        for n in entered_numbers:
                            info = number_lookup[n]
                            g = games_by_id_manual[info["game_id"]]
                            supabase.table("picks").insert({
                                "user_id": selected_manual_user_id,
                                "username": selected_manual_player,
                                "week_number": manual_pick_week,
                                "game_id": info["game_id"],
                                "selected_team": info["team"],
                                "spread_at_pick": g.get("spread_value", ""),
                            }).execute()
                        picked_teams = ", ".join(f"#{n} {number_lookup[n]['team']}" for n in sorted(entered_numbers))
                        st.success(f"Saved picks for {selected_manual_player}: {picked_teams}")
                        st.rerun()
                    except Exception as e:
                        st.error(f"Database error: {e}")

st.write("---")

# 12. PLAYER PAYMENT STATUS
st.subheader("💰 Player Payment Status")

players_for_payment = supabase.table("players").select("*").order("username").execute().data
if not players_for_payment:
    st.info("No players yet -- they need to log in at least once before they show up here.")
else:
    payment_df = pd.DataFrame([
        {"Player": p["username"], "Paid": bool(p.get("paid")), "_id": p["id"]}
        for p in players_for_payment
    ])
    edited_payment_df = st.data_editor(
        payment_df.drop(columns=["_id"]),
        column_config={"Paid": st.column_config.CheckboxColumn("Paid?")},
        hide_index=True,
        use_container_width=True,
        key="payment_editor",
    )
    if st.button("Save Payment Status", key="save_payment_status"):
        try:
            for i, row in edited_payment_df.iterrows():
                player_id = payment_df.iloc[i]["_id"]
                supabase.table("players").update({"paid": bool(row["Paid"])}).eq("id", player_id).execute()
            st.success("Payment status updated.")
        except Exception as e:
            st.error(f"Database error: {e}")

st.write("---")

# 13. EXPORT SEASON TRACKER
st.subheader("📥 Export Season Tracker (.xlsx)")
st.caption("A running week-by-week win/loss breakdown for every player, in the same style as your old sheet.")

all_week_status_rows = supabase.table("games").select("week_number, status").execute().data
graded_weeks = sorted({g["week_number"] for g in all_week_status_rows if g.get("status") == "final"})

if not graded_weeks:
    st.info("No graded weeks yet -- use 'Grade Finished Games' above first.")
else:
    players_for_export = supabase.table("players").select("*").order("username").execute().data
    if not players_for_export:
        st.info("No players found yet.")
    else:
        def build_season_tracker_workbook(players_rows, weeks):
            wb = Workbook()
            ws = wb.active
            ws.title = "Season Tracker"

            headers = ["Player"]
            for wk in weeks:
                headers += [f"Week {wk} Picks", f"Week {wk} Wins", f"Week {wk} Loss", f"Week {wk} W", f"Week {wk} L"]
            headers += ["Overall Wins", "Overall Losses", "Place"]

            ws.append(headers)
            for col_idx in range(1, len(headers) + 1):
                cell = ws.cell(row=1, column=col_idx)
                cell.font = Font(name="Arial", bold=True, color="FFFFFF")
                cell.fill = PatternFill(start_color="1F4E78", end_color="1F4E78", fill_type="solid")
                cell.alignment = Alignment(horizontal="center")

            # Pre-fetch each week's games/picks once
            week_game_numbers, week_games_by_id, week_picks = {}, {}, {}
            for wk in weeks:
                games_this_week = supabase.table("games").select("*").eq("week_number", wk).execute().data
                week_game_numbers[wk] = compute_game_numbers(games_this_week)
                week_games_by_id[wk] = {g["game_id"]: g for g in games_this_week}
                week_picks[wk] = supabase.table("picks").select("*").eq("week_number", wk).execute().data

            # Build every player's row data first so ranking can happen before writing
            player_rows_data = []
            for p in players_rows:
                weekly_cells = []
                total_wins, total_losses = 0, 0

                for wk in weeks:
                    games_map = week_games_by_id[wk]
                    numbers_map = week_game_numbers[wk]
                    player_picks = [pk for pk in week_picks[wk] if pk["user_id"] == p["id"]]

                    picks_nums, win_nums, loss_nums = [], [], []
                    for pk in player_picks:
                        g = games_map.get(pk["game_id"])
                        if not g:
                            continue
                        nums = numbers_map.get(pk["game_id"], {})
                        is_fav = pk["selected_team"] == g.get("favorite_team")
                        num = nums.get("fav_num") if is_fav else nums.get("und_num")
                        if num is None:
                            continue
                        picks_nums.append(num)
                        if pk.get("result") == "win":
                            win_nums.append(num)
                        elif pk.get("result") == "loss":
                            loss_nums.append(num)

                    picks_nums.sort(); win_nums.sort(); loss_nums.sort()
                    weekly_cells += [
                        ",".join(str(n) for n in picks_nums),
                        ",".join(str(n) for n in win_nums),
                        ",".join(str(n) for n in loss_nums),
                        len(win_nums),
                        len(loss_nums),
                    ]
                    total_wins += len(win_nums)
                    total_losses += len(loss_nums)

                player_rows_data.append({
                    "username": p["username"],
                    "paid": bool(p.get("paid")),
                    "weekly_cells": weekly_cells,
                    "total_wins": total_wins,
                    "total_losses": total_losses,
                })

            # Competition ranking -- ties share a place, same as your RANK() formula
            for row in player_rows_data:
                row["place"] = sum(1 for r in player_rows_data if r["total_wins"] > row["total_wins"]) + 1
            player_rows_data.sort(key=lambda r: (-r["total_wins"], r["username"]))

            for row in player_rows_data:
                ws.append([row["username"]] + row["weekly_cells"] + [row["total_wins"], row["total_losses"], row["place"]])
                r_idx = ws.max_row
                name_cell = ws.cell(row=r_idx, column=1)
                name_cell.font = Font(name="Arial", bold=True)
                paid_color = "FF00B050" if row["paid"] else "FFFF0000"
                name_cell.fill = PatternFill(start_color=paid_color, end_color=paid_color, fill_type="solid")
                for col_idx in range(2, len(headers) + 1):
                    ws.cell(row=r_idx, column=col_idx).font = Font(name="Arial")

            for col_idx in range(1, len(headers) + 1):
                col_letter = get_column_letter(col_idx)
                longest = max(
                    [len(str(headers[col_idx - 1]))] +
                    [len(str(ws.cell(row=r, column=col_idx).value or "")) for r in range(2, ws.max_row + 1)]
                )
                ws.column_dimensions[col_letter].width = min(longest + 3, 22)

            ws.freeze_panes = "B2"

            buffer = io.BytesIO()
            wb.save(buffer)
            buffer.seek(0)
            return buffer

        tracker_buffer = build_season_tracker_workbook(players_for_export, graded_weeks)
        st.download_button(
            "⬇️ Download Season Tracker (.xlsx)",
            data=tracker_buffer,
            file_name="season_tracker.xlsx",
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )

st.write("---")

# 14. EXPORT WEEK + SEASON RESULTS (what you'd send out to the group)
st.subheader("📤 Export Week + Season Results")
st.caption("What you'd send out after grading a week: that week's individual results, plus updated season standings.")

results_week = st.number_input("Week to report on:", min_value=1, max_value=18, value=int(active_week), step=1, key="results_export_week")

if results_week not in graded_weeks:
    st.info(f"Week {int(results_week)} hasn't been graded yet -- use 'Grade Finished Games' above first.")
else:
    players_for_results = supabase.table("players").select("*").order("username").execute().data
    if not players_for_results:
        st.info("No players found yet.")
    else:
        def build_week_and_season_workbook(players_rows, target_week, all_graded_weeks):
            wb = Workbook()

            def style_header(ws, headers):
                ws.append(headers)
                for col_idx in range(1, len(headers) + 1):
                    cell = ws.cell(row=1, column=col_idx)
                    cell.font = Font(name="Arial", bold=True, color="FFFFFF")
                    cell.fill = PatternFill(start_color="1F4E78", end_color="1F4E78", fill_type="solid")
                    cell.alignment = Alignment(horizontal="center")

            def autosize(ws, headers):
                for col_idx, header in enumerate(headers, start=1):
                    col_letter = get_column_letter(col_idx)
                    longest = max(
                        [len(str(header))] +
                        [len(str(ws.cell(row=r, column=col_idx).value or "")) for r in range(2, ws.max_row + 1)]
                    )
                    ws.column_dimensions[col_letter].width = min(longest + 3, 22)
                ws.freeze_panes = "A2"

            # --- Sheet 1: this week's individual results ---
            ws1 = wb.active
            ws1.title = f"Week {target_week} Results"[:31]

            week_games = supabase.table("games").select("*").eq("week_number", target_week).execute().data
            numbers_map = compute_game_numbers(week_games)
            games_map = {g["game_id"]: g for g in week_games}
            week_picks_rows = supabase.table("picks").select("*").eq("week_number", target_week).execute().data

            headers1 = ["Player", "Picks", "Wins", "Loss", "W", "L"]
            style_header(ws1, headers1)

            week_rows_data = []
            for p in players_rows:
                player_picks = [pk for pk in week_picks_rows if pk["user_id"] == p["id"]]
                if not player_picks:
                    continue
                picks_nums, win_nums, loss_nums = [], [], []
                for pk in player_picks:
                    g = games_map.get(pk["game_id"])
                    if not g:
                        continue
                    nums = numbers_map.get(pk["game_id"], {})
                    is_fav = pk["selected_team"] == g.get("favorite_team")
                    num = nums.get("fav_num") if is_fav else nums.get("und_num")
                    if num is None:
                        continue
                    picks_nums.append(num)
                    if pk.get("result") == "win":
                        win_nums.append(num)
                    elif pk.get("result") == "loss":
                        loss_nums.append(num)
                picks_nums.sort(); win_nums.sort(); loss_nums.sort()
                week_rows_data.append({
                    "username": p["username"], "picks": picks_nums, "wins": win_nums,
                    "losses": loss_nums, "w": len(win_nums), "l": len(loss_nums),
                })

            week_rows_data.sort(key=lambda r: (-r["w"], r["l"], r["username"]))
            for r in week_rows_data:
                ws1.append([
                    r["username"], ",".join(map(str, r["picks"])), ",".join(map(str, r["wins"])),
                    ",".join(map(str, r["losses"])), r["w"], r["l"],
                ])
                for col_idx in range(1, len(headers1) + 1):
                    ws1.cell(row=ws1.max_row, column=col_idx).font = Font(name="Arial")

            autosize(ws1, headers1)

            # --- Sheet 2: season standings ---
            ws2 = wb.create_sheet(title="Season Standings")
            headers2 = ["Place", "Player", "Wins", "Losses", "Win %", "Paid"]
            style_header(ws2, headers2)

            season_totals = {}
            for wk in all_graded_weeks:
                picks_wk = supabase.table("picks").select("user_id, result").eq("week_number", wk).execute().data
                for pk in picks_wk:
                    uid = pk["user_id"]
                    totals = season_totals.setdefault(uid, {"wins": 0, "losses": 0})
                    if pk.get("result") == "win":
                        totals["wins"] += 1
                    elif pk.get("result") == "loss":
                        totals["losses"] += 1

            season_rows = []
            for p in players_rows:
                totals = season_totals.get(p["id"], {"wins": 0, "losses": 0})
                wins, losses = totals["wins"], totals["losses"]
                win_pct = round(wins / (wins + losses), 3) if (wins + losses) else 0.0
                season_rows.append({
                    "username": p["username"], "wins": wins, "losses": losses,
                    "win_pct": win_pct, "paid": bool(p.get("paid")),
                })

            for row in season_rows:
                row["place"] = sum(1 for r in season_rows if r["wins"] > row["wins"]) + 1
            season_rows.sort(key=lambda r: (-r["wins"], r["losses"], r["username"]))

            for row in season_rows:
                ws2.append([row["place"], row["username"], row["wins"], row["losses"], row["win_pct"], "Yes" if row["paid"] else "No"])
                r_idx = ws2.max_row
                name_cell = ws2.cell(row=r_idx, column=2)
                name_cell.font = Font(name="Arial", bold=True)
                paid_color = "FF00B050" if row["paid"] else "FFFF0000"
                name_cell.fill = PatternFill(start_color=paid_color, end_color=paid_color, fill_type="solid")
                for col_idx in (1, 3, 4, 5, 6):
                    ws2.cell(row=r_idx, column=col_idx).font = Font(name="Arial")

            autosize(ws2, headers2)

            buffer = io.BytesIO()
            wb.save(buffer)
            buffer.seek(0)
            return buffer

        results_buffer = build_week_and_season_workbook(players_for_results, int(results_week), graded_weeks)
        st.download_button(
            f"⬇️ Download Week {int(results_week)} + Season Results (.xlsx)",
            data=results_buffer,
            file_name=f"week_{int(results_week)}_and_season_results.xlsx",
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
