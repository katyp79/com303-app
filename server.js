require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const archiver = require("archiver");
const store = require("./lib/store");
const pdf = require("./lib/pdf");
const claude = require("./lib/claude");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
// During the pilot, never cache the front-end files — so code changes always
// take effect on refresh and you never run a stale copy.
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res) => res.setHeader("Cache-Control", "no-store, must-revalidate")
}));

// ---------- uploads ----------
const uploadPdf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const uploadVideo = multer({
  storage: multer.diskStorage({
    destination: store.VIDEO_DIR,
    filename: (req, file, cb) => {
      const ext = /mp4/.test(file.mimetype || "") ? ".mp4" : /ogg/.test(file.mimetype || "") ? ".ogg" : ".webm";
      cb(null, store.uid() + ext);
    }
  }),
  limits: { fileSize: 300 * 1024 * 1024 }
});
const uploadRec = uploadVideo.fields([{ name: "video", maxCount: 1 }, { name: "audio", maxCount: 1 }]);

// ---------- instructor gate (simple, for the pilot) ----------
function requireInstructor(req, res, next) {
  const pw = process.env.INSTRUCTOR_PASSWORD;
  if (!pw) return next();
  const given = req.get("x-instructor-key") || req.query.key;
  if (given === pw) return next();
  return res.status(401).json({ error: "unauthorized" });
}

// ---------- health / config ----------
app.get("/api/health", (req, res) => {
  // Persistence self-test: a marker file written once. If storage is durable, it
  // survives restarts (same timestamp); if ephemeral, each restart makes a new one.
  let diskMarker = null;
  try {
    const marker = path.join(store.DATA_DIR, ".persist-test");
    if (fs.existsSync(marker)) diskMarker = fs.readFileSync(marker, "utf8");
    else { diskMarker = "first-write-" + new Date().toISOString(); fs.writeFileSync(marker, diskMarker); }
  } catch (e) { diskMarker = "ERROR: " + e.message; }
  res.json({
    ok: true,
    hasKey: !!process.env.ANTHROPIC_API_KEY,
    model: claude.MODEL,
    needsPassword: !!process.env.INSTRUCTOR_PASSWORD,
    dataDir: store.DATA_DIR,
    diskMarker
  });
});
app.post("/api/login", (req, res) => {
  const pw = process.env.INSTRUCTOR_PASSWORD;
  if (!pw) return res.json({ ok: true, token: "" });
  if ((req.body && req.body.password) === pw) return res.json({ ok: true, token: pw });
  res.status(401).json({ error: "wrong password" });
});

// ---------- assignments ----------
app.post("/api/assignments", requireInstructor, uploadPdf.single("pdf"), async (req, res) => {
  try {
    const b = req.body;
    let readingText = (b.readingText || "").trim();
    let wordCount = readingText ? readingText.split(/\s+/).length : 0;
    let numPages = null;

    if (req.file) {
      const start = b.startPage ? parseInt(b.startPage, 10) : null;
      const end = b.endPage ? parseInt(b.endPage, 10) : null;
      const out = await pdf.extractText(req.file.buffer, start, end);
      readingText = out.text;
      wordCount = out.wordCount;
      numPages = out.numPages;
    }

    const concepts = [];
    for (let i = 1; i <= 6; i++) {
      const v = b["concept" + i];
      if (v && v.trim()) concepts.push(v.trim());
    }

    const assignment = {
      id: b.id && store.getAssignment(b.id) ? b.id : store.uid(),
      title: b.title || "Untitled reading",
      subject: b.subject || "",
      gradeLevel: b.gradeLevel || "College",
      readingText,
      wordCount,
      numPages,
      pageRange: (b.startPage && b.endPage) ? `${b.startPage}–${b.endPage}` : "",
      tuning: b.tuning || "ai",        // 'concepts' | 'ai'
      concepts: (b.tuning === "concepts") ? concepts : [],
      requireCamera: b.requireCamera !== "false",
      showReading: b.showReading === "true", // default false — source doc is the AI's private key
      feedbackMode: b.feedbackMode || "approve", // 'approve' | 'immediate'
      waitingTime: parseInt(b.waitingTime || "0", 10),
      minWords: parseInt(b.minWords || "10", 10),
      maxQuestions: parseInt(b.maxQuestions || "5", 10),
      createdAt: store.getAssignment(b.id)?.createdAt || Date.now()
    };
    store.saveAssignment(assignment);
    res.json(assignment);
  } catch (e) {
    console.error("assignment save failed:", e);
    res.status(500).json({ error: "Could not read that PDF. Try the Text option, or a different PDF." });
  }
});

app.get("/api/assignments", requireInstructor, (req, res) => {
  const subs = store.getSubmissions();
  const list = store.getAssignments().map(a => ({
    ...a,
    readingText: undefined, // keep list light
    responseCount: subs.filter(s => s.assignmentId === a.id).length
  }));
  res.json(list);
});

// student needs this to run the session (no instructor key required)
app.get("/api/assignments/:id/run", (req, res) => {
  const a = store.getAssignment(req.params.id);
  if (!a) return res.status(404).json({ error: "Assignment not found" });
  res.json({
    id: a.id, title: a.title, subject: a.subject, gradeLevel: a.gradeLevel,
    // readingText is the AI's private source of truth — only sent to the student if explicitly opted in
    readingText: a.showReading ? a.readingText : "",
    showReading: !!a.showReading,
    requireCamera: a.requireCamera, waitingTime: a.waitingTime, minWords: a.minWords
  });
});

app.delete("/api/assignments/:id", requireInstructor, (req, res) => {
  store.deleteAssignment(req.params.id);
  res.json({ ok: true });
});

// ---------- live conversation ----------
app.post("/api/conversation", async (req, res) => {
  try {
    const { assignmentId, student, history, seed } = req.body;
    const assignment = store.getAssignment(assignmentId);
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });
    const turn = await claude.nextTurn({
      assignment,
      student: student || { name: "the student" },
      history: Array.isArray(history) ? history : [],
      maxTurns: assignment.maxQuestions || 5,
      seed: seed || 1
    });
    res.json(turn);
  } catch (e) {
    if (e.code === "NO_API_KEY") {
      return res.status(503).json({ error: "The app has no Anthropic API key yet. Add it to the .env file and restart." });
    }
    console.error("conversation error:", e.message);
    res.status(500).json({ error: "The AI had trouble responding. Please try again." });
  }
});

// ---------- autosave progress (so a crashed/closed session is still visible) ----------
app.post("/api/progress", (req, res) => {
  try {
    const { sessionId, assignmentId, student, history, startedAt } = req.body || {};
    if (!sessionId || !assignmentId) return res.status(400).json({ error: "bad progress" });
    const assignment = store.getAssignment(assignmentId);
    let s = store.getSubmissions().find(x => x.sessionId === sessionId);
    if (!s) {
      s = {
        id: store.uid(), sessionId, assignmentId,
        assignmentTitle: assignment ? assignment.title : "(assignment)",
        studentName: (student && student.name) || "Unknown",
        studentEmail: (student && student.email) || "",
        studentId: (student && student.id) || "",
        history: [], videoFile: null, videoError: null,
        startedAt: startedAt || Date.now(), endedAt: null,
        flaggedPaste: false, flaggedEdited: false, submittedAt: Date.now(),
        feedback: null, suggestedScore: null, scoreRationale: "", grade: null,
        feedbackApproved: false, status: "in-progress"
      };
    }
    if (Array.isArray(history)) {
      s.history = history;
      s.flaggedEdited = history.some(h => h && h.edited);
    }
    if (Array.isArray(req.body.awayEvents)) { s.awayEvents = req.body.awayEvents; s.tabAway = req.body.awayEvents.length; }
    if (Array.isArray(req.body.copyEvents)) { s.copyEvents = req.body.copyEvents; s.copies = req.body.copyEvents.length; }
    if (Array.isArray(req.body.pasteEvents)) s.pasteEvents = req.body.pasteEvents;
    s.endedAt = Date.now();
    store.saveSubmission(s);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "progress save failed" }); }
});

// ---------- submit a completed session ----------
app.post("/api/submit", (req, res) => {
  // Run multer manually so that even if the VIDEO fails (e.g. too large), we still
  // save the transcript — the text fields are parsed before the file, so req.body has them.
  uploadRec(req, res, async (uploadErr) => {
  try {
    if (uploadErr) console.error("video upload issue:", uploadErr.code || uploadErr.message);
    const assignmentId = req.body.assignmentId;
    const assignment = store.getAssignment(assignmentId);
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    let history = [];
    try { history = JSON.parse(req.body.history || "[]"); } catch {}
    const student = { name: req.body.studentName || "Unknown", id: req.body.studentId || "", email: req.body.studentEmail || "" };

    // If this session was being autosaved (progress), complete that record instead of duplicating.
    const sessionId = req.body.sessionId || null;
    const existing = sessionId ? store.getSubmissions().find(x => x.sessionId === sessionId) : null;
    const submission = existing || {
      id: store.uid(), sessionId,
      feedback: null, suggestedScore: null, scoreRationale: "", grade: null, feedbackApproved: false
    };
    submission.assignmentId = assignmentId;
    submission.assignmentTitle = assignment.title;
    submission.studentName = student.name;
    submission.studentEmail = student.email;
    submission.studentId = student.id;
    submission.history = history;
    const vF = req.files && req.files.video && req.files.video[0];
    const aF = req.files && req.files.audio && req.files.audio[0];
    submission.videoFile = vF ? vF.filename : (submission.videoFile || null);
    submission.audioFile = aF ? aF.filename : (submission.audioFile || null);
    submission.videoError = uploadErr ? (uploadErr.code === "LIMIT_FILE_SIZE" ? "Recording too large to store — transcript saved." : "Recording upload failed — transcript saved.") : null;
    submission.startedAt = parseInt(req.body.startedAt, 10) || submission.startedAt || null;
    submission.endedAt = parseInt(req.body.endedAt, 10) || Date.now();
    submission.flaggedPaste = !!req.body.flaggedPaste;
    submission.flaggedEdited = Array.isArray(history) && history.some(h => h && h.edited);
    const parseArr = (s) => { try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
    submission.awayEvents = parseArr(req.body.awayEvents);
    submission.copyEvents = parseArr(req.body.copyEvents);
    submission.pasteEvents = parseArr(req.body.pasteEvents);
    submission.tabAway = submission.awayEvents.length;
    submission.copies = submission.copyEvents.length;
    submission.submittedAt = Date.now();
    submission.status = "complete";

    // generate feedback + a suggested score now (instructor reviews/overrides the grade)
    if (process.env.ANTHROPIC_API_KEY && history.length && !submission.feedback) {
      try {
        const a = await claude.generateFeedback({ assignment, student, history });
        submission.feedback = a.feedback;
        submission.suggestedScore = a.suggestedScore;
        submission.scoreRationale = a.scoreRationale;
        submission.feedbackApproved = (assignment.feedbackMode === "immediate");
      } catch (e) { console.error("feedback gen failed:", e.message); }
    }

    store.saveSubmission(submission);
    res.json({ ok: true, submissionId: submission.id, feedbackShared: submission.feedbackApproved, feedback: submission.feedbackApproved ? submission.feedback : null });
  } catch (e) {
    console.error("submit error:", e);
    res.status(500).json({ error: "Could not save your submission." });
  }
  });
});

// ---------- instructor dashboard ----------
app.get("/api/submissions", requireInstructor, (req, res) => {
  const list = store.getSubmissions().map(s => ({
    ...s,
    hasVideo: !!s.videoFile,
    hasAudio: !!s.audioFile,
    videoFile: undefined,
    audioFile: undefined
  }));
  res.json(list);
});
app.get("/api/submissions.csv", requireInstructor, (req, res) => {
  const sel = req.query.assignmentId;
  let subs = store.getSubmissions();
  if (sel) subs = subs.filter(s => s.assignmentId === sel);
  const q = v => {
    let s = String(v == null ? "" : v);
    // neutralize CSV/Excel formula injection (cells starting with = + - @ tab CR)
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const head = ["Student", "Email", "StudentID", "Assignment", "Status", "Started", "DurationSec", "Submitted", "Grade", "AISuggestedScore", "FlaggedPaste", "EditedTranscript", "TabSwitches", "Copies", "CopiedText", "PastedText", "FeedbackShared", "Transcript", "Feedback"];
  const lines = subs.map(s => {
    const dur = (s.startedAt && s.endedAt) ? Math.round((s.endedAt - s.startedAt) / 1000) : "";
    const transcript = (s.history || []).map(h => `${h.role === "tutor" ? "Coach" : s.studentName}: ${h.text}`).join("\n");
    return [
      s.studentName, s.studentEmail, s.studentId, s.assignmentTitle,
      s.status === "in-progress" ? "INCOMPLETE" : "complete",
      s.startedAt ? new Date(s.startedAt).toLocaleString() : "",
      dur, new Date(s.submittedAt).toLocaleString(),
      s.grade == null ? "" : s.grade, s.suggestedScore == null ? "" : s.suggestedScore,
      s.flaggedPaste ? "YES" : "", s.flaggedEdited ? "YES" : "", s.tabAway || 0, s.copies || 0,
      (s.copyEvents || []).map(c => c.text).join("  |  "), (s.pasteEvents || []).map(p => p.text).join("  |  "),
      s.feedbackApproved ? "YES" : "",
      transcript, s.feedback || ""
    ].map(q).join(",");
  });
  const BOM = String.fromCharCode(0xFEFF); // so Excel reads it as UTF-8
  const csv = BOM + [head.join(","), ...lines].join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=com303-submissions.csv");
  res.send(csv);
});

// Bulk-download all recordings (video + audio backups) for the filter as one zip — for offloading.
app.get("/api/videos.zip", requireInstructor, (req, res) => {
  const sel = req.query.assignmentId;
  let subs = store.getSubmissions().filter(s => s.videoFile || s.audioFile);
  if (sel) subs = subs.filter(s => s.assignmentId === sel);
  const files = [];
  for (const s of subs) {
    const base = (s.studentName || "student").replace(/[^\w.-]+/g, "_") + "__" + s.id;
    if (s.videoFile) { const p = path.join(store.VIDEO_DIR, s.videoFile); if (fs.existsSync(p)) files.push({ p, name: base + path.extname(s.videoFile) }); }
    if (s.audioFile) { const p = path.join(store.VIDEO_DIR, s.audioFile); if (fs.existsSync(p)) files.push({ p, name: base + "_audio" + path.extname(s.audioFile) }); }
  }
  if (!files.length) return res.status(404).send("No recordings to download.");
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", "attachment; filename=com303-recordings.zip");
  const archive = archiver("zip", { zlib: { level: 0 } }); // store mode — media is already compressed
  archive.on("error", err => { console.error("zip error:", err.message); try { res.destroy(); } catch {} });
  archive.pipe(res);
  for (const { p, name } of files) archive.file(p, { name });
  archive.finalize();
});

// Delete videos (keep transcripts/grades) to free disk space — after you've offloaded.
app.post("/api/purge-videos", requireInstructor, (req, res) => {
  const sel = req.body && req.body.assignmentId;
  let subs = store.getSubmissions();
  if (sel) subs = subs.filter(s => s.assignmentId === sel);
  let purged = 0;
  for (const s of subs) {
    let did = false;
    for (const key of ["videoFile", "audioFile"]) {
      if (s[key]) {
        const p = path.join(store.VIDEO_DIR, s[key]);
        if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
        s[key] = null; did = true;
      }
    }
    if (did) { s.videoPurgedAt = Date.now(); store.saveSubmission(s); purged++; }
  }
  res.json({ ok: true, purged });
});

app.get("/api/submissions/:id", requireInstructor, (req, res) => {
  const s = store.getSubmission(req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  res.json({ ...s, hasVideo: !!s.videoFile, hasAudio: !!s.audioFile });
});
app.get("/api/audio/:id", requireInstructor, (req, res) => {
  const s = store.getSubmission(req.params.id);
  if (!s || !s.audioFile) return res.status(404).send("No audio");
  const p = path.join(store.VIDEO_DIR, s.audioFile);
  if (!fs.existsSync(p)) return res.status(404).send("Audio file missing");
  res.sendFile(p);
});
app.get("/api/video/:id", requireInstructor, (req, res) => {
  const s = store.getSubmission(req.params.id);
  if (!s || !s.videoFile) return res.status(404).send("No video");
  const p = path.join(store.VIDEO_DIR, s.videoFile);
  if (!fs.existsSync(p)) return res.status(404).send("Video file missing");
  res.sendFile(p);
});
app.post("/api/submissions/:id/feedback", requireInstructor, async (req, res) => {
  const s = store.getSubmission(req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  const assignment = store.getAssignment(s.assignmentId) || { title: s.assignmentTitle };
  try {
    const a = await claude.generateFeedback({ assignment, student: { name: s.studentName }, history: s.history });
    s.feedback = a.feedback; s.suggestedScore = a.suggestedScore; s.scoreRationale = a.scoreRationale;
    store.saveSubmission(s);
    res.json({ feedback: s.feedback, suggestedScore: s.suggestedScore, scoreRationale: s.scoreRationale });
  } catch (e) {
    if (e.code === "NO_API_KEY") return res.status(503).json({ error: "No API key set." });
    res.status(500).json({ error: "Could not generate feedback." });
  }
});
app.post("/api/submissions/:id/grade", requireInstructor, (req, res) => {
  const s = store.getSubmission(req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  s.grade = (req.body.grade == null ? "" : String(req.body.grade)).slice(0, 100);
  store.saveSubmission(s);
  res.json({ ok: true });
});
app.post("/api/submissions/:id/approve", requireInstructor, (req, res) => {
  const s = store.getSubmission(req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  if (typeof req.body.feedback === "string") s.feedback = req.body.feedback;
  s.feedbackApproved = true;
  store.saveSubmission(s);
  res.json({ ok: true });
});
app.delete("/api/submissions/:id", requireInstructor, (req, res) => {
  store.deleteSubmission(req.params.id);
  res.json({ ok: true });
});

// ---------- routes for pages ----------
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log("\n  COM 303 Voice Conversations — running");
  console.log("  Instructor:  http://localhost:" + PORT + "/");
  console.log("  API key set: " + (process.env.ANTHROPIC_API_KEY ? "yes" : "NO  (add it to .env to enable conversations)"));
  console.log("  Model:       " + claude.MODEL + "\n");
});
