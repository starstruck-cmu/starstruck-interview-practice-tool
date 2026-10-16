# STARstruck Interview Practice

A web app that helps job seekers practice interview questions and get feedback on their answers. It was built for a CMU class project with HAAPE (Helping Autistic and ADHD People Enter the workforce), with a focus on neuroinclusive design. Feedback focuses on the content of answers, and the app is self-paced and private.

## Setup

You need Python 3.10 or newer and a Gemini API key.

**1. Install the backend packages**
```bash
cd backend
pip install -r requirements.txt
```

**2. Set your API key**
```bash
export GEMINI_API_KEY="your-key-here"
```

## Running the app locally

Open two terminal windows.

**Terminal 1: backend**
```bash
cd backend
export GEMINI_API_KEY="your-key-here"
uvicorn main:app --reload
```
The backend runs at `http://127.0.0.1:8000`.

**Terminal 2: frontend**
```bash
cd docs
python3 -m http.server 5500
```
Open `http://localhost:5500` in your browser. Use `localhost`, not a double-click on the file, so the camera works.

## Configuration

- `GEMINI_API_KEY` (required): your Gemini API key

The frontend calls the deployed Railway backend by default. To use your local backend instead, change `API` at the top of `docs/app.js` to `http://127.0.0.1:8000`.

## Deployment

- **Frontend:** GitHub Pages serves the `docs/` folder from `main` at https://mallanic-cmu.github.io/starstruck-interview-practice-tool/. Pushing to `main` updates the site.
- **Backend:** Railway runs the `backend/` folder. Set `GEMINI_API_KEY` in Railway's variables.
