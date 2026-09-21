import { escapeHtml } from "./app.js";

export function renderRequestsVotes(el, { supabase, user }) {
  const s = {
    loading: true,
    error: "",
    subTab: "vote",
    openPolls: [],
    closedPolls: [],
    optionsByPoll: {},
    tallyByPoll: {},
    myVoteByPoll: {},
    myRequests: [],
    requestTitle: "",
    requestDescription: "",
  };

  function statusLabel(status) {
    if (status === "pending") return "⏳ Pending review";
    if (status === "accepted") return "✅ Accepted";
    if (status === "denied") return "❌ Denied";
    return status;
  }

  function pollClosesHtml(poll) {
    if (poll.auto_close && poll.closes_at) {
      let closesStr = "";
      try {
        closesStr = new Date(poll.closes_at).toLocaleString("en-US", {
          month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
        });
      } catch (_) {}
      return `<div class="hint">Voting closes ${escapeHtml(closesStr)}</div>`;
    }
    return `<div class="hint">An admin will close this vote when ready</div>`;
  }

  function tallyHtml(poll) {
    const options = s.optionsByPoll[poll.id] || [];
    const tally = s.tallyByPoll[poll.id] || {};
    const total = Object.values(tally).reduce((a, b) => a + b, 0);
    return `
      <details style="margin-top:10px;">
        <summary class="hint">See current tally (${total} vote${total === 1 ? "" : "s"} so far)</summary>
        ${options.map((o) => {
          const count = tally[o.id] || 0;
          const pct = total ? Math.round((count / total) * 100) : 0;
          return `
            <div style="margin-top:8px;">
              <div>${escapeHtml(o.label)} — ${count} vote${count === 1 ? "" : "s"}</div>
              <div class="progress-track"><div class="progress-fill" style="width:${pct}%;"></div></div>
            </div>
          `;
        }).join("")}
      </details>
    `;
  }

  function openPollHtml(poll) {
    const options = s.optionsByPoll[poll.id] || [];
    const myVote = s.myVoteByPoll[poll.id];
    return `
      <div class="card">
        <div style="font-weight:600;">${escapeHtml(poll.title)}</div>
        ${poll.description ? `<div class="hint" style="margin-top:2px;">${escapeHtml(poll.description)}</div>` : ""}
        ${pollClosesHtml(poll)}
        <div class="pick-choices" style="flex-direction:column; margin-top:10px;">
          ${options.map((o) => `
            <label class="pick-choice ${myVote === o.id ? "selected" : ""}" style="width:100%;">
              <input type="radio" name="poll_${poll.id}" data-vote-poll="${poll.id}" value="${o.id}" ${myVote === o.id ? "checked" : ""}>
              ${escapeHtml(o.label)}
            </label>
          `).join("")}
        </div>
        <div class="btn-row" style="margin-top:10px;">
          <button class="btn btn-primary" data-submit-vote="${poll.id}">${myVote ? "Update my vote" : "Submit vote"}</button>
        </div>
        ${tallyHtml(poll)}
      </div>
    `;
  }

  function closedPollHtml(poll) {
    const options = s.optionsByPoll[poll.id] || [];
    const tally = s.tallyByPoll[poll.id] || {};
    const winner = options.find((o) => o.id === poll.result_option_id);
    return `
      <details class="card">
        <summary style="font-weight:600; cursor:pointer;">${escapeHtml(poll.title)} — winner: ${escapeHtml(winner ? winner.label : "No votes were cast")}</summary>
        ${options.map((o) => {
          const count = tally[o.id] || 0;
          const marker = o.id === poll.result_option_id ? "\u{1F3C6} " : "";
          return `<div style="margin-top:6px;">${marker}${escapeHtml(o.label)} — ${count} vote${count === 1 ? "" : "s"}</div>`;
        }).join("")}
      </details>
    `;
  }

  function requestHtml(req) {
    let followUp = "";
    if (req.status === "accepted" && req.poll_id) {
      const poll = [...s.openPolls, ...s.closedPolls].find((p) => p.id === req.poll_id);
      if (poll) {
        followUp = poll.status === "open"
          ? `<div class="hint" style="margin-top:6px;">\u{1F5F3}️ It's open for a vote now -- check the Vote tab.</div>`
          : `<div class="hint" style="margin-top:6px;">\u{1F4DC} Voting has closed -- check Past Results in the Vote tab.</div>`;
      }
    } else if (req.status === "denied" && req.denial_reason) {
      followUp = `<div class="hint" style="margin-top:6px;">Admin note: ${escapeHtml(req.denial_reason)}</div>`;
    }
    return `
      <div class="card">
        <div style="font-weight:600;">${escapeHtml(req.title)} — ${statusLabel(req.status)}</div>
        ${req.description ? `<div class="hint" style="margin-top:2px;">${escapeHtml(req.description)}</div>` : ""}
        ${followUp}
      </div>
    `;
  }

  function draw() {
    if (s.loading) {
      el.innerHTML = `<div class="centered"><div class="loading-spinner"></div></div>`;
      return;
    }

    el.innerHTML = `
      <h2>\u{1F5F3}️ Requests & Votes</h2>
      <p class="hint">Suggest something for the pool, or vote on what's currently open.</p>
      ${s.error ? `<div class="error-msg">${escapeHtml(s.error)}</div>` : ""}
      <div class="tabs">
        <button data-subtab="vote" class="${s.subTab === "vote" ? "active" : ""}">\u{1F5F3}️ Vote</button>
        <button data-subtab="request" class="${s.subTab === "request" ? "active" : ""}">\u{1F4A1} Submit a Request</button>
      </div>
      <div id="rv-subtab-content"></div>
    `;

    el.querySelectorAll("[data-subtab]").forEach((btn) => {
      btn.addEventListener("click", () => { s.subTab = btn.dataset.subtab; draw(); });
    });

    const contentEl = el.querySelector("#rv-subtab-content");
    if (s.subTab === "vote") {
      contentEl.innerHTML = `
        <h3 style="margin-top:4px;">Open Votes</h3>
        ${s.openPolls.length ? s.openPolls.map(openPollHtml).join("") : `<div class="hint">Nothing is open for a vote right now.</div>`}
        <h3>Past Results</h3>
        ${s.closedPolls.length ? s.closedPolls.map(closedPollHtml).join("") : `<div class="hint">No votes have closed yet.</div>`}
      `;
      contentEl.querySelectorAll("[data-submit-vote]").forEach((btn) => {
        btn.addEventListener("click", () => onSubmitVote(btn.dataset.submitVote));
      });
    } else {
      contentEl.innerHTML = `
        <h3 style="margin-top:4px;">Submit a Feature Request</h3>
        <p class="hint">Have an idea for the app? Admins will review it, and it may get pushed out for a pool-wide vote.</p>
        <div class="field">
          <label>What's your idea?</label>
          <input type="text" id="rv-request-title" value="${escapeHtml(s.requestTitle)}">
        </div>
        <div class="field">
          <label>Details (optional)</label>
          <textarea id="rv-request-description" rows="3">${escapeHtml(s.requestDescription)}</textarea>
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" id="rv-request-submit">Submit Request</button>
        </div>
        <h3>Your Requests</h3>
        ${s.myRequests.length ? s.myRequests.map(requestHtml).join("") : `<div class="hint">You haven't submitted anything yet.</div>`}
      `;
      contentEl.querySelector("#rv-request-submit").addEventListener("click", onSubmitRequest);
    }
  }

  async function onSubmitVote(pollIdStr) {
    const pollId = Number(pollIdStr);
    const checked = el.querySelector(`input[name="poll_${pollId}"]:checked`);
    if (!checked) { s.error = "Pick an answer first."; draw(); return; }
    const optionId = Number(checked.value);
    const existing = s.myVoteByPoll[pollId];
    if (existing === optionId) { return; }

    try {
      if (existing) {
        const { error: delErr } = await supabase.from("poll_votes").delete().eq("poll_id", pollId).eq("user_id", user.id);
        if (delErr) throw delErr;
      }
      const { error: insErr } = await supabase.from("poll_votes").insert({ poll_id: pollId, option_id: optionId, user_id: user.id });
      if (insErr) throw insErr;
      s.error = "";
      await loadAll();
    } catch (e) {
      s.error = "Couldn't save your vote: " + (e.message || e);
      draw();
    }
  }

  async function onSubmitRequest() {
    const titleInput = el.querySelector("#rv-request-title");
    const descInput = el.querySelector("#rv-request-description");
    const title = (titleInput.value || "").trim();
    const description = (descInput.value || "").trim();
    if (!title) { s.error = "Give it a short title first."; draw(); return; }

    try {
      const { error } = await supabase.from("feature_requests").insert({
        requester_id: user.id, title, description,
      });
      if (error) throw error;
      s.requestTitle = "";
      s.requestDescription = "";
      s.error = "";
      await loadAll();
    } catch (e) {
      s.error = "Couldn't submit that: " + (e.message || e);
      draw();
    }
  }

  async function loadAll() {
    try {
      const [{ data: openPolls, error: openErr }, { data: closedPolls, error: closedErr }, { data: myRequests, error: reqErr }] = await Promise.all([
        supabase.from("polls").select("*").eq("status", "open").order("created_at", { ascending: false }),
        supabase.from("polls").select("*").eq("status", "closed").order("closed_at", { ascending: false }).limit(20),
        supabase.from("feature_requests").select("*").eq("requester_id", user.id).order("created_at", { ascending: false }),
      ]);
      if (openErr) throw openErr;
      if (closedErr) throw closedErr;
      if (reqErr) throw reqErr;

      s.openPolls = openPolls || [];
      s.closedPolls = closedPolls || [];
      s.myRequests = myRequests || [];

      const allPollIds = [...s.openPolls, ...s.closedPolls].map((p) => p.id);
      s.optionsByPoll = {};
      s.tallyByPoll = {};
      s.myVoteByPoll = {};

      if (allPollIds.length) {
        const [{ data: options, error: optErr }, { data: votes, error: voteErr }] = await Promise.all([
          supabase.from("poll_options").select("*").in("poll_id", allPollIds).order("sort_order", { ascending: true }),
          supabase.from("poll_votes").select("*").in("poll_id", allPollIds),
        ]);
        if (optErr) throw optErr;
        if (voteErr) throw voteErr;

        (options || []).forEach((o) => {
          (s.optionsByPoll[o.poll_id] = s.optionsByPoll[o.poll_id] || []).push(o);
        });
        (votes || []).forEach((v) => {
          s.tallyByPoll[v.poll_id] = s.tallyByPoll[v.poll_id] || {};
          s.tallyByPoll[v.poll_id][v.option_id] = (s.tallyByPoll[v.poll_id][v.option_id] || 0) + 1;
          if (v.user_id === user.id) s.myVoteByPoll[v.poll_id] = v.option_id;
        });
      }

      s.loading = false;
      draw();
    } catch (e) {
      s.loading = false;
      s.error = e.message || "Couldn't load requests & votes.";
      draw();
    }
  }

  loadAll();
  draw();
}
