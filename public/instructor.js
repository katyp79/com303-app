"use strict";
let KEY = sessionStorage.getItem("inst_key") || "";
let editingId = null;

const $ = s => document.querySelector(s);
const toast = m => { const t = $("#toast"); t.textContent = m; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 2400); };
const esc = s => (s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = d => new Date(d).toLocaleString();
// NOTE: dateStyle/timeStyle CANNOT be combined with timeZoneName (throws) — use explicit components.
const fmtTZ = d => new Date(d).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" });
const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
// word-level diff of original (spoken) vs submitted text → HTML with <del>/<ins>
function wordDiff(oldStr, newStr) {
  const a = (oldStr || "").split(/(\s+)/), b = (newStr || "").split(/(\s+)/);
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0, out = "";
  while (i < m && j < n) {
    if (a[i] === b[j]) { out += esc(b[j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { if (a[i].trim()) out += `<del>${esc(a[i])}</del>`; i++; }
    else { out += b[j].trim() ? `<ins>${esc(b[j])}</ins>` : esc(b[j]); j++; } // keep inserted spaces
  }
  while (i < m) { if (a[i].trim()) out += `<del>${esc(a[i])}</del>`; i++; }
  while (j < n) { out += b[j].trim() ? `<ins>${esc(b[j])}</ins>` : esc(b[j]); j++; }
  return out;
}

function headers(extra) { return Object.assign({ "x-instructor-key": KEY }, extra || {}); }
async function api(path, opts) {
  const r = await fetch(path, Object.assign({ headers: headers(opts && opts.json ? { "Content-Type": "application/json" } : {}) }, opts || {}));
  if (r.status === 401) { showLogin(); throw new Error("unauthorized"); }
  return r;
}

// ---------- tabs ----------
document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => switchView(b.dataset.view)));
function switchView(name) {
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + name));
  if (name === "assignments") loadAssignments();
  if (name === "submissions") { loadSubmissions(); startSubsAutoRefresh(); } else { stopSubsAutoRefresh(); }
}

// ---- live "recording now" indicator (auto-refreshes while on the Submissions tab) ----
let subsRefreshTimer = null;
function startSubsAutoRefresh() { stopSubsAutoRefresh(); subsRefreshTimer = setInterval(refreshSubsQuietly, 15000); }
function stopSubsAutoRefresh() { if (subsRefreshTimer) { clearInterval(subsRefreshTimer); subsRefreshTimer = null; } }
async function refreshSubsQuietly() {
  // re-fetch + re-render the list and active banner WITHOUT closing an open submission
  try { allSubs = await (await api("/api/submissions")).json(); renderSubs(); updateActiveNow(); } catch {}
}
function updateActiveNow() {
  const el = $("#active-now"); if (!el) return;
  const cutoff = Date.now() - 90000; // "active" = an in-progress session that pinged in the last 90s
  const live = allSubs.filter(s => s.status === "in-progress" && s.endedAt && s.endedAt > cutoff);
  if (live.length) {
    el.innerHTML = `<div class="banner warn">🔴 <strong>${live.length} student(s) recording right now</strong>: ${live.map(s => esc(s.studentName || "?")).join(", ")}. Don't restart or redeploy until they finish.</div>`;
  } else {
    el.innerHTML = `<div class="banner ok">✓ No one is recording right now — safe to restart / redeploy. <span class="footnote">(updates every 15s)</span></div>`;
  }
}

// ---------- boot / login ----------
(async function boot() {
  const h = await (await fetch("/api/health")).json();
  const sb = $("#status-banner");
  if (!h.hasKey) sb.innerHTML = `<div class="banner warn">⚠️ No Anthropic API key yet — conversations won't run. Add your key to the <code>.env</code> file and restart the app. Everything else works for setup.</div>`;
  else sb.innerHTML = `<div class="banner info">Model: <strong>${esc(h.model)}</strong>. Ready.</div>`;
  if (h.needsPassword && !KEY) showLogin();
})();
function showLogin() {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  $("#view-login").classList.add("active");
}
$("#login-btn").addEventListener("click", async () => {
  const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: $("#login-pw").value }) });
  if (!r.ok) return toast("Wrong password");
  const d = await r.json(); KEY = d.token || ""; sessionStorage.setItem("inst_key", KEY);
  switchView("create");
});

// ---------- create form ----------
$("#src-toggle").addEventListener("click", e => {
  const btn = e.target.closest("button"); if (!btn) return;
  $("#src-toggle").querySelectorAll("button").forEach(b => b.classList.toggle("on", b === btn));
  $("#src-pdf").style.display = btn.dataset.src === "pdf" ? "block" : "none";
  $("#src-text").style.display = btn.dataset.src === "text" ? "block" : "none";
});
function currentSrc() { return $("#src-toggle .on").dataset.src; }

const drop = $("#drop"), fpdf = $("#f-pdf");
drop.addEventListener("click", () => fpdf.click());
["dragover", "dragenter"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("hot"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("hot"); }));
drop.addEventListener("drop", e => { if (e.dataTransfer.files[0]) { fpdf.files = e.dataTransfer.files; showPdfName(); } });
fpdf.addEventListener("change", showPdfName);
function showPdfName() { const f = fpdf.files[0]; $("#pdf-name").textContent = f ? "Selected: " + f.name : ""; }

$("#f-text").addEventListener("input", () => {
  const v = $("#f-text").value.trim();
  $("#text-wc").textContent = (v ? v.split(/\s+/).length.toLocaleString() : 0) + " words";
});
$("#f-tuning").addEventListener("change", () => {
  $("#concepts-box").style.display = $("#f-tuning").value === "concepts" ? "block" : "none";
});

$("#reset-btn").addEventListener("click", resetForm);
function resetForm() {
  editingId = null;
  ["f-title", "f-text", "f-c1", "f-c2", "f-c3", "f-c4", "f-c5", "f-c6", "f-start", "f-end"].forEach(id => { const el = $("#" + id); if (el) el.value = ""; });
  $("#pdf-name").textContent = ""; fpdf.value = ""; $("#text-wc").textContent = "";
  $("#edit-note").textContent = "";
}

$("#save-btn").addEventListener("click", async () => {
  const title = $("#f-title").value.trim();
  if (!title) return toast("Add a title");
  const fd = new FormData();
  if (editingId) fd.append("id", editingId);
  fd.append("title", title);
  fd.append("subject", $("#f-subject").value);
  fd.append("gradeLevel", $("#f-grade").value);
  fd.append("tuning", $("#f-tuning").value);
  for (let i = 1; i <= 6; i++) fd.append("concept" + i, $("#f-c" + i).value);
  fd.append("maxQuestions", $("#f-maxq").value);
  fd.append("minWords", $("#f-minwords").value);
  fd.append("requireCamera", $("#f-camera").value);
  fd.append("feedbackMode", $("#f-feedback").value);
  fd.append("showReading", $("#f-showreading").value);
  fd.append("waitingTime", $("#f-waiting").value);

  if (currentSrc() === "pdf") {
    if (!fpdf.files[0] && !editingId) return toast("Choose a PDF (or switch to Paste text)");
    if (fpdf.files[0]) fd.append("pdf", fpdf.files[0]);
    if ($("#f-start").value) fd.append("startPage", $("#f-start").value);
    if ($("#f-end").value) fd.append("endPage", $("#f-end").value);
  } else {
    const t = $("#f-text").value.trim();
    if (!t && !editingId) return toast("Paste the module material text");
    fd.append("readingText", t);
  }

  $("#save-btn").disabled = true; $("#save-btn").textContent = "Saving…";
  try {
    const r = await api("/api/assignments", { method: "POST", body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "save failed");
    toast(editingId ? "Updated" : "Saved" + (d.wordCount ? ` · ${d.wordCount.toLocaleString()} words read` : ""));
    resetForm(); switchView("assignments");
  } catch (e) { toast(e.message); }
  finally { $("#save-btn").disabled = false; $("#save-btn").textContent = "Save assignment"; }
});

// ---------- assignments ----------
async function loadAssignments() {
  const box = $("#assignment-list");
  const list = await (await api("/api/assignments")).json();
  if (!list.length) { box.innerHTML = `<div class="empty">No assignments yet.</div>`; return; }
  box.innerHTML = "";
  list.forEach(a => {
    const link = location.origin + "/student.html?a=" + a.id;
    const el = document.createElement("div");
    el.className = "list-item";
    el.innerHTML = `<div style="flex:1">
        <div style="font-weight:650">${esc(a.title)}</div>
        <div class="meta">${esc(a.subject || "")} · ${a.wordCount ? a.wordCount.toLocaleString() + " words" : "no text"} · ${a.tuning === "concepts" ? (a.concepts.length + " concept(s)") : "AI-driven"} · ${a.responseCount} submission(s)</div></div>`;
    const mk = (t, cls, fn) => { const b = document.createElement("button"); b.className = "btn " + cls; b.textContent = t; b.style.fontSize = "13px"; b.onclick = fn; return b; };
    el.append(
      mk("Copy student link", "ghost", () => navigator.clipboard.writeText(link).then(() => toast("Link copied"))),
      mk("Edit", "subtle", () => editAssignment(a.id)),
      mk("Delete", "danger", async () => { if (confirm("Delete this assignment? Submissions are kept.")) { await api("/api/assignments/" + a.id, { method: "DELETE" }); loadAssignments(); } })
    );
    box.appendChild(el);
  });
}
async function editAssignment(id) {
  const a = (await (await api("/api/assignments")).json()).find(x => x.id === id);
  if (!a) return;
  editingId = id; switchView("create");
  $("#f-title").value = a.title; $("#f-subject").value = a.subject || "Communication"; $("#f-grade").value = a.gradeLevel || "College";
  $("#f-tuning").value = a.tuning; $("#f-tuning").dispatchEvent(new Event("change"));
  for (let i = 0; i < 6; i++) $("#f-c" + (i + 1)).value = a.concepts[i] || "";
  $("#f-maxq").value = a.maxQuestions; $("#f-minwords").value = a.minWords;
  $("#f-camera").value = String(a.requireCamera); $("#f-feedback").value = a.feedbackMode;
  $("#f-showreading").value = String(!!a.showReading);
  $("#f-waiting").value = String(a.waitingTime || 0);
  $("#edit-note").textContent = "Editing “" + a.title + "”. Re-upload the PDF only if you want to change the material.";
}

// ---------- submissions ----------
let allSubs = [];
$("#export-csv").addEventListener("click", () => {
  if (!allSubs.length) return toast("No submissions to export");
  const sel = $("#sub-filter").value;
  // key passed in the query string because a file download can't carry a custom header
  const url = "/api/submissions.csv?key=" + encodeURIComponent(KEY) + (sel ? "&assignmentId=" + encodeURIComponent(sel) : "");
  window.location = url;
});
$("#download-videos").addEventListener("click", () => {
  const sel = $("#sub-filter").value;
  window.location = "/api/videos.zip?key=" + encodeURIComponent(KEY) + (sel ? "&assignmentId=" + encodeURIComponent(sel) : "");
});
$("#purge-videos").addEventListener("click", async () => {
  const sel = $("#sub-filter").value;
  const scope = sel ? "this assignment" : "ALL assignments";
  if (!confirm("Delete the video files for " + scope + "?\n\nTranscripts and grades are KEPT. Make sure you've downloaded the videos first — this can't be undone.")) return;
  const r = await api("/api/purge-videos", { json: true, method: "POST", body: JSON.stringify({ assignmentId: sel || undefined }) });
  const d = await r.json().catch(() => ({}));
  toast(r.ok ? "Deleted " + (d.purged || 0) + " video(s); transcripts kept" : "Failed");
  loadSubmissions();
});
async function loadSubmissions() {
  allSubs = await (await api("/api/submissions")).json();
  const f = $("#sub-filter");
  const titles = {}; allSubs.forEach(s => titles[s.assignmentId] = s.assignmentTitle);
  f.innerHTML = `<option value="">All assignments</option>` + Object.entries(titles).map(([id, t]) => `<option value="${id}">${esc(t)}</option>`).join("");
  f.onchange = renderSubs; renderSubs(); updateActiveNow(); $("#sub-detail").style.display = "none";
}
function renderSubs() {
  const sel = $("#sub-filter").value;
  const rows = (sel ? allSubs.filter(s => s.assignmentId === sel) : allSubs);
  const box = $("#submission-list");
  if (!rows.length) { box.innerHTML = `<div class="empty">No submissions yet.</div>`; return; }
  box.innerHTML = "";
  rows.forEach(s => {
    const el = document.createElement("div"); el.className = "list-item";
    const fb = (s.status === "in-progress" ? `<span class="pill warn">⏳ incomplete</span> ` : "") + (s.grade != null && s.grade !== "" ? `<span class="pill good">grade: ${esc(s.grade)}</span> ` : (s.suggestedScore != null ? `<span class="pill muted">suggested: ${s.suggestedScore}</span> ` : "")) + (s.flaggedPaste ? `<span class="pill warn">⚠ pasted</span> ` : "") + (s.flaggedEdited ? `<span class="pill warn">✎ edited</span> ` : "") + (s.tabAway ? `<span class="pill warn">👁 away ${s.tabAway}×</span> ` : "") + (s.copies ? `<span class="pill warn">⎘ copied ${s.copies}×</span> ` : "") + (s.feedbackApproved ? `<span class="pill good">shared</span>` : "");
    el.innerHTML = `<div style="flex:1"><div style="font-weight:650">${esc(s.studentName)} ${s.studentId ? `<span class="meta">(${esc(s.studentId)})</span>` : ""}</div>
      <div class="meta">${s.studentEmail ? esc(s.studentEmail) + " · " : ""}${esc(s.assignmentTitle)} · ${fmt(s.submittedAt)} · ${s.hasVideo ? "🎥 video" : (s.videoPurgedAt ? "video offloaded" : "no video")}</div></div> ${fb}`;
    const open = document.createElement("button"); open.className = "btn subtle"; open.textContent = "Open"; open.style.fontSize = "13px";
    open.onclick = () => openSub(s.id); el.appendChild(open);
    box.appendChild(el);
  });
}
async function openSub(id) {
  const d = $("#sub-detail");
  try {
  const r = await api("/api/submissions/" + id);
  if (!r.ok) throw new Error("server returned " + r.status);
  const s = await r.json();
  const hist = Array.isArray(s.history) ? s.history : [];
  const dur = (s.startedAt && s.endedAt) ? ` · lasted ${mmss(s.endedAt - s.startedAt)}` : "";
  const startStr = s.startedAt ? fmtTZ(s.startedAt) : fmtTZ(s.submittedAt);

  let maxGapMs = 0;
  const transcript = hist.map((h, i) => {
    const who = h.role === "tutor" ? "Coach" : esc(s.studentName);
    const t = h.at ? `<span class="meta"> · ${fmtTZ(h.at)}</span>` : "";
    const jump = (s.hasVideo && h.videoOffsetMs != null)
      ? ` <a href="#" class="vjump" data-off="${Math.round(h.videoOffsetMs / 1000)}">▶ ${mmss(h.videoOffsetMs)}</a>` : "";
    let resp = "";
    if (h.role === "student" && h.at && i > 0 && hist[i - 1].role === "tutor" && hist[i - 1].at) {
      const gap = h.at - hist[i - 1].at;
      if (gap > maxGapMs) maxGapMs = gap;
      const longish = gap > 180000; // > 3 min from question to answer (60s think-time is allowed)
      resp = ` <span class="meta" style="${longish ? "color:var(--warn);font-weight:700" : ""}">⏱ ${mmss(gap)} to answer</span>`;
    }
    let edited = "";
    if (h.role === "student" && h.edited && h.spoken) {
      edited = `<div class="meta" style="margin:4px 0 0 14px;padding-left:8px;border-left:2px solid var(--warn)">`
        + `<span class="pill warn">✎ edited</span> originally transcribed: “${esc(h.spoken)}”`
        + `<div style="margin-top:2px">changes: ${wordDiff(h.spoken, h.text)}</div></div>`;
    }
    return `<div class="transcript-line"><span class="who">${who}:</span> ${esc(h.text)}${t}${resp}${jump}${edited}</div>`;
  }).join("");
  const longPause = maxGapMs > 180000;
  const watchBits = [
    s.tabAway ? `switched away from the page ${s.tabAway}×` : null,
    s.copies ? `copied text ${s.copies}×` : null,
    (s.pasteEvents && s.pasteEvents.length) ? `pasted ${s.pasteEvents.length}×` : null,
    longPause ? `a long pause before answering (${mmss(maxGapMs)})` : null
  ].filter(Boolean);
  // per-event detail with clickable jumps to that moment in the video
  const off = e => (s.hasVideo && e.videoOffsetMs != null) ? ` <a href="#" class="vjump" data-off="${Math.round(e.videoOffsetMs / 1000)}">▶ ${mmss(e.videoOffsetMs)}</a>` : "";
  const awayDetail = (s.awayEvents || []).map(e => `<li>Left the page for <strong>${mmss(e.durationMs)}</strong>${e.q ? ` (during Q${e.q})` : ""}${off(e)}</li>`).join("");
  const copyDetail = (s.copyEvents || []).map(e => `<li>Copied: “<em>${esc((e.text || "").trim() || "(nothing was selected)")}</em>”${e.q ? ` (Q${e.q})` : ""}${off(e)}</li>`).join("");
  const pasteDetail = (s.pasteEvents || []).map(e => `<li>Pasted into the answer: “<em>${esc((e.text || "").trim() || "(empty)")}</em>”${e.q ? ` (Q${e.q})` : ""}${off(e)}</li>`).join("");
  const integrityDetail = (awayDetail || copyDetail || pasteDetail)
    ? `<div class="banner warn" style="text-align:left">
        ${awayDetail ? `<div><strong>👁 Left the page:</strong></div><ul style="margin:4px 0 8px 18px">${awayDetail}</ul>` : ""}
        ${copyDetail ? `<div><strong>⎘ Copied text:</strong></div><ul style="margin:4px 0 8px 18px">${copyDetail}</ul>` : ""}
        ${pasteDetail ? `<div><strong>📋 Pasted in:</strong></div><ul style="margin:4px 0 0 18px">${pasteDetail}</ul>` : ""}
      </div>` : "";

  d.innerHTML = `<div class="row"><h2 style="margin:0">${esc(s.studentName)}</h2><span class="spacer"></span>
      <button class="btn danger" id="del-sub" style="font-size:13px">Delete submission + video</button></div>
    <p class="meta">${esc(s.assignmentTitle)}</p>
    <p class="meta">${s.studentEmail ? "✉ " + esc(s.studentEmail) + " · " : ""}${s.studentId ? "ID " + esc(s.studentId) : ""}</p>
    <p class="meta">🕒 Started ${startStr}${dur} · submitted ${fmtTZ(s.submittedAt)}</p>
    ${s.status === "in-progress" ? `<div class="banner warn">⏳ <strong>Not submitted.</strong> This attempt was autosaved but never completed — the student likely closed the tab or their device crashed mid-conversation. The partial transcript is below; there's no video or AI feedback for it. They may have a separate completed attempt.</div>` : ""}
    ${s.flaggedPaste ? `<div class="banner warn">⚠ This student <strong>pasted text</strong> into the answer box during the session. Compare the transcript against the video to confirm the words were actually spoken.</div>` : ""}
    ${s.flaggedEdited ? `<div class="banner warn">✎ This student <strong>edited the transcription</strong> of one or more spoken answers. The edited answers below show the original and exactly what changed.</div>` : ""}
    ${watchBits.length ? `<div class="banner warn">🔎 <strong>Worth a closer look:</strong> ${watchBits.join(" · ")}. These are signals, not proof — watch the video to judge for yourself.</div>` : ""}
    ${integrityDetail}
    ${s.hasVideo ? `<video id="sub-video" controls src="/api/video/${s.id}?key=${encodeURIComponent(KEY)}"></video>
      <div class="footnote" style="margin:6px 0 16px">▸ Click a <strong>▶ time</strong> beside any answer to jump the video to that moment. To keep this past your retention window, download it (right-click → Save) to your external drive, then delete the submission.</div>` :
      (s.videoPurgedAt ? `<div class="banner info">Video was offloaded/removed on ${fmtTZ(s.videoPurgedAt)}. Transcript kept below.</div>` : (s.videoError ? `<div class="banner warn">🎥 ${esc(s.videoError)}</div>` : ""))}
    ${s.hasAudio ? `<div style="margin:6px 0 16px"><div class="footnote" style="margin-bottom:4px">🔊 Audio backup${s.hasVideo ? "" : " — no video was captured, but here's the audio of what they said"}:</div><audio controls src="/api/audio/${s.id}?key=${encodeURIComponent(KEY)}" style="width:100%"></audio></div>` : ""}
    <h3>Transcript</h3><div class="reading-box">${transcript || "(empty)"}</div>
    <h3 style="margin-top:18px">AI feedback (for you to review)</h3>
    <textarea id="fb-text" rows="7">${esc(s.feedback || "")}</textarea>
    <div class="row" style="margin-top:10px">
      <button class="btn subtle" id="fb-gen">${s.feedback ? "Regenerate" : "Generate"} feedback</button>
      <button class="btn good" id="fb-approve">${s.feedbackApproved ? "Re-share with student" : "Approve & share with student"}</button>
      ${s.feedbackApproved ? `<span class="pill good">shared</span>` : ""}
    </div>
    <h3 style="margin-top:18px">Grade</h3>
    ${s.suggestedScore != null ? `<p class="meta">🤖 AI-suggested: <strong>${s.suggestedScore}/100</strong>${s.scoreRationale ? " — " + esc(s.scoreRationale) : ""} — you decide the final grade.</p>` : `<p class="meta">(No AI suggestion yet — needs an API key and a completed conversation.)</p>`}
    <div class="row" style="margin-top:6px">
      <input type="text" id="grade-input" style="max-width:180px" placeholder="e.g. 9/10, 85, or A-" value="${esc(s.grade != null ? s.grade : (s.suggestedScore != null ? String(s.suggestedScore) : ""))}"/>
      <button class="btn good" id="save-grade">Save grade</button>
      <span class="footnote" id="grade-status">${(s.grade != null && s.grade !== "") ? "saved ✓" : ""}</span>
    </div>`;
  d.style.display = "block";
  $("#del-sub").onclick = async () => { if (confirm("Delete this submission and its video permanently?")) { await api("/api/submissions/" + id, { method: "DELETE" }); $("#sub-detail").style.display = "none"; loadSubmissions(); } };
  $("#fb-gen").onclick = async () => {
    $("#fb-gen").disabled = true; $("#fb-gen").textContent = "Working…";
    const r = await api("/api/submissions/" + id + "/feedback", { method: "POST" });
    const dd = await r.json(); if (r.ok) $("#fb-text").value = dd.feedback; else toast(dd.error || "failed");
    $("#fb-gen").disabled = false; $("#fb-gen").textContent = "Regenerate feedback";
  };
  $("#fb-approve").onclick = async () => {
    await api("/api/submissions/" + id + "/approve", { json: true, method: "POST", body: JSON.stringify({ feedback: $("#fb-text").value }) });
    toast("Approved & shared"); loadSubmissions();
  };
  $("#save-grade").onclick = async () => {
    await api("/api/submissions/" + id + "/grade", { json: true, method: "POST", body: JSON.stringify({ grade: $("#grade-input").value }) });
    $("#grade-status").textContent = "saved ✓"; toast("Grade saved"); loadSubmissions();
  };
  d.querySelectorAll(".vjump").forEach(a => a.onclick = ev => {
    ev.preventDefault();
    const v = $("#sub-video"); if (!v) return;
    v.currentTime = parseFloat(a.dataset.off) || 0; v.play();
    if (v.scrollIntoView) v.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  if (d.scrollIntoView) d.scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    d.style.display = "block";
    d.innerHTML = `<div class="banner err">Couldn't open this submission: ${esc(e.message)}.<br>Try a hard refresh (Ctrl+Shift+R). If it persists, tell Claude this exact message.</div>`;
    console.error("openSub failed:", e);
  }
}
