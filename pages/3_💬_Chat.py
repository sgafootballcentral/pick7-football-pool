import streamlit as st
import streamlit.components.v1 as components
import uuid
import json
from supabase import create_client, Client
from datetime import datetime
from zoneinfo import ZoneInfo
from streamlit_autorefresh import st_autorefresh

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

if "user" not in st.session_state or not st.session_state.user:
    st.warning("Please log in on the home page first.")
    st.stop()

user = st.session_state.user
username = user.user_metadata.get("username", user.email)

is_admin = False
try:
    role_resp = supabase.table("league_users").select("role").eq("id", user.id).execute()
    if role_resp.data and role_resp.data[0].get("role") == "admin":
        is_admin = True
except Exception:
    pass

st.title("💬 League Chat")
st.caption("Messages stay here for everyone to see until an admin removes them.")

# Same six quick-reaction emoji as the PWA's long-press picker (docs/js/chat.js)
# -- kept in sync there so both platforms offer the same "standard" set.
REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🔥"]


def toggle_reaction(message_id, emoji, mine):
    try:
        # Only one reaction per person per message -- clear whatever this
        # user already has here before adding the new one. Re-picking the
        # same emoji they already had just removes it, with no replacement.
        supabase.table("chat_reactions").delete().eq("message_id", message_id).eq("user_id", user.id).execute()
        if not mine:
            supabase.table("chat_reactions").insert({
                "message_id": message_id, "user_id": user.id, "username": username, "emoji": emoji,
            }).execute()
        st.rerun()
    except Exception as e:
        st.error(f"Couldn't update reaction: {e}")


def render_reaction_picker(message_id, by_emoji):
    """The popover's contents: the six standard emoji (tap to toggle), plus a
    text field for the 'full emoji picker' equivalent -- there's no way to pop
    the OS emoji keyboard from Streamlit, so typing or pasting any emoji here
    and hitting Add is the desktop/admin-page stand-in for that."""
    quick_cols = st.columns(len(REACTION_EMOJIS))
    for i, emoji in enumerate(REACTION_EMOJIS):
        with quick_cols[i]:
            mine = by_emoji.get(emoji, {}).get("mine", False)
            if st.button(emoji, key=f"quick_{message_id}_{emoji}", type="primary" if mine else "secondary", use_container_width=True):
                toggle_reaction(message_id, emoji, mine)
    custom_col, add_col = st.columns([3, 1])
    with custom_col:
        custom_emoji = st.text_input(
            "More", key=f"custom_input_{message_id}", max_chars=8, placeholder="or paste any emoji…", label_visibility="collapsed",
        )
    with add_col:
        if st.button("Add", key=f"custom_add_{message_id}", use_container_width=True) and custom_emoji.strip():
            mine = by_emoji.get(custom_emoji.strip(), {}).get("mine", False)
            toggle_reaction(message_id, custom_emoji.strip(), mine)


def storage_path_from_url(url):
    """Pull the path Supabase Storage actually needs (everything after the
    bucket name) back out of a public URL, so a delete can target the file."""
    if not url:
        return None
    marker = "/chat-images/"
    if marker in url:
        return url.split(marker, 1)[1]
    return None


@st.dialog("⚠️ Clear Entire Chat?")
def confirm_clear_chat():
    st.write("This will permanently delete **every message** in this chat, including any uploaded images/gifs. This cannot be undone.")
    col_yes, col_no = st.columns(2)
    with col_yes:
        confirm_clicked = st.button("Yes, clear everything", type="primary", use_container_width=True)
    with col_no:
        cancel_clicked = st.button("Cancel", use_container_width=True)

    if confirm_clicked:
        try:
            all_msgs = supabase.table("chat_messages").select("image_url").execute().data
            image_paths = [p for p in (storage_path_from_url(m.get("image_url")) for m in all_msgs) if p]
            if image_paths:
                try:
                    supabase.storage.from_("chat-images").remove(image_paths)
                except Exception:
                    pass  # don't let a storage hiccup block clearing the messages themselves
            supabase.table("chat_messages").delete().gte("id", 0).execute()
            st.session_state.pending_clear_chat = False
            st.rerun()
        except Exception as e:
            st.error(f"Database error: {e}")
    elif cancel_clicked:
        st.session_state.pending_clear_chat = False
        st.rerun()


col_refresh, col_auto, col_interval, col_clear = st.columns([1, 1, 1, 1])
with col_refresh:
    if st.button("🔄 Refresh Now"):
        st.rerun()
with col_auto:
    auto_refresh_on = st.checkbox("Auto-refresh", value=True, key="chat_auto_refresh_enabled")
with col_interval:
    if auto_refresh_on:
        interval_label = st.selectbox(
            "Every:", ["5 sec", "15 sec", "30 sec"], key="chat_auto_refresh_interval", label_visibility="collapsed",
        )
        interval_seconds = {"5 sec": 5, "15 sec": 15, "30 sec": 30}[interval_label]
        st_autorefresh(interval=interval_seconds * 1000, key="chat_autorefresh")
with col_clear:
    if is_admin:
        if st.button("🗑️ Clear All", use_container_width=True):
            st.session_state.pending_clear_chat = True
            st.rerun()

if st.session_state.get("pending_clear_chat"):
    confirm_clear_chat()

st.divider()

EASTERN_TZ = ZoneInfo("America/New_York")
messages = supabase.table("chat_messages").select("*").order("created_at").execute().data
all_reactions = supabase.table("chat_reactions").select("*").execute().data

reactions_by_message = {}
for r in all_reactions:
    by_emoji = reactions_by_message.setdefault(r["message_id"], {})
    entry = by_emoji.setdefault(r["emoji"], {"count": 0, "mine": False, "usernames": []})
    entry["count"] += 1
    entry["usernames"].append(r.get("username") or "Someone")
    if r["user_id"] == user.id:
        entry["mine"] = True

if not messages:
    st.info("No messages yet -- be the first to say something.")
else:
    for m in messages:
        role = "user" if m["user_id"] == user.id else "assistant"
        with st.chat_message(role):
            try:
                ts = datetime.fromisoformat(m["created_at"].replace("Z", "+00:00")).astimezone(EASTERN_TZ)
                time_str = ts.strftime("%a %m/%d %I:%M %p")
            except (ValueError, AttributeError):
                time_str = ""
            st.markdown(f"**{m['username']}**  ·  _{time_str}_")
            if m.get("message"):
                st.write(m["message"])
            if m.get("image_url"):
                st.image(m["image_url"])

            by_emoji = reactions_by_message.get(m["id"], {})
            if by_emoji:
                chip_cols = st.columns(len(by_emoji) + 1)
                for i, (emoji, entry) in enumerate(by_emoji.items()):
                    with chip_cols[i]:
                        if st.button(
                            f"{emoji} {entry['count']}", key=f"chip_{m['id']}_{emoji}",
                            help=", ".join(entry["usernames"]),
                            type="primary" if entry["mine"] else "secondary",
                        ):
                            toggle_reaction(m["id"], emoji, entry["mine"])
                with chip_cols[-1]:
                    with st.popover("➕"):
                        render_reaction_picker(m["id"], by_emoji)
            else:
                with st.popover("🙂 React"):
                    render_reaction_picker(m["id"], by_emoji)

            if is_admin:
                if st.button("🗑️ Delete", key=f"delete_msg_{m['id']}"):
                    try:
                        image_path = storage_path_from_url(m.get("image_url"))
                        if image_path:
                            try:
                                supabase.storage.from_("chat-images").remove([image_path])
                            except Exception:
                                pass
                        supabase.table("chat_messages").delete().eq("id", m["id"]).execute()
                        st.rerun()
                    except Exception as e:
                        st.error(f"Database error: {e}")

new_prompt = st.chat_input(
    "Type a message and/or attach an image or gif...",
    accept_file=True,
    file_type=["png", "jpg", "jpeg", "gif", "webp"],
)
if new_prompt:
    text = (new_prompt.text or "").strip()
    image_url = None

    if new_prompt["files"]:
        uploaded_file = new_prompt["files"][0]
        try:
            file_bytes = uploaded_file.getvalue()
            file_ext = uploaded_file.name.rsplit(".", 1)[-1].lower() if "." in uploaded_file.name else "png"
            storage_path = f"{user.id}/{uuid.uuid4().hex}.{file_ext}"
            content_type = uploaded_file.type or "application/octet-stream"
            supabase.storage.from_("chat-images").upload(
                storage_path, file_bytes, {"content-type": content_type}
            )
            image_url = supabase.storage.from_("chat-images").get_public_url(storage_path)
        except Exception as e:
            st.error(f"Image upload failed: {e}")

    if text or image_url:
        try:
            supabase.table("chat_messages").insert({
                "user_id": user.id,
                "username": username,
                "message": text,
                "image_url": image_url,
            }).execute()
            st.rerun()
        except Exception as e:
            st.error(f"Database error: {e}")
