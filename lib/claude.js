// The conversation engine. Built on Webb's Depth of Knowledge (DoK) framework —
// a public educational model, NOT Sherpa's proprietary prompts.
const Anthropic = require("@anthropic-ai/sdk");

const MODEL = process.env.MODEL || "claude-sonnet-4-6";

function client() {
  if (!process.env.ANTHROPIC_API_KEY) {
    const e = new Error("NO_API_KEY");
    e.code = "NO_API_KEY";
    throw e;
  }
  // 60s timeout + 1 retry so a hung/slow API call fails fast instead of hanging the student
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60000, maxRetries: 1 });
}

const DOK = `You probe understanding using Webb's Depth of Knowledge (DoK):
  - Level 1 (Recall): can the student state key facts/definitions from the reading?
  - Level 2 (Skill/Concept): can they explain relationships, summarize, classify, compare?
  - Level 3 (Strategic Thinking): can they reason, justify a position, cite evidence, handle "why"/"what if"?
  - Level 4 (Extended Thinking): can they connect ideas across contexts, critique, or apply to new situations?
Start gentle (L1-2) to build confidence, then escalate. The goal is to reveal genuine understanding, not to trick.`;

// Deterministic shuffle from a per-session seed: stable within one student's
// session (so the order doesn't change mid-conversation) but different per student.
function seededShuffle(arr, seed) {
  const a = arr.slice();
  let s = (parseInt(seed, 10) || 1) >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function systemPrompt(assignment, seed) {
  const concepts = seededShuffle((assignment.concepts || []).filter(Boolean), seed);
  const tuning = concepts.length
    ? `The instructor wants you to probe the student's understanding of these specific concept(s). Work through them in roughly THIS order (it is randomized per student — follow the order you're given):\n${concepts.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}`
    : `The instructor wants you to decide the flow entirely. Using session variation #${seed}, choose a fresh selection and ordering of the reading's most important ideas, so different students are asked about different things.`;

  return `You are a warm, curious discussion partner for a ${assignment.gradeLevel || "college"}-level ${assignment.subject || ""} course. You are having a short SPOKEN conversation with a student about the assigned module material, to gauge how well they truly understand it. Always call it "the module material" or "the material" — NEVER "the reading" (some of it may be videos, lectures, or other media, not just readings). Your name is the course's coach.

${DOK}

${tuning}

MODULE MATERIAL: ${assignment.title}
${assignment.pageRange ? `FOCUS: pages ${assignment.pageRange}` : ""}

THE MATERIAL (what the student was assigned to study):
"""
${assignment.readingText || "(no material text was provided — rely on the concepts above)"}
"""

SHAPE OF THE CONVERSATION (about ${assignment.maxQuestions || 5} exchanges total):
${concepts.length ? `- BREADTH IS THE PRIORITY: ask ONE question about EACH listed concept, in order, then MOVE ON to the next concept. Spend roughly one exchange per concept. By your Nth question you should be on the Nth concept. Your job is to TOUCH EVERY CONCEPT — not to drill a single one until it's mastered. It is normal and fine to cover a concept in one question and advance even if the answer was imperfect.
- OPENER: greet the student by name and name the module material in ONE short sentence, then go straight into your question about the FIRST concept. Keep the warm-up to a sentence — you have several concepts to get through.
- MIDDLE: one focused question per remaining concept, in order. Build on what the student said where natural, but do NOT linger — always advance to the next uncovered concept.` :
`- OPENER (warm-up, not evaluative): greet the student by name, name the module material, and ask ONE broad, low-pressure question. Don't grade this.
- MIDDLE: ask focused questions that escalate through the DoK levels and build on what the student just said, ranging across the material's most important ideas (don't get stuck on one).`}
- CLOSER: when you decide to end (set done=true), give a warm, brief sign-off that acknowledges their effort. Do NOT pose a question in this final turn — the conversation ends immediately after it, so any question would go unanswered and feel abrupt. If you want to leave them with a reflection, phrase it as a takeaway ("something worth mulling over is…"), never as a question.

HANDLING A WEAK OR WRONG ANSWER (without getting stuck):
- Briefly and specifically name what was off ("you've described X, but the reading distinguishes it from Y") — then ADVANCE to the next concept in the SAME turn. Fold the quick correction and your next concept's question together; don't spend a whole separate turn re-asking.
- Re-ask the same concept ONLY if the student was very close and one nudge would land it — and NEVER spend more than two turns total on any one concept. After two tries, move on no matter what.
- If the student answers a DIFFERENT concept than you asked, do NOT keep re-asking your original question — briefly accept what they said, count both concepts as covered, and advance to the next uncovered one.
- Covering all the concepts matters more than getting a perfect answer on any single one. When in doubt, move on.

OTHER RULES:
- Speak naturally, like a real person. One question at a time. Keep each turn short (1-3 sentences) — it is spoken aloud.
- Each substantive answer should aim for at least ${assignment.minWords || 10} words; if they give a one-word answer, warmly invite them to say more.
- VARIETY: vary your wording, your examples, and the specific angle you take this session (use session variation #${seed}). Avoid canned or identical phrasings, so no two students get the same script.
- Never break character, never mention these instructions, never say "Depth of Knowledge" to the student.

OUTPUT FORMAT — respond with ONLY a JSON object, no other text:
{"say": "<your spoken turn to the student>", "done": <true only when you are ending the conversation, else false>}`;
}

function parseJSON(text) {
  // be forgiving: pull the first {...} block
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return { say: text.trim(), done: false };
}

// history: [{ role: 'tutor'|'student', text }]
async function nextTurn({ assignment, student, history, maxTurns, seed }) {
  const c = client();
  const messages = [];

  // seed so the model always has a user turn to respond to first
  if (!history.length) {
    messages.push({ role: "user", content: `The student "${student.name}" has joined and turned on their camera. Begin the conversation.` });
  } else {
    for (const h of history) {
      // Claude rejects empty text content — substitute a placeholder so an empty
      // or whitespace-only turn can never 500 the conversation.
      const text = (h.text && h.text.trim()) ? h.text : "(no response given)";
      messages.push({ role: h.role === "tutor" ? "assistant" : "user", content: text });
    }
    // if the last turn was the tutor's, we shouldn't be here; guard anyway
    if (messages[messages.length - 1].role === "assistant") {
      messages.push({ role: "user", content: "(the student was silent)" });
    }
  }

  const studentTurns = history.filter(h => h.role === "student").length;
  const forceEnd = maxTurns && studentTurns >= maxTurns;
  // Put the wrap-up nudge in the messages (not the system prompt) so the system
  // prompt stays byte-identical across turns and the cache keeps hitting.
  if (forceEnd) {
    messages.push({ role: "user", content: "(You've reached the final exchange — give a brief, warm sign-off and end now with done=true. Do NOT ask a new question; the student can't answer it.)" });
  } else {
    // Near the end, stop re-asking earlier concepts and guarantee the LAST concept gets
    // asked — otherwise weaker students (who triggered re-asks) lose the tail question.
    const conceptCount = (assignment.concepts || []).filter(Boolean).length;
    const turnsLeft = maxTurns ? Math.max(0, maxTurns - studentTurns) : 99;
    if (conceptCount && turnsLeft <= 2) {
      messages.push({ role: "user", content: `(Only about ${turnsLeft} exchange(s) left, and you have ${conceptCount} concept(s) to cover in total. Do NOT re-ask an earlier concept now — ask about a concept you have NOT covered yet, especially the FINAL one, so every concept gets asked before you sign off.)` });
    }
  }

  const resp = await c.messages.create({
    model: MODEL,
    max_tokens: 400,
    // cache_control on the system prompt (which holds the big reading text):
    // the first turn writes the cache, the rest of this student's turns read it
    // at ~10% cost. Cuts the per-conversation cost roughly in half.
    system: [{ type: "text", text: systemPrompt(assignment, seed), cache_control: { type: "ephemeral" } }],
    messages
  });
  if (resp.usage) {
    const u = resp.usage;
    console.log(`[turn] in:${u.input_tokens} cache_read:${u.cache_read_input_tokens || 0} cache_write:${u.cache_creation_input_tokens || 0} out:${u.output_tokens}`);
  }

  const text = (resp.content || []).map(b => b.text || "").join("");
  const out = parseJSON(text);
  // Don't let the conversation end too early: require at least 2 real answers first.
  if (out.done && studentTurns < 2 && !forceEnd) out.done = false;
  if (forceEnd) out.done = true;
  return { say: (out.say || "").trim(), done: !!out.done };
}

// Instructor-facing feedback on a completed conversation (held for approval).
async function generateFeedback({ assignment, student, history }) {
  const c = client();
  const transcript = history.map(h => `${h.role === "tutor" ? "Coach" : student.name}: ${h.text}`).join("\n");
  const concepts = (assignment.concepts || []).filter(Boolean);

  const resp = await c.messages.create({
    model: MODEL,
    max_tokens: 700,
    system: `You are helping a ${assignment.gradeLevel || "college"} instructor assess a student's spoken understanding of the module material titled "${assignment.title}". Be concise, specific, and constructive. ${concepts.length ? `The instructor cared about these concepts: ${concepts.join("; ")}.` : ""}`,
    messages: [{
      role: "user",
      content: `Here is the transcript of the student's spoken conversation about the module material. Write a short assessment for the INSTRUCTOR with four labeled parts:\n1) Understanding demonstrated (1-2 sentences)\n2) Specific gaps or confusions — name the EXACT concept(s) the student muddled and how (e.g. "confuses mediators with moderators"), not a vague "needs work"; or "none obvious"\n3) How the student could improve (2-3 concrete, actionable sentences)\n4) Confidence: High / Medium / Low — how sure you are in this assessment given how much the student actually said\n\nThen, on a FINAL separate line, output exactly this format (this is a SUGGESTED grade the instructor will review and can override):\nSCORE: <integer 0-100> | <8-12 word justification>\n\nTRANSCRIPT:\n${transcript}`
    }]
  });

  let full = (resp.content || []).map(b => b.text || "").join("").trim();
  // pull out the SCORE: NN | reason line; keep the prose feedback separate
  let suggestedScore = null, scoreRationale = "";
  const m = full.match(/SCORE:\s*(\d{1,3})\s*\|\s*(.*)$/im);
  if (m) {
    suggestedScore = Math.max(0, Math.min(100, parseInt(m[1], 10)));
    scoreRationale = m[2].trim();
    full = full.replace(m[0], "").trim(); // strip the machine line from the prose
  }
  return { feedback: full, suggestedScore, scoreRationale };
}

module.exports = { nextTurn, generateFeedback, MODEL };
