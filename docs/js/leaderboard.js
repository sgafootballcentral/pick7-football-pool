import { escapeHtml, avatarInnerHtml, fetchAvatarsByUsername } from "./app.js";
import { getSharedWeek, setSharedWeek } from "./weekState.js";

const MEDALS = { 1: "\u{1F947}", 2: "\u{1F948}", 3: "\u{1F949}" };

export function renderLeaderboard(el, { supabase, user, username, unreadDmSenders, markDmRead, currentSeason }) {
  // Falls back to Week 1 only if the Picks tab hasn't set a week yet this
  // session (Picks is the default tab, so in practice this almost always
  // already reflects whatever week the player was just looking at there).
  const s = {
    loading: true, error: "", picksData: [], avatars: {}, selectedWeek: getSharedWeek() || 1,
    seasons: [], selectedSeasonId: currentSeason?.id ?? null,
    profile: null, // { userId, username } when the profile sheet is open
    dm: null, // { otherId, otherUsername, messages, loading } when a DM thread is open
  };
  let dmTimer = null;

  function draw() {
    if (s.loading) {
      el.innerHTML = `<div class="centered"><div class="loading-spinner"></div></div>`;
      return;
    }
    if (s.error) {
      el.innerHTML = `<div class="error-msg">${escapeHtml(s.error)}</div>`;
      return;
    }
    if (!s.picksData.length) {
      el.innerHTML = `<h2>\u{1F3C6} League Standings</h2><div class="card">No player picks have been submitted yet in this league.</div>`;
      return;
    }

    const hasAnyGraded = s.picksData.some((r) => r.wins > 0 || r.losses > 0);
    if (!hasAnyGraded) {
      const roster = [...new Set(s.picksData.map((p) => p.username))];
      el.innerHTML = `
        <h2>\u{1F3C6} League Standings</h2>
        <div class="card">\u{1F3C8} Total standings will update here as soon as games are graded.</div>
        <h3>Active League Roster</h3>
        <div class="card">${roster.map((u) => `
          <div class="player-with-avatar" style="margin-bottom:6px;">
            <span class="avatar-circle-sm">${avatarInnerHtml(s.avatars[u]?.url, s.avatars[u]?.monogram, u)}</span>${escapeHtml(u)}
          </div>
        `).join("")}</div>
      `;
      return;
    }

    // Keyed by the stable user_id, never by the display name -- a rename
    // can never split or orphan someone's record here, because
    // picks_week_tallies (see the "avatars everywhere" migration) groups
    // by user_id in Postgres and joins in whatever the player's CURRENT
    // name is, live, every time this loads.
    const byPlayer = {};
    for (const r of s.picksData) {
      const rec = (byPlayer[r.user_id] ||= { user_id: r.user_id, username: r.username, wins: 0, losses: 0 });
      rec.wins += r.wins;
      rec.losses += r.losses;
    }
    const standings = Object.values(byPlayer).filter((r) => r.wins + r.losses > 0);
    standings.forEach((r) => (r.winPct = r.wins / (r.wins + r.losses)));
    standings.sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses));

    // Rank by wins, ties share a place (1-2-2-4), same as Excel's RANK().
    let lastWins = null, lastPlace = 0;
    standings.forEach((r, i) => {
      if (r.wins !== lastWins) { lastPlace = i + 1; lastWins = r.wins; }
      r.place = lastPlace;
    });

    // Rank change vs. the standings as of the week before the most recent
    // one with any graded games -- a lightweight "last week" comparison
    // computed from the same picks_week_tallies rows already loaded, no
    // extra query needed.
    const weeksWithData = [...new Set(s.picksData.filter((r) => r.wins + r.losses > 0).map((r) => r.week_number))].sort((a, b) => a - b);
    const latestWeek = weeksWithData[weeksWithData.length - 1];
    const priorByPlayer = {};
    if (latestWeek != null) {
      for (const r of s.picksData) {
        if (r.week_number >= latestWeek) continue;
        const rec = (priorByPlayer[r.user_id] ||= { wins: 0, losses: 0 });
        rec.wins += r.wins;
        rec.losses += r.losses;
      }
    }
    const priorList = Object.entries(priorByPlayer)
      .map(([uid, rec]) => ({ user_id: uid, ...rec }))
      .filter((r) => r.wins + r.losses > 0);
    priorList.sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses));
    let plw = null, plp = 0;
    priorList.forEach((r, i) => { if (r.wins !== plw) { plp = i + 1; plw = r.wins; } r.place = plp; });
    const priorPlaceByUser = Object.fromEntries(priorList.map((r) => [r.user_id, r.place]));

    function rankChipHtml(r) {
      const prior = priorPlaceByUser[r.user_id];
      if (prior == null) return `<span class="rank-chip same">NEW</span>`;
      const delta = prior - r.place;
      if (delta > 0) return `<span class="rank-chip up">▲${delta}</span>`;
      if (delta < 0) return `<span class="rank-chip down">▼${-delta}</span>`;
      return `<span class="rank-chip same">–</span>`;
    }

    // The view already has (at most) one row per player per week, so this
    // is a direct lookup rather than a re-aggregation.
    const weekByPlayer = {};
    for (const r of s.picksData) {
      if (r.week_number === s.selectedWeek) weekByPlayer[r.user_id] = { wins: r.wins, losses: r.losses };
    }

    const weekOptions = Array.from({ length: 16 }, (_, i) => i + 1);

    // The podium is for actual places 1, 2 and 3 ONLY -- never "whichever
    // 3 distinct place values happen to be smallest". A tie swallows places:
    // a 3-way tie for 1st leaves no place 2 or 3 at all (the next player is
    // 4th), and a 3-way tie for 2nd leaves no place 3 (the next player is
    // 5th) -- in both cases nobody belongs on the podium beyond whatever
    // place groups genuinely exist, and everyone else starts the table
    // below, however their actual place number reads.
    const TIER_BY_PLACE = { 1: "first", 2: "second", 3: "third" };
    const groupsByPlace = {};
    for (const pl of [1, 2, 3]) {
      const players = standings.filter((r) => r.place === pl);
      if (players.length) groupsByPlace[pl] = { place: pl, tier: TIER_BY_PLACE[pl], players };
    }
    const podiumGroups = Object.values(groupsByPlace);
    const restPlayers = standings.filter((r) => r.place > 3);
    // Visual layout convention: 2nd on the left, 1st in the center, 3rd on
    // the right -- any place without a group (swallowed by a tie above it)
    // is simply omitted rather than leaving an empty slot.
    const visualOrder = [2, 1, 3].map((pl) => groupsByPlace[pl]).filter(Boolean);

    function podiumTierHtml(group) {
      const { tier, players } = group;
      const medal = MEDALS[group.place];
      return `
        <div class="podium-item ${tier}">
          <div class="podium-players-stack">
            ${players.map((r) => {
              const wk = weekByPlayer[r.user_id] || { wins: 0, losses: 0 };
              return `
                <button type="button" class="podium-player" data-open-profile="${escapeHtml(r.user_id)}" data-open-profile-name="${escapeHtml(r.username)}">
                  <div class="podium-avatar-wrap">
                    <span class="avatar-circle-lg" style="${tier === "first" ? "width:62px;height:62px;font-size:1.3rem;" : "width:48px;height:48px;font-size:1rem;"}">${avatarInnerHtml(s.avatars[r.username]?.url, s.avatars[r.username]?.monogram, r.username)}</span>
                    <span class="podium-medal">${medal}</span>
                  </div>
                  <div class="podium-name">${escapeHtml(r.username)}${unreadDmSenders?.[r.user_id] ? `<span class="dm-unread-dot" title="New message"></span>` : ""}</div>
                  <div class="podium-record">${r.wins}–${r.losses} <span style="opacity:0.7;">overall</span></div>
                  <div class="podium-record">${(r.winPct * 100).toFixed(1)}% win · ${rankChipHtml(r)}</div>
                  <div class="podium-record">Wk ${s.selectedWeek}: ${wk.wins}–${wk.losses}</div>
                </button>
              `;
            }).join("")}
          </div>
          <div class="podium-platform">${players[0].place}</div>
        </div>
      `;
    }

    el.innerHTML = `
      <h2>\u{1F3C6} League Standings</h2>
      ${s.seasons.length > 1 ? `
        <div class="week-select-row">
          <label class="hint" style="white-space:nowrap;">Season:</label>
          <select id="lb-season-select">
            ${s.seasons.map((se) => `<option value="${se.id}" ${se.id === s.selectedSeasonId ? "selected" : ""}>${escapeHtml(se.label)}</option>`).join("")}
          </select>
        </div>
      ` : ""}
      <div class="week-select-row">
        <label class="hint" style="white-space:nowrap;">Show record for week:</label>
        <select id="lb-week-select">
          ${weekOptions.map((w) => `<option value="${w}" ${w === s.selectedWeek ? "selected" : ""}>${w}</option>`).join("")}
        </select>
      </div>

      ${podiumGroups.length ? `<div class="podium">${visualOrder.map(podiumTierHtml).join("")}</div>` : ""}

      <div style="overflow-x:auto;">
        <table class="standings">
          <thead><tr><th>Rank</th><th>Player</th><th>Overall</th><th>Week ${s.selectedWeek}</th><th>Win %</th><th>Trend</th></tr></thead>
          <tbody>
            ${(restPlayers.length ? restPlayers : standings).map((r) => {
              const wk = weekByPlayer[r.user_id] || { wins: 0, losses: 0 };
              const rankClass = r.place <= 3 ? `rank-${r.place}` : "";
              const isMe = r.user_id === user.id;
              return `<tr class="standings-clickable ${isMe ? "standings-me" : ""}" data-open-profile="${escapeHtml(r.user_id)}" data-open-profile-name="${escapeHtml(r.username)}">
                <td class="${rankClass}">${MEDALS[r.place] || r.place}</td>
                <td><span class="player-with-avatar"><span class="avatar-circle-sm">${avatarInnerHtml(s.avatars[r.username]?.url, s.avatars[r.username]?.monogram, r.username)}</span>${escapeHtml(r.username)}${isMe ? ` <span class="hint">(you)</span>` : ""}${unreadDmSenders?.[r.user_id] ? `<span class="dm-unread-dot" title="New message"></span>` : ""}</span></td>
                <td>${r.wins} | ${r.losses}</td>
                <td>${wk.wins} | ${wk.losses}</td>
                <td>${(r.winPct * 100).toFixed(1)}%</td>
                <td>${rankChipHtml(r)}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
      <div class="hint" style="margin-top:8px;">Tap a player to see their picture, full record, and send them a message.</div>
    `;

    el.querySelector("#lb-week-select").addEventListener("change", (e) => {
      s.selectedWeek = Number(e.target.value);
      setSharedWeek(s.selectedWeek);
      draw();
    });

    el.querySelector("#lb-season-select")?.addEventListener("change", async (e) => {
      s.selectedSeasonId = Number(e.target.value);
      await loadStandings();
    });

    el.querySelectorAll("[data-open-profile]").forEach((node) => {
      node.addEventListener("click", () => {
        openProfile(node.dataset.openProfile, node.dataset.openProfileName);
      });
    });

    const modalAlreadyOpen = !!document.querySelector(".modal-backdrop");
    if (s.profile && !modalAlreadyOpen) drawProfileModal(byPlayer);
    if (s.dm && !modalAlreadyOpen) drawDmModal();
  }

  function openProfile(userId, uname) {
    s.profile = { userId, username: uname };
    draw();
  }

  function drawProfileModal(byPlayer) {
    const { userId, username: uname } = s.profile;
    const rec = byPlayer[userId] || { wins: 0, losses: 0 };
    const weeks = s.picksData
      .filter((r) => r.user_id === userId && r.wins + r.losses > 0)
      .sort((a, b) => a.week_number - b.week_number);
    const isMe = userId === user.id;

    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = `
      <div class="modal-sheet">
        <div class="profile-head">
          <span class="avatar-circle-lg profile-avatar-xl">${avatarInnerHtml(s.avatars[uname]?.url, s.avatars[uname]?.monogram, uname)}</span>
          <h2 style="margin:0;">${escapeHtml(uname)}${isMe ? ` <span class="hint">(you)</span>` : ""}</h2>
          <div class="hint">${rec.wins}–${rec.losses} overall · ${rec.wins + rec.losses ? ((rec.wins / (rec.wins + rec.losses)) * 100).toFixed(1) : "0.0"}% win rate</div>
        </div>
        ${weeks.length ? `
          <table class="profile-weeks">
            <thead><tr><th>Week</th><th>W</th><th>L</th></tr></thead>
            <tbody>${weeks.map((w) => `<tr class="standings-clickable" data-week="${w.week_number}"><td>${w.week_number}</td><td>${w.wins}</td><td>${w.losses}</td></tr>`).join("")}</tbody>
          </table>
          <div class="hint" style="text-align:center; margin-top:6px;">Tap a week to see those picks.</div>
        ` : `<div class="hint" style="text-align:center;">No graded weeks yet.</div>`}
        <div class="btn-row" style="margin-top:14px;">
          ${!isMe ? `<button class="btn btn-primary" id="profile-message-btn">\u{1F4AC} Message ${escapeHtml(uname)}</button>` : ""}
          <button class="btn btn-secondary" id="profile-close-btn">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
    wrap.querySelectorAll("tr[data-week]").forEach((row) => {
      row.addEventListener("click", () => {
        openWeekPicksModal(userId, uname, Number(row.dataset.week));
      });
    });
    wrap.querySelector("#profile-close-btn").addEventListener("click", () => {
      s.profile = null;
      wrap.remove();
    });
    wrap.querySelector("#profile-message-btn")?.addEventListener("click", () => {
      s.profile = null;
      wrap.remove();
      openDmThread(userId, uname);
    });
  }

  // Opens on top of the profile sheet (its own stacked modal-backdrop, same
  // pattern as the DM thread / photo cropper elsewhere) and shows exactly
  // what a player picked that week -- matchup, their team, the spread they
  // picked it at, and the graded result if there is one. Scoped to
  // whichever season the Standings tab is currently showing, not always
  // the live current season, so this stays correct when looking at a past
  // season's final standings too.
  async function openWeekPicksModal(userId, uname, weekNumber) {
    const panel = document.createElement("div");
    panel.className = "modal-backdrop";
    document.body.appendChild(panel);

    panel.innerHTML = `
      <div class="modal-sheet">
        <h3 style="text-align:center; margin-top:0;">${escapeHtml(uname)} -- Week ${weekNumber}</h3>
        <div class="hint" style="text-align:center;">Loading…</div>
      </div>
    `;

    try {
      let picksQuery = supabase.from("picks").select("*").eq("user_id", userId).eq("week_number", weekNumber);
      let gamesQuery = supabase.from("games").select("*").eq("week_number", weekNumber);
      if (s.selectedSeasonId != null) {
        picksQuery = picksQuery.eq("season_id", s.selectedSeasonId);
        gamesQuery = gamesQuery.eq("season_id", s.selectedSeasonId);
      }
      const [{ data: picks, error: pErr }, { data: games, error: gErr }] = await Promise.all([picksQuery, gamesQuery]);
      if (pErr) throw pErr;
      if (gErr) throw gErr;

      const gameLookup = Object.fromEntries((games || []).map((g) => [g.game_id, g]));
      const rows = (picks || []).slice().sort((a, b) => {
        const ga = gameLookup[a.game_id], gb = gameLookup[b.game_id];
        return (ga?.kickoff_time || "").localeCompare(gb?.kickoff_time || "");
      });

      panel.innerHTML = `
        <div class="modal-sheet">
          <h3 style="text-align:center; margin-top:0;">${escapeHtml(uname)} -- Week ${weekNumber}</h3>
          ${rows.length ? rows.map((p) => {
            const g = gameLookup[p.game_id];
            const matchup = g ? `${g.favorite_team} vs ${g.underdog_team}` : p.game_id;
            const spread = p.spread_at_pick || g?.spread_value || "";
            const resultClass = p.result === "win" ? "win" : p.result === "loss" ? "loss" : "";
            const resultLabel = p.result === "win" ? "✓ Win" : p.result === "loss" ? "✗ Loss" : "Pending";
            return `
              <div class="game-card" style="margin-bottom:7px;">
                <div class="game-card-stripe ${resultClass}"></div>
                <div class="game-card-body">
                  <div class="game-card-top">
                    <div class="game-card-matchup">${escapeHtml(matchup)}</div>
                    <div class="game-card-meta"><span class="spread">${escapeHtml(spread)}</span></div>
                  </div>
                  <div class="game-card-pickrow ${resultClass === "win" ? "win-bg" : ""}">
                    <span class="label">Picked</span>
                    <span class="value">${escapeHtml(p.selected_team)}</span>
                    <span class="value ${resultClass}">${resultLabel}</span>
                  </div>
                </div>
              </div>
            `;
          }).join("") : `<div class="hint" style="text-align:center;">No picks on file for this week.</div>`}
          <button class="btn btn-secondary" id="week-picks-close-btn" style="margin-top:10px;">Close</button>
        </div>
      `;
      panel.querySelector("#week-picks-close-btn").addEventListener("click", () => panel.remove());
    } catch (e) {
      panel.innerHTML = `
        <div class="modal-sheet">
          <h3 style="text-align:center; margin-top:0;">${escapeHtml(uname)} -- Week ${weekNumber}</h3>
          <div class="error-msg" style="text-align:center;">Couldn't load picks: ${escapeHtml(e.message || String(e))}</div>
          <button class="btn btn-secondary" id="week-picks-close-btn" style="margin-top:10px;">Close</button>
        </div>
      `;
      panel.querySelector("#week-picks-close-btn").addEventListener("click", () => panel.remove());
    }
  }

  async function openDmThread(otherId, otherUsername) {
    markDmRead?.(otherId);
    s.dm = { otherId, otherUsername, messages: [], loading: true };
    draw();
    await loadDm();
    if (dmTimer) clearInterval(dmTimer);
    dmTimer = setInterval(loadDm, 4000);
  }

  function closeDm() {
    s.dm = null;
    if (dmTimer) { clearInterval(dmTimer); dmTimer = null; }
  }

  async function loadDm() {
    if (!s.dm) return;
    try {
      const { otherId } = s.dm;
      const { data, error } = await supabase.from("direct_messages").select("*")
        .or(`and(sender_id.eq.${user.id},recipient_id.eq.${otherId}),and(sender_id.eq.${otherId},recipient_id.eq.${user.id})`)
        .order("created_at", { ascending: true });
      if (error) throw error;
      s.dm.messages = data || [];
      s.dm.loading = false;
      redrawDmModal();
    } catch (e) {
      s.dm.loading = false;
      s.dm.error = e.message || "Couldn't load messages.";
      redrawDmModal();
    }
  }

  function dmMsgHtml(m) {
    const mine = m.sender_id === user.id;
    let timeStr = "";
    try {
      timeStr = new Date(m.created_at).toLocaleString("en-US", {
        month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
      });
    } catch (_) {}
    return `
      <div class="dm-msg ${mine ? "mine" : ""}">
        <div class="meta">${mine ? "You" : escapeHtml(s.dm.otherUsername)} · ${escapeHtml(timeStr)}</div>
        <div class="bubble">${escapeHtml(m.message)}</div>
      </div>
    `;
  }

  function drawDmModal() {
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.id = "dm-modal-backdrop";
    renderDmInner(wrap);
    document.body.appendChild(wrap);
  }

  function renderDmInner(wrap) {
    const { otherUsername, messages, loading, error } = s.dm;
    wrap.innerHTML = `
      <div class="modal-sheet">
        <h2 style="display:flex; align-items:center; gap:8px;">
          <span class="avatar-circle-sm">${avatarInnerHtml(s.avatars[otherUsername]?.url, s.avatars[otherUsername]?.monogram, otherUsername)}</span>
          ${escapeHtml(otherUsername)}
        </h2>
        ${error ? `<div class="error-msg">${escapeHtml(error)}</div>` : ""}
        <div class="dm-list" id="dm-list">
          ${loading ? `<div class="centered" style="min-height:0; padding:20px 0;"><div class="loading-spinner"></div></div>` : (
            messages.length ? messages.map(dmMsgHtml).join("") : `<div class="hint" style="text-align:center;">No messages yet — say hi!</div>`
          )}
        </div>
        <div class="dm-input-row">
          <textarea id="dm-text-input" placeholder="Message ${escapeHtml(otherUsername)}…" rows="1"></textarea>
          <button class="btn btn-primary" id="dm-send-btn">Send</button>
        </div>
        <button class="btn btn-secondary" id="dm-close-btn" style="margin-top:10px;">Close</button>
      </div>
    `;
    const list = wrap.querySelector("#dm-list");
    if (list) list.scrollTop = list.scrollHeight + 1000;

    wrap.querySelector("#dm-close-btn").addEventListener("click", () => {
      closeDm();
      wrap.remove();
    });
    const sendBtn = wrap.querySelector("#dm-send-btn");
    const textInput = wrap.querySelector("#dm-text-input");
    const send = async () => {
      const text = (textInput.value || "").trim();
      if (!text || !s.dm) return;
      sendBtn.disabled = true;
      try {
        const { error: insErr } = await supabase.from("direct_messages").insert({
          sender_id: user.id, recipient_id: s.dm.otherId, message: text,
        });
        if (insErr) throw insErr;
        textInput.value = "";
        await loadDm();
      } catch (e) {
        s.dm.error = "Couldn't send: " + (e.message || e);
        redrawDmModal();
      } finally {
        sendBtn.disabled = false;
      }
    };
    sendBtn.addEventListener("click", send);
    textInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
  }

  function redrawDmModal() {
    const wrap = document.getElementById("dm-modal-backdrop");
    if (wrap) renderDmInner(wrap);
  }

  // Re-usable for both the first load and a season-switch -- the season
  // dropdown only ever needs to swap this data and redraw, not reload the
  // whole page.
  async function loadStandings() {
    s.loading = true;
    draw();
    try {
      // picks_week_tallies is a Postgres view (user_id + week_number -> wins/
      // losses, with the player's current name and season_id joined in
      // live) instead of raw picks rows. Two things this fixes at once:
      // (1) the raw picks table recently passed Supabase's default 1000-row
      // API cap, which was silently truncating this unfiltered select and
      // producing wrong, randomly-shifting totals; (2) grouping by user_id
      // instead of by username means a display-name change can never split
      // or orphan anyone's record again, however the rename happens.
      let tallyQuery = supabase.from("picks_week_tallies").select("user_id, username, week_number, wins, losses, season_id");
      if (s.selectedSeasonId != null) tallyQuery = tallyQuery.eq("season_id", s.selectedSeasonId);
      const [{ data, error }, avatars] = await Promise.all([
        tallyQuery,
        fetchAvatarsByUsername(supabase),
      ]);
      if (error) throw error;
      s.picksData = data || [];
      s.avatars = avatars;
      s.loading = false;
      draw();
    } catch (e) {
      s.loading = false;
      s.error = e.message || "Couldn't load standings.";
      draw();
    }
  }

  (async function init() {
    try {
      const { data: seasons } = await supabase.from("seasons").select("id, year, label").order("year", { ascending: false });
      s.seasons = seasons || [];
      if (s.selectedSeasonId == null && s.seasons.length) s.selectedSeasonId = s.seasons[0].id;
    } catch (_) {
      s.seasons = [];
    }
    await loadStandings();
  })();

  draw();

  const observer = new MutationObserver(() => {
    if (!document.body.contains(el)) {
      if (dmTimer) clearInterval(dmTimer);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
