# STARstruck Interview Practice

A web app that helps job seekers practice interview questions and get feedback on their answers. It was built for a CMU class project with HAAPE (Helping Autistic and ADHD People Enter the workforce), with a focus on neuroinclusive design. Feedback focuses on the content of answers, and the app is self-paced and private.

## Setup

You need Python 3.10 or newer. A Gemini API key is optional (see Configuration).

**1. Install the backend packages**
```bash
cd backend
pip install -r requirements.txt
```

**2. Set your API key (optional; skip this to run without AI)**
```bash
export GEMINI_API_KEY="your-key-here"
```

## Running the app locally

Open two terminal windows.

**Terminal 1: backend**
```bash
cd backend
uvicorn main:app --reload
```
The backend runs at `http://127.0.0.1:8000`.

**Terminal 2: frontend**
```bash
cd docs
python3 -m http.server 5500
```
Open `http://localhost:5500` in your browser. Use `localhost`, not a double-click on the file, so the camera works.

## How it works

1. **Home:** the user uploads a resume (PDF or DOCX). The backend pulls out the text and does not keep the file.
2. **Setup:** the user picks general questions or a particular job, typing or speaking, 1 or 3 questions, small talk and camera preview.
3. **Practice:** Gemini writes questions for the resume and job, each with a plain-language version. An optional practice companion helps recall experiences or structure an answer. Spoken answers are turned into an editable transcript before they are submitted.
4. **Feedback:** Gemini returns what worked, what to improve and highlights that quote the user's own words.
5. **Summary:** the user can save the session. Preferences, the resume text and saved sessions are kept in the browser only (`localStorage`), never on the server.

6. **Experience** (unlocks after the first finished session): Gemini turns the resume and past answers into short STAR experience cards, which the user can edit, delete or add to. On the practice page, the **Experience hint** button asks Gemini to pick the card that best fits the current question.
7. **Progress** (unlocks after the first finished session): a chart of clarity and structure scores for each saved session, common strengths, areas to improve from the latest session, a session viewer, a side-by-side comparison of two sessions, and a "Choose a next focus" option that steers the next session's questions.

Experience cards are also kept only in the browser.

## Configuration

- `GEMINI_API_KEY` (optional): your Gemini API key.

**Without a key** the app still works. Questions come from a built-in list in `backend/fallback.py`, feedback is a basic check for situation, action and result, and the companion buttons give ready-made tips. Recording still works, but there's no transcript: the answer box shows a placeholder and you can type your answer instead.

When the page is opened from `localhost`, it calls the local backend at `http://127.0.0.1:8000`. Anywhere else, it calls the deployed Railway backend. Both addresses are set by `API` at the top of `docs/app.js`.

## Deployment

- **Frontend:** GitHub Pages serves the `docs/` folder from `main` at https://starstruck-cmu.github.io/starstruck-interview-practice-tool/. Pushing to `main` updates the site.
- **Backend:** Railway runs the `backend/` folder. Set `GEMINI_API_KEY` in Railway's variables.
