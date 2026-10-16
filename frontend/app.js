/* =====================================================
   APP.JS
   All the behavior for the page, split into sections:
     1. SETTINGS         - change the backend address or the question here
     2. HELPERS          - small shared functions
     3. TYPED ANSWER     - the "type your answer" flow
     4. RECORDING        - the camera/mic flow
     5. ADMIN            - login, prompt editing, recent answers
   ===================================================== */


/* =====================================================
   1. SETTINGS
   ===================================================== */

// Backend address (the deployed Railway backend).
const API = "https://starstruck-interview-practice-tool-production.up.railway.app";

// The question the user answers.
const QUESTION = "What makes you qualified for this job?";


/* =====================================================
   2. HELPERS
   ===================================================== */

const feedbackBox = document.getElementById("feedback");
const CONNECTION_ERROR =
  "Error: The feedback service could not be reached.";

// Shows text in the feedback box on the right.
function showFeedback(text) {
  feedbackBox.textContent = text;
}

// Sends a JSON POST to the backend. Returns { ok, data }.
// Throws if the backend can't be reached at all.
async function postJson(path, body) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return { ok: res.ok, data: data };
}


/* =====================================================
   3. TYPED ANSWER
   Sends the text box contents to /api/feedback.
   ===================================================== */

document.getElementById("submitTyped").addEventListener("click", async () => {
  const answer = document.getElementById("answer").value;
  showFeedback("Loading...");

  try {
    const result = await postJson("/api/feedback", { question: QUESTION, answer: answer });
    showFeedback(result.ok ? result.data.feedback : result.data.detail);
  } catch (err) {
    showFeedback(CONNECTION_ERROR);
  }
});


/* =====================================================
   4. RECORDING
   - The camera preview and the replay share one <video> box.
   - Two recorders run together:
       videoRecorder: video + audio, kept in the browser for replay
       audioRecorder: audio only, the only thing sent to the backend
   ===================================================== */

const video = document.getElementById("video");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const submitRecBtn = document.getElementById("submitRecBtn");

let videoRecorder = null;
let audioRecorder = null;
let recordingDone = null;   // a promise that resolves once both recorders have stopped
let videoChunks = [];
let audioChunks = [];
let audioBlob = null;       // the audio that gets uploaded

// Start: ask for camera and mic, show the live preview, start recording.
startBtn.addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

    // Show the live camera in the same box the replay will use.
    video.removeAttribute("src");
    video.load();
    video.srcObject = stream;
    video.muted = true;        // mute the live preview so no echo
    video.controls = false;
    video.play();

    // Audio-only stream from the same mic. This is the only part uploaded.
    const audioStream = new MediaStream(stream.getAudioTracks());

    // Reset from any earlier recording.
    videoChunks = [];
    audioChunks = [];
    audioBlob = null;

    videoRecorder = new MediaRecorder(stream);
    audioRecorder = new MediaRecorder(audioStream);
    videoRecorder.ondataavailable = (e) => videoChunks.push(e.data);
    audioRecorder.ondataavailable = (e) => audioChunks.push(e.data);

    // Wait for both recorders to finish before building the files.
    const videoStopped = new Promise((resolve) => (videoRecorder.onstop = resolve));
    const audioStopped = new Promise((resolve) => (audioRecorder.onstop = resolve));

    recordingDone = Promise.all([videoStopped, audioStopped]).then(() => {
      audioBlob = new Blob(audioChunks, { type: "audio/webm" });
      const videoBlob = new Blob(videoChunks, { type: "video/webm" });
      console.log("Recording sizes:", { video: videoBlob.size, audio: audioBlob.size, videoChunks: videoChunks.length, audioChunks: audioChunks.length });

      if (videoBlob.size === 0 || audioBlob.size === 0) {
        audioBlob = null;
        showFeedback("The recording came out empty. Check that your camera and mic are working, record for a few seconds, and try again.");
      }

      // Replace the live camera with the replay, in the same box.
      video.srcObject = null;
      video.src = URL.createObjectURL(videoBlob);
      video.muted = false;
      video.controls = true;

      // Turn off the camera and mic.
      stream.getTracks().forEach((track) => track.stop());
      submitRecBtn.disabled = !audioBlob;
    });

    videoRecorder.start(1000);
    audioRecorder.start(1000);
    startBtn.disabled = true;
    stopBtn.disabled = false;
    submitRecBtn.disabled = true;
  } catch (err) {
    showFeedback("Error: Could not access the camera or microphone. Check your browser permissions and try again.");
  }
});

// Stop: end both recorders and wait for the replay to be ready.
stopBtn.addEventListener("click", async () => {
  videoRecorder.stop();
  audioRecorder.stop();
  stopBtn.disabled = true;
  await recordingDone;
  startBtn.disabled = false;
});

// Submit: upload only the audio to /api/feedback-audio.
submitRecBtn.addEventListener("click", async () => {
  if (!audioBlob) return;
  showFeedback("Loading...");

  const form = new FormData();
  form.append("question", QUESTION);
  form.append("recording", audioBlob, "answer.webm");   // audio only

  try {
    const res = await fetch(API + "/api/feedback-audio", { method: "POST", body: form });
    const data = await res.json();
    showFeedback(res.ok ? data.feedback : data.detail);
  } catch (err) {
    showFeedback(CONNECTION_ERROR);
  }
});


/* =====================================================
   5. ADMIN
   Password is checked by the backend. Anyone can read
   this file, so change ADMIN_PASSWORD on the server.
   ===================================================== */

const adminBox = document.getElementById("admin");
const adminMessage = document.getElementById("adminMessage");
let adminPassword = "";   // kept in memory only, cleared on page refresh

// Admin button: show or hide the panel.
document.getElementById("adminToggle").addEventListener("click", () => {
  adminBox.style.display = adminBox.style.display === "block" ? "none" : "block";
});

// Log in: check the password and load the current prompt.
document.getElementById("loginBtn").addEventListener("click", async () => {
  const password = document.getElementById("password").value;
  adminMessage.textContent = "";

  try {
    const result = await postJson("/api/admin/login", { password: password });
    if (!result.ok) {
      adminMessage.textContent = result.data.detail;
      return;
    }

    adminPassword = password;
    document.getElementById("adminPrompt").value = result.data.prompt;
    document.getElementById("adminLogin").style.display = "none";
    document.getElementById("adminEditor").style.display = "block";
  } catch (err) {
    adminMessage.textContent = "Error: The backend server could not be reached.";
  }
});

// Save prompt: send the edited prompt to the backend.
document.getElementById("saveBtn").addEventListener("click", async () => {
  const prompt = document.getElementById("adminPrompt").value;
  adminMessage.textContent = "";

  try {
    const result = await postJson("/api/admin/prompt", { password: adminPassword, prompt: prompt });
    adminMessage.textContent = result.ok ? "Prompt saved." : result.data.detail;
  } catch (err) {
    adminMessage.textContent = "Error: The backend server could not be reached.";
  }
});

// Load recent answers: show what was sent to the LLM.
document.getElementById("loadSubsBtn").addEventListener("click", async () => {
  const box = document.getElementById("submissions");
  box.textContent = "Loading...";

  try {
    const res = await fetch(API + "/api/admin/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: adminPassword })
    });
    const data = await res.json();
    if (!res.ok) {
      box.textContent = data.detail;
      return;
    }

    box.textContent = "";
    if (data.submissions.length === 0) {
      box.textContent = "No answers yet.";
      return;
    }

    // Build each entry with textContent so answer text can't inject HTML.
    data.submissions.forEach((s, i) => {
      const div = document.createElement("div");
      div.className = "submission";

      const title = document.createElement("strong");
      title.textContent = (i + 1) + ". " + s.type;

      const question = document.createElement("p");
      question.textContent = "Question: " + s.question;

      const answer = document.createElement("p");
      answer.textContent = "Answer text sent to the LLM: " + s.answer;

      div.append(title, question, answer);
      box.appendChild(div);
    });
  } catch (err) {
    box.textContent = "Error: The backend server could not be reached.";
  }
});
