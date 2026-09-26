import streamlit as st
import streamlit.components.v1 as components
import json
import pandas as pd
from supabase import create_client, Client
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

SUPABASE_URL = st.secrets.get("SUPABASE_URL")
SUPABASE_KEY = st.secrets.get("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    st.error("Missing critical Supabase connection variables in Streamlit Secrets.")
    st.stop()

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Same "remember me" browser storage keys/helpers as app.py -- see there for
# the full explanation. This page doesn't drive its own login, but a
# successful refresh here still needs to update the saved tokens app.py's
# restore logic reads on the next visit.
REMEMBER_AT_KEY = "pick7_remember_at"
REMEMBER_RT_KEY = "pick7_remember_rt"


def remember_session_in_browser(access_token, refresh_token):
    components.html(f"""
        <script>
        try {{
            localStorage.setItem({json.dumps(REMEMBER_AT_KEY)}, {json.dumps(access_token)});
            localStorage.setItem({json.dumps(REMEMBER_RT_KEY)}, {json.dumps(refresh_token)});
        }} catch (e) {{}}
        </script>
    """, height=0)


def forget_session_in_browser():
    components.html(f"""
        <script>
        try {{
            localStorage.removeItem({json.dumps(REMEMBER_AT_KEY)});
            localStorage.removeItem({json.dumps(REMEMBER_RT_KEY)});
        }} catch (e) {{}}
        </script>
    """, height=0)


if "user" not in st.session_state or not st.session_state.user:
    st.warning("Please log in on the home page first.")
    st.stop()

if st.session_state.get("access_token"):
    try:
        supabase.auth.set_session(st.session_state.access_token, st.session_state.refresh_token)
    except Exception:
        # Same fix as app.py/Admin.py: try one explicit refresh before
        # treating a set_session() failure as a genuine logout.
        try:
            refreshed = supabase.auth.refresh_session(st.session_state.refresh_token)
            st.session_state.access_token = refreshed.session.access_token
            st.session_state.refresh_token = refreshed.session.refresh_token
            remember_session_in_browser(refreshed.session.access_token, refreshed.session.refresh_token)
        except Exception:
            st.session_state.user = None
            st.session_state.access_token = None
            st.session_state.refresh_token = None
            forget_session_in_browser()
            st.session_state["_just_logged_out"] = True
            st.warning("Your session expired -- please log in again on the home page.")
            st.stop()

user = st.session_state.user
username = user.user_metadata.get("username", user.email)

EASTERN_TZ = ZoneInfo("America/New_York")

st.title("🆚 Compare Picks")
st.caption("See how your picks stack up against everyone else's -- once the week locks.")

available_week_rows = supabase.table("games").select("week_number").execute().data
available_weeks = sorted({w["week_number"] for w in available_week_rows}, reverse=True)

if not available_weeks:
    st.info("No games have been loaded yet. Check back once the admin sets up a week.")
    st.stop()

# Same shared "global_week" pattern as app.py/Leaderboard/Admin -- keeps the
# week selector in sync across pages. Streamlit deletes a widget's own
# session_state key on navigating away from its page, so the widget key must
# be reseeded from global_week whenever it's missing, not just when
# global_week last changed.
if "global_week" not in st.session_state:
    st.session_state["global_week"] = available_weeks[0]
if "cmp_selected_week" not in st.session_state or st.session_state["cmp_selected_week"] not in available_weeks:
    st.session_state["cmp_selected_week"] = (
        st.session_state["global_week"] if st.session_state["global_week"] in available_weeks else available_weeks[0]
    )

CURRENT_WEEK = st.selectbox("Week:", available_weeks, key="cmp_selected_week")
if CURRENT_WEEK != st.session_state["global_week"]:
    st.session_state["global_week"] = CURRENT_WEEK

games = supabase.table("games").select("*").eq("week_number", CURRENT_WEEK).execute().data or []
games_sorted = sorted(games, key=lambda g: g.get("kickoff_time") or "")

try:
    lock_row = supabase.table("week_pick_locks").select("*").eq("week_number", CURRENT_WEEK).maybe_single().execute().data
except Exception:
    lock_row = None

now = datetime.now(timezone.utc)
lock_at_dt = None
if lock_row and lock_row.get("lock_at"):
    lock_at_dt = datetime.fromisoformat(lock_row["lock_at"].replace("Z", "+00:00"))

# Unlocked once the admin's lock time passes, OR once every game in the week
# has already kicked off -- same idea as the weekly pick lock everywhere
# else, so there's nothing to "scout" even if an admin never set an
# explicit lock time for this week.
unlocked = False
if lock_at_dt and now >= lock_at_dt:
    unlocked = True
elif games_sorted:
    kickoffs = []
    for g in games_sorted:
        try:
            kickoffs.append(datetime.fromisoformat(g["kickoff_time"].replace("Z", "+00:00")))
        except (ValueError, AttributeError, TypeError):
            kickoffs.append(None)
    if kickoffs and all(k is not None and now >= k for k in kickoffs):
        unlocked = True

if not unlocked:
    if lock_at_dt:
        lock_at_str = lock_at_dt.astimezone(EASTERN_TZ).strftime("%a %m/%d %I:%M %p ET").replace(" 0", " ")
        st.info(f"🔒 Picks for Week {CURRENT_WEEK} unlock for comparison once they lock, at {lock_at_str}.")
    else:
        st.info(
            f"🔒 Picks for Week {CURRENT_WEEK} unlock for comparison once its games kick off, "
            "or once an admin sets a weekly lock time -- whichever comes first."
        )
    st.stop()

week_picks = supabase.table("picks").select("*").eq("week_number", CURRENT_WEEK).execute().data or []
picks_by_username = {}
for p in week_picks:
    picks_by_username.setdefault(p.get("username", "Unknown"), []).append(p)

if not picks_by_username:
    st.info(f"No picks have been submitted yet for Week {CURRENT_WEEK}.")
    st.stop()

WIN_STYLE = "background-color: #1e6b2e; color: #ffffff"
LOSS_STYLE = "background-color: #8a1f1f; color: #ffffff"

view_mode = st.radio("View:", ["📊 Everyone", "🆚 Head-to-Head"], horizontal=True, key="cmp_view_mode")

# The Everyone grid only makes sense for games at least one player actually
# picked -- a game nobody picked (or that isn't part of anyone's 7) would
# just be an all-"—" column. Head-to-head is left showing the full week
# either way, since "neither of us picked this one" is still meaningful there.
picked_game_ids = {p["game_id"] for p in week_picks if p.get("selected_team")}
grid_games = [g for g in games_sorted if g["game_id"] in picked_game_ids]
game_cols = [f"G{i + 1}" for i in range(len(grid_games))]

if view_mode == "📊 Everyone":
    with st.expander("🔢 Game legend (matchup & spread for G1-G{})".format(len(grid_games)) if grid_games else "🔢 Game legend"):
        for i, g in enumerate(grid_games):
            st.write(f"**G{i + 1}**: {g.get('display_text') or g.get('game_id')} ({g.get('spread_value', '')})")

    players = sorted(picks_by_username.keys())

    display_rows = []
    results_grid = {}
    for row_idx, p in enumerate(players):
        picks_by_game = {pk["game_id"]: pk for pk in picks_by_username[p]}
        row = {"Player": p + (" (you)" if p == username else "")}
        wins = losses = 0
        for col, g in zip(game_cols, grid_games):
            pk = picks_by_game.get(g["game_id"])
            if not pk or not pk.get("selected_team"):
                row[col] = "—"
                continue
            label = pk["selected_team"]
            if pk.get("result") == "win":
                label += " ✅"
                wins += 1
                results_grid[(row_idx, col)] = "win"
            elif pk.get("result") == "loss":
                label += " ❌"
                losses += 1
                results_grid[(row_idx, col)] = "loss"
            row[col] = label
        row["This Week"] = f"{wins}-{losses}"
        display_rows.append(row)

    grid_df = pd.DataFrame(display_rows, columns=["Player"] + game_cols + ["This Week"])

    def _style_grid(df):
        styles = pd.DataFrame("", index=df.index, columns=df.columns)
        for row_idx in df.index:
            for col in game_cols:
                r = results_grid.get((row_idx, col))
                if r == "win":
                    styles.loc[row_idx, col] = WIN_STYLE
                elif r == "loss":
                    styles.loc[row_idx, col] = LOSS_STYLE
        return styles

    st.dataframe(grid_df.style.apply(_style_grid, axis=None), use_container_width=True, hide_index=True)

else:
    players = sorted(picks_by_username.keys())
    if len(players) < 2:
        st.info(f"Need at least two players' picks on file for Week {CURRENT_WEEK} to compare head-to-head.")
        st.stop()

    default_a_index = players.index(username) if username in players else 0
    col_a, col_b = st.columns(2)
    with col_a:
        player_a = st.selectbox("Player A:", players, index=default_a_index, key="cmp_h2h_a")
    b_choices = [p for p in players if p != player_a]
    with col_b:
        player_b = st.selectbox("Player B:", b_choices, index=0, key="cmp_h2h_b")

    a_picks_by_game = {pk["game_id"]: pk for pk in picks_by_username.get(player_a, [])}
    b_picks_by_game = {pk["game_id"]: pk for pk in picks_by_username.get(player_b, [])}

    a_wins = a_losses = b_wins = b_losses = 0
    agree = comparable = 0
    display_rows = []
    results_grid = {}
    for row_idx, g in enumerate(games_sorted):
        a_pick = a_picks_by_game.get(g["game_id"])
        b_pick = b_picks_by_game.get(g["game_id"])

        a_label = a_pick["selected_team"] if a_pick and a_pick.get("selected_team") else "—"
        b_label = b_pick["selected_team"] if b_pick and b_pick.get("selected_team") else "—"

        if a_pick and a_pick.get("result") == "win":
            a_label += " ✅"; a_wins += 1; results_grid[(row_idx, player_a)] = "win"
        elif a_pick and a_pick.get("result") == "loss":
            a_label += " ❌"; a_losses += 1; results_grid[(row_idx, player_a)] = "loss"

        if b_pick and b_pick.get("result") == "win":
            b_label += " ✅"; b_wins += 1; results_grid[(row_idx, player_b)] = "win"
        elif b_pick and b_pick.get("result") == "loss":
            b_label += " ❌"; b_losses += 1; results_grid[(row_idx, player_b)] = "loss"

        same = bool(
            a_pick and b_pick and a_pick.get("selected_team") and
            a_pick.get("selected_team") == b_pick.get("selected_team")
        )
        if a_pick and b_pick and a_pick.get("selected_team") and b_pick.get("selected_team"):
            comparable += 1
            if same:
                agree += 1

        display_rows.append({
            "Matchup": g.get("display_text") or g.get("game_id"),
            "Spread": g.get("spread_value", ""),
            player_a: a_label,
            player_b: b_label,
            "Same Pick?": "🤝" if same else "",
        })

    col1, col2, col3 = st.columns(3)
    col1.metric(f"{player_a}", f"{a_wins}-{a_losses}")
    col2.metric(f"{player_b}", f"{b_wins}-{b_losses}")
    col3.metric("Agree on", f"{agree} / {comparable}")

    h2h_df = pd.DataFrame(display_rows, columns=["Matchup", "Spread", player_a, player_b, "Same Pick?"])

    def _style_h2h(df):
        styles = pd.DataFrame("", index=df.index, columns=df.columns)
        for row_idx in df.index:
            for col in (player_a, player_b):
                r = results_grid.get((row_idx, col))
                if r == "win":
                    styles.loc[row_idx, col] = WIN_STYLE
                elif r == "loss":
                    styles.loc[row_idx, col] = LOSS_STYLE
        return styles

    st.dataframe(h2h_df.style.apply(_style_h2h, axis=None), use_container_width=True, hide_index=True)
