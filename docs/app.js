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

const DEFAULT_PREFS = { input: "type", count: 3, smallTalk: false, camera: false };

let prefs = { ...DEFAULT_PREFS, ...load("starstruck.prefs", {}) };
let resume = load("starstruck.resume", null);     // { name, text }
let session = null;                                // the practice session in progress
let currentView = "home";
let lastView = "home";                             // where Preferences goes back to
let preparing = false;                             // true while questions are being written
let cards = load("starstruck.stories", []);       // experience cards: { title, situation, task, action, result, skills }
let nextFocus = "";                                // an area to practice, chosen on the Progress page


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
  currentView = view;
  if (view !== "preferences") lastView = view;
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== "view-" + view));

  // One companion chat follows the user from Practice to Feedback.
  if (view === "practice") $("practiceSide").append($("companion"));
  if (view === "feedback") {
    $("feedbackSide").append($("companion"));
    $("companion").hidden = false;
  }

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

function renderHome() {
  const hasResume = Boolean(resume && resume.text);
  $("resumeChip").hidden = !hasResume;
  $("resumeName").textContent = hasResume ? resume.name : "";
  if (currentView === "home") renderArrows();
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
  $("setupCamera").checked = prefs.camera;
  $("setupStatus").textContent = "";
  $("focusNote").hidden = !nextFocus;
  $("focusNote").textContent = nextFocus ? "Focus: " + nextFocus : "";
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
    smallTalk: $("setupSmallTalk").checked,
    camera: $("setupCamera").checked
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
    camera: prefs.camera,
    finished: false,
    saved: false,
    hints: {}   // question index -> experience card suggested for it
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
  if (session.camera) startPreview();
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

// Fills a question card. The hint button flips it to the plain-language side.
function setFlip(prefix, q) {
  const card = $(prefix + "Flip");
  card.classList.remove("flipped");
  card.querySelector(".hint-btn").setAttribute("aria-pressed", "false");
  card.querySelector(".hint-label").textContent = "Hint";
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
    button.querySelector(".hint-label").textContent = flipped ? "Original" : "Hint";
    card.querySelector(".flip-back").setAttribute("aria-hidden", String(!flipped));
    card.querySelector(".flip-front").setAttribute("aria-hidden", String(flipped));
  });
});

function renderPractice() {
  const stage = session.stage;
  const speaking = session.mode === "speak";
  const waiting = stage === "loading" || stage === "error";
  const busy = stage === "recording" || stage === "transcribing";

  $("practiceCounter").textContent = `Question ${session.index + 1} of ${session.questions.length}`;
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
  if (session.results.some((r) => r && r.answer)) save("starstruck.unlocked", true);
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
    { label: "Ways to practice", message: "What are some actionable things I could do to practice these skills?" }
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

// The companion's profile picture: a small robot.
function robotAvatar() {
  const avatar = el("span", "avatar");
  avatar.setAttribute("aria-hidden", "true");
  avatar.innerHTML = '<svg viewBox="0 0 24 24"><rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M10 16h4M3 13v2M21 13v2"/><circle cx="12" cy="3.5" r="1"/></svg>';
  return avatar;
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
      feedback: fb ? `What worked: ${fb.what_worked} What to improve: ${fb.to_improve}` : "",
      history: history
    });
    reply.text = data.reply;
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

  const lastImprove = withFeedback.map((r) => r.feedback.to_improve).filter(Boolean).pop();
  $("sumNext").textContent = lastImprove || "Answer a question to get a focus for next time.";

  const answers = $("sumAnswers");
  answers.textContent = "";
  session.questions.forEach((q, i) => {
    const r = session.results[i];
    const item = el("li");
    item.append(el("strong", "", q.original), el("br"));
    item.append(el("span", "muted", r && r.answer ? r.answer : "Skipped"));
    answers.append(item);
  });

  $("saveSession").hidden = session.saved || !results.length;
  $("saveStatus").textContent = session.saved ? "Saved in this browser." : "";
}

$("saveSession").addEventListener("click", () => {
  const sessions = load("starstruck.sessions", []);
  sessions.push({
    date: new Date().toISOString(),
    jobTitle: session.jobTitle,
    general: !session.jobDescription,
    results: session.results.filter(Boolean)
  });
  save("starstruck.sessions", sessions);
  session.saved = true;
  renderSummary();
});


/* =====================================================
   11b. EXPERIENCE
   Cards are short STAR notes about real experiences, built by
   the AI from the resume and practice answers. Kept in this browser.
   ===================================================== */

let editingCard = -1;   // index of the card in the editor, or -1 for a new card

function saveCards() {
  save("starstruck.stories", cards);
}

function renderExperience() {
  const grid = $("cardsGrid");
  grid.textContent = "";
  $("cardsStatus").textContent = cards.length ? "" : "No cards yet. Build them from your resume and answers, or add one yourself.";

  cards.forEach((card, i) => {
    const note = el("article", "note-card");
    note.append(el("h3", "", card.title));
    [["Situation", card.situation], ["Task", card.task], ["Action", card.action], ["Result", card.result]]
      .filter(([, text]) => text)
      .forEach(([label, text]) => {
        const line = el("p", "note-line");
        line.append(el("strong", "", label + ": "), text);
        note.append(line);
      });
    const tags = el("div", "tags");
    (card.skills || []).forEach((skill) => tags.append(el("span", "tag", skill)));
    note.append(tags);
    const edit = el("button", "link-btn", "Edit");
    edit.addEventListener("click", () => openCard(i));
    note.append(edit);
    grid.append(note);
  });

  const add = el("button", "note-card note-add", "+ Add an experience");
  add.addEventListener("click", () => openCard(-1));
  grid.append(add);
}

// Collects every answer the user has given, from saved sessions and the current one.
function allAnswers() {
  const results = load("starstruck.sessions", []).flatMap((s) => s.results || [])
    .concat(session ? session.results.filter(Boolean) : []);
  const seen = new Set();
  return results
    .filter((r) => r.answer && !seen.has(r.answer) && seen.add(r.answer))
    .map((r) => ({ question: r.question.original, answer: r.answer }));
}

$("buildCards").addEventListener("click", async () => {
  const button = $("buildCards");
  button.disabled = true;
  $("cardsStatus").textContent = "Building cards from your resume and answers…";
  try {
    const data = await postJson("/api/experiences", { resume: resume ? resume.text : "", answers: allAnswers() });
    // Keep existing cards and add new ones with a different title.
    const titles = new Set(cards.map((c) => c.title.toLowerCase()));
    const fresh = data.cards.filter((c) => {
      const key = (c.title || "").toLowerCase();
      if (!key || titles.has(key)) return false;
      titles.add(key);
      return true;
    });
    cards = cards.concat(fresh);
    saveCards();
    renderExperience();
    $("cardsStatus").textContent = fresh.length ? `Added ${fresh.length} card${fresh.length === 1 ? "" : "s"}.` : "No new experiences found.";
  } catch (err) {
    $("cardsStatus").textContent = connectionMessage(err);
  } finally {
    button.disabled = false;
  }
});

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
  else cards[editingCard] = card;
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
  [["Situation", card.situation], ["Action", card.action], ["Result", card.result]]
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

function sessionScores(saved) {
  const scored = (saved.results || []).map((r) => r.feedback && r.feedback.scores).filter(Boolean);
  if (!scored.length) return null;
  const avg = (key) => Math.round(scored.reduce((sum, sc) => sum + (Number(sc[key]) || 0), 0) / scored.length);
  return { clarity: avg("clarity"), structure: avg("structure") };
}

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
  const date = new Date(saved.date).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `Session ${i + 1} · ${date}` + (saved.jobTitle ? ` · ${saved.jobTitle}` : "");
}

function renderProgress() {
  const sessions = load("starstruck.sessions", []);
  $("progressEmpty").hidden = sessions.length > 0;
  $("progressContent").hidden = !sessions.length;
  if (!sessions.length) return;

  drawChart(sessions);

  const fill = (id, items, empty) => {
    const list = $(id);
    list.textContent = "";
    (items.length ? items : [empty]).forEach((t) => list.append(el("li", "", t)));
  };
  fill("progStrengths", topTags(sessions, "strength_tags", 3), "Keep practicing to see your strengths here.");
  // Areas to improve come from the most recent session, so they show where you are now.
  const growth = topTags(sessions.slice(-1), "growth_tags", 3);
  fill("progGrowth", growth, "No areas to improve found yet.");

  const last = sessions[sessions.length - 1];
  const answered = (last.results || []).filter((r) => r.answer).length;
  $("recentText").textContent = `${sessionName(last, sessions.length - 1)}: ${answered} answer${answered === 1 ? "" : "s"}` +
    (last.general ? ", general questions." : ".");
  $("compareSessions").disabled = sessions.length < 2;

  const choices = $("focusChoices");
  choices.textContent = "";
  growth.forEach((area, i) => {
    const option = el("label", "option");
    const input = el("input");
    input.type = "radio";
    input.name = "nextFocus";
    input.value = area;
    input.checked = i === 0;
    option.append(input, " " + area);
    choices.append(option);
  });
  $("practiceFocus").disabled = !growth.length;
}

// A small line chart of clarity and structure per saved session.
function drawChart(sessions) {
  const points = sessions.map(sessionScores);
  const W = 520, H = 220, left = 40, right = 16, top = 16, bottom = 36;
  const x = (i) => left + (sessions.length === 1 ? (W - left - right) / 2 : (i * (W - left - right)) / (sessions.length - 1));
  const y = (v) => top + (1 - v / 100) * (H - top - bottom);
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Clarity and structure scores for each saved session");
  const add = (tag, attrs, text) => {
    const node = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
    if (text) node.textContent = text;
    svg.append(node);
  };

  [0, 50, 100].forEach((v) => {
    add("line", { x1: left, x2: W - right, y1: y(v), y2: y(v), class: "grid-line" });
    add("text", { x: left - 8, y: y(v) + 4, class: "axis", "text-anchor": "end" }, v + "%");
  });
  sessions.forEach((_, i) => add("text", { x: x(i), y: H - 12, class: "axis", "text-anchor": "middle" }, "Session " + (i + 1)));

  [["clarity", "series-a"], ["structure", "series-b"]].forEach(([key, cls]) => {
    const pts = points.map((p, i) => (p ? [x(i), y(p[key])] : null)).filter(Boolean);
    if (pts.length > 1) add("polyline", { points: pts.map((p) => p.join(",")).join(" "), class: "line " + cls });
    pts.forEach(([cx, cy]) => add("circle", { cx, cy, r: 5, class: "dot " + cls }));
  });

  const box = $("chart");
  box.textContent = "";
  box.append(svg);
  const legend = el("div", "legend");
  legend.append(el("span", "key series-a", "Clarity"), el("span", "key series-b", "Structure"));
  box.append(legend);
}

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

$("viewSession").addEventListener("click", () => {
  const sessions = load("starstruck.sessions", []);
  const last = sessions[sessions.length - 1];
  $("comparePick").hidden = true;
  showSessionModal(sessionName(last, sessions.length - 1), sessionDetails(last));
});

$("compareSessions").addEventListener("click", () => {
  const sessions = load("starstruck.sessions", []);
  ["compareA", "compareB"].forEach((id, k) => {
    const select = $(id);
    select.textContent = "";
    sessions.forEach((s, i) => select.append(new Option(sessionName(s, i), i)));
    select.value = String(k === 0 ? sessions.length - 2 : sessions.length - 1);
  });
  $("comparePick").hidden = false;
  showSessionModal("Compare two sessions", renderComparison());
});

function renderComparison() {
  const sessions = load("starstruck.sessions", []);
  const grid = el("div", "compare-grid");
  ["compareA", "compareB"].forEach((id) => {
    const i = Number($(id).value);
    const s = sessions[i];
    const scores = sessionScores(s);
    const col = el("div", "card");
    col.append(el("h3", "", sessionName(s, i)));
    col.append(el("p", "", scores ? `Clarity ${scores.clarity}% · Structure ${scores.structure}%` : "No scores"));
    col.append(el("p", "muted", "Strengths: " + (topTags([s], "strength_tags", 3).join(", ") || "none yet")));
    col.append(el("p", "muted", "To improve: " + (topTags([s], "growth_tags", 3).join(", ") || "none")));
    grid.append(col);
  });
  return grid;
}

["compareA", "compareB"].forEach((id) => $(id).addEventListener("change", () => {
  $("sessionModalBody").textContent = "";
  $("sessionModalBody").append(renderComparison());
}));

$("sessionModalClose").addEventListener("click", () => $("sessionModal").close());

$("practiceFocus").addEventListener("click", () => {
  nextFocus = radioValue("nextFocus") || "";
  session = null;
  go("setup");
});


/* =====================================================
   12. PREFERENCES
   ===================================================== */

$("prefsButton").addEventListener("click", () => {
  if (currentView === "preferences") return;
  stopPreview();
  setRadio("prefInput", prefs.input);
  setRadio("prefCount", String(prefs.count));
  $("prefSmallTalk").checked = prefs.smallTalk;
  $("prefCamera").checked = prefs.camera;
  $("prefsStatus").textContent = "";
  show("preferences");
});

function savePreferences() {
  prefs = {
    input: radioValue("prefInput"),
    count: Number(radioValue("prefCount")),
    smallTalk: $("prefSmallTalk").checked,
    camera: $("prefCamera").checked
  };
  save("starstruck.prefs", prefs);

  // Input method and camera apply to the current question straight away.
  if (sessionActive() && lastView === "practice" && !["loading", "error", "recording", "transcribing"].includes(session.stage)) {
    session.mode = prefs.input;
    session.camera = prefs.camera;
    session.stage = session.mode === "speak" && $("answer").value.trim() ? "review" : "answer";
  }
  closePreferences();
}

function closePreferences() {
  if (lastView === "setup") renderSetup();
  show(lastView);
  if (lastView === "practice" && sessionActive()) {
    renderPractice();
    if (session.camera) startPreview();
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

renderHome();
show("home");
