// ---------------------------------------------------------------------------
// Fill these in with your Supabase project's values (Project Settings > API
// in the Supabase dashboard). The anon/public key is safe to ship in a
// client-side app like this one -- it only grants what your RLS policies
// allow, same as the Streamlit app's key already does.
// ---------------------------------------------------------------------------
window.APP_CONFIG = {
  SUPABASE_URL: "https://ccuodbluyunwdwybmtmb.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_OL9-2_3Sj7TodRQS1KTGyg_duJIBRrt",

  // Set after you deploy the get-live-scores Edge Function (see
  // supabase/functions/get-live-scores/README.md). Looks like:
  // "https://YOUR-PROJECT-REF.supabase.co/functions/v1/get-live-scores"
  LIVE_SCORES_URL: "https://ccuodbluyunwdwybmtmb.supabase.co/functions/v1/get-live-scores",

  // Your existing Streamlit app -- where the real Admin tools (weekly ESPN
  // sync, grading, exports, player management) still live. Admins see a
  // shortcut to this in the PWA's top bar.
  ADMIN_URL: "https://pick7-football-pool-akxf5scobqjcmpbjbfai9d.streamlit.app/",
};
