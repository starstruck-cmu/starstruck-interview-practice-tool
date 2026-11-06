import os
import io
import re
import json
import asyncio
import base64
import zipfile
import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pypdf import PdfReader

import fallback

# Set these as environment variables. Never put the key in the code.
# Without a key the app still runs, using the built-in replies in fallback.py.
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
AI_ENABLED = bool(GEMINI_API_KEY)
if not AI_ENABLED:
    print("No GEMINI_API_KEY set: using built-in questions, basic feedback and browser transcription.")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.1-flash-lite")
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

# Admin password for the admin panel.
ADMIN_PASSWORD = "1234"

# Debug mode. Set DEBUG=1 to print Gemini responses in the terminal. Leave it off in production.
DEBUG = os.environ.get("DEBUG") == "1"

# Largest resume or job description file accepted.
MAX_FILE_BYTES = 10 * 1024 * 1024

DEFAULT_PROMPT = (
    "You are an inclusive interview coach helping job seekers practice and improve their interview responses. "
    "Provide constructive, actionable feedback that is especially accessible to autistic and ADHD users. "
    "Focus on the content of their answers rather than communication style, eye contact, or other nonverbal behaviors. "
    "Explain what the interviewer is trying to assess, identify specific strengths and areas for improvement, "
    "and suggest practical changes the user can make. "
    "Do not rewrite the user's answer; quote their own words when pointing out what worked or what to improve. "
    "Use clear, direct, encouraging language without vague praise, unnecessary criticism, "
    "or assumptions about the user's background."
)

# The format the feedback must come back in, so the page can highlight the user's own words.
FEEDBACK_FORMAT = """
Return only JSON in this shape:
{
  "what_worked": "1-2 sentences on the strongest part of the answer",
  "to_improve": "1-2 sentences on the single most useful change",
  "highlights": [
    {
      "type": "worked" or "improve",
      "label": "2-5 word label, e.g. 'your action' or 'add a result'",
      "quote": "an exact excerpt copied from the answer, or an empty string if the point is about something missing",
      "note": "one plain sentence explaining this point"
    }
  ],
  "next_step": "one sentence the user can act on in their next attempt",
  "scores": {"clarity": 0-100, "structure": 0-100},
  "strength_tags": ["2-4 word skill shown, e.g. 'setting the scene'"],
  "growth_tags": ["2-4 word area to grow, e.g. 'describing results'"]
}
Give 2 to 4 highlights. Quotes must match the answer text exactly."""

# The prompt the admin can edit. It resets to the default when the server restarts.
current_prompt = {"text": DEFAULT_PROMPT}

# Recent answers sent to the LLM, for the admin panel. Kept in memory only; cleared on restart.
submissions = []
MAX_SUBMISSIONS = 50


def record_submission(kind: str, question: str, answer: str):
    submissions.append({"type": kind, "question": question, "answer": answer})
    del submissions[:-MAX_SUBMISSIONS]

app = FastAPI()

# Lets the separate frontend page call this backend.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class QuestionsRequest(BaseModel):
    resume: str = ""
    job_title: str = ""
    job_description: str = ""
    count: int = 3
    small_talk: bool = False
    focus: str = ""


class FeedbackRequest(BaseModel):
    question: str
    answer: str
    small_talk: bool = False
    job_title: str = ""
    job_description: str = ""


class ChatMessage(BaseModel):
    role: str   # "you" or "companion"
    text: str


class CompanionRequest(BaseModel):
    question: str
    message: str
    answer: str = ""
    resume: str = ""
    job_title: str = ""
    job_description: str = ""
    feedback: str = ""
    history: list[ChatMessage] = []


class QA(BaseModel):
    question: str
    answer: str


class Card(BaseModel):
    title: str
    situation: str = ""
    task: str = ""
    action: str = ""
    result: str = ""
    skills: list[str] = []


class ExperiencesRequest(BaseModel):
    resume: str = ""
    answers: list[QA] = []
    existing: list[Card] = []   # the user's current cards, so they get updated instead of copied


class PickRequest(BaseModel):
    question: str
    cards: list[Card]
    used: list[int] = []   # cards already suggested for other questions this session


class AdminLogin(BaseModel):
    password: str


class PromptUpdate(BaseModel):
    password: str
    prompt: str


def check_password(password: str):
    if password != ADMIN_PASSWORD:
        raise HTTPException(status_code=401, detail="Wrong password.")


async def call_gemini(parts: list, as_json: bool = False):
    body = {"contents": [{"parts": parts}]}
    if as_json:
        body["generationConfig"] = {"responseMimeType": "application/json"}
    headers = {"x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=60) as client:
        # Retry when the model is busy or rate limited: waits 1s, 2s, 4s
        for attempt in range(4):
            resp = await client.post(GEMINI_URL, headers=headers, json=body)
            if resp.status_code in (429, 503) and attempt < 3:
                await asyncio.sleep(2 ** attempt)
                continue
            break

    # Debug: prints Gemini's raw response. Only on when DEBUG=1 is set.
    if DEBUG:
        print("Gemini status:", resp.status_code, resp.text)

    if resp.status_code != 200:
        raise HTTPException(status_code=503, detail="The feedback service is busy. Please try again in a minute.")

    data = resp.json()
    text = data["candidates"][0]["content"]["parts"][0]["text"]
    if not as_json:
        return text

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise HTTPException(status_code=503, detail="The feedback service sent an unreadable reply. Please try again.")


def job_context(job_title: str, job_description: str) -> str:
    if not job_description.strip():
        return "This is general interview practice, not for a specific job."
    return f"Job title: {job_title or 'not given'}\nJob description: {job_description}"


def read_file_text(filename: str, content: bytes) -> str:
    """Pulls plain text out of a PDF, DOCX or TXT file. Returns "" if it can't."""
    name = filename.lower()
    try:
        if name.endswith(".pdf"):
            reader = PdfReader(io.BytesIO(content))
            return "\n".join(page.extract_text() or "" for page in reader.pages).strip()
        if name.endswith(".docx"):
            with zipfile.ZipFile(io.BytesIO(content)) as z:
                xml = z.read("word/document.xml").decode("utf-8")
            xml = re.sub(r"</w:p>", "\n", xml)
            return re.sub(r"<[^>]+>", "", xml).strip()
        if name.endswith(".txt"):
            return content.decode("utf-8", errors="ignore").strip()
    except Exception:
        return ""
    return ""


# Turns an uploaded resume or job description into plain text. The file is not stored.
@app.post("/api/read-file")
async def read_file(file: UploadFile = File(...)):
    content = await file.read()
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="This file is larger than 10 MB.")

    text = read_file_text(file.filename or "", content)
    if not text:
        raise HTTPException(status_code=422, detail="This file could not be read.")
    return {"text": text[:20000]}


@app.post("/api/questions")
async def questions(req: QuestionsRequest):
    count = max(1, min(req.count, 5))
    if not AI_ENABLED:
        return {"questions": fallback.questions(count, req.small_talk)}
    small_talk = (
        "Start with one friendly small-talk question (like an interviewer would open with), then "
        if req.small_talk else ""
    )
    prompt = (
        "You write interview practice questions for autistic and ADHD job seekers.\n"
        f"{job_context(req.job_title, req.job_description)}\n"
        f"Resume: {req.resume or 'not given'}\n\n"
        + (f"The user wants to practice this area: {req.focus}. Choose questions that exercise it.\n" if req.focus else "")
        + f"{small_talk}Write {count} common behavioral interview questions that fit this person and job. "
        "For each, also write a plain-language version that says exactly what to talk about, "
        "and one sentence on what the interviewer is trying to learn.\n"
        'Return only JSON: {"questions": [{"original": "...", "plain": "...", "meaning": "...", "small_talk": false}]}'
    )
    data = await call_gemini([{"text": prompt}], as_json=True)
    return {"questions": data.get("questions", [])}


@app.post("/api/feedback")
async def feedback(req: FeedbackRequest):
    if not AI_ENABLED:
        record_submission("answer", req.question, req.answer)
        return fallback.feedback(req.answer, req.small_talk)
    prompt = (
        current_prompt["text"] + "\n\n"
        "Judge only the content of the answer. If it was spoken, do not comment on speech patterns, "
        "fluency, pace, tone, or delivery.\n\n"
        f"{job_context(req.job_title, req.job_description)}\n\n"
        f"Interview question: {req.question}\n\n"
        f"Candidate's answer: {req.answer}\n"
        + FEEDBACK_FORMAT
    )
    result = await call_gemini([{"text": prompt}], as_json=True)
    record_submission("answer", req.question, req.answer)
    return result


# Audio -> transcript only. The user reviews and edits the transcript before asking for feedback.
@app.post("/api/transcribe")
async def transcribe(recording: UploadFile = File(...)):
    if not AI_ENABLED:
        # The page falls back to the browser's own speech recognition.
        raise HTTPException(status_code=501, detail="Transcription needs a Gemini API key.")
    audio_b64 = base64.b64encode(await recording.read()).decode()
    mime = (recording.content_type or "audio/webm").split(";")[0]
    transcript = await call_gemini([
        {"text": "Transcribe the speech in this audio exactly as spoken. Output only the transcript text, nothing else."},
        {"inline_data": {"mime_type": mime, "data": audio_b64}},
    ])
    return {"transcript": transcript.strip()}


# The practice companion: optional chat help while preparing an answer or reading feedback.
@app.post("/api/companion")
async def companion(req: CompanionRequest):
    if not AI_ENABLED:
        return {"reply": fallback.companion(req.message)}
    history = "\n".join(f"{m.role.upper()}: {m.text}" for m in req.history[-8:])
    prompt = (
        "You are a calm practice companion for an autistic or ADHD job seeker preparing an interview answer. "
        "Help them recall their own experiences, name skills, or structure their answer with STAR "
        "(Situation, Task, Action, Result). If they haven't received feedback yet, do not write the answer for them. "
        "If they ask how to practice, give concrete exercises for applying the specific feedback they received. "
        "If they have feedback and ask for an improved version or script, rewrite their answer using only their own experiences. "
        "Use short, plain sentences and at most 150 words. Write plain text only: no markdown, "
        "no asterisks or pound signs. For a list, start each line with \"• \".\n\n"
        f"{job_context(req.job_title, req.job_description)}\n"
        f"Resume: {req.resume or 'not given'}\n"
        f"Interview question: {req.question}\n"
        f"Their draft answer so far: {req.answer or 'none yet'}\n"
        + (f"Feedback they received: {req.feedback}\n" if req.feedback else "")
        + f"\nConversation so far:\n{history}\n\nYOU: {req.message}\nCOMPANION:"
    )
    reply = await call_gemini([{"text": prompt}])
    return {"reply": reply.strip()}


# Builds or updates short STAR experience cards from the resume and past answers.
# Cards that update an existing one come back with that card's "id" (its position in the list).
@app.post("/api/experiences")
async def experiences(req: ExperiencesRequest):
    answers = [a for a in req.answers if a.answer.strip()][-15:]
    existing = [c.model_dump() for c in req.existing]
    if not AI_ENABLED:
        return {"cards": fallback.experiences(req.resume, [(a.question, a.answer) for a in answers], existing)}
    answer_text = "\n".join(f"Q: {a.question}\nA: {a.answer}" for a in answers) or "none"
    existing_text = "\n".join(
        f"id {i}: {c['title']} | S: {c['situation']} | T: {c['task']} | A: {c['action']} | R: {c['result']}"
        for i, c in enumerate(existing)
    ) or "none"
    prompt = (
        "You help an autistic or ADHD job seeker keep a set of real experiences they can use in interviews.\n"
        f"Resume: {req.resume or 'not given'}\n"
        f"Their past practice answers:\n{answer_text}\n\n"
        f"Their existing experience cards:\n{existing_text}\n\n"
        "Rules:\n"
        "- Every practice answer that describes a real experience must be covered by a card.\n"
        "- If an experience is already on an existing card, do not make a new card. Instead return that card "
        "with its id, filling in or improving parts using new details from the answers.\n"
        "- Add new cards (without an id) only for experiences not covered yet, from the answers or the resume.\n"
        "- Only use what they actually wrote; do not invent details. Leave a STAR part empty if unknown.\n"
        "- Return only cards that are new or changed. At most 8 new cards.\n"
        'Return only JSON: {"cards": [{"id": 0 (only for existing cards), "title": "3-6 words", '
        '"situation": "...", "task": "...", "action": "...", "result": "...", "skills": ["2-3 skills"]}]}'
    )
    data = await call_gemini([{"text": prompt}], as_json=True)
    return {"cards": data.get("cards", [])}


# Picks the experience card that best fits an interview question.
@app.post("/api/pick-experience")
async def pick_experience(req: PickRequest):
    if not req.cards:
        raise HTTPException(status_code=400, detail="There are no experience cards yet.")
    if not AI_ENABLED:
        return fallback.pick_experience(req.question, [c.model_dump() for c in req.cards], req.used)
    listing = "\n".join(
        f"{i}. {c.title} - {c.situation} {c.action} {c.result} (skills: {', '.join(c.skills)})"
        for i, c in enumerate(req.cards)
    )
    prompt = (
        f"Interview question: {req.question}\n\nThe user's experiences:\n{listing}\n\n"
        + (f"Already suggested for other questions: {', '.join(map(str, req.used))}. "
           "Prefer a different experience so the user gets variety, unless one of these is clearly the best fit "
           "or no other experience fits.\n" if req.used else "")
        + "Pick the one experience that would make the best answer to this question, "
        "and say in one short plain sentence why it fits.\n"
        'Return only JSON: {"index": 0, "reason": "..."}'
    )
    data = await call_gemini([{"text": prompt}], as_json=True)
    index = data.get("index", 0)
    if not isinstance(index, int) or not 0 <= index < len(req.cards):
        index = 0
    return {"index": index, "reason": data.get("reason", "")}


@app.post("/api/admin/login")
async def admin_login(req: AdminLogin):
    check_password(req.password)
    return {"prompt": current_prompt["text"]}


@app.post("/api/admin/prompt")
async def admin_update_prompt(req: PromptUpdate):
    check_password(req.password)
    current_prompt["text"] = req.prompt
    return {"ok": True}


@app.post("/api/admin/submissions")
async def admin_submissions(req: AdminLogin):
    check_password(req.password)
    return {"submissions": list(reversed(submissions))}
