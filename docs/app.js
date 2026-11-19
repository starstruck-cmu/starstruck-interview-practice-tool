/* =====================================================
   APP.JS
   All the behavior for the page, split into sections:
     1. SETTINGS        - backend address
     2. STATE           - preferences, resume and the current session
     3. HELPERS         - small shared functions
     4. NAVIGATION      - screens, progress steps, back/next arrows
     5. HOME            - resume upload
     6. SETUP           - choosing what to practice
     7. PRACTICE        - question card, typed answer, submit, skip
     8. RECORDING       - camera, microphone, transcript
     9. COMPANION       - optional chat help
    10. FEEDBACK        - annotated feedback for one answer
    11. SUMMARY         - end of session, save in this browser
    11b. EXPERIENCE     - experience cards built from the resume and answers
    11c. PROGRESS       - saved sessions over time
    12. PREFERENCES     - default settings
    13. LEAVE           - confirm before losing an answer
    14. ADMIN           - login, prompt editing, recent answers
   ===================================================== */


/* =====================================================
   1. SETTINGS
   ===================================================== */

// Uses the local backend when the page is opened from localhost, otherwise Railway.
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const API = LOCAL
  ? "http://127.0.0.1:8000"
  : "https://starstruck-interview-practice-tool-production.up.railway.app";

const MAX_FILE_MB = 10;


/* =====================================================
   2. STATE
   Preferences, the resume and saved sessions are kept in
   this browser only (localStorage). Nothing is stored on the server.
   ===================================================== */

const DEFAULT_PREFS = { input: "speak", count: 3, smallTalk: false };

let prefs = { ...DEFAULT_PREFS, ...load("starstruck.prefs", {}) };
let resume = load("starstruck.resume", null);     // { name, text }
let session = null;                                // the practice session in progress
let currentView = "home";
let lastView = "home";                             // where Preferences goes back to
let preparing = false;                             // true while questions are being written
let cards = load("starstruck.stories", []);       // experience cards: { title, situation, task, action, result, skills }
let nextFocus = "";                                // an area to practice, sent to the AI when writing questions
let nextFocusLabel = "";                           // the short name for it shown on Set up
let coachMinimized = load("starstruck.coachMin", false);   // coach tucked into a tab on the right


/* =====================================================
   3. HELPERS
   ===================================================== */

const $ = (id) => document.getElementById(id);

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch (err) {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // Storage can be blocked (private windows). The app still works for this visit.
  }
}

// Sends a JSON POST to the backend. Throws an Error with a readable message on failure.
async function postJson(path, body) {
  return handle(await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }));
}

async function postForm(path, form) {
  return handle(await fetch(API + path, { method: "POST", body: form }));
}

async function handle(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || "Something went wrong. Please try again.");
  return data;
}

function connectionMessage(err) {
  return err instanceof TypeError ? "The practice service could not be reached. Check your connection and try again." : err.message;
}

// Uploads a PDF/DOCX/TXT file and returns its text.
async function readFile(file) {
  if (file.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`This file is larger than ${MAX_FILE_MB} MB.`);
  const form = new FormData();
  form.append("file", file);
  return (await postForm("/api/read-file", form)).text;
}

function radioValue(name) {
  const checked = document.querySelector(`input[name="${name}"]:checked`);
  return checked ? checked.value : null;
}

function setRadio(name, value) {
  const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}


/* =====================================================
   4. NAVIGATION
   The top steps only show where you are; they can't be clicked.
   The back/next arrows at the bottom change meaning per page.
   ===================================================== */

const STEP_FOR_VIEW = {
  home: "home", setup: "setup", practice: "practice", feedback: "practice", summary: "summary",
  experience: "experience", progress: "progress"
};
const STEP_ORDER = ["home", "setup", "practice", "summary", "experience", "progress"];

// Experience and Progress unlock after the first finished practice session.
function unlocked() {
  return load("starstruck.unlocked", false);
}

function show(view) {
  if (view !== "practice" && tourIndex >= 0) endTour();
  currentView = view;
  if (view !== "preferences") lastView = view;
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== "view-" + view));

  // One companion chat follows the user from Practice to Feedback.
  if (view === "practice") $("practiceSide").append($("companion"));
  if (view === "feedback") {
    $("feedbackSide").append($("companion"));
    $("companion").hidden = false;
  }
  updateCoach();

  const current = STEP_ORDER.indexOf(STEP_FOR_VIEW[lastView]);
  const open = unlocked();
  document.querySelectorAll("#steps li").forEach((li, i) => {
    const extra = li.classList.contains("extra");
    li.classList.toggle("done", !extra && i < current);
    li.classList.toggle("locked", extra && !open);
    if (extra) {
      const button = li.querySelector("button");
      button.disabled = !open;
      button.title = open ? "" : "Finish a practice session to unlock";
    }
    if (i === current) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  });

  renderArrows();
  window.scrollTo(0, 0);
}

// What the back and next arrows do on each page. null hides that arrow.
function arrowActions() {
  const stage = session && session.stage;
  switch (currentView) {
    case "gate":
      return { back: null, next: null };
    case "home":
      return {
        back: null,
        next: { label: "Next", disabled: !resume, run: () => go("setup") }
      };
    case "setup":
      return {
        back: { label: "Back", run: () => go("home") },
        next: { label: preparing ? "Preparing…" : "Start", disabled: preparing, run: startPractice }
      };
    case "practice":
      return {
        back: { label: "Leave", run: leavePractice },
        next: {
          // An empty answer skips the question.
          label: $("answer").value.trim() ? "Submit" : "Skip",
          disabled: ["recording", "transcribing", "loading", "error"].includes(stage),
          run: submitAnswer
        }
      };
    case "feedback":
      return {
        back: { label: "Leave", run: leavePractice },
        middle: { label: "Retry question", run: retryQuestion },
        next: { label: isLastQuestion() ? "Finish" : "Next question", run: nextQuestion }
      };
    case "summary":
      return {
        back: { label: "Home", run: () => { session = null; go("home"); } },
        next: { label: "Practice again", run: () => { session = null; go("setup"); } }
      };
    case "experience":
    case "progress":
      return {
        back: { label: "Home", run: () => { session = null; go("home"); } },
        next: { label: "Practice", run: () => { session = null; go("setup"); } }
      };
    case "preferences":
      return {
        back: { label: "Back", run: closePreferences },
        next: { label: "Save", run: savePreferences }
      };
  }
  return { back: null, next: null };
}

function renderArrows() {
  const actions = arrowActions();
  [["back", $("backArrow"), $("backLabel")], ["middle", $("middleArrow"), $("middleLabel")],
   ["next", $("nextArrow"), $("nextLabel")]].forEach(([key, button, label]) => {
    const action = actions[key];
    button.hidden = !action;
    if (!action) return;
    label.textContent = action.label;
    button.setAttribute("aria-label", action.label);
    button.disabled = Boolean(action.disabled);
  });
}

$("backArrow").addEventListener("click", () => arrowActions().back?.run());
$("middleArrow").addEventListener("click", () => arrowActions().middle?.run());
$("nextArrow").addEventListener("click", () => arrowActions().next?.run());

function sessionActive() {
  return session && !session.finished;
}

function go(target) {
  if (target === "setup" && !resume) target = "home";
  if (currentView === "practice" && target !== "preferences") stopPreview();
  if (target === "home") renderHome();
  if (target === "setup") renderSetup();
  if (target === "summary") renderSummary();
  if (target === "experience") renderExperience();
  if (target === "progress") renderProgress();
  show(target);
}

// Experience and Progress steps (and other [data-open] buttons) open once unlocked.
document.addEventListener("click", (e) => {
  const opener = e.target.closest("[data-open]");
  if (opener && unlocked()) go(opener.dataset.open);
});


/* =====================================================
   5. HOME
   ===================================================== */

const dropzone = $("dropzone");

// Returning users (anyone with a saved session) get a dashboard; new users get the upload page.
function renderHome() {
  const hasResume = Boolean(resume && resume.text);
  const returning = load("starstruck.sessions", []).length > 0;
  $("resumeChip").hidden = !hasResume;
  $("resumeName").textContent = hasResume ? resume.name : "";

  $("homeNew").hidden = returning;
  $("homeReturning").hidden = !returning;
  $(returning ? "returningUploadSlot" : "newUploadSlot").append($("uploadCard"));
  $("uploadCard").classList.toggle("compact", returning);
  $("uploadCard").classList.toggle("no-file", !hasResume);
  // Returning users see their current file plus a small box to drop a new one.
  $("replaceResume").hidden = true;
  $("dropText").textContent = returning && hasResume ? "Drop a new resume here" : "Drag and drop your resume here";
  $("uploadTitle").textContent = returning ? (hasResume ? "Resume on file" : "No resume on file") : "Upload your resume";

  if (returning) {
    drawWeek($("weekSummary"), $("weekChart"), load("starstruck.sessions", []), false);
    $("dashPractice").disabled = !hasResume;
    $("dashPractice").title = hasResume ? "" : "Upload your resume first";
  }
  if (currentView === "home") renderArrows();
}

$("dashPractice").addEventListener("click", () => go("setup"));

// Bar chart of minutes practiced on each day of this week (Monday to Sunday).
// withValues adds the number of minutes above each bar.
function drawWeek(summaryEl, chartEl, sessions, withValues) {
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const minutes = [0, 0, 0, 0, 0, 0, 0];
  const practiced = [false, false, false, false, false, false, false];
  sessions.forEach((saved) => {
    const day = Math.floor((new Date(saved.date) - monday) / 86400000);
    if (day < 0 || day > 6) return;
    minutes[day] += saved.minutes || 0;
    practiced[day] = true;
  });

  const total = minutes.reduce((a, b) => a + b, 0);
  const days = practiced.filter(Boolean).length;
  summaryEl.textContent = days
    ? `This week: ${total} minute${total === 1 ? "" : "s"} across ${days} day${days === 1 ? "" : "s"}`
    : "No practice yet this week.";

  chartEl.textContent = "";
  const max = Math.max(...minutes, 1);
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((name, i) => {
    const col = el("div", "week-col");
    const bar = el("div", "week-bar" + (minutes[i] ? "" : " empty"));
    bar.style.height = (minutes[i] ? Math.max(6, (minutes[i] / max) * 100) : 0) + "%";
    bar.title = `${name}: ${minutes[i]} minute${minutes[i] === 1 ? "" : "s"}`;
    const track = el("div", "week-track");
    if (withValues) {
      const stack = el("div", "week-stack");
      stack.style.height = "100%";
      stack.append(el("span", "week-value", String(minutes[i])), bar);
      track.append(stack);
    } else {
      track.append(bar);
    }
    col.append(track, el("span", "week-day", name));
    col.setAttribute("aria-label", bar.title);
    chartEl.append(col);
  });
}

async function uploadResume(file) {
  if (!file) return;
  $("resumeError").hidden = true;
  $("resumeStatus").className = "status";
  $("resumeStatus").textContent = "Reading your resume…";

  try {
    const text = await readFile(file);
    resume = { name: file.name, text: text };
    save("starstruck.resume", resume);
    $("resumeStatus").textContent = "";
  } catch (err) {
    $("resumeStatus").textContent = "";
    if (err instanceof TypeError) {
      $("resumeStatus").className = "status error";
      $("resumeStatus").textContent = connectionMessage(err);
    } else {
      $("resumeError").hidden = false;
    }
  }
  renderHome();
}

$("resumeInput").addEventListener("change", (e) => {
  uploadResume(e.target.files[0]);
  e.target.value = "";
});

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragging");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragging"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragging");
  uploadResume(e.dataTransfer.files[0]);
});

$("usePasted").addEventListener("click", () => {
  const text = $("resumePaste").value.trim();
  if (!text) return;
  resume = { name: "Pasted resume text", text: text };
  save("starstruck.resume", resume);
  $("resumeError").hidden = true;
  renderHome();
});

$("removeResume").addEventListener("click", () => {
  resume = null;
  try { localStorage.removeItem("starstruck.resume"); } catch (err) {}
  renderHome();
});


/* =====================================================
   6. SETUP
   ===================================================== */

function renderSetup() {
  setRadio("setupInput", prefs.input);
  setRadio("setupCount", String(prefs.count));
  $("setupSmallTalk").checked = prefs.smallTalk;
  // New users (no saved sessions yet) get the tour switched on and marked "recommended".
  const newUser = load("starstruck.sessions", []).length === 0;
  $("setupTour").checked = newUser;
  $("tourRec").hidden = !newUser;
  $("setupStatus").textContent = "";
  $("focusNote").hidden = !nextFocus;
  $("focusNote").textContent = nextFocus ? "Focus: " + (nextFocusLabel || nextFocus) : "";
  updateSetup();
}

function updateSetup() {
  $("jobFields").hidden = radioValue("focus") !== "job";
}

$("view-setup").addEventListener("change", updateSetup);

$("jobFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  $("jobStatus").textContent = "Reading the job description…";
  try {
    $("jobDescription").value = await readFile(file);
    $("jobStatus").textContent = "";
  } catch (err) {
    $("jobStatus").textContent = connectionMessage(err) + " You can paste the text instead.";
  }
});

async function startPractice() {
  const isJob = radioValue("focus") === "job";
  const jobTitle = isJob ? $("jobTitle").value.trim() : "";
  const jobDescription = isJob ? $("jobDescription").value.trim() : "";
  if (isJob && !jobDescription) {
    $("setupStatus").textContent = "Add the job description, or choose general questions.";
    $("jobDescription").focus();
    return;
  }

  // The choices made here become the saved preferences too.
  prefs = {
    input: radioValue("setupInput"),
    count: Number(radioValue("setupCount")),
    smallTalk: $("setupSmallTalk").checked
  };
  save("starstruck.prefs", prefs);

  preparing = true;
  renderArrows();
  $("setupStatus").textContent = "";

  try {
    const data = await postJson("/api/questions", {
      resume: resume.text,
      job_title: jobTitle,
      job_description: jobDescription,
      count: prefs.count,
      small_talk: prefs.smallTalk,
      focus: nextFocus
    });
    if (!data.questions.length) throw new Error("No questions came back. Please try again.");
    preparing = false;
    startSession(data.questions, jobTitle, jobDescription);
    if ($("setupTour").checked) startTour();
  } catch (err) {
    preparing = false;
    $("setupStatus").textContent = connectionMessage(err);
    renderArrows();
  }
}


/* =====================================================
   7. PRACTICE
   Stages: answer, recording, transcribing, review, mic, loading, error
   ===================================================== */

const TRANSCRIPT_PLACEHOLDER = "No API key, so there's no transcript. This is where it would go. You can type your answer here.";

function startSession(questions, jobTitle, jobDescription) {
  session = {
    questions: questions,
    jobTitle: jobTitle,
    jobDescription: jobDescription,
    index: 0,
    results: [],
    mode: prefs.input,
    camera: true,   // the camera starts on; the user can turn it off on the practice page
    finished: false,
    saved: false,
    hints: {},   // question index -> experience card suggested for it
    startedAt: Date.now()
  };
  startQuestion("");
}

// keepChat: retrying a question keeps its companion conversation.
function startQuestion(draft, keepChat) {
  session.stage = draft ? "review" : "answer";
  if (!keepChat) session.chat = [];
  $("answer").value = draft;
  $("answer").placeholder = "";
  $("recStatus").textContent = "";
  $("expHint").hidden = true;
  clearReplay();
  setFlip("q", currentQuestion());
  show("practice");
  renderPractice();
  renderChat();
  if (session.mode === "speak" && session.camera) startPreview();
}

function currentQuestion() {
  return session.questions[session.index];
}

function isLastQuestion() {
  return session && session.index + 1 >= session.questions.length;
}

function hasUnsentAnswer() {
  return sessionActive() && currentView === "practice" &&
    !["loading", "error"].includes(session.stage) &&
    ($("answer").value.trim() !== "" || session.stage === "recording");
}

const HINT_LABEL = "Hint: see it in plain language";

// Fills a question card. The hint button flips it to the plain-language side.
function setFlip(prefix, q) {
  const card = $(prefix + "Flip");
  card.classList.remove("flipped");
  card.querySelector(".hint-btn").setAttribute("aria-pressed", "false");
  card.querySelector(".hint-label").textContent = HINT_LABEL;
  card.querySelector(".flip-back").setAttribute("aria-hidden", "true");
  card.querySelector(".flip-front").removeAttribute("aria-hidden");
  $(prefix + "Text").textContent = q.original;
  $(prefix + "Plain").textContent = q.plain || "";
  $(prefix + "Meaning").textContent = q.meaning || "";
}

document.querySelectorAll(".hint-btn").forEach((button) => {
  button.addEventListener("click", () => {
    const card = button.closest(".flip");
    const flipped = card.classList.toggle("flipped");
    button.setAttribute("aria-pressed", String(flipped));
    button.querySelector(".hint-label").textContent = flipped ? "Back to the original question" : HINT_LABEL;
    card.querySelector(".flip-back").setAttribute("aria-hidden", String(!flipped));
    card.querySelector(".flip-front").setAttribute("aria-hidden", String(flipped));
  });
});

function renderPractice() {
  const stage = session.stage;
  const speaking = session.mode === "speak";
  const waiting = stage === "loading" || stage === "error";
  const busy = stage === "recording" || stage === "transcribing";

  $("practiceCounter").textContent = `Question ${session.index + 1} of ${session.questions.length} · take your time`;
  $("practiceTitle").textContent = stage === "review" ? "Review your answer" : "Interview practice";
  $("noticeMic").hidden = stage !== "mic";

  // Answer box: when typing, and after a recording (as an editable transcript)
  $("answerArea").hidden = waiting || (speaking && !["review", "mic"].includes(stage));
  $("answerLabel").textContent = stage === "review" ? "Your transcript (you can edit it)" : "Your answer";
  $("audioReplay").hidden = waiting;

  // Controls
  $("controls").hidden = waiting;
  $("recBtn").classList.toggle("recording", stage === "recording");
  $("recBtn").disabled = stage === "transcribing";
  $("recLabel").textContent =
    stage === "recording" ? "Stop" :
    stage === "review" ? "Record again" :
    stage === "mic" ? "Try again" : "Record";
  $("recBtn").setAttribute("aria-label", $("recLabel").textContent);
  $("recRecommended").hidden = $("recLabel").textContent !== "Record";
  $("cameraToggle").disabled = busy;
  $("cameraToggle").setAttribute("aria-pressed", String(session.camera));
  $("cameraLabel").textContent = session.camera ? "Camera on" : "Camera off";
  $("typeBtn").disabled = busy;
  $("expHintBtn").hidden = !cards.length;
  $("typeBtn").setAttribute("aria-pressed", String(!speaking));
  $("recStatus").hidden = waiting;
  if (stage === "recording") $("recStatus").textContent = "Recording… press Stop when you're done.";
  else if (stage === "transcribing") $("recStatus").textContent = "Writing out your answer…";
  else if (stage !== "review") $("recStatus").textContent = "";

  // Waiting for feedback
  $("submittedCard").hidden = !waiting;
  $("submittedText").textContent = $("answer").value.trim();
  $("loadingPanel").hidden = stage !== "loading";
  $("errorPanel").hidden = stage !== "error";
  $("companion").hidden = waiting;
  updateCoach();

  renderArrows();
}

// The arrow says "Skip" while the answer is empty.
$("answer").addEventListener("input", renderArrows);

$("recBtn").addEventListener("click", () => {
  if (session.stage === "recording") stopRecording(false);
  else {
    $("answer").value = "";
    startRecording();
  }
});

$("typeBtn").addEventListener("click", () => {
  session.mode = "type";
  stopPreview();
  if (session.stage !== "review") session.stage = "answer";
  renderPractice();
  $("answer").focus();
});

$("retryFeedback").addEventListener("click", submitAnswer);

async function submitAnswer() {
  const answer = $("answer").value.trim();
  if (!answer) {
    session.results[session.index] = { question: currentQuestion(), answer: "", skipped: true };
    nextQuestion();
    return;
  }

  stopPreview();
  session.stage = "loading";
  renderPractice();
  const mySession = session;
  const q = currentQuestion();

  try {
    const feedback = await postJson("/api/feedback", {
      question: q.original,
      answer: answer,
      small_talk: Boolean(q.small_talk),
      job_title: session.jobTitle,
      job_description: session.jobDescription
    });
    if (mySession !== session || session.finished) return;   // left while waiting
    session.results[session.index] = { question: q, answer: answer, feedback: feedback };
    renderFeedback();
    show("feedback");
    renderChat();
  } catch (err) {
    if (mySession !== session || session.finished) return;
    session.stage = "error";
    renderPractice();
  }
}

$("continueNoFeedback").addEventListener("click", () => {
  session.results[session.index] = { question: currentQuestion(), answer: $("answer").value.trim(), feedback: null };
  nextQuestion();
});

function nextQuestion() {
  stopPreview();
  if (isLastQuestion()) {
    finishSession();
    return;
  }
  session.index += 1;
  startQuestion("");
}

// Feedback page: answer the same question again, starting from the last answer.
function retryQuestion() {
  const draft = session.results[session.index].answer;
  session.results[session.index] = undefined;
  session.mode = "type";
  startQuestion(draft, true);
}

function finishSession() {
  stopRecording(true);
  stopPreview();
  session.finished = true;
  nextFocus = "";
  // Every session with at least one answer is saved automatically, in this browser.
  if (session.results.some((r) => r && r.answer)) {
    save("starstruck.unlocked", true);
    const sessions = load("starstruck.sessions", []);
    sessions.push({
      date: new Date().toISOString(),
      minutes: Math.max(1, Math.round((Date.now() - session.startedAt) / 60000)),
      jobTitle: session.jobTitle,
      jobDescription: session.jobDescription,
      general: !session.jobDescription,
      results: session.results.filter(Boolean)
    });
    save("starstruck.sessions", sessions);
    session.saved = true;
  }
  go("summary");
}


/* =====================================================
   8. RECORDING
   - Only the audio is uploaded, to be turned into text.
   - With the camera on, a video copy is kept in this browser for replay.
   ===================================================== */

const video = $("video");
let previewStream = null;
let recorders = [];
let recordStream = null;
let replayUrl = null;

async function startPreview() {
  if (previewStream) return;
  try {
    previewStream = await navigator.mediaDevices.getUserMedia({ video: true });
    showLive(previewStream);
  } catch (err) {
    session.camera = false;
    renderPractice();
  }
}

function stopPreview() {
  if (previewStream) previewStream.getTracks().forEach((t) => t.stop());
  previewStream = null;
  if (!recordStream && !replayUrl) $("cameraBox").classList.remove("on");
}

function showLive(stream) {
  video.removeAttribute("src");
  video.srcObject = stream;
  video.muted = true;
  video.controls = false;
  video.play().catch(() => {});
  $("cameraBox").classList.add("on");
}

function clearReplay() {
  if (replayUrl) URL.revokeObjectURL(replayUrl);
  replayUrl = null;
  video.removeAttribute("src");
  video.srcObject = null;
  $("cameraBox").classList.remove("on");
  $("audioReplay").textContent = "";
}

$("cameraToggle").addEventListener("click", () => {
  session.camera = !session.camera;
  clearReplay();
  if (session.camera) startPreview();
  else stopPreview();
  renderPractice();
});

async function startRecording() {
  const s = session;
  stopPreview();
  clearReplay();

  try {
    recordStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: s.camera });
  } catch (err) {
    s.mode = "speak";
    s.stage = "mic";
    renderPractice();
    return;
  }

  const audioChunks = [];
  const videoChunks = [];
  const audioRecorder = new MediaRecorder(new MediaStream(recordStream.getAudioTracks()));
  audioRecorder.ondataavailable = (e) => audioChunks.push(e.data);
  recorders = [audioRecorder];

  let videoRecorder = null;
  if (s.camera) {
    showLive(recordStream);
    videoRecorder = new MediaRecorder(recordStream);
    videoRecorder.ondataavailable = (e) => videoChunks.push(e.data);
    recorders.push(videoRecorder);
  }

  const stopped = recorders.map((r) => new Promise((resolve) => (r.onstop = resolve)));
  recorders.forEach((r) => r.start(1000));
  s.mode = "speak";
  s.stage = "recording";
  renderPractice();

  await Promise.all(stopped);
  if (recordStream) recordStream.getTracks().forEach((t) => t.stop());
  recordStream = null;
  if (s.cancelled || s !== session) {
    s.cancelled = false;
    return;
  }

  const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
  showReplay(videoRecorder ? new Blob(videoChunks, { type: "video/webm" }) : audioBlob, Boolean(videoRecorder));
  await transcribe(audioBlob);
}

// Stops recording. With cancel = true the recording is thrown away.
function stopRecording(cancel) {
  if (!recorders.length) return;
  if (cancel && session) session.cancelled = true;
  recorders.forEach((r) => r.state !== "inactive" && r.stop());
  recorders = [];
}

function showReplay(blob, isVideo) {
  replayUrl = URL.createObjectURL(blob);
  if (isVideo) {
    video.srcObject = null;
    video.src = replayUrl;
    video.muted = false;
    video.controls = true;
    $("cameraBox").classList.add("on");
  } else {
    const audio = el("audio");
    audio.controls = true;
    audio.src = replayUrl;
    $("audioReplay").append(audio);
  }
}

async function transcribe(audioBlob) {
  const s = session;
  s.stage = "transcribing";
  renderPractice();
  let message = "";

  if (audioBlob.size === 0) {
    message = "The recording came out empty. Check your microphone and record again, or type instead.";
  } else {
    const form = new FormData();
    form.append("recording", audioBlob, "answer.webm");
    try {
      const data = await postForm("/api/transcribe", form);
      if (s !== session) return;   // left while waiting
      $("answer").value = data.transcript;
    } catch (err) {
      if (s !== session) return;
      // Without an API key there is no transcript: leave a placeholder the user can type over.
      $("answer").placeholder = TRANSCRIPT_PLACEHOLDER;
    }
  }

  s.stage = "review";
  $("recStatus").textContent = message;
  renderPractice();
}


/* =====================================================
   9. COMPANION
   One chat per question, shown on Practice and Feedback.
   The suggestions above the text box send a ready-made message.
   ===================================================== */

// Short labels on the chips; the full message is what gets sent.
const SUGGESTIONS = {
  practice: [
    { label: "Find an experience", message: "Help me find a relevant experience for this question." },
    { label: "Key skills", message: "Remind me of the key skills this question is looking for." },
    { label: "Structure my answer", message: "Help me structure my answer using STAR." }
  ],
  feedback: [
    { label: "Improved script", message: "Give me a script of an improved version of my answer." },
    { label: "Ways to practice", message: "What are some actionable things I can do to practice applying the areas to improve feedback?" }
  ]
};

const GREETING = {
  practice: "Hi! I can help you find an experience, name the skills this question is about, or plan your answer. Pick a suggestion or ask me anything.",
  feedback: "Want help with your feedback? Pick a suggestion or ask me anything."
};

function renderChat() {
  if (!session) return;
  const where = currentView === "feedback" ? "feedback" : "practice";
  const box = $("chatLog");
  box.textContent = "";
  [{ role: "companion", text: GREETING[where] }].concat(session.chat).forEach((m) => {
    const you = m.role === "you";
    const row = el("div", "msg-row" + (you ? " you" : ""));
    const bubble = el("p", "bubble " + (you ? "you" : "companion-msg"), m.text);
    if (m.pending) bubble.classList.add("typing");
    if (!you) row.append(robotAvatar());
    row.append(bubble);
    box.append(row);
  });
  box.scrollTop = box.scrollHeight;

  const chips = $("chips");
  chips.textContent = "";
  SUGGESTIONS[where].forEach((s) => {
    const chip = el("button", "chip", s.label);
    chip.type = "button";
    chip.addEventListener("click", () => askCompanion(s.message));
    chips.append(chip);
  });
}

// Removes markdown symbols (**bold**, # headings, * bullets) so replies read as plain text.
function plainText(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[*-]\s+/gm, "• ")
    .replace(/\*/g, "")
    .trim();
}

// Minimize tucks the coach into a tab on the right edge; the tab opens it again.
function updateCoach() {
  $("companion").classList.toggle("minimized", coachMinimized);
  const onPage = currentView === "practice" || currentView === "feedback";
  $("coachTab").hidden = !(coachMinimized && onPage && !$("companion").hidden);
}

function setCoachMinimized(value) {
  coachMinimized = value;
  save("starstruck.coachMin", value);
  updateCoach();
  if (tourIndex >= 0) showTourStep();
}

$("coachMinimize").addEventListener("click", () => setCoachMinimized(true));
$("coachTab").addEventListener("click", () => {
  setCoachMinimized(false);
  $("chatInput").focus();
});

// The companion's profile picture: a small robot.
function robotAvatar() {
  const avatar = el("span", "avatar");
  avatar.setAttribute("aria-hidden", "true");
  avatar.innerHTML = '<svg viewBox="0 0 24 24"><rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M10 16h4M3 13v2M21 13v2"/><circle cx="12" cy="3.5" r="1"/></svg>';
  return avatar;
}

// All of the feedback as text, including each note shown under the answer.
function feedbackSummary(fb) {
  const notes = (fb.highlights || []).filter((h) => h && h.note).map((h) =>
    `- ${h.type === "worked" ? "Did well" : "To improve"}${h.label ? " (" + h.label + ")" : ""}: ${h.note}` +
    (h.quote ? ` [about: "${h.quote}"]` : ""));
  return [`What worked: ${fb.what_worked || ""}`, `What to improve: ${fb.to_improve || ""}`]
    .concat(notes.length ? ["Notes:"].concat(notes) : [])
    .join("\n");
}

async function askCompanion(text) {
  text = text.trim();
  if (!text || !session) return;
  const history = session.chat.filter((m) => !m.pending);
  const reply = { role: "companion", text: "…", pending: true };
  session.chat.push({ role: "you", text: text }, reply);
  renderChat();

  const result = session.results[session.index];
  const fb = result && result.feedback;
  try {
    const data = await postJson("/api/companion", {
      question: currentQuestion().original,
      message: text,
      answer: result ? result.answer : $("answer").value.trim(),
      resume: resume ? resume.text : "",
      job_title: session.jobTitle,
      job_description: session.jobDescription,
      feedback: fb ? feedbackSummary(fb) : "",
      history: history
    });
    reply.text = plainText(data.reply);
  } catch (err) {
    reply.text = "Sorry, I couldn't answer just now. " + connectionMessage(err);
  }
  reply.pending = false;
  renderChat();
}

$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  askCompanion($("chatInput").value);
  $("chatInput").value = "";
});


/* =====================================================
   10. FEEDBACK
   ===================================================== */

function renderFeedback() {
  const result = session.results[session.index];
  const fb = result.feedback;

  $("feedbackCounter").textContent = `Question ${session.index + 1} of ${session.questions.length}`;
  setFlip("fb", result.question);
  // Notes sit next to the answer. If there are none, show the one thing to improve.
  let highlights = (fb.highlights || []).filter((h) => h && h.note);
  if (!highlights.length && fb.to_improve) highlights = [{ type: "improve", label: "To improve", note: fb.to_improve }];
  renderAnnotatedAnswer(result.answer, highlights);

  const list = $("fbHighlights");
  list.textContent = "";
  highlights.forEach((h) => {
    const kind = h.type === "worked" ? "worked" : "improve";
    const item = el("div", "hl " + kind);
    item.append(
      el("span", "hl-label", (kind === "worked" ? "What you did well" : "Area to improve") + (h.label ? " – " + h.label : "")),
      el("span", "hl-note", h.note)
    );
    list.append(item);
  });
}

// Shows the user's own words with the quoted excerpts marked and numbered.
function renderAnnotatedAnswer(answer, highlights) {
  const box = $("fbAnswer");
  box.textContent = "";
  const lower = answer.toLowerCase();

  const spans = [];
  highlights.forEach((h, i) => {
    if (!h.quote) return;
    const start = lower.indexOf(h.quote.toLowerCase());
    if (start === -1) return;
    const end = start + h.quote.length;
    if (spans.some((s) => start < s.end && end > s.start)) return;   // skip overlaps
    spans.push({ start, end, n: i + 1, kind: h.type === "worked" ? "worked" : "improve" });
  });
  spans.sort((a, b) => a.start - b.start);

  let pos = 0;
  spans.forEach((s) => {
    box.append(answer.slice(pos, s.start));
    box.append(el("mark", s.kind, answer.slice(s.start, s.end)));
    pos = s.end;
  });
  box.append(answer.slice(pos));
}


/* =====================================================
   11. SUMMARY
   ===================================================== */

function renderSummary() {
  if (!session) return;
  const results = session.results.filter(Boolean);
  const withFeedback = results.filter((r) => r.feedback);

  const strengths = $("sumStrengths");
  strengths.textContent = "";
  const worked = [...new Set(withFeedback.map((r) => r.feedback.what_worked).filter(Boolean))];
  (worked.length ? worked : ["You showed up and practiced."]).slice(0, 4)
    .forEach((s) => strengths.append(el("li", "", s)));

  const improve = $("sumNext");
  improve.textContent = "";
  const areas = [...new Set(withFeedback.map((r) => r.feedback.to_improve).filter(Boolean))];
  (areas.length ? areas : ["Answer a question to get a focus for next time."]).slice(0, 4)
    .forEach((s) => improve.append(el("li", "", s)));

  const answers = $("sumAnswers");
  answers.textContent = "";
  session.questions.forEach((q, i) => {
    const r = session.results[i];
    const item = el("li");
    item.append(el("strong", "", q.original), el("br"));
    item.append(el("span", "muted", r && r.answer ? r.answer : "Skipped"));
    answers.append(item);
  });

  $("saveStatus").textContent = session.saved ? "This session was saved automatically in this browser." : "";
  $("saveStatus").hidden = !session.saved;
}


/* =====================================================
   11b. EXPERIENCE
   Cards are short STAR notes about real experiences, built by
   the AI from the resume and practice answers. Kept in this browser.
   ===================================================== */

let editingCard = -1;   // index of the card in the editor, or -1 for a new card
let cardsWork = null;   // while building or updating: { placeholders: number }
let cardsChanged = {};  // card index -> "new" or "updated", highlighted after a build or update

function saveCards() {
  save("starstruck.stories", cards);
}

const SOURCE_LABEL = { practice: "From practice", resume: "From resume" };

// A question for the most important missing STAR part, or "" when the story is complete.
function cardQuestion(card) {
  if (card.result && card.situation && card.action) return "";
  if (card.question) return card.question;
  if (!card.result) return "What changed after you did this?";
  if (!card.situation) return "Where were you, and what was happening?";
  return "What did you do yourself?";
}

function renderExperience() {
  $("cardsWorking").hidden = !cardsWork;
  // Update appears only when there's new practice since the last build or update.
  const fresh = newAnswers().length;
  $("updateCards").hidden = !fresh;
  // Build is only offered before the first build; after that, Update brings cards up to date.
  $("buildCards").hidden = Boolean(load("starstruck.cardsUpdatedAt", null)) && cards.length > 0;
  $("cardsUpToDate").hidden = !($("buildCards").hidden && !fresh);
  $("updateCardsLabel").textContent = `Update cards (${fresh} new answer${fresh === 1 ? "" : "s"})`;
  const grid = $("cardsGrid");
  grid.textContent = "";
  $("cardsStatus").textContent = cards.length || cardsWork ? "" : "No cards yet. Build them from your resume and past answers, or create one yourself.";

  cards.forEach((card, i) => {
    const note = el("article", "note-card");
    const change = cardsChanged[i];
    if (change) note.classList.add("just-changed");
    const head = el("div", "note-head");
    head.append(el("h3", "", card.title));
    if (change) head.append(el("span", "change-tag", change === "new" ? "New" : "Updated"));
    head.append(el("span", "source-tag", SOURCE_LABEL[card.source] || "Added by you"));
    note.append(head);

    // A short summary of the STAR parts the card has.
    const summary = [["Situation", card.situation], ["Task", card.task], ["Action", card.action], ["Result", card.result]]
      .filter(([, text]) => text)
      .map(([label, text]) => `${label}: ${text}`)
      .join(" ");
    if (summary) note.append(el("p", "note-summary", summary));

    const question = cardQuestion(card);
    if (question) note.append(el("p", "note-question", "Expand: " + question));

    const actions = el("div", "note-actions");
    const practice = el("button", "btn btn-primary btn-small", "Practice this experience");
    practice.addEventListener("click", () => practiceCard(card));
    const edit = el("button", "btn btn-small", "Edit");
    edit.addEventListener("click", () => openCard(i));
    actions.append(practice, edit);
    note.append(actions);
    grid.append(note);
  });

  // Shimmering placeholder cards where new cards are coming in.
  for (let n = 0; cardsWork && n < cardsWork.placeholders; n++) {
    const ghost = el("div", "note-card skeleton-card");
    ghost.setAttribute("aria-hidden", "true");
    ["w60", "w100", "w85", "w70", "btn"].forEach((size) => ghost.append(el("span", "skeleton " + size)));
    grid.append(ghost);
  }
}

$("addCard").addEventListener("click", () => openCard(-1));

// Starts a session whose questions fit this experience.
function practiceCard(card) {
  nextFocus = `my experience "${card.title}"` + (card.action ? ` (${card.action})` : "");
  nextFocusLabel = card.title;
  session = null;
  go("setup");
}

// Every answer the user has given in saved sessions, optionally only those saved after a date.
function allAnswers(since) {
  const seen = new Set();
  return load("starstruck.sessions", [])
    .filter((saved) => !since || new Date(saved.date) > new Date(since))
    .flatMap((saved) => saved.results || [])
    .filter((r) => r.answer && !seen.has(r.answer) && seen.add(r.answer))
    .map((r) => ({ question: r.question.original, answer: r.answer }));
}

// Answers from practice done since the cards were last built or updated.
function newAnswers() {
  const since = load("starstruck.cardsUpdatedAt", null);
  return since ? allAnswers(since) : [];
}

// Build: uses the resume and all past answers. Update: only answers from new practice.
async function runCards(mode) {
  const building = mode === "build";
  const button = $(building ? "buildCards" : "updateCards");
  const label = $(building ? "buildCardsLabel" : "updateCardsLabel");
  const idle = label.textContent;
  button.disabled = true;
  button.classList.add("busy");
  label.textContent = building ? "Building…" : "Updating…";
  $("cardsStatus").textContent = "";
  $("cardsWorkingTitle").textContent = building ? "Building your experience cards…" : "Updating your experience cards…";
  const answers = building ? allAnswers() : newAnswers();
  cardsWork = { placeholders: building ? 3 : Math.min(3, Math.max(1, answers.length)) };
  cardsChanged = {};
  if (currentView === "experience") renderExperience();
  try {
    const data = await postJson("/api/experiences", {
      resume: building && resume ? resume.text : "",
      answers: answers,
      existing: cards
    });
    // Cards with an id update that card; the rest are new (skipped if the title already exists).
    let updated = 0, added = 0;
    const titles = new Set(cards.map((c) => c.title.toLowerCase()));
    data.cards.forEach((c) => {
      const card = { title: c.title || "", situation: c.situation || "", task: c.task || "",
                     action: c.action || "", result: c.result || "", skills: c.skills || [],
                     source: c.source || "", question: c.question || "" };
      if (Number.isInteger(c.id) && cards[c.id]) {
        cards[c.id] = { ...cards[c.id], ...card, title: card.title || cards[c.id].title };
        cardsChanged[c.id] = "updated";
        updated += 1;
      } else if (card.title && !titles.has(card.title.toLowerCase())) {
        titles.add(card.title.toLowerCase());
        cards.push(card);
        cardsChanged[cards.length - 1] = "new";
        added += 1;
      }
    });
    saveCards();
    save("starstruck.cardsUpdatedAt", new Date().toISOString());
    cardsWork = null;
    if (currentView === "experience") renderExperience();
    // The New / Updated highlight fades after a few seconds.
    setTimeout(() => {
      cardsChanged = {};
      document.querySelectorAll(".just-changed").forEach((n) => n.classList.add("settled"));
    }, 6000);
    const plural = (n) => `${n} card${n === 1 ? "" : "s"}`;
    const done = [added && `added ${plural(added)}`, updated && `updated ${plural(updated)}`].filter(Boolean);
    $("cardsStatus").textContent = done.length
      ? done.join(" and ").replace(/^./, (c) => c.toUpperCase()) + "."
      : "Your cards are up to date.";
  } catch (err) {
    cardsWork = null;
    if (currentView === "experience") renderExperience();
    $("cardsStatus").textContent = connectionMessage(err);
  } finally {
    button.disabled = false;
    button.classList.remove("busy");
    label.textContent = idle;
  }
}

$("buildCards").addEventListener("click", () => runCards("build"));
$("updateCards").addEventListener("click", () => runCards("update"));

function openCard(index) {
  editingCard = index;
  const card = cards[index] || { title: "", situation: "", task: "", action: "", result: "", skills: [] };
  $("cardModalTitle").textContent = index === -1 ? "Add an experience" : "Edit experience";
  $("cardTitle").value = card.title;
  $("cardSituation").value = card.situation || "";
  $("cardTask").value = card.task || "";
  $("cardAction").value = card.action || "";
  $("cardResult").value = card.result || "";
  $("cardSkills").value = (card.skills || []).join(", ");
  $("cardDelete").hidden = index === -1;
  $("cardModal").showModal();
}

$("cardForm").addEventListener("submit", () => {
  const card = {
    title: $("cardTitle").value.trim(),
    situation: $("cardSituation").value.trim(),
    task: $("cardTask").value.trim(),
    action: $("cardAction").value.trim(),
    result: $("cardResult").value.trim(),
    skills: $("cardSkills").value.split(",").map((t) => t.trim()).filter(Boolean)
  };
  if (editingCard === -1) cards.push(card);
  else cards[editingCard] = { ...cards[editingCard], ...card };   // keeps where the card came from
  saveCards();
  renderExperience();
});

$("cardCancel").addEventListener("click", () => $("cardModal").close());

$("cardDelete").addEventListener("click", () => {
  cards.splice(editingCard, 1);
  saveCards();
  $("cardModal").close();
  renderExperience();
});

// Practice page: the AI picks the card that best fits the current question,
// preferring cards not already suggested for other questions this session.
$("expHintBtn").addEventListener("click", async () => {
  const body = $("expHintBody");
  $("expHint").hidden = false;
  const index = session.index;
  const known = session.hints[index];
  if (known && cards[known.card]) {
    showHint(cards[known.card], known.reason);
    return;
  }

  body.textContent = "Finding an experience that fits…";
  const used = Object.entries(session.hints)
    .filter(([q]) => Number(q) !== index)
    .map(([, h]) => h.card);
  try {
    const data = await postJson("/api/pick-experience", {
      question: currentQuestion().original,
      cards: cards,
      used: [...new Set(used)]
    });
    session.hints[index] = { card: data.index, reason: data.reason };
    showHint(cards[data.index], data.reason);
  } catch (err) {
    body.textContent = connectionMessage(err);
  }
});

function showHint(card, reason) {
  const body = $("expHintBody");
  body.textContent = "";
  body.append(el("h3", "", card.title));
  if (reason) body.append(el("p", "muted", reason));
  [["Situation", card.situation], ["Task", card.task], ["Action", card.action], ["Result", card.result]]
    .filter(([, text]) => text)
    .forEach(([label, text]) => {
      const line = el("p", "note-line");
      line.append(el("strong", "", label + ": "), text);
      body.append(line);
    });
}

$("expHintClose").addEventListener("click", () => ($("expHint").hidden = true));


/* =====================================================
   11c. PROGRESS
   Built from the sessions the user chose to save.
   ===================================================== */

// Most common tags across saved feedback, most frequent first.
function topTags(sessions, key, limit) {
  const counts = {};
  sessions.flatMap((s) => s.results || []).forEach((r) => {
    ((r.feedback && r.feedback[key]) || []).forEach((tag) => {
      const t = tag.toLowerCase();
      counts[t] = (counts[t] || 0) + 1;
    });
  });
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, limit);
}

function sessionName(saved, i) {
  const date = new Date(saved.date).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `Session ${i + 1} · ${date}` + (saved.jobTitle ? ` · ${saved.jobTitle}` : "");
}

let progressTab = "all";   // "all" or a job key

// Sessions grouped by job (title, or the start of the description). General practice has no job.
function jobKey(saved) {
  return (saved.jobTitle || "").trim().toLowerCase() || (saved.jobDescription || "").trim().slice(0, 60).toLowerCase();
}

function jobsPracticed(sessions) {
  const jobs = [];
  sessions.forEach((saved) => {
    const key = jobKey(saved);
    if (!key || jobs.some((j) => j.key === key)) return;
    jobs.push({ key, title: saved.jobTitle || `Job ${jobs.length + 1}`, description: saved.jobDescription || "" });
  });
  return jobs;
}

function renderProgress() {
  const all = load("starstruck.sessions", []);
  const jobs = jobsPracticed(all);
  if (progressTab !== "all" && !jobs.some((j) => j.key === progressTab)) progressTab = "all";
  const job = jobs.find((j) => j.key === progressTab);
  const sessions = job ? all.filter((saved) => jobKey(saved) === job.key) : all;

  // Tabs
  const tabs = $("jobTabs");
  tabs.textContent = "";
  [{ key: "all", title: "All practice" }].concat(jobs).forEach((j) => {
    const tab = el("button", "job-tab", j.title);
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(j.key === progressTab));
    tab.addEventListener("click", () => { progressTab = j.key; renderProgress(); });
    tabs.append(tab);
  });
  const add = el("button", "job-tab job-tab-add", "+ Add job description");
  add.addEventListener("click", () => practiceForJob("", ""));
  tabs.append(add);

  $("progressEmpty").hidden = all.length > 0;
  $("progressContent").hidden = !all.length;
  $("adviceCard").hidden = true;
  if (!all.length) return;

  drawWeek($("progWeekSummary"), $("progWeekChart"), sessions, true);

  // On a job tab, the headings say they're for this role.
  const forRole = job ? " for this role" : "";
  $("strengthsTitle").textContent = "Strengths in your feedback" + forRole;
  $("growthTitle").textContent = "Areas to improve" + forRole;
  $("focusTitle").textContent = "Choose a next focus" + forRole;
  $("practiceFocus").textContent = "Practice focused on these skills" + forRole;

  // Advice card, only for a specific job
  $("adviceCard").hidden = !job;
  if (job) showJobAdvice(job);

  // Strengths and areas to improve
  const fill = (id, items, empty) => {
    const list = $(id);
    list.textContent = "";
    (items.length ? items : [empty]).forEach((t) => list.append(el("li", "", t)));
  };
  fill("progStrengths", topTags(sessions, "strength_tags", 3), "Keep practicing to see your strengths here.");
  const growth = topTags(sessions.slice(-1), "growth_tags", 3);   // from the latest session: where you are now
  fill("progGrowth", growth, "No areas to improve found yet.");

  // Sessions, newest first, each with a View button
  $("sessionsTitle").textContent = job ? `Sessions for ${job.title}` : "All sessions";
  const list = $("sessionList");
  list.textContent = "";
  all.map((saved, i) => [saved, i]).filter(([saved]) => sessions.includes(saved)).reverse().forEach(([saved, i]) => {
    const answered = (saved.results || []).filter((r) => r.answer).length;
    const item = el("li");
    item.append(el("span", "", `${sessionName(saved, i)} · ${answered} answer${answered === 1 ? "" : "s"}`));
    const view = el("button", "btn btn-small", "View");
    view.addEventListener("click", () => showSessionModal(sessionName(saved, i), sessionDetails(saved)));
    item.append(view);
    list.append(item);
  });

  // Next focus
  const choices = $("focusChoices");
  choices.textContent = "";
  // Pick one or more areas; the button needs at least one.
  growth.forEach((area, i) => {
    const option = el("label", "option");
    const input = el("input");
    input.type = "checkbox";
    input.name = "nextFocus";
    input.value = area;
    input.checked = i === 0;
    input.addEventListener("change", () => {
      $("practiceFocus").disabled = !chosenFocus().length;
    });
    option.append(input, " " + area);
    choices.append(option);
  });
  $("practiceFocus").disabled = !growth.length;
  if (!growth.length) choices.append(el("p", "muted", "Answer a few more questions to get a focus."));
}

// The AI's advice for a job, kept in this browser so it isn't fetched again.
async function showJobAdvice(job) {
  $("adviceTitle").textContent = `Advice for ${job.title}`;
  const saved = load("starstruck.jobAdvice", {});
  if (saved[job.key]) {
    $("adviceText").textContent = saved[job.key];
    return;
  }
  $("adviceText").textContent = "Reading the job description…";
  try {
    const data = await postJson("/api/job-advice", { job_title: job.title, job_description: job.description });
    const advice = plainText(data.advice);
    saved[job.key] = advice;
    save("starstruck.jobAdvice", saved);
    if (progressTab === job.key) $("adviceText").textContent = advice;
  } catch (err) {
    if (progressTab === job.key) $("adviceText").textContent = connectionMessage(err);
  }
}

// Opens Set up for "A particular job", filled in with this job (or empty to add a new one).
// focus (optional): a skill to practice for this job.
function practiceForJob(title, description, focus) {
  session = null;
  nextFocus = focus || "";
  nextFocusLabel = "";
  go("setup");
  setRadio("focus", "job");
  $("jobTitle").value = title;
  $("jobDescription").value = description;
  updateSetup();
  if (!description) $("jobDescription").focus();
}

$("practiceRole").addEventListener("click", () => {
  const job = jobsPracticed(load("starstruck.sessions", [])).find((j) => j.key === progressTab);
  if (job) practiceForJob(job.title.startsWith("Job ") ? "" : job.title, job.description);
});

function showSessionModal(title, body) {
  $("sessionModalTitle").textContent = title;
  $("sessionModalBody").textContent = "";
  $("sessionModalBody").append(body);
  $("sessionModal").showModal();
}

function sessionDetails(saved) {
  const list = el("ol", "answer-list");
  (saved.results || []).forEach((r) => {
    const item = el("li");
    item.append(el("strong", "", r.question.original), el("br"));
    item.append(el("span", "", r.answer || "Skipped"));
    if (r.feedback && r.feedback.to_improve) item.append(el("p", "muted", "Area to improve: " + r.feedback.to_improve));
    list.append(item);
  });
  return list;
}

$("sessionModalClose").addEventListener("click", () => $("sessionModal").close());

// The areas ticked under "Choose a next focus".
function chosenFocus() {
  return [...document.querySelectorAll('input[name="nextFocus"]:checked')].map((i) => i.value);
}

$("practiceFocus").addEventListener("click", () => {
  const focus = chosenFocus().join(", ");
  // On a job tab, practice this skill for that job.
  const job = jobsPracticed(load("starstruck.sessions", [])).find((j) => j.key === progressTab);
  if (job) {
    practiceForJob(job.title.startsWith("Job ") ? "" : job.title, job.description, focus);
    return;
  }
  nextFocus = focus;
  nextFocusLabel = "";
  session = null;
  go("setup");
  setRadio("focus", "general");
  updateSetup();
});


/* =====================================================
   PRACTICE TOUR
   Three short steps the first time someone practices.
   Each step points at one part of the Practice page.
   ===================================================== */

const TOUR = [
  { target: () => $("controls"), title: "Answer the question",
    text: "Press Record to speak your answer, or the keyboard to type it. There's no timer, so take as long as you need." },
  { target: () => document.querySelector("#qFlip .hint-btn"), title: "Get a hint",
    text: "Not sure what the question is asking? Press Hint to see it in plain language." },
  { target: () => (coachMinimized ? $("coachTab") : $("companion")), title: "Ask your AI coach",
    text: "Your AI coach can help you find an experience, name the skills the question is about, or plan your answer. Press Minimize to tuck it away on the right." }
];
let tourIndex = -1;

function startTour() {
  tourIndex = 0;
  showTourStep();
}

function endTour() {
  document.querySelectorAll(".tour-target").forEach((n) => n.classList.remove("tour-target"));
  $("tour").hidden = true;
  tourIndex = -1;
  save("starstruck.tourDone", true);
}

function showTourStep() {
  document.querySelectorAll(".tour-target").forEach((n) => n.classList.remove("tour-target"));
  const step = TOUR[tourIndex];
  const target = step.target();
  if (!target || target.hidden || !target.getClientRects().length) {   // skip a step whose part of the page isn't showing
    if (tourIndex < TOUR.length - 1) { tourIndex += 1; showTourStep(); } else endTour();
    return;
  }
  target.classList.add("tour-target");
  $("tourStep").textContent = `Tour step ${tourIndex + 1} of ${TOUR.length}`;
  $("tourTitle").textContent = step.title;
  $("tourText").textContent = step.text;
  $("tourNext").textContent = tourIndex === TOUR.length - 1 ? "Got it" : "Next";
  $("tour").hidden = false;
  placeTour();
  $("tourNext").focus();
}

// Puts the tooltip below the highlighted part, or above it if there's no room.
function placeTour() {
  if (tourIndex < 0) return;
  const target = TOUR[tourIndex].target();
  if (!target) return;
  const tour = $("tour");
  const r = target.getBoundingClientRect();
  const t = tour.getBoundingClientRect();
  const below = r.bottom + 12 + t.height < window.innerHeight;
  let top = below ? r.bottom + 12 : r.top - t.height - 12;
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(12, Math.min(left, window.innerWidth - t.width - 12));
  top = Math.max(12, top);
  tour.style.top = top + "px";
  tour.style.left = left + "px";
}

$("tourNext").addEventListener("click", () => {
  if (tourIndex < 0) return;
  if (tourIndex >= TOUR.length - 1) endTour();
  else { tourIndex += 1; showTourStep(); }
});
$("tourSkip").addEventListener("click", endTour);
window.addEventListener("resize", placeTour);


/* =====================================================
   12. PREFERENCES
   ===================================================== */

$("prefsButton").addEventListener("click", () => {
  if (currentView === "preferences") return;
  stopPreview();
  setRadio("prefInput", prefs.input);
  setRadio("prefCount", String(prefs.count));
  $("prefSmallTalk").checked = prefs.smallTalk;
  $("prefsStatus").textContent = "";
  show("preferences");
});

function savePreferences() {
  prefs = {
    input: radioValue("prefInput"),
    count: Number(radioValue("prefCount")),
    smallTalk: $("prefSmallTalk").checked
  };
  save("starstruck.prefs", prefs);

  // The input method applies to the current question straight away.
  if (sessionActive() && lastView === "practice" && !["loading", "error", "recording", "transcribing"].includes(session.stage)) {
    session.mode = prefs.input;
    session.stage = session.mode === "speak" && $("answer").value.trim() ? "review" : "answer";
  }
  closePreferences();
}

function closePreferences() {
  if (lastView === "setup") renderSetup();
  show(lastView);
  if (lastView === "practice" && sessionActive()) {
    renderPractice();
    if (session.mode === "speak" && session.camera) startPreview();
  }
}


/* =====================================================
   13. LEAVE
   Leaving ends the session. An unsent answer asks first.
   ===================================================== */

function leavePractice() {
  if (hasUnsentAnswer()) {
    $("leaveModal").showModal();
    return;
  }
  endSession();
  go("home");
}

function endSession() {
  stopRecording(true);
  stopPreview();
  session = null;
  $("answer").value = "";
}

$("keepEditing").addEventListener("click", () => $("leaveModal").close());

$("discardLeave").addEventListener("click", () => {
  $("leaveModal").close();
  endSession();
  go("home");
});


/* =====================================================
   14. ADMIN
   Password is checked by the backend. Anyone can read
   this file, so change ADMIN_PASSWORD on the server.
   ===================================================== */

const adminMessage = $("adminMessage");
let adminPassword = "";   // kept in memory only, cleared on page refresh

$("adminToggle").addEventListener("click", () => $("admin").showModal());
$("adminClose").addEventListener("click", () => $("admin").close());

// Log in: check the password and load the current prompt.
$("loginBtn").addEventListener("click", async () => {
  const password = $("password").value;
  adminMessage.textContent = "";
  try {
    const data = await postJson("/api/admin/login", { password: password });
    adminPassword = password;
    $("adminPrompt").value = data.prompt;
    $("adminLogin").hidden = true;
    $("adminEditor").hidden = false;
  } catch (err) {
    adminMessage.textContent = connectionMessage(err);
  }
});

// Save prompt: send the edited prompt to the backend.
$("saveBtn").addEventListener("click", async () => {
  adminMessage.textContent = "";
  try {
    await postJson("/api/admin/prompt", { password: adminPassword, prompt: $("adminPrompt").value });
    adminMessage.textContent = "Prompt saved.";
  } catch (err) {
    adminMessage.textContent = connectionMessage(err);
  }
});

// Load recent answers: show what was sent to the LLM.
$("loadSubsBtn").addEventListener("click", async () => {
  const box = $("submissions");
  box.textContent = "Loading...";
  try {
    const data = await postJson("/api/admin/submissions", { password: adminPassword });
    box.textContent = data.submissions.length ? "" : "No answers yet.";

    // Built with textContent so answer text can't inject HTML.
    data.submissions.forEach((s, i) => {
      const div = el("div", "submission");
      div.append(
        el("strong", "", (i + 1) + ". " + s.type),
        el("p", "", "Question: " + s.question),
        el("p", "", "Answer text sent to the LLM: " + s.answer)
      );
      box.append(div);
    });
  } catch (err) {
    box.textContent = connectionMessage(err);
  }
});


/* =====================================================
   START
   ===================================================== */

// Testing password. This only keeps casual visitors out: anyone can read it in this file.
const TEST_PASSWORD = "cmu2026";

$("gateForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if ($("gatePassword").value.trim() !== TEST_PASSWORD) {
    $("gateStatus").textContent = "That password isn't right. Please try again.";
    return;
  }
  save("starstruck.access", true);
  document.body.classList.remove("gated");
  renderHome();
  show("home");
});

if (load("starstruck.access", false)) {
  renderHome();
  show("home");
} else {
  document.body.classList.add("gated");
  show("gate");
  $("gatePassword").focus();
}
