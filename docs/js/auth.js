import { escapeHtml } from "./app.js";

export function renderAuth(el, { supabase }) {
  let mode = "login"; // "login" | "signup" | "forgot"
  let error = "";
  let success = "";
  let busy = false;

  function draw() {
    el.innerHTML = `
      <div class="centered" style="min-height: 40vh; margin-bottom: 8px;">
        <h1>\u{1F3C8} Pick 7 Against The Spread</h1>
      </div>
      <div class="tabs">
        <button data-mode="login" class="${mode === "login" ? "active" : ""}">Log In</button>
        <button data-mode="signup" class="${mode === "signup" ? "active" : ""}">Sign Up</button>
      </div>
      ${error ? `<div class="error-msg">${escapeHtml(error)}</div>` : ""}
      ${success ? `<div class="success-msg">${escapeHtml(success)}</div>` : ""}
      <div id="auth-form"></div>
    `;
    el.querySelectorAll("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        mode = btn.dataset.mode;
        error = ""; success = "";
        draw();
      });
    });
    drawForm();
  }

  function wireEnterToNextField(form) {
    const inputs = Array.from(form.querySelectorAll("input"));
    inputs.forEach((input, i) => {
      const isLast = i === inputs.length - 1;
      input.setAttribute("enterkeyhint", isLast ? "go" : "next");
      if (!isLast) {
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            inputs[i + 1].focus();
          }
        });
      }
    });
  }

  function drawForm() {
    const formSlot = document.getElementById("auth-form");
    if (mode === "login") {
      formSlot.innerHTML = `
        <form id="login-form">
          <div class="field"><label>Email</label><input type="email" name="email" required autocomplete="email"></div>
          <div class="field"><label>Password</label><input type="password" name="password" required autocomplete="current-password"></div>
          <button class="btn btn-primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Logging in…" : "Log In"}</button>
        </form>
        <div style="text-align:center; margin-top:14px;">
          <button class="chat-delete" id="forgot-link" style="font-size:0.85rem;">Forgot your password?</button>
        </div>
      `;
      wireEnterToNextField(formSlot.querySelector("#login-form"));
      formSlot.querySelector("#login-form").addEventListener("submit", onLogin);
      formSlot.querySelector("#forgot-link").addEventListener("click", () => {
        mode = "forgot"; error = ""; success = "";
        draw();
      });
    } else if (mode === "signup") {
      formSlot.innerHTML = `
        <form id="signup-form">
          <div class="field">
            <label>Your name</label>
            <input type="text" name="full_name" required autocomplete="name">
            <div class="hint" style="margin-top:4px;">Just for the commissioner, so they know who you are -- not shown to other players.</div>
          </div>
          <div class="field">
            <label>Display name</label>
            <input type="text" name="username" required autocomplete="nickname">
            <div class="hint" style="margin-top:4px;">This is what other players will see on picks, the leaderboard, and chat.</div>
          </div>
          <div class="field"><label>Email</label><input type="email" name="email" required autocomplete="email"></div>
          <div class="field"><label>Password</label><input type="password" name="password" required autocomplete="new-password" minlength="6"></div>
          <button class="btn btn-primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Creating account…" : "Sign Up"}</button>
        </form>
      `;
      wireEnterToNextField(formSlot.querySelector("#signup-form"));
      formSlot.querySelector("#signup-form").addEventListener("submit", onSignup);
    } else {
      formSlot.innerHTML = `
        <p class="hint">Enter your email and we'll send a reset link.</p>
        <form id="forgot-form">
          <div class="field"><label>Email</label><input type="email" name="email" required autocomplete="email"></div>
          <button class="btn btn-primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Sending…" : "Send Reset Link"}</button>
        </form>
        <div style="text-align:center; margin-top:14px;">
          <button class="chat-delete" id="back-link" style="font-size:0.85rem;">&larr; Back to log in</button>
        </div>
      `;
      wireEnterToNextField(formSlot.querySelector("#forgot-form"));
      formSlot.querySelector("#forgot-form").addEventListener("submit", onForgot);
      formSlot.querySelector("#back-link").addEventListener("click", () => {
        mode = "login"; error = ""; success = "";
        draw();
      });
    }
  }

  async function onLogin(e) {
    e.preventDefault();
    error = ""; success = ""; busy = true; draw();
    const fd = new FormData(e.target);
    const { error: err } = await supabase.auth.signInWithPassword({
      email: fd.get("email"),
      password: fd.get("password"),
    });
    busy = false;
    if (err) { error = "Login failed. Check your email and password."; draw(); }
    // On success, app.js's onAuthStateChange listener takes over.
  }

  async function onSignup(e) {
    e.preventDefault();
    error = ""; success = ""; busy = true; draw();
    const fd = new FormData(e.target);
    const fullName = String(fd.get("full_name") || "").trim();
    const username = String(fd.get("username") || "").trim();
    if (!fullName) {
      error = "Please enter your name."; busy = false; draw(); return;
    }
    if (!username) {
      error = "Please enter a display name."; busy = false; draw(); return;
    }
    const { error: err } = await supabase.auth.signUp({
      email: fd.get("email"),
      password: fd.get("password"),
      options: { data: { username, full_name: fullName } },
    });
    busy = false;
    if (err) {
      error = err.message || "Sign up failed.";
    } else {
      success = "Account created! If your league requires email confirmation, check your inbox, then log in.";
      mode = "login";
    }
    draw();
  }

  async function onForgot(e) {
    e.preventDefault();
    error = ""; success = ""; busy = true; draw();
    const fd = new FormData(e.target);
    const redirectTo = window.location.origin + window.location.pathname;
    const { error: err } = await supabase.auth.resetPasswordForEmail(fd.get("email"), { redirectTo });
    busy = false;
    if (err) {
      error = err.message || "Couldn't send reset email.";
    } else {
      success = "Email sent! Click the link on your phone or computer to set a new password.";
    }
    draw();
  }

  draw();
}
