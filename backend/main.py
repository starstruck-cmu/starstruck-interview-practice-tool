import os
import asyncio
import base64
import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Set these as environment variables. Never put the key in the code.
GEMINI_API_KEY = os.environ["GEMINI_API_KEY"]
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.1-flash-lite")
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

# Admin password for the admin panel.
ADMIN_PASSWORD = "1234"

# Debug mode. Set DEBUG=1 to print Gemini responses in the terminal. Leave it off in production.
DEBUG = os.environ.get("DEBUG") == "1"

DEFAULT_PROMPT = (
    "You are an inclusive interview coach helping job seekers practice and improve their interview responses. "
    "Provide constructive, actionable feedback that is especially accessible to autistic and ADHD users. "
    "Focus on the content of their answers rather than communication style, eye contact, or other nonverbal behaviors. "
    "Explain what the interviewer is trying to assess, identify specific strengths and areas for improvement, "
    "and suggest practical changes the user can make. "
    "Provide a revised example answer while preserving the user's original experiences and meaning. "
    "Use clear, direct, encouraging language without vague praise, unnecessary criticism, "
    "or assumptions about the user's background."
)

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


class FeedbackRequest(BaseModel):
    question: str
    answer: str


class AdminLogin(BaseModel):
    password: str


class PromptUpdate(BaseModel):
    password: str
    prompt: str


def check_password(password: str):
    if password != ADMIN_PASSWORD:
        raise HTTPException(status_code=401, detail="Wrong password.")


async def call_gemini(parts: list) -> str:
    body = {"contents": [{"parts": parts}]}
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
    return data["candidates"][0]["content"]["parts"][0]["text"]


@app.post("/api/feedback")
async def feedback(req: FeedbackRequest):
    prompt = (
        current_prompt["text"] + "\n\n"
        f"Interview question: {req.question}\n\n"
        f"Candidate's answer: {req.answer}"
    )
    feedback_text = await call_gemini([{"text": prompt}])
    record_submission("typed", req.question, req.answer)
    return {"feedback": feedback_text}


@app.post("/api/feedback-audio")
async def feedback_audio(question: str = Form(...), recording: UploadFile = File(...)):
    audio_b64 = base64.b64encode(await recording.read()).decode()
    mime = (recording.content_type or "audio/webm").split(";")[0]

    # Step 1: audio -> transcript. Only this call receives the audio.
    transcript = await call_gemini([
        {"text": "Transcribe the speech in this audio exactly as spoken. Output only the transcript text, nothing else."},
        {"inline_data": {"mime_type": mime, "data": audio_b64}},
    ])

    # Step 2: feedback from the transcript text only. No audio is sent.
    prompt = (
        current_prompt["text"] + "\n\n"
        "Judge only the content of the answer. Do not comment on speech patterns, "
        "fluency, pace, tone, or delivery.\n\n"
        f"Interview question: {question}\n\n"
        f"Candidate's answer (transcript): {transcript}"
    )
    feedback = await call_gemini([{"text": prompt}])

    record_submission("recording (transcript)", question, transcript)
    return {"transcript": transcript, "feedback": feedback}


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
