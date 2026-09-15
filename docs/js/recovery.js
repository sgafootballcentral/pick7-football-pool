import { escapeHtml } from "./app.js";

export function renderSetNewPassword(el, { supabase, onDone }) {
  let error = "";
  let busy = false;

  function draw() {
    el.innerHTML = `
      <div class="centered" style="min-height: 30vh;"><h1>\u{1F511} Set a New Password</h1></div>
      ${error ? `<div class="error-msg">${escapeHtml(error)}</div>` : ""}
      <form id="new-pw-form">
        <div class="field"><label>New password</label><input type="password" name="pw1" required minlength="6" autocomplete="new-password"></div>
        <div class="field"><label>Confirm password</label><input type="password" name="pw2" required minlength="6" autocomplete="new-password"></div>
        <button class="btn btn-primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Updating…" : "Update Password"}</button>
      </form>
    `;
    el.querySelector("#new-pw-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const pw1 = fd.get("pw1"), pw2 = fd.get("pw2");
      if (!pw1 || pw1 !== pw2) { error = "Passwords must match and can't be blank."; draw(); return; }
      busy = true; error = ""; draw();
      const { error: err } = await supabase.auth.updateUser({ password: pw1 });
      busy = false;
      if (err) { error = err.message || "Couldn't update password."; draw(); return; }
      onDone();
    });
  }

  draw();
}
