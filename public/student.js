"use strict";
const $ = s => document.querySelector(s);
const toast = m => { const t = $("#toast"); t.textContent = m; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 2600); };
const esc = s => (s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const wordCount = s => (s.trim() ? s.trim().split(/\s+/).length : 0);

const params = new URLSearchParams(location.search);
const ASSIGNMENT_ID = params.get("a");

let assignment = null;
let history = [];          // [{role:'tutor'|'student', text}]
let student = { name: "", id: "" };
let mediaStream = null, mediaRecorder = null, videoChunks = [];
let audioRecorder = null, audioChunks = []; // separate audio-only backup, in case the video recording fails
let recordingStartedAt = null, sessionStartedAt = null;
// ---- AV reliability: detect/log capture gaps so the instructor knows if a recording is partial ----
const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
let recordingGaps = [];          // [{startOffsetMs, endOffsetMs|null, reason}] — stretches where capture dropped
let recordingEverStarted = false;
let recordingStoppedEarly = false;
let finishing = false, restarting = false;
function closeOpenGaps(prefix) {
  for (const g of recordingGaps) if (g.endOffsetMs == null && (!prefix || g.reason.startsWith(prefix))) g.endOffsetMs = videoOffsetMs();
}
function watchTrack(track) {
  const kind = track.kind; // "video" | "audio"
  track.addEventListener("mute", () => {
    if (!sessionActive || finishing || recordingGaps.length >= 200) return;
    recordingGaps.push({ startOffsetMs: videoOffsetMs(), endOffsetMs: null, reason: kind + " muted" });
  });
  track.addEventListener("unmute", () => { closeOpenGaps(kind + " muted"); });
  track.addEventListener("ended", () => {
    if (!sessionActive || finishing) return;
    recordingStoppedEarly = true;
    closeOpenGaps(kind);
    if (recordingGaps.length < 200) recordingGaps.push({ startOffsetMs: videoOffsetMs(), endOffsetMs: null, reason: kind + " ended (device lost)" });
    tryRestartRecording();
  });
}
function startRecorders(stream) {
  const wantVideo = assignment && assignment.requireCamera !== false;
  try {
    const recOpts = pickMime();
    recOpts.videoBitsPerSecond = 1000000; // ~1 Mbps
    recOpts.audioBitsPerSecond = 64000;
    mediaRecorder = new MediaRecorder(stream, recOpts);
    mediaRecorder.ondataavailable = e => { if (e.data && e.data.size) videoChunks.push(e.data); };
    mediaRecorder.onerror = () => { if (sessionActive && !finishing) { recordingStoppedEarly = true; tryRestartRecording(); } };
    mediaRecorder.start(1000);
    if (!recordingStartedAt) recordingStartedAt = Date.now();
    recordingEverStarted = true;
    $("#recdot").style.display = "inline-block";
    $("#cam-status").textContent = wantVideo ? "Recording video" : "Recording audio";
  } catch (e) { $("#cam-status").textContent = "Recording unavailable"; }
  // separate audio-only backup — survives even if the video recording fails (common on Safari)
  try {
    const audioStream = new MediaStream(stream.getAudioTracks());
    const aMime = pickAudioMime();
    audioRecorder = new MediaRecorder(audioStream, aMime ? { mimeType: aMime, audioBitsPerSecond: 64000 } : {});
    audioRecorder.ondataavailable = e => { if (e.data && e.data.size) audioChunks.push(e.data); };
    if (!recordingStartedAt) recordingStartedAt = Date.now();
    audioRecorder.start(1000);
  } catch (e) { /* no audio backup available on this browser */ }
}
async function tryRestartRecording() {
  if (!sessionActive || finishing || restarting) return;
  restarting = true;
  try {
    const wantVideo = assignment && assignment.requireCamera !== false;
    const fresh = await navigator.mediaDevices.getUserMedia(wantVideo ? { video: true, audio: AUDIO_CONSTRAINTS } : { audio: AUDIO_CONSTRAINTS });
    try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); } catch {}
    mediaStream = fresh;
    const cam = $("#cam"); if (cam) cam.srcObject = fresh;
    fresh.getTracks().forEach(watchTrack);
    startRecorders(fresh); // new segment appended to the same chunk arrays
    closeOpenGaps(); // capture resumed
  } catch (e) { /* couldn't reacquire — the open gap stays open → marked partial */ }
  restarting = false;
}
let sessionSeed = Math.floor(Math.random() * 1e9) + 1; // randomizes question order/angle per student
let sessionId = null; // unique id for this attempt, used to autosave progress server-side
let heartbeatTimer = null; // pings the server periodically so the instructor can see live sessions
function saveProgress() {
  if (!sessionId) return;
  fetch("/api/progress", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, assignmentId: ASSIGNMENT_ID, student, history, startedAt: sessionStartedAt, awayEvents, copyEvents, pasteEvents })
  }).catch(() => {}); // fire-and-forget; never block the conversation on this
}
let sessionActive = false; // true while a conversation is in progress and not yet submitted

// ---- integrity signals (not proof — just "worth a look", paired with the video) ----
let awayEvents = [];   // each time the student left the page: {videoOffsetMs, durationMs, q}
let copyEvents = [];   // each copy: {text, videoOffsetMs, q}
let pasteEvents = [];  // each paste into the answer box: {text, videoOffsetMs, q}
let awayStart = null;
const questionNum = () => history.filter(h => h.role === "tutor").length;
// "away" = the tab is hidden OR the window lost focus (e.g. alt-tabbed to another app/window).
// Only record stretches longer than 1.5s, so momentary focus blips (clicking the address bar) don't count.
function checkActivity() {
  const active = !document.hidden && document.hasFocus();
  if (!active && awayStart === null) {
    awayStart = Date.now();
  } else if (active && awayStart !== null) {
    const dur = Date.now() - awayStart;
    if (sessionActive && dur > 1500 && awayEvents.length < 100) {
      awayEvents.push({ videoOffsetMs: awayStart - (recordingStartedAt || awayStart), durationMs: dur, q: questionNum() });
    }
    awayStart = null;
  }
}
document.addEventListener("visibilitychange", checkActivity);
window.addEventListener("blur", checkActivity);
window.addEventListener("focus", checkActivity);
document.addEventListener("copy", () => {
  if (!sessionActive || copyEvents.length >= 100) return;
  const sel = (document.getSelection && document.getSelection().toString()) || "";
  copyEvents.push({ text: sel.slice(0, 1000), videoOffsetMs: videoOffsetMs(), q: questionNum() });
});

// Warn before closing the tab mid-conversation (browsers show a generic confirm dialog).
window.addEventListener("beforeunload", (e) => {
  if (sessionActive) { e.preventDefault(); e.returnValue = ""; }
});
const videoOffsetMs = () => (recordingStartedAt ? Date.now() - recordingStartedAt : null);
let recog = null, listening = false, waitTimer = null;
let recognizedText = ""; // the raw speech-to-text for the CURRENT answer (the "original")
let answerFirstWordAt = null, answerFirstWordOffsetMs = null; // when the student first started speaking this answer
let busy = false;
let pasteUsed = false; // flags if the student pasted into the answer box (integrity signal)
let timeOverFlag = false; // flags if the student went past the per-answer time limit on any answer
let manuallyEdited = false; // true only when the student actually types/edits (not the speech engine)

// ---------- load assignment ----------
(async function init() {
  if (!ASSIGNMENT_ID) { $("#msg").innerHTML = `<div class="banner err">This link is missing an assignment. Ask your instructor for the correct link.</div>`; return; }
  try {
    const r = await fetch("/api/assignments/" + ASSIGNMENT_ID + "/run");
    if (!r.ok) throw 0;
    assignment = await r.json();
  } catch { $("#msg").innerHTML = `<div class="banner err">Couldn't load this assignment. The link may be wrong, or the app isn't running.</div>`; return; }

  $("#intro").style.display = "block";
  $("#head-title").textContent = assignment.title;
  $("#intro-title").textContent = assignment.title;
  $("#intro-sub").textContent = `${assignment.subject || ""} · You'll have a short spoken conversation about this module's material.`;
  if (assignment.readingText) {
    $("#reading").textContent = assignment.readingText;
  } else {
    $("#reading-wrap").style.display = "none"; // source doc is private to the AI
  }
  if (assignment.requireCamera) $("#cam-note").style.display = "block";

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const sn = $("#speech-note");
  if (SR) {
    sn.className = "footnote";
    sn.textContent = "Tip: speak naturally — your spoken words turn into text automatically. (Use Chrome or Edge.)";
  } else {
    // Hard stop: this browser can't do voice. Don't let them start, and don't invite typing.
    sn.className = "banner err";
    sn.innerHTML = "🚫 <strong>This browser won't work for this assignment.</strong> It can't record spoken answers.<br><br>Please open this same link in <strong>Google Chrome</strong> or <strong>Microsoft Edge</strong> on a computer, and begin there. <span class='footnote'>(Chrome or Edge on a computer is the most reliable. Firefox isn't supported.)</span>";
    $("#begin-btn").disabled = true;
    $("#begin-btn").textContent = "Open in Chrome or Edge to begin";
  }
})();

// ---------- begin ----------
$("#begin-btn").addEventListener("click", async () => {
  if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) return toast("Please open this link in Chrome or Edge on a computer.");
  student.name = $("#s-name").value.trim();
  student.email = $("#s-email").value.trim();
  student.id = $("#s-id").value.trim();
  if (!student.name) return toast("Please enter your name");
  if (!/@([a-z0-9-]+\.)*(uw|washington)\.edu$/i.test(student.email)) return toast("Please enter your UW email (e.g. netid@uw.edu)");
  if (!student.id) return toast("Please enter your student ID number");

  if (!$("#agree-rules") || !$("#agree-rules").checked) return toast("Please read the ground rules and check the box to begin.");

  // AV is the highest-value signal for resolving an ambiguous session, so it's required by default.
  // The instructor can mark an assignment "AV optional" (accommodation), which relaxes the hard block.
  const wantVideo = assignment.requireCamera !== false; // record video unless the instructor turned camera off
  const avRequired = !assignment.avOptional;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia(
      wantVideo ? { video: true, audio: AUDIO_CONSTRAINTS } : { audio: AUDIO_CONSTRAINTS }
    );
  } catch {
    if (avRequired) return toast(wantVideo
      ? "This assignment is recorded. Please ALLOW camera and microphone when your browser asks, then click Begin again."
      : "This assignment is recorded. Please ALLOW microphone access when your browser asks, then click Begin again.");
    mediaStream = null; // accommodation: proceed with no recording
  }
  if (avRequired) {
    if (!mediaStream || !mediaStream.getAudioTracks().length) {
      return toast("No microphone was detected. Please connect or enable a mic, then click Begin again.");
    }
    if (wantVideo && !mediaStream.getVideoTracks().length) {
      return toast("No camera was detected. Please enable your camera, then click Begin again.");
    }
    if (!window.MediaRecorder) {
      return toast("This browser can't record. Please use Chrome or Edge on a computer.");
    }
  }

  if (mediaStream) $("#cam").srcObject = mediaStream;
  $("#intro").style.display = "none";
  $("#session").style.display = "block";
  sessionStartedAt = Date.now();
  sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  sessionActive = true;
  saveProgress(); // register this attempt immediately so it shows as "active now"
  heartbeatTimer = setInterval(saveProgress, 30000); // keep the "active now" status fresh

  // record the whole session, watching for mid-session drops
  if (mediaStream && window.MediaRecorder) {
    mediaStream.getTracks().forEach(watchTrack);
    startRecorders(mediaStream);
    // pre-flight: confirm the camera is actually producing frames a few seconds in
    if (wantVideo) setTimeout(() => {
      const cam = $("#cam");
      if (sessionActive && !finishing && cam && !cam.videoWidth) {
        if (recordingGaps.length < 200) recordingGaps.push({ startOffsetMs: 0, endOffsetMs: null, reason: "no camera frames at start" });
        $("#cam-status").textContent = "⚠ Camera may not be capturing — check nothing else is using it";
      }
    }, 3500);
  } else {
    $("#cam-status").textContent = "No recording (accommodation)";
  }

  coachTurn(); // AI opens
});

function pickAudioMime() {
  const opts = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
  for (const m of opts) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

function pickMime() {
  const opts = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "audio/webm"];
  for (const m of opts) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return { mimeType: m };
  return {};
}

// ---------- conversation loop ----------
function addBubble(role, text) {
  const b = document.createElement("div");
  b.className = "bubble " + role;
  b.textContent = text;
  $("#chat").appendChild(b);
  b.scrollIntoView({ behavior: "smooth", block: "end" });
}

function showRetry(msg) {
  $("#mic-status").textContent = msg;
  $("#retry-btn").style.display = "inline-block";
  setMic(false, "…");
}
$("#retry-btn").addEventListener("click", () => { $("#retry-btn").style.display = "none"; coachTurn(); });

async function coachTurn() {
  if (busy) return; busy = true;
  $("#retry-btn").style.display = "none";
  setMic(false, "Coach is speaking…");
  $("#mic-status").textContent = "…";
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 75000); // don't let a hung server strand the student
    const r = await fetch("/api/conversation", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignmentId: ASSIGNMENT_ID, student, history, seed: sessionSeed }),
      signal: ctrl.signal
    });
    clearTimeout(to);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { busy = false; showRetry((d && d.error ? d.error : "The coach had trouble responding.") + " Click Retry."); return; }

    history.push({ role: "tutor", text: d.say, at: Date.now(), videoOffsetMs: videoOffsetMs() });
    addBubble("tutor", d.say);
    saveProgress();
    speak(d.say, () => {
      if (d.done) { finish(); }
      else { enableAnswering(); }
      busy = false;
    });
  } catch (e) { busy = false; showRetry((e && e.name === "AbortError") ? "That took too long to respond. Click Retry — your conversation is safe." : "Connection problem. Click Retry — your conversation is safe."); }
}

function enableAnswering() {
  recognizedText = ""; manuallyEdited = false; answerFirstWordAt = null; answerFirstWordOffsetMs = null; $("#answer").value = ""; updateWC();
  $("#edit-note").style.color = "var(--muted)";
  $("#edit-note").innerHTML = STATIC_EDIT_NOTE;
  // show the question being answered right above the answer box, so both are on screen
  const lastTutor = [...history].reverse().find(h => h.role === "tutor");
  if (lastTutor) $("#current-q").textContent = lastTutor.text;
  const wait = assignment.waitingTime || 0;
  if (wait > 0) {
    let left = wait;
    const cd = $("#countdown"); cd.style.display = "block";
    cd.textContent = `Take a moment to think — recording starts in ${left}s (or click the mic to start now).`;
    setMic(true, "Start now");
    $("#mic-status").textContent = "Get ready — recording will start automatically.";
    waitTimer = setInterval(() => {
      left--;
      if (left <= 0) { clearInterval(waitTimer); waitTimer = null; cd.style.display = "none"; if (!listening) startListening(); startAnswerLimit(); startAnswerWindow(); }
      else cd.textContent = `Take a moment to think — recording starts in ${left}s (or click the mic to start now).`;
    }, 1000);
  } else {
    setMic(true, "…");
    $("#mic-status").textContent = "Recording starts automatically — just speak. Click Stop when you're done.";
    setTimeout(() => { if (!listening) startListening(); }, 500); // auto-start after the coach finishes
    startAnswerLimit(); // the per-answer countdown begins now
    startAnswerWindow(); // and the "must start speaking" window
  }
}

function setMic(enabled, label) {
  const m = $("#mic"); m.disabled = !enabled; $("#mic-label").textContent = label;
  $("#send-btn").disabled = !enabled;
}

// ---------- speech recognition ----------
$("#mic").addEventListener("click", () => listening ? stopListening() : startListening());
const STATIC_EDIT_NOTE = "✎ You can fix transcription mistakes, but your <strong>original spoken words and any edits are saved and shown to your instructor.</strong>";
$("#answer").addEventListener("input", () => {
  updateWC();
  // The 'input' event fires ONLY on real user typing/paste/delete — the speech engine
  // sets .value programmatically, which does NOT fire it. So this is a true manual-edit signal.
  manuallyEdited = true;
  const cur = $("#answer").value.trim();
  const spoken = recognizedText.replace(/\s+/g, " ").trim();
  if (spoken && cur !== spoken) {
    $("#edit-note").innerHTML = "✎ <strong>You've edited the transcript.</strong> Your original spoken words and this change are saved and shown to your instructor.";
    $("#edit-note").style.color = "var(--warn)";
  } else {
    $("#edit-note").innerHTML = STATIC_EDIT_NOTE;
    $("#edit-note").style.color = "var(--muted)";
  }
});
$("#answer").addEventListener("paste", (e) => {
  e.preventDefault(); // pasting is disabled — this is a spoken answer. Still logged for the instructor.
  pasteUsed = true;
  const t = (e.clipboardData && e.clipboardData.getData("text")) || "";
  if (pasteEvents.length < 100) pasteEvents.push({ text: t.slice(0, 1000), videoOffsetMs: videoOffsetMs(), q: questionNum() });
  $("#mic-status").textContent = "⚠ Pasting is disabled — please speak your answer.";
  toast("Pasting isn't allowed here — please speak your answer.");
});
$("#answer").addEventListener("drop", (e) => { e.preventDefault(); toast("Dropping text isn't allowed — please speak your answer."); });
function updateWC() {
  const n = wordCount($("#answer").value);
  const min = assignment.minWords || 0;
  $("#wc").textContent = n + " words" + (min ? ` (need ${min}+)` : "");
  $("#wc").style.color = (min && n < min) ? "var(--warn)" : "var(--muted)";
}

function startListening(attempt) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
  $("#countdown").style.display = "none";
  if (!SR) { setMic(false, "Not supported"); $("#send-btn").disabled = true; $("#mic-status").textContent = "This browser can't record voice. Please reopen this link in Chrome or Edge."; return; }
  // Don't open the mic while the coach is still talking (prevents capturing its voice)
  if (window.speechSynthesis && window.speechSynthesis.speaking) {
    setTimeout(() => { if (!listening) startListening(attempt); }, 300);
    return;
  }
  if (recog) { try { recog.abort(); } catch {} recog = null; }
  recog = new SR();
  recog.continuous = true; recog.interimResults = true; recog.lang = "en-US";
  recog.onstart = () => {
    listening = true;
    $("#retry-btn").style.display = "none";
    $("#mic").classList.add("live"); $("#mic-label").textContent = "Stop";
    $("#mic-status").textContent = "🎙 Listening… speak your answer, then click Stop.";
  };
  recog.onresult = ev => {
    if (answerFirstWordAt == null) { answerFirstWordAt = Date.now(); answerFirstWordOffsetMs = videoOffsetMs(); }
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const t = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) recognizedText += t + " "; else interim += t;
    }
    $("#answer").value = (recognizedText + interim).replace(/\s+/g, " ").trimStart();
    updateWC();
  };
  recog.onerror = e => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") { $("#mic-status").textContent = "Microphone blocked — please allow it, or type your answer below."; }
    else if (e.error !== "no-speech" && e.error !== "aborted") { $("#mic-status").textContent = "Mic hiccup (" + e.error + "). Click the mic to retry, or type below."; }
  };
  recog.onend = () => { if (listening) { try { recog.start(); } catch {} } }; // keep alive across the API's auto-stops
  try {
    recog.start();
  } catch (err) {
    // start() can throw if a previous instance hasn't released yet — retry once
    if (!attempt) { setTimeout(() => startListening(1), 600); }
    else { setMic(true, "Start answering"); $("#mic-status").textContent = "Tap the mic when you're ready to talk."; }
  }
}
function stopListening() {
  listening = false;
  if (recog) { try { recog.stop(); } catch {} recog = null; }
  $("#mic").classList.remove("live"); $("#mic-label").textContent = "Start answering";
  $("#mic-status").textContent = "Review your answer, then Send (or keep talking).";
}

// ---------- send answer (manual, or forced when the time limit runs out) ----------
$("#send-btn").addEventListener("click", () => submitAnswer(false));
function submitAnswer(forced, emptyMsg) {
  let ans = $("#answer").value.trim();
  const min = assignment.minWords || 0;
  if (!forced) {
    if (!ans) return toast("Say or type an answer first");
    if (wordCount(ans) < min) return toast(`Please give a fuller answer (at least ${min} words).`);
  }
  if (forced && !ans) ans = emptyMsg || "(no answer given before the time limit)";
  clearAnswerLimit();
  clearAnswerWindow();
  stopListening();
  const spoken = recognizedText.replace(/\s+/g, " ").trim();
  // only flag as edited if the student ACTUALLY typed/edited AND the result differs from speech
  const edited = manuallyEdited && spoken.length > 0 && spoken !== ans;
  history.push({ role: "student", text: ans, spoken, edited, at: Date.now(), videoOffsetMs: videoOffsetMs(), firstWordAt: answerFirstWordAt, firstWordOffsetMs: answerFirstWordOffsetMs });
  addBubble("student", ans);
  saveProgress();
  $("#answer").value = ""; updateWC();
  setMic(false, "…");
  if (forced) toast("Time's up — sending your answer.");
  coachTurn();
}

// ---------- answer window: must START speaking within N seconds (no sitting silently) ----------
let answerWindowTimer = null;
function clearAnswerWindow() { if (answerWindowTimer) { clearTimeout(answerWindowTimer); answerWindowTimer = null; } }
function startAnswerWindow() {
  clearAnswerWindow();
  const w = assignment.answerWindow || 0; // seconds; 0 = off
  if (!w) return;
  answerWindowTimer = setTimeout(() => {
    if (answerFirstWordAt == null) { // they never began speaking — move the session along
      toast("No answer detected — moving on.");
      submitAnswer(true, "(no answer — the student did not begin speaking within the time allowed)");
    }
  }, w * 1000);
}

// ---------- per-answer time limit ----------
let answerLimitTimer = null;
function clearAnswerLimit() {
  if (answerLimitTimer) { clearInterval(answerLimitTimer); answerLimitTimer = null; }
  const el = $("#answer-timer"); if (el) el.textContent = "";
}
const GRACE_SECONDS = 75; // soft cap: after the limit, this much extra before an auto-send backstop
function startAnswerLimit() {
  clearAnswerLimit();
  const limit = assignment.answerLimit || 0; // seconds; 0 = no limit
  const el = $("#answer-timer");
  if (!limit || !el) return;
  // Subtle by design: a gentle note up front, the live countdown only near the end, and at the
  // limit a soft "wrap up" nudge (never a mid-sentence cutoff). A grace backstop ends a stalled
  // session so it can't run forever. Going over is a FLAG for the instructor, not an auto-penalty.
  const warnAt = Math.min(120, Math.max(15, Math.round(limit * 0.3)));
  const human = limit >= 60
    ? (limit % 60 === 0 ? (limit / 60) + ((limit / 60) === 1 ? " minute" : " minutes") : (limit / 60).toFixed(1).replace(/\.0$/, "") + " minutes")
    : limit + " seconds";
  el.style.color = "var(--muted)"; el.style.fontWeight = "400";
  el.textContent = "You have up to " + human + " for this answer — take your time.";
  let left = limit, over = 0;
  answerLimitTimer = setInterval(() => {
    if (left > 0) {
      left--;
      if (left <= warnAt) { // only now show the ticking clock — calm, not alarming
        const m = Math.floor(left / 60), s = left % 60;
        el.textContent = "⏱ " + m + ":" + String(s).padStart(2, "0") + " left";
        el.style.fontWeight = "600";
        el.style.color = left <= 15 ? "var(--warn)" : "var(--muted)";
      }
      return;
    }
    // Past the suggested time: gentle nudge, no cutoff. Flag it once.
    if (over === 0) { timeOverFlag = true; }
    over++;
    el.style.fontWeight = "600"; el.style.color = "var(--danger)";
    el.textContent = "⏱ Time to wrap up — please finish your thought and click Send.";
    if (over >= GRACE_SECONDS) { clearAnswerLimit(); submitAnswer(true); } // backstop for a stalled session
  }, 1000);
}

// ---------- text-to-speech ----------
function speak(text, done) {
  let fired = false, poll = null;
  const fire = () => { if (fired) return; fired = true; if (poll) clearInterval(poll); if (done) done(); };
  if (!window.speechSynthesis) { return fire(); }
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02; u.onend = fire; u.onerror = fire;
    window.speechSynthesis.speak(u);
    // Safety net that RESPECTS actual playback: never advance while speech is still
    // playing. Wait for it to start, then fire only once it has truly stopped.
    let waited = 0;
    poll = setInterval(() => {
      waited += 250;
      const speaking = window.speechSynthesis.speaking;
      if ((waited > 900 && !speaking) || waited > 120000) fire();
    }, 250);
  } catch { fire(); }
}

// ---------- finish & upload ----------
async function finish() {
  finishing = true;
  setMic(false, "Done");
  $("#session").style.display = "none";
  $("#done").style.display = "block";
  $("#upload-status").textContent = "Saving your conversation…";

  closeOpenGaps(); // any capture drop still open ran to the end of the session
  // stop recording and gather both the video and the audio-backup blobs
  const { video, audio } = await stopRecording();
  const hadVideo = !!(video && video.size), hadAudio = !!(audio && audio.size);

  const fd = new FormData();
  fd.append("assignmentId", ASSIGNMENT_ID);
  fd.append("studentName", student.name);
  fd.append("studentEmail", student.email || "");
  fd.append("studentId", student.id);
  fd.append("history", JSON.stringify(history));
  fd.append("startedAt", String(sessionStartedAt || ""));
  fd.append("endedAt", String(Date.now()));
  fd.append("sessionId", sessionId || "");
  fd.append("flaggedPaste", pasteUsed ? "1" : "");
  fd.append("flaggedTimeOver", timeOverFlag ? "1" : "");
  fd.append("awayEvents", JSON.stringify(awayEvents));
  fd.append("copyEvents", JSON.stringify(copyEvents));
  fd.append("pasteEvents", JSON.stringify(pasteEvents));
  fd.append("recordingGaps", JSON.stringify(recordingGaps));
  fd.append("recordingEverStarted", recordingEverStarted ? "1" : "");
  fd.append("recordingStoppedEarly", recordingStoppedEarly ? "1" : "");
  if (hadVideo) fd.append("video", video, "session.webm");
  if (hadAudio) fd.append("audio", audio, "session-audio.webm");

  // upload with verification + retry: confirm the recording actually persisted before we call it done
  let ok = false, lastErr = "";
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    try {
      if (attempt > 1) $("#upload-status").textContent = `Saving… (retry ${attempt} of 3)`;
      const r = await fetch("/api/submit", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "upload failed");
      // verify what we sent actually stored
      if ((hadVideo && !(d.videoBytes > 0)) && (hadAudio && !(d.audioBytes > 0))) throw new Error("recording didn't store");
      ok = true;
      const avNote = d.avStatus === "missing" ? " · ⚠ no recording saved"
        : d.avStatus === "partial" ? " · ⚠ recording is partial" : "";
      const sizeNote = hadVideo ? ` · video ${(video.size / 1048576).toFixed(1)} MB` : (hadAudio ? ` · audio ${(audio.size / 1048576).toFixed(1)} MB` : "");
      $("#upload-status").textContent = "Submitted successfully" + sizeNote + avNote;
      if (d.feedbackShared && d.feedback) {
        $("#done-feedback").innerHTML = `<h3>Feedback from your instructor's AI coach</h3><div class="reading-box">${esc(d.feedback)}</div>`;
      }
    } catch (e) { lastErr = e.message; if (attempt < 3) await new Promise(res => setTimeout(res, attempt * 1500)); }
  }
  if (!ok) $("#upload-status").textContent = "Saved your answers, but the recording upload had a problem (" + lastErr + "). Your instructor still has the transcript — let them know.";

  if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
  sessionActive = false; // submitted — safe to leave the page now
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  clearAnswerLimit();
  clearAnswerWindow();
}
function stopRecording() {
  const stopOne = (rec, chunks, fallbackType) => new Promise(resolve => {
    const make = () => chunks.length ? new Blob(chunks, { type: chunks[0]?.type || fallbackType }) : null;
    if (!rec || rec.state === "inactive") return resolve(make());
    rec.onstop = () => resolve(make());
    try { rec.stop(); } catch { resolve(make()); }
  });
  return Promise.all([
    stopOne(mediaRecorder, videoChunks, "video/webm"),
    stopOne(audioRecorder, audioChunks, "audio/webm")
  ]).then(([video, audio]) => ({ video, audio }));
}
