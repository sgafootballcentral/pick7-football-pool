import streamlit as st
import uuid
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

if st.session_state.get("access_token"):
    try:
        supabase.auth.set_session(st.session_state.access_token, st.session_state.refresh_token)
    except Exception:
        st.session_state.user = None
        st.session_state.access_token = None

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


@st.dialog("⚠️ Clear Entire Chat?")
def confirm_clear_chat():
    st.write("This will permanently delete **every message** in this chat. This cannot be undone.")
    col_yes, col_no = st.columns(2)
    with col_yes:
        confirm_clicked = st.button("Yes, clear everything", type="primary", use_container_width=True)
    with col_no:
        cancel_clicked = st.button("Cancel", use_container_width=True)

    if confirm_clicked:
        try:
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
    auto_refresh_on = st.checkbox("Auto-refresh", key="chat_auto_refresh_enabled")
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
            if is_admin:
                if st.button("🗑️ Delete", key=f"delete_msg_{m['id']}"):
                    try:
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
