import streamlit as st
import requests
import io
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

        params = {"limit": 1000, "dates": f"{min(kickoff_dates):%Y%m%d}-{max(kickoff_dates):%Y%m%d}"}
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
                st.session_state.pending_resubmit = None
                st.rerun()
            except Exception as e:
                st.error(f"Database error: {e}")
    with col_no:
        if st.button("Cancel", use_container_width=True):
            st.session_state.pending_resubmit = None
            st.rerun()

st.set_page_config(page_title="Football Pick-7 Pool", page_icon="🏈", layout="wide")
st.title("🏈 Pick 7 Against The Spread")

# 2. Track user sessions
if "user" not in st.session_state:
    st.session_state.user = None

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
username = user.user_metadata.get("username", user.email)
try:
    supabase.table("players").upsert({"id": user.id, "username": username}).execute()
except Exception:
    pass  # non-critical -- don't block the session over this
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

# Bidirectional week sync with the Admin page, via a single shared "global_week"
# value. Either page can change it; whichever page didn't just change it locally
# adopts the new value on its next run.
if "global_week" not in st.session_state:
    st.session_state["global_week"] = available_weeks[0]

if st.session_state.get("_app_last_seen_global") != st.session_state["global_week"]:
    if st.session_state["global_week"] in available_weeks:
        st.session_state["app_selected_week"] = st.session_state["global_week"]
    st.session_state["_app_last_seen_global"] = st.session_state["global_week"]

if st.session_state.get("app_selected_week") not in available_weeks:
    st.session_state["app_selected_week"] = available_weeks[0]

CURRENT_WEEK = st.selectbox("Select Week:", available_weeks, key="app_selected_week")

if CURRENT_WEEK != st.session_state["global_week"]:
    st.session_state["global_week"] = CURRENT_WEEK
    st.session_state["_app_last_seen_global"] = CURRENT_WEEK

st.header(f"Week {CURRENT_WEEK} Master Slate")
now = datetime.now(timezone.utc)
EASTERN_TZ = ZoneInfo("America/New_York")

# Score refresh controls. Auto-refresh options start at 60s (not 30s) since the
# underlying ESPN fetch is itself cached for 60s -- refreshing the page faster
# than the data can actually change would just show the same numbers twice.
col_refresh_btn, col_auto_toggle, col_auto_interval = st.columns([1, 1, 1])
with col_refresh_btn:
    if st.button("🔄 Refresh Scores Now"):
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

    current_picks_count = sum(1 for g in all_games if st.session_state.get(f"sel_{g['game_id']}", "-- Select --") != "-- Select --")
    ui_max_reached = current_picks_count >= 7

    # Computed immediately (not inside the game-row loop below) so the Lock In
    # button can live in a sticky bar at the top, before any games have rendered.
    chosen_picks = [
        {"game_id": g["game_id"], "selected_team": st.session_state.get(f"sel_{g['game_id']}")}
        for g in all_games
        if st.session_state.get(f"sel_{g['game_id']}", "-- Select --") != "-- Select --"
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

    # CSS targets the container below by its Streamlit-assigned key class. "sticky"
    # (not "fixed") is deliberate: it keeps the bar in its normal spot in the page
    # flow -- below the title, week selector, etc. -- until scrolling would carry
    # it off-screen, at which point it sticks in place. "fixed" ignores document
    # flow entirely and always renders at the same screen coordinate, which is
    # why the previous version covered the title from the moment the page loaded.
    st.markdown("""
        <style>
        div[class*="st-key-sticky_top_bar"] {
            position: sticky !important;
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
        existing_picks = supabase.table("picks").select("*").eq("user_id", user.id).eq("week_number", CURRENT_WEEK).execute().data
        already_submitted = bool(existing_picks)

        if st.button("Lock In Weekly Picks", type="primary", use_container_width=True):
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
        with hdr_pck: st.markdown("**YOUR SELECTION**")
        st.divider()

        for game, kickoff_est, kickoff_utc in games_in_day:
            is_time_locked = now >= kickoff_utc
            time_str = kickoff_est.strftime("%I:%M %p ET").lstrip("0")
            
            fav_team = game.get("favorite_team", "Away Team")
            und_team = game.get("underdog_team", "Home Team")
            
            fav_label = f"{fav_team} 🏠" if game.get("favorite_team_home") else fav_team
            und_label = f"{und_team} 🏠" if game.get("underdog_team_home") else und_team

            fav_score_text = ""
            und_score_text = ""
            status_ticker = f"`🕒 {time_str}`"
            live_line = game.get("spread_value", "0.0")

            live_data = espn_scores.get(game["game_id"])
            if live_data:
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
            with c_fav: st.markdown(f"**{fav_label}**{fav_score_text}  \n{status_ticker}")
            with c_und: st.markdown(f"**{und_label}**{und_score_text}")
            with c_spr: st.markdown(f"`{live_line}`")
            with c_pck:
                if is_time_locked:
                    st.button("🔒 Locked", key=f"lock_{game['game_id']}", disabled=True, use_container_width=True)
                else:
                    is_current_empty = st.session_state.get(f"sel_{game['game_id']}", "-- Select --") == "-- Select --"
                    should_disable = ui_max_reached and is_current_empty
                    
                    pick = st.selectbox(
                        "Choose", options=["-- Select --", fav_team, und_team], 
                        key=f"sel_{game['game_id']}", label_visibility="collapsed", disabled=should_disable
                    )

    st.divider()
    st.subheader("Your Submission Status")
    st.write(f"Total Games Selected: **{len(chosen_picks)} / 7**")
    st.caption("Use the 'Lock In Weekly Picks' button at the top of the page to submit.")
