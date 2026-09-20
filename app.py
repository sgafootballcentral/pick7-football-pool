import streamlit as st
import streamlit.components.v1 as components
import requests
import io
from urllib.parse import parse_qs
from streamlit_autorefresh import st_autorefresh
from supabase import create_client, Client
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
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


def nudge_off_whole_number(odds_string: str) -> str:
    """Same rule as the Admin page -- keeps a live-refreshed line from reintroducing
    a whole-number spread that could push."""
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
    """Same odd/even numbering as the Admin exports: favorite=odd, underdog=even,
    assigned in chronological kickoff order."""
    sorted_games = sorted(week_games, key=lambda g: g.get("kickoff_time") or "")
    numbers = {}
    for i, g in enumerate(sorted_games, start=1):
        numbers[g["game_id"]] = {"fav_num": 2 * i - 1, "und_num": 2 * i}
    return numbers


@st.cache_data(ttl=60)
def fetch_live_scores(games_for_week):
    """Pull live/final scores from ESPN for whatever leagues/dates this week's
    games actually span. Cached for 60s so repeated page loads/reruns across
    everyone viewing the app don't hammer ESPN's rate limits."""
    scores = {}
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
    for g in games_for_week:
        games_by_league.setdefault(g.get("league"), []).append(g)

    for league_name, league_games in games_by_league.items():
        url = league_url_map.get(league_name)
        if not url:
            continue  # manually-added or historical-import games have no live ESPN source

        kickoff_dates = []
        for g in league_games:
            try:
                kickoff_dates.append(datetime.fromisoformat(g["kickoff_time"].replace("Z", "+00:00")))
            except (ValueError, AttributeError, TypeError):
                pass
        if not kickoff_dates:
            continue

        # ESPN's scoreboard endpoint used to accept a "YYYYMMDD-YYYYMMDD" date
        # range, but it now rejects any hyphenated range with an HTTP 400
        # ("Failed to get events endpoint.") -- only a single bare date works.
        # So instead of one request for the whole week's span, fetch each
        # unique kickoff date separately and merge the results together.
        unique_dates = sorted({d.strftime("%Y%m%d") for d in kickoff_dates})

        for date_str in unique_dates:
            # ESPN also silently truncates CFB results to a fraction of the
            # real slate when "limit" is set anywhere near/at 1000 (a value
            # that used to work fine) -- 500 is comfortably under whatever
            # their new cap is and still far more than any single day's games.
            params = {"limit": 500, "dates": date_str}
            if league_name == "CFB":
                params["groups"] = 80

            try:
                resp = requests.get(url, params=params, headers=headers, timeout=15)
                if resp.status_code != 200:
                    continue
                data = resp.json()
            except Exception:
                continue

            for event in data.get("events", []):
                g_id = f"espn_{event.get('id')}"
                status_type = event.get("status", {}).get("type", {})
                state = status_type.get("state", "pre")
                completed = bool(status_type.get("completed", False))
                status_name = (status_type.get("name") or "").upper()
                detail_clock = status_type.get("shortDetail") or status_type.get("detail", "")

                competitions = event.get("competitions", [{}])[0]
                competitors = competitions.get("competitors", [])
                home_node = next((c for c in competitors if c.get("homeAway") == "home"), {})
                away_node = next((c for c in competitors if c.get("homeAway") == "away"), {})

                odds_node = competitions.get("odds", [])
                odds_line = odds_node[0].get("details", "0.0") if odds_node else "0.0"
                odds_line = nudge_off_whole_number(odds_line)

                scores[g_id] = {
                    "home_score": home_node.get("score", "0"),
                    "away_score": away_node.get("score", "0"),
                    "state": state,
                    "completed": completed,
                    "status_name": status_name,
                    "clock": detail_clock,
                    "line": odds_line,
                }
    return scores


@st.dialog("🔢 Confirm Your Picks")
def show_number_picks_preview(preview_data):
    st.write(f"You are submitting picks for **Week {preview_data['week']}**.")
    st.write("Here's what these numbers resolve to:")
    st.dataframe(preview_data["rows"], use_container_width=True, hide_index=True)

    col_apply, col_cancel = st.columns(2)
    with col_apply:
        if st.button("✅ Apply These Picks", type="primary", use_container_width=True, key="confirm_apply_number_picks"):
            for item in preview_data["resolved"]:
                st.session_state[f"sel_{item['game_id']}"] = item["team"]
            st.session_state.pending_number_preview = None
            st.rerun()
    with col_cancel:
        if st.button("Cancel", use_container_width=True, key="cancel_number_picks"):
            st.session_state.pending_number_preview = None
            st.rerun()


@st.dialog("🔒 Your Picks Are Locked In!")
def show_picks_recap(recap_rows):
    st.write("Here's what you picked for this week:")
    for item in recap_rows:
        st.markdown(f"- **{item['selected_team']}** — {item['matchup']}  (`{item['spread']}`)")
    if st.button("Got it!", use_container_width=True):
        st.rerun()


@st.dialog("⚠️ You've Already Submitted This Week")
def confirm_resubmit(existing_picks_raw, new_picks, game_lookup):
    st.write("Here's how your on-file picks compare to your new selections:")

    existing_map = {p["game_id"]: p["selected_team"] for p in existing_picks_raw}
    new_map = {p["game_id"]: p["selected_team"] for p in new_picks}
    all_game_ids = set(existing_map) | set(new_map)

    comparison_rows = []
    for gid in all_game_ids:
        g = game_lookup.get(gid, {})
        on_file = existing_map.get(gid, "—")
        new_pick = new_map.get(gid, "—")
        comparison_rows.append({
            "_kickoff": g.get("kickoff_time", ""),
            "Matchup": g.get("display_text", gid),
            "Spread": g.get("spread_value", ""),
            "On File": on_file,
            "New Selection": new_pick,
            "": "🔄" if on_file != new_pick else "",
        })
    comparison_rows.sort(key=lambda r: r["_kickoff"])
    for r in comparison_rows:
        r.pop("_kickoff")

    st.dataframe(comparison_rows, use_container_width=True, hide_index=True)
    st.write("Replace your on-file picks with the new selections above?")

    col_yes, col_no = st.columns(2)
    with col_yes:
        if st.button("Yes, resubmit", type="primary", use_container_width=True):
            try:
                supabase.table("picks").delete().eq("user_id", user.id).eq("week_number", CURRENT_WEEK).execute()
                for p in new_picks:
                    supabase.table("picks").insert({
                        "user_id": user.id, "username": username, "week_number": CURRENT_WEEK,
                        "game_id": p["game_id"], "selected_team": p["selected_team"],
                        "spread_at_pick": game_lookup.get(p["game_id"], {}).get("spread_value", ""),
                    }).execute()
                # One row per submission event (not per pick) -- a Database
                # Webhook on this table's INSERT is what triggers the admin
                # push notification, see supabase/functions/send-picks-push.
                try:
                    supabase.table("pick_submissions").insert({
                        "user_id": user.id, "username": username,
                        "week_number": CURRENT_WEEK, "picks_count": len(new_picks),
                    }).execute()
                except Exception:
                    pass  # non-critical -- picks themselves are already saved
                st.session_state.pending_resubmit = None
                st.rerun()
            except Exception as e:
                st.error(f"Database error: {e}")
    with col_no:
        if st.button("Cancel", use_container_width=True):
            st.session_state.pending_resubmit = None
            st.rerun()

st.set_page_config(page_title="Football Pick-7 Pool", page_icon="🏈", layout="wide")

# Reserve space for the fixed sticky bar defined later in this file. This has to
# happen here, before ANY other content (including the title), because a
# position:fixed element always renders at the same screen coordinate no matter
# where in the page it's actually defined -- so everything that would otherwise
# render underneath it needs to be pushed down first. Streamlit doesn't support
# true sticky/fixed containers natively (see streamlit/streamlit#7034, #9545),
# so this is a manual, best-effort spacer -- sized generously since the bar now
# holds two rows (the ticker + the button row). If there's a visible gap or
# overlap once this is live, tell me which direction it's off by and I'll
# adjust this one number.
st.markdown('<div style="margin-top: 10.5rem;"></div>', unsafe_allow_html=True)

st.title("🏈 Pick 7 Against The Spread")

# Password recovery landing. There are two different link formats to handle here:
#  1. The RAW link straight from the email itself: a supabase.co/auth/v1/verify
#     URL with a "token" query param. This one is easy -- it's a normal query
#     param (not a hash fragment), so Python can read it directly, and it can
#     be verified server-side via verify_otp(), no JavaScript needed at all.
#  2. The link Supabase redirects the browser TO after verifying #1: the app's
#     own URL with the tokens after a "#" (a "hash fragment"), which browsers
#     NEVER send to the server -- Python can't see this one at all without a
#     small script to move it into the query string first.
recovery_access_token = st.session_state.get("_recovery_access_token") or st.query_params.get("access_token")
recovery_refresh_token = st.session_state.get("_recovery_refresh_token") or st.query_params.get("refresh_token", "")

if not recovery_access_token and not st.session_state.get("user"):
    components.html("""
        <script>
        (function() {
            const hash = window.top.location.hash;
            if (hash && hash.includes('access_token') && hash.includes('type=recovery')) {
                const params = new URLSearchParams(hash.substring(1));
                const accessToken = params.get('access_token');
                const refreshToken = params.get('refresh_token');
                if (accessToken) {
                    const newUrl = window.top.location.pathname
                        + '?access_token=' + encodeURIComponent(accessToken)
                        + '&refresh_token=' + encodeURIComponent(refreshToken || '')
                        + '&type=recovery';
                    window.top.location.replace(newUrl);
                }
            }
        })();
        </script>
    """, height=0)

if recovery_access_token and not st.session_state.get("user"):
    st.subheader("🔑 Set a New Password")
    try:
        supabase.auth.set_session(recovery_access_token, recovery_refresh_token)
        with st.form("set_new_password_form"):
            new_pw = st.text_input("New password", type="password", key="recovery_new_pw")
            confirm_pw = st.text_input("Confirm new password", type="password", key="recovery_confirm_pw")
            submitted_new_pw = st.form_submit_button("Update Password", use_container_width=True)
        if submitted_new_pw:
            if not new_pw or new_pw != confirm_pw:
                st.error("Passwords must match and can't be blank.")
            else:
                try:
                    supabase.auth.update_user({"password": new_pw})
                    st.success("Password updated! Clear this link from your address bar, then log in with your new password below.")
                    st.query_params.clear()
                    st.session_state.pop("_recovery_access_token", None)
                    st.session_state.pop("_recovery_refresh_token", None)
                except Exception as e:
                    st.error(f"Couldn't update password: {e}")
    except Exception as e:
        st.error(f"This reset link is invalid or has expired -- request a new one below. ({e})")
        st.query_params.clear()
        st.session_state.pop("_recovery_access_token", None)
        st.session_state.pop("_recovery_refresh_token", None)
    st.stop()

# 2. Track user sessions
if "user" not in st.session_state:
    st.session_state.user = None

# Single-sign-on handoff from the PWA's Admin shortcut: the PWA (already
# logged in there) passes its own Supabase session tokens along as
# admin_sso_at/admin_sso_rt so an admin doesn't have to log in a second
# time here. Deliberately different param names from the password-recovery
# handling above (access_token/refresh_token) so the two flows can never be
# confused with each other or trigger the wrong one.
sso_access_token = st.query_params.get("admin_sso_at")
sso_refresh_token = st.query_params.get("admin_sso_rt")
if sso_access_token and not st.session_state.user:
    try:
        res = supabase.auth.set_session(sso_access_token, sso_refresh_token or "")
        st.session_state.user = res.user
        st.session_state.access_token = res.session.access_token
        st.session_state.refresh_token = res.session.refresh_token
    except Exception:
        pass  # invalid/expired handoff token -- fall through to the normal login screen
    finally:
        # Scrub the tokens out of the URL either way -- they've done their
        # job (or failed to) and shouldn't linger in the address bar/history.
        st.query_params.clear()
        st.rerun()

# 3. Secure Authentication Interface
if not st.session_state.user:
    tab1, tab2 = st.tabs(["Log In", "Sign Up"])
    with tab1:
        with st.form("login_form"):
            login_email = st.text_input("Email", key="l_email")
            login_pass = st.text_input("Password", type="password", key="l_pass")
            login_submitted = st.form_submit_button("Log In", use_container_width=True)
        if login_submitted:
            try:
                res = supabase.auth.sign_in_with_password({"email": login_email, "password": login_pass})
                st.session_state.user = res.user
                st.session_state.access_token = res.session.access_token
                st.session_state.refresh_token = res.session.refresh_token
                st.rerun()
            except Exception: st.error("Login failed. Check entries.")

        with st.expander("Forgot your password?"):
            with st.form("forgot_password_form"):
                reset_email = st.text_input("Email", key="reset_email")
                reset_submitted = st.form_submit_button("Send Reset Link")
            if reset_submitted:
                app_url = st.secrets.get("APP_URL")
                if not app_url:
                    st.error("APP_URL isn't set in secrets yet -- add your app's live URL first (see setup notes).")
                else:
                    try:
                        supabase.auth.reset_password_for_email(reset_email, {"redirect_to": app_url})
                        st.success("Email sent! Check below for how to use the link.")
                    except Exception as e:
                        st.error(f"Couldn't send reset email: {e}")

            st.divider()
            # This is the actual, reliable way to complete a password reset in
            # this app. Clicking the email link directly doesn't work reliably
            # here (Streamlit Cloud's iframe sandboxing blocks the script that
            # would otherwise catch the redirect), and since the link is
            # single-use, clicking it first would burn it before ever reaching
            # this box anyway. Copying it without clicking sidesteps that.
            st.info("📋 **Don't click the link in your email.** Right-click it, choose **Copy Link Address**, and paste it below instead.")
            pasted_link = st.text_input("Paste your reset link here:", key="pasted_reset_link")
            if pasted_link:
                query_part = pasted_link.split("?", 1)[1] if "?" in pasted_link else ""
                hash_part = pasted_link.split("#", 1)[1] if "#" in pasted_link else ""
                query_parsed = parse_qs(query_part)
                hash_parsed = parse_qs(hash_part)

                raw_token_hash = query_parsed.get("token", [None])[0]
                pasted_access_token = hash_parsed.get("access_token", query_parsed.get("access_token", [None]))[0]
                pasted_refresh_token = hash_parsed.get("refresh_token", query_parsed.get("refresh_token", [None]))[0]
                pasted_type = hash_parsed.get("type", query_parsed.get("type", [None]))[0]

                if raw_token_hash and pasted_type == "recovery":
                    # The raw email link -- verify it directly, no hash/JS needed.
                    try:
                        res = supabase.auth.verify_otp({"token_hash": raw_token_hash, "type": "recovery"})
                        st.session_state["_recovery_access_token"] = res.session.access_token
                        st.session_state["_recovery_refresh_token"] = res.session.refresh_token
                        st.rerun()
                    except Exception as e:
                        st.error(f"That link didn't work: {e}. If you clicked it before pasting it, request a fresh one -- each link only works once.")
                elif pasted_access_token and pasted_type == "recovery":
                    st.query_params["access_token"] = pasted_access_token
                    st.query_params["refresh_token"] = pasted_refresh_token or ""
                    st.query_params["type"] = "recovery"
                    st.rerun()
                else:
                    st.error("Couldn't find a reset token in that link -- make sure you pasted the entire thing.")
    with tab2:
        with st.form("signup_form"):
            signup_email = st.text_input("Email", key="s_email")
            signup_pass = st.text_input("Password", type="password", key="s_pass")
            signup_username = st.text_input("Display name", key="s_username")
            signup_submitted = st.form_submit_button("Sign Up", use_container_width=True)
        if signup_submitted:
            if not signup_username.strip():
                st.error("Please enter a display name.")
            else:
                try:
                    supabase.auth.sign_up({
                        "email": signup_email,
                        "password": signup_pass,
                        "options": {"data": {"username": signup_username.strip()}},
                    })
                    st.success("Account created! If your league requires email confirmation, check your inbox, then log in on the other tab.")
                except Exception as e:
                    st.error(f"Sign up failed: {e}")
    st.stop()

# --- Authenticated User Area Hub ---
user = st.session_state.user
if st.session_state.get("access_token"):
    try:
        supabase.auth.set_session(st.session_state.access_token, st.session_state.refresh_token)
    except Exception:
        # token expired or invalid -- force a fresh login
        st.session_state.user = None
        st.session_state.access_token = None
        st.rerun()
signup_username = user.user_metadata.get("username", user.email)
try:
    existing_player_row = supabase.table("players").select("username").eq("id", user.id).execute().data
    if existing_player_row:
        # Already on file -- use whatever name is there (an admin may have
        # renamed them since signup) instead of overwriting it back to the
        # name chosen at signup every time they log in.
        username = existing_player_row[0].get("username") or signup_username
    else:
        username = signup_username
        supabase.table("players").insert({"id": user.id, "username": username}).execute()
except Exception:
    username = signup_username  # non-critical -- don't block the session over this
st.sidebar.write(f"Logged in as: **{username}**")
if st.sidebar.button("Log Out", use_container_width=True):
    supabase.auth.sign_out()
    st.session_state.user = None
    st.rerun()

available_week_rows = supabase.table("games").select("week_number").execute().data
available_weeks = sorted({w["week_number"] for w in available_week_rows}, reverse=True)

if not available_weeks:
    st.info("No games have been loaded yet. Check back once the admin sets up a week.")
    st.stop()

# Bidirectional week sync with the Admin page (and Leaderboard), via a single
# shared "global_week" value. IMPORTANT: Streamlit deletes a widget's own
# session_state key entirely when you navigate away from the page it's on, so
# the widget key ("app_selected_week") must be reseeded from global_week
# whenever it's missing or invalid for this page -- not just "when global_week
# last changed" (that was the actual bug: the key can vanish from navigation
# even when global_week hasn't changed at all).
if "global_week" not in st.session_state:
    st.session_state["global_week"] = available_weeks[0]

if "app_selected_week" not in st.session_state or st.session_state["app_selected_week"] not in available_weeks:
    st.session_state["app_selected_week"] = (
        st.session_state["global_week"] if st.session_state["global_week"] in available_weeks else available_weeks[0]
    )

CURRENT_WEEK = st.selectbox("Select Week:", available_weeks, key="app_selected_week")

if CURRENT_WEEK != st.session_state["global_week"]:
    st.session_state["global_week"] = CURRENT_WEEK

st.header(f"Week {CURRENT_WEEK} Master Slate")
now = datetime.now(timezone.utc)
EASTERN_TZ = ZoneInfo("America/New_York")

# 4. Pull active week slate from database rows
try:
    all_games = supabase.table("games").select("*").eq("week_number", CURRENT_WEEK).execute().data
except Exception:
    all_games = []

# 5. 🌐 LIVE SCOREBOARD FEED FROM ESPN (fetch_live_scores is defined near the
# top of this file so the refresh controls above can call .clear() on it)
espn_scores = fetch_live_scores(all_games) if all_games else {}

if not all_games:
    st.info(f"No games loaded yet for Week {CURRENT_WEEK}.")
else:
    is_admin = False
    try:
        role_resp = supabase.table("league_users").select("role").eq("id", user.id).execute()
        if role_resp.data and role_resp.data[0].get("role") == "admin":
            is_admin = True
    except Exception:
        pass

    if is_admin:
        def build_slate_workbook_for_export(games_rows, week_number):
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

            sorted_for_export = sorted(games_rows, key=lambda g: g.get("kickoff_time") or "")
            for i, g in enumerate(sorted_for_export, start=1):
                fav_num, und_num = 2 * i - 1, 2 * i
                fav_t = g.get("favorite_team", "")
                und_t = g.get("underdog_team", "")
                fav_t = f"{fav_t} (Home)" if g.get("favorite_team_home") else fav_t
                und_t = f"{und_t} (Home)" if g.get("underdog_team_home") else und_t
                spread_number = (g.get("spread_value") or "").rsplit(" ", 1)[-1]

                kickoff_display = g.get("kickoff_time", "") or ""
                try:
                    kickoff_dt = datetime.fromisoformat(kickoff_display.replace("Z", "+00:00")).astimezone(ZoneInfo("America/New_York"))
                    kickoff_display = kickoff_dt.strftime("%a %m/%d %I:%M %p ET").replace(" 0", " ")
                except (ValueError, AttributeError):
                    pass

                ws.append([fav_num, fav_t, und_num, und_t, spread_number, kickoff_display, g.get("tv_network", "") or ""])
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

        slate_buffer = build_slate_workbook_for_export(all_games, CURRENT_WEEK)
        st.download_button(
            f"⬇️ Export Week {CURRENT_WEEK} Slate (.xlsx)",
            data=slate_buffer,
            file_name=f"week_{CURRENT_WEEK}_slate.xlsx",
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )

    all_games = sorted(all_games, key=lambda x: x.get("game_number") or 999)
    # Sort chronologically first so the day groups come out in calendar order below
    games_chronological = sorted(all_games, key=lambda g: g["kickoff_time"])

    # Each pick's radio (key=f"sel_{game_id}") starts with nothing selected
    # and never looks at the database on its own -- without this, switching
    # to a week you've already picked (including just reloading the page)
    # would show every game as unpicked. Only seed a key the very first
    # time it shows up in this session, so it never overwrites an edit
    # already in progress this session (e.g. mid-resubmit).
    # One query for everyone's picks this week -- existing_picks (mine) is
    # filtered out of it below, and the rest powers the "view someone else's
    # picks" selector further down. Reading other players' own picks table
    # rows is already how the Leaderboard page works for every logged-in
    # user, not just admins, so this doesn't open up anything new.
    week_picks_all = supabase.table("picks").select("*").eq("week_number", CURRENT_WEEK).execute().data
    existing_picks = [p for p in week_picks_all if p["user_id"] == user.id]
    pick_results_by_game = {}
    for _p in existing_picks:
        _sel_key = f"sel_{_p['game_id']}"
        if _sel_key not in st.session_state:
            st.session_state[_sel_key] = _p["selected_team"]
        pick_results_by_game[_p["game_id"]] = _p.get("result")

    picks_by_username_this_week = {}
    for _p in week_picks_all:
        picks_by_username_this_week.setdefault(_p.get("username", "Unknown"), []).append(_p)
    other_players_submitted = sorted(u for u in picks_by_username_this_week if u != username)

    current_picks_count = sum(1 for g in all_games if st.session_state.get(f"sel_{g['game_id']}") is not None)
    ui_max_reached = current_picks_count >= 7

    # Computed immediately (not inside the game-row loop below) so the Lock In
    # button can live in a sticky bar at the top, before any games have rendered.
    chosen_picks = [
        {"game_id": g["game_id"], "selected_team": st.session_state.get(f"sel_{g['game_id']}")}
        for g in all_games
        if st.session_state.get(f"sel_{g['game_id']}") is not None
    ]

    # 🔢 PICK BY NUMBER -- fills in the same dropdowns below rather than duplicating
    # the submit logic, so locking, resubmit protection, etc. all just work.
    with st.expander("🔢 Enter your picks by number instead"):
        numbers_map_player = compute_game_numbers(all_games)
        games_by_id_player = {g["game_id"]: g for g in all_games}
        number_lookup_player = {}
        for g in all_games:
            nums = numbers_map_player.get(g["game_id"], {})
            number_lookup_player[nums["fav_num"]] = {"game_id": g["game_id"], "team": g.get("favorite_team", "")}
            number_lookup_player[nums["und_num"]] = {"game_id": g["game_id"], "team": g.get("underdog_team", "")}

        numbers_text = st.text_input(
            "Your 7 picks, comma-separated (e.g. 1,5,9,12,23,78,100):",
            key="picks_by_number_input",
        )

        if st.button("Preview My Picks", key="preview_picks_by_number"):
            raw_parts = [p.strip() for p in numbers_text.split(",") if p.strip()]
            try:
                entered_numbers = [int(p) for p in raw_parts]
            except ValueError:
                entered_numbers = None
                st.error("Please enter numbers only, separated by commas.")

            if entered_numbers is not None:
                invalid_numbers = sorted({n for n in entered_numbers if n not in number_lookup_player})
                duplicate_numbers = sorted({n for n in entered_numbers if entered_numbers.count(n) > 1})

                locked_numbers = []
                for n in entered_numbers:
                    info = number_lookup_player.get(n)
                    if not info:
                        continue
                    g = games_by_id_player.get(info["game_id"], {})
                    try:
                        kickoff_dt = datetime.fromisoformat(g.get("kickoff_time", "").replace("Z", "+00:00"))
                        if now >= kickoff_dt:
                            locked_numbers.append(n)
                    except (ValueError, AttributeError):
                        pass

                if invalid_numbers:
                    st.error(f"These numbers don't match any game this week: {invalid_numbers}")
                elif duplicate_numbers:
                    st.error(f"These numbers were entered more than once: {duplicate_numbers}")
                elif locked_numbers:
                    st.error(f"These games have already started and can't be picked: {locked_numbers}")
                elif len(entered_numbers) != 7:
                    st.error(f"You entered {len(entered_numbers)} number(s) -- exactly 7 are required.")
                else:
                    preview_rows = []
                    resolved_picks = []
                    for n in entered_numbers:
                        info = number_lookup_player[n]
                        g = games_by_id_player[info["game_id"]]
                        preview_rows.append({
                            "#": n, "Team": info["team"],
                            "Matchup": g.get("display_text", ""), "Spread": g.get("spread_value", ""),
                        })
                        resolved_picks.append({"game_id": info["game_id"], "team": info["team"]})
                    st.session_state.pending_number_preview = {
                        "week": CURRENT_WEEK, "rows": preview_rows, "resolved": resolved_picks,
                    }
                    st.rerun()

        if st.session_state.get("pending_number_preview"):
            show_number_picks_preview(st.session_state.pending_number_preview)

    pct = min(current_picks_count / 7 * 100, 100)

    # CSS targets the container below by its Streamlit-assigned key class.
    # "fixed" (not "sticky") -- position:sticky is silently broken here because
    # a Streamlit ancestor container has overflow set for its own internal
    # scrolling, which disables sticky per the CSS spec (this is a documented,
    # open Streamlit limitation: streamlit/streamlit#7034, #9545). "fixed"
    # doesn't have that restriction, but it ignores document flow entirely and
    # always renders at the same screen coordinate -- which is why the matching
    # spacer at the very top of this file (before the title) has to exist, to
    # keep it from covering anything. left/width aren't set here in CSS -- a
    # small script below sets them directly, since CSS alone can't reliably
    # track the sidebar's live width or open/closed state (a "static position"
    # CSS-only approach was tried first but produced a shrink-to-fit width that
    # cut off content once the sidebar was open).
    st.markdown("""
        <style>
        div[class*="st-key-sticky_top_bar"] {
            position: fixed !important;
            top: 3.7rem;
            z-index: 9999;
            padding: 10px 20px 4px 20px;
            border-bottom: 2px solid var(--secondary-background-color, #333);
            box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
        }
        div[class*="st-key-sticky_top_bar"],
        div[class*="st-key-sticky_top_bar"] > div {
            background-color: var(--background-color, #0e1117) !important;
            opacity: 1 !important;
        }
        .sticky-ticker-track {
            background-color: var(--secondary-background-color, #333);
            border-radius: 6px;
            height: 8px;
            width: 100%;
            max-width: 500px;
            margin: 6px auto 10px auto;
            overflow: hidden;
        }
        .sticky-ticker-fill {
            background-color: var(--primary-color, #ff4b4b);
            height: 100%;
        }
        </style>
    """, unsafe_allow_html=True)

    # Keeps the sticky bar's left edge and width matched to the actual visible
    # content area (i.e., clear of the sidebar), and re-syncs continuously so it
    # adjusts the moment the sidebar opens, closes, or gets resized -- which is
    # also why the "games selected" ticker re-centers correctly either way: it's
    # centered within this same box, so once the box is sized right, so is it.
    components.html("""
        <script>
        function syncStickyBarToSidebar() {
            const doc = window.parent.document;
            const bar = doc.querySelector('div[class*="st-key-sticky_top_bar"]');
            if (!bar) return;
            const sidebar = doc.querySelector('[data-testid="stSidebar"]');
            let leftEdge = 0;
            if (sidebar) {
                const expanded = sidebar.getAttribute('aria-expanded');
                if (expanded === 'true') {
                    leftEdge = sidebar.getBoundingClientRect().right;
                }
            }
            bar.style.left = leftEdge + 'px';
            bar.style.width = (window.parent.innerWidth - leftEdge) + 'px';
        }
        syncStickyBarToSidebar();
        setInterval(syncStickyBarToSidebar, 400);
        window.parent.addEventListener('resize', syncStickyBarToSidebar);
        </script>
    """, height=0)

    with st.container(key="sticky_top_bar"):
        st.markdown(f"""
            <div style="text-align: center; font-weight: 600;">
                🏈 {current_picks_count} of 7 games selected
                <div class="sticky-ticker-track">
                    <div class="sticky-ticker-fill" style="width: {pct}%;"></div>
                </div>
            </div>
        """, unsafe_allow_html=True)

        game_lookup = {g["game_id"]: g for g in all_games}
        already_submitted = bool(existing_picks)  # fetched above, before the game rows render

        col_lock, col_refresh_btn, col_auto_toggle, col_auto_interval = st.columns([2, 1, 1, 1])
        with col_lock:
            lock_clicked = st.button("Lock In Weekly Picks", type="primary", use_container_width=True)
        with col_refresh_btn:
            if st.button("🔄 Refresh Scores", use_container_width=True):
                fetch_live_scores.clear()
                st.rerun()
        with col_auto_toggle:
            auto_refresh_on = st.checkbox("Auto-refresh", key="auto_refresh_enabled")
        with col_auto_interval:
            if auto_refresh_on:
                interval_label = st.selectbox(
                    "Every:", ["60 sec", "2 min", "5 min"], key="auto_refresh_interval", label_visibility="collapsed",
                )
                interval_seconds = {"60 sec": 60, "2 min": 120, "5 min": 300}[interval_label]
                st_autorefresh(interval=interval_seconds * 1000, key="scoreboard_autorefresh")

        if lock_clicked:
            if len(chosen_picks) != 7:
                st.error("Validation Error: You must pick exactly 7 games.")
            elif already_submitted:
                st.session_state.pending_resubmit = {
                    "existing_picks": existing_picks,
                    "new_picks": chosen_picks,
                    "game_lookup": game_lookup,
                }
                st.rerun()
            else:
                try:
                    supabase.table("picks").delete().eq("user_id", user.id).eq("week_number", CURRENT_WEEK).execute()
                    for p in chosen_picks:
                        supabase.table("picks").insert({
                            "user_id": user.id, "username": username, "week_number": CURRENT_WEEK,
                            "game_id": p["game_id"], "selected_team": p["selected_team"],
                            "spread_at_pick": game_lookup.get(p["game_id"], {}).get("spread_value", ""),
                        }).execute()
                    # One row per submission event (not per pick) -- a Database
                    # Webhook on this table's INSERT is what triggers the admin
                    # push notification, see supabase/functions/send-picks-push.
                    try:
                        supabase.table("pick_submissions").insert({
                            "user_id": user.id, "username": username,
                            "week_number": CURRENT_WEEK, "picks_count": len(chosen_picks),
                        }).execute()
                    except Exception:
                        pass  # non-critical -- picks themselves are already saved
                    st.success("Boom! Your 7 picks are saved securely.")

                    recap_rows = [
                        {
                            "selected_team": p["selected_team"],
                            "matchup": game_lookup.get(p["game_id"], {}).get("display_text", p["game_id"]),
                            "spread": game_lookup.get(p["game_id"], {}).get("spread_value", ""),
                        }
                        for p in chosen_picks
                    ]
                    show_picks_recap(recap_rows)
                except Exception as e:
                    st.error(f"Database error: {e}")

        # Checked every rerun (not just on the button click above) so the dialog's
        # own Yes/Cancel buttons get a chance to actually be detected as clicked.
        if st.session_state.get("pending_resubmit"):
            confirm_resubmit(
                st.session_state.pending_resubmit["existing_picks"],
                st.session_state.pending_resubmit["new_picks"],
                st.session_state.pending_resubmit["game_lookup"],
            )

    # Which games to actually show below: the full slate, just the games
    # you've picked, or -- read-only, and only once a game has kicked off,
    # so nobody can scout a still-editable pick -- another player's picks.
    # The selector can only ever offer players who've submitted at least
    # one pick this week (other_players_submitted, built above from the
    # week's picks rows), so there's no way to pick someone with nothing
    # submitted yet.
    st.write("---")
    view_scope_options = ["All games", "My picks"] + [f"{p}'s picks" for p in other_players_submitted]
    selected_view_scope = st.selectbox(
        "👀 Which games would you like to view?",
        view_scope_options,
        key=f"picks_view_scope_{CURRENT_WEEK}",
    )

    viewing_other_player = None
    other_picks_by_game = {}
    if selected_view_scope == "My picks":
        my_game_ids = {p["game_id"] for p in existing_picks}
        games_chronological = [g for g in games_chronological if g["game_id"] in my_game_ids]
        if not games_chronological:
            st.info("You haven't made any picks yet for this week.")
    elif selected_view_scope != "All games":
        viewing_other_player = selected_view_scope[: -len("'s picks")]
        other_picks_this_week = picks_by_username_this_week.get(viewing_other_player, [])
        other_picks_by_game = {p["game_id"]: p for p in other_picks_this_week}
        games_chronological = [g for g in games_chronological if g["game_id"] in other_picks_by_game]
        if not games_chronological:
            st.info(f"{viewing_other_player} hasn't picked any games yet for this week.")

    grouped_by_date = {}
    for game in games_chronological:
        kickoff_utc = datetime.fromisoformat(game['kickoff_time'].replace('Z', '+00:00'))
        kickoff_est = kickoff_utc.astimezone(EASTERN_TZ)
        date_str = kickoff_est.strftime("%A, %b %d")
        if date_str not in grouped_by_date:
            grouped_by_date[date_str] = []
        grouped_by_date[date_str].append((game, kickoff_est, kickoff_utc))

    for date_header, games_in_day in grouped_by_date.items():
        st.write("")
        st.markdown(f"### 📅 {date_header}")
        
        hdr_fav, hdr_und, hdr_spr, hdr_pck = st.columns(4)
        with hdr_fav: st.markdown("**FAVORITE**")
        with hdr_und: st.markdown("**UNDERDOG**")
        with hdr_spr: st.markdown("**SPREAD**")
        with hdr_pck:
            st.markdown(f"**{viewing_other_player.upper()}'S PICK**" if viewing_other_player else "**YOUR SELECTION**")
        st.divider()

        for game, kickoff_est, kickoff_utc in games_in_day:
            is_time_locked = now >= kickoff_utc
            time_str = kickoff_est.strftime("%I:%M %p ET").lstrip("0")
            
            fav_team = game.get("favorite_team", "Away Team")
            und_team = game.get("underdog_team", "Home Team")
            
            fav_label = f"{fav_team} 🏠" if game.get("favorite_team_home") else fav_team
            und_label = f"{und_team} 🏠" if game.get("underdog_team_home") else und_team

            # Once the game is graded, highlight whichever team covered.
            winning_team = game.get("winning_team")
            game_graded = game.get("status") == "final" and winning_team
            if game_graded and winning_team == fav_team:
                fav_label = f'<span style="color: #2ecc71;">✅ {fav_label}</span>'
            elif game_graded and winning_team == und_team:
                und_label = f'<span style="color: #2ecc71;">✅ {und_label}</span>'

            fav_score_text = ""
            und_score_text = ""
            status_ticker = f"`🕒 {time_str}`"
            live_line = game.get("spread_value", "0.0")

            live_data = espn_scores.get(game["game_id"])
            if not live_data and game_graded and game.get("home_score") is not None and game.get("away_score") is not None:
                # ESPN's live feed only really covers today's/this week's
                # games -- looking back at an old, already-graded week falls
                # back to the final score the admin's grading step saved
                # directly on this game, instead of showing a blank score.
                _fav_score = game["home_score"] if game.get("favorite_team_home") else game["away_score"]
                _und_score = game["home_score"] if game.get("underdog_team_home") else game["away_score"]
                fav_score_text = f"  \n**Score: {_fav_score}**"
                und_score_text = f"  \n**Score: {_und_score}**"
                status_ticker = "`🏁 FINAL`"
            elif live_data:
                # Update spreads dynamically from the live internet wire if present
                if live_data.get("line") and live_data["line"] != "0.0":
                    live_line = live_data["line"]

                state = live_data["state"]
                completed = live_data.get("completed", False)

                if completed:
                    fav_score = live_data["home_score"] if game.get("favorite_team_home") else live_data["away_score"]
                    und_score = live_data["home_score"] if game.get("underdog_team_home") else live_data["away_score"]
                    fav_score_text = f"  \n**Score: {fav_score}**"
                    und_score_text = f"  \n**Score: {und_score}**"
                    status_ticker = "`🏁 FINAL`"
                elif state == "in":
                    fav_score = live_data["home_score"] if game.get("favorite_team_home") else live_data["away_score"]
                    und_score = live_data["home_score"] if game.get("underdog_team_home") else live_data["away_score"]
                    fav_score_text = f"  \n**Score: {fav_score}**"
                    und_score_text = f"  \n**Score: {und_score}**"
                    status_ticker = f"`🔴 LIVE - {live_data['clock']}`"
                elif any(flag in live_data.get("status_name", "") for flag in ("DELAY", "POSTPON", "SUSPEND", "CANCEL")):
                    # Genuinely unusual -- e.g. "Weather Delay", "Postponed". Show
                    # ESPN's own description instead of the normal scheduled-time
                    # ticker, and definitely instead of falsely claiming FINAL.
                    status_ticker = f"`⏳ {live_data['clock']}`" if live_data.get("clock") else "`⏳ Delayed`"

            c_fav, c_und, c_spr, c_pck = st.columns(4)
            with c_fav: st.markdown(f"**{fav_label}**{fav_score_text}  \n{status_ticker}", unsafe_allow_html=True)
            with c_und: st.markdown(f"**{und_label}**{und_score_text}", unsafe_allow_html=True)
            with c_spr: st.markdown(f"`{live_line}`")
            with c_pck:
                if viewing_other_player:
                    # Read-only, and only for games that have actually kicked
                    # off -- never reveal another player's still-editable
                    # pick, only what they had locked in once it's too late
                    # to change anyway.
                    if is_time_locked:
                        other_pick = other_picks_by_game.get(game["game_id"], {})
                        other_team = other_pick.get("selected_team")
                        if other_team:
                            _result = other_pick.get("result")
                            _badge = " \u2705 Win" if _result == "win" else (" \u274C Loss" if _result == "loss" else "")
                            st.markdown(f"\U0001F464 {viewing_other_player} picked:  \n**{other_team}**{_badge}")
                        else:
                            st.caption("No pick found for this game.")
                    else:
                        st.caption("\U0001F512 Locks at kickoff -- check back after this game starts.")
                elif is_time_locked:
                    locked_team = st.session_state.get(f"sel_{game['game_id']}")
                    if locked_team:
                        _result = pick_results_by_game.get(game["game_id"])
                        _badge = " \u2705 Win" if _result == "win" else (" \u274C Loss" if _result == "loss" else "")
                        st.markdown(f"\U0001F512 You picked:  \n**{locked_team}**{_badge}")
                    else:
                        st.caption("\U0001F512 Locked -- no pick made")
                else:
                    is_current_empty = st.session_state.get(f"sel_{game['game_id']}") is None
                    should_disable = ui_max_reached and is_current_empty

                    # A radio group has no built-in way to click your way back
                    # to "nothing selected" -- clicking the already-chosen
                    # option again is simply a no-op. This is the only way to
                    # back out of a game once picked, short of the widget
                    # itself supporting it.
                    if not is_current_empty:
                        if st.button("✖ Clear", key=f"clear_{game['game_id']}", use_container_width=True):
                            st.session_state[f"sel_{game['game_id']}"] = None
                            st.rerun()

                    pick = st.radio(
                        "Choose", options=[fav_team, und_team], index=None, horizontal=True,
                        key=f"sel_{game['game_id']}", label_visibility="collapsed", disabled=should_disable
                    )

    st.divider()
    st.subheader("Your Submission Status")
    st.write(f"Total Games Selected: **{len(chosen_picks)} / 7**")
    st.caption("Use the 'Lock In Weekly Picks' button at the top of the page to submit.")
