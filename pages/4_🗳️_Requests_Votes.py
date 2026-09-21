import streamlit as st
import streamlit.components.v1 as components
import json
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

st.title("🗳️ Requests & Votes")
st.caption("Suggest something for the pool, or vote on what's currently open.")


def _tally_votes(poll_id):
    rows = supabase.table("poll_votes").select("option_id").eq("poll_id", poll_id).execute().data or []
    counts = {}
    for r in rows:
        oid = r["option_id"]
        counts[oid] = counts.get(oid, 0) + 1
    return counts


tab_vote, tab_request = st.tabs(["🗳️ Vote", "💡 Submit a Request"])

with tab_vote:
    st.subheader("Open Votes")
    open_polls = supabase.table("polls").select("*").eq("status", "open").order("created_at", desc=True).execute().data or []

    if not open_polls:
        st.caption("Nothing is open for a vote right now.")
    else:
        my_votes = supabase.table("poll_votes").select("*").eq("user_id", user.id).execute().data or []
        my_votes_by_poll = {v["poll_id"]: v for v in my_votes}

        for poll in open_polls:
            options = (
                supabase.table("poll_options").select("*").eq("poll_id", poll["id"])
                .order("sort_order").execute().data or []
            )
            option_labels = [o["label"] for o in options]
            option_by_label = {o["label"]: o["id"] for o in options}

            with st.container(border=True):
                st.markdown(f"**{poll['title']}**")
                if poll.get("description"):
                    st.caption(poll["description"])
                if poll["auto_close"] and poll.get("closes_at"):
                    closes_dt = datetime.fromisoformat(poll["closes_at"]).astimezone(ZoneInfo("America/New_York"))
                    st.caption(f"Voting closes {closes_dt:%b %d, %Y %I:%M %p %Z}")
                else:
                    st.caption("An admin will close this vote when ready")

                existing_vote = my_votes_by_poll.get(poll["id"])
                default_index = None
                if existing_vote:
                    existing_label = next((o["label"] for o in options if o["id"] == existing_vote["option_id"]), None)
                    if existing_label in option_labels:
                        default_index = option_labels.index(existing_label)

                choice = st.radio(
                    "Your answer:", option_labels, index=default_index,
                    key=f"vote_choice_{poll['id']}",
                )

                if st.button(
                    "Update my vote" if existing_vote else "Submit vote",
                    key=f"vote_submit_{poll['id']}", type="primary",
                ):
                    chosen_option_id = option_by_label[choice]
                    if existing_vote and existing_vote["option_id"] == chosen_option_id:
                        st.info("That's already your vote.")
                    else:
                        if existing_vote:
                            supabase.table("poll_votes").delete().eq("poll_id", poll["id"]).eq("user_id", user.id).execute()
                        supabase.table("poll_votes").insert({
                            "poll_id": poll["id"], "option_id": chosen_option_id, "user_id": user.id,
                        }).execute()
                        st.success("Vote recorded.")
                        st.rerun()

                tally = _tally_votes(poll["id"])
                total_votes = sum(tally.values())
                with st.expander(f"See current tally ({total_votes} vote(s) so far)"):
                    for opt in options:
                        count = tally.get(opt["id"], 0)
                        pct = (count / total_votes * 100) if total_votes else 0
                        st.write(f"{opt['label']} — {count} vote(s)")
                        st.progress(pct / 100)

    st.write("---")
    st.subheader("Past Results")
    closed_polls = (
        supabase.table("polls").select("*").eq("status", "closed")
        .order("closed_at", desc=True).limit(20).execute().data or []
    )
    if not closed_polls:
        st.caption("No votes have closed yet.")
    else:
        for poll in closed_polls:
            options = (
                supabase.table("poll_options").select("*").eq("poll_id", poll["id"])
                .order("sort_order").execute().data or []
            )
            tally = _tally_votes(poll["id"])
            winning_label = "No votes were cast"
            for opt in options:
                if opt["id"] == poll.get("result_option_id"):
                    winning_label = opt["label"]
                    break
            with st.expander(f"{poll['title']} — winner: {winning_label}"):
                for opt in options:
                    count = tally.get(opt["id"], 0)
                    marker = "🏆 " if opt["id"] == poll.get("result_option_id") else ""
                    st.write(f"{marker}{opt['label']} — {count} vote(s)")

with tab_request:
    st.subheader("Submit a Feature Request")
    st.caption("Have an idea for the app? Admins will review it, and it may get pushed out for a pool-wide vote.")

    request_title = st.text_input("What's your idea?", key="new_request_title")
    request_description = st.text_area("Details (optional)", key="new_request_description", height=100)

    if st.button("Submit Request", type="primary"):
        if not request_title.strip():
            st.warning("Give it a short title first.")
        else:
            supabase.table("feature_requests").insert({
                "requester_id": user.id,
                "title": request_title.strip(),
                "description": request_description.strip(),
            }).execute()
            st.success("Request submitted -- admins have been notified.")
            st.rerun()

    st.write("---")
    st.subheader("Your Requests")
    my_requests = (
        supabase.table("feature_requests").select("*").eq("requester_id", user.id)
        .order("created_at", desc=True).execute().data or []
    )
    if not my_requests:
        st.caption("You haven't submitted anything yet.")
    else:
        status_labels = {"pending": "⏳ Pending review", "accepted": "✅ Accepted", "denied": "❌ Denied"}
        for req in my_requests:
            with st.container(border=True):
                st.markdown(f"**{req['title']}** — {status_labels.get(req['status'], req['status'])}")
                if req.get("description"):
                    st.caption(req["description"])
                if req["status"] == "accepted" and req.get("poll_id"):
                    linked_poll = supabase.table("polls").select("status").eq("id", req["poll_id"]).maybe_single().execute().data
                    if linked_poll:
                        if linked_poll["status"] == "open":
                            st.caption("🗳️ It's open for a vote now -- check the Vote tab.")
                        else:
                            st.caption("📜 Voting has closed -- check Past Results in the Vote tab.")
