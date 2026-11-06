"""
Built-in replies used when no GEMINI_API_KEY is set.
Questions come from a fixed list, feedback is a simple STAR check,
and the companion gives ready-made tips. No data leaves the server.
"""
import random
import re

QUESTIONS = [
    {"original": "Tell me about a time you took initiative.",
     "plain": "When did you notice something that needed doing? What did you do, and what happened?",
     "meaning": "Whether you act on problems without being told."},
    {"original": "Describe a time you worked as part of a team.",
     "plain": "Tell me about a group you worked with. What was your part, and how did it go?",
     "meaning": "How you cooperate and share work with others."},
    {"original": "Tell me about a challenge you faced and how you handled it.",
     "plain": "What was something hard you had to deal with? What steps did you take?",
     "meaning": "How you solve problems and stay steady when things go wrong."},
    {"original": "Give an example of a time you had to learn something new quickly.",
     "plain": "When did you have to learn a new skill or task fast? How did you learn it?",
     "meaning": "How you learn and adapt."},
    {"original": "Tell me about a time you made a mistake.",
     "plain": "What is a mistake you made? What did you do to fix it, and what did you learn?",
     "meaning": "Whether you take responsibility and learn from errors."},
    {"original": "Describe a time you managed several tasks at once.",
     "plain": "When did you have many things to do at the same time? How did you decide what to do first?",
     "meaning": "How you organize your time and priorities."},
    {"original": "Tell me about something you are proud of.",
     "plain": "What is something you did that you feel good about? What was your part in it?",
     "meaning": "What you value and what strengths you bring."},
    {"original": "Describe a time you helped someone.",
     "plain": "When did you help a coworker, classmate or customer? What did you do for them?",
     "meaning": "How you support the people around you."},
]

SMALL_TALK = [
    {"original": "How has your week been so far?",
     "plain": "Tell me a little about your week. A short, friendly answer is fine.",
     "meaning": "A warm-up. The interviewer wants to start the conversation comfortably.",
     "small_talk": True},
    {"original": "Did you find the place okay?",
     "plain": "Was it easy to get here today? A short answer is fine.",
     "meaning": "A warm-up question to help you settle in.",
     "small_talk": True},
]


def questions(count: int, small_talk: bool) -> list:
    chosen = [dict(q, small_talk=False) for q in random.sample(QUESTIONS, count)]
    if small_talk:
        chosen.insert(0, random.choice(SMALL_TALK))
    return chosen


# ---------- Feedback: a simple STAR check ----------

SITUATION_WORDS = r"\b(when|while|during|at (my|our|the)|in (my|our)|last (year|summer|month)|was working|were working)\b"
ACTION_WORDS = r"\bI (\w+ )?(created|made|organized|led|built|decided|talked|wrote|set up|started|planned|helped|asked|fixed|trained|designed|reached out|took|worked|managed|solved|suggested|volunteered|learned|practiced|scheduled|called|emailed|shared)\b"
RESULT_WORDS = r"\b(as a result|result|so that|which (meant|helped|led)|led to|afterwards|after that|in the end|because of (this|that)|now|improved|increased|reduced|saved|thanked|finished|on time|fewer|more|less|\d+ ?%|\d+)\b"


def sentences(text: str) -> list:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s.strip()]


def first_match(items: list, pattern: str):
    return next((s for s in items if re.search(pattern, s, re.IGNORECASE)), "")


def feedback(answer: str, small_talk: bool = False) -> dict:
    parts = sentences(answer)
    words = len(answer.split())

    if small_talk:
        return {
            "what_worked": "You answered the warm-up question.",
            "to_improve": "One or two friendly sentences is enough here.",
            "highlights": [],
            "next_step": "Keep small talk short and relaxed.",
            "scores": None,
            "strength_tags": [],
            "growth_tags": [],
            "basic": True,
        }

    situation = first_match(parts, SITUATION_WORDS)
    action = first_match(parts, ACTION_WORDS)
    result = first_match([p for p in parts if p not in (situation, action)], RESULT_WORDS)

    highlights = []
    worked = []
    improve = []

    if situation:
        highlights.append({"type": "worked", "label": "setting the scene", "quote": situation,
                           "note": "This tells the listener where and when it happened."})
        worked.append("you set the scene")
    else:
        highlights.append({"type": "improve", "label": "add the situation", "quote": "",
                           "note": "Start with one sentence about where you were and what was happening."})
        improve.append("Start with one sentence about where you were and what was happening.")

    if action:
        highlights.append({"type": "worked", "label": "your action", "quote": action,
                           "note": "This shows what you did yourself."})
        worked.append("you described a specific action you took")
    else:
        highlights.append({"type": "improve", "label": "say what you did", "quote": "",
                           "note": "Use \"I\" and say the exact steps you took, for example \"I made a checklist\"."})
        improve.append("Say what you did yourself, using \"I\" and the exact steps you took.")

    if result:
        highlights.append({"type": "worked", "label": "the result", "quote": result,
                           "note": "This shows what changed because of your action."})
        worked.append("you explained the result")
    else:
        highlights.append({"type": "improve", "label": "add a result", "quote": "",
                           "note": "Describe what changed after your action. A simple observation is enough."})
        improve.append("Explain what changed after your action. A simple observation is enough; you do not need a number.")

    if words < 40:
        improve.append("Add a little more detail. Most answers are 4 to 8 sentences.")
    elif words > 300:
        improve.append("Try to keep it shorter. Most answers are 4 to 8 sentences.")

    if worked:
        items = [w.removeprefix("you ") for w in worked]
        joined = items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]
        what_worked = "You " + joined + "."
    else:
        what_worked = "You gave an answer to practice with. That is a good start."
    to_improve = improve[0] if improve else "Your answer covers the situation, your action and the result. Keep practicing this structure."

    # Simple scores for the progress chart.
    structure = round(100 * len(worked) / 3)
    clarity = 100 if 40 <= words <= 300 else max(20, min(100, round(words * 2.5)) if words < 40 else 70)
    labels = {"you set the scene": "setting the scene",
              "you described a specific action you took": "describing your actions",
              "you explained the result": "explaining results"}
    strength_tags = [labels[w] for w in worked]
    growth_tags = [t for t in labels.values() if t not in strength_tags]
    if words < 40:
        growth_tags.append("adding detail")

    return {
        "what_worked": what_worked,
        "to_improve": to_improve,
        "highlights": highlights,
        "next_step": to_improve,
        "scores": {"clarity": clarity, "structure": structure},
        "strength_tags": strength_tags,
        "growth_tags": growth_tags,
        "basic": True,
    }


# ---------- Companion: ready-made tips ----------

TIPS = {
    "experience": (
        "Think about:\n"
        "- A job, volunteer role, class project or hobby\n"
        "- A time something needed fixing or improving\n"
        "- A time someone thanked you\n"
        "Pick one specific moment, not a general habit."
    ),
    "skills": (
        "Interviewers often look for:\n"
        "- Problem solving\n"
        "- Teamwork and communication\n"
        "- Reliability and following through\n"
        "- Learning new things\n"
        "Choose the one this question is about, and show it with an example."
    ),
    "script": (
        "Writing a script for you needs the AI, which is turned off. You can build one with this template:\n"
        "- \"At ___, ___ was happening.\"\n"
        "- \"I needed to ___.\"\n"
        "- \"So I ___ and ___.\"\n"
        "- \"As a result, ___.\""
    ),
    "practice": (
        "Ways to practice:\n"
        "- Write 3 short stories from your life using STAR\n"
        "- Say each one out loud, then try it without notes\n"
        "- Add one sentence about the result to every story\n"
        "- Practice one question a day instead of many at once"
    ),
    "structure": (
        "Use STAR:\n"
        "- Situation: where were you, and what was happening?\n"
        "- Task: what needed to be done?\n"
        "- Action: what did you do? Use \"I\".\n"
        "- Result: what changed afterwards?\n"
        "One or two sentences for each part is enough."
    ),
}


def companion(message: str) -> str:
    text = message.lower()
    if "script" in text or "improved version" in text:
        return TIPS["script"]
    if "actionable" in text or "practice these" in text:
        return TIPS["practice"]
    if "experience" in text:
        return TIPS["experience"]
    if "skill" in text:
        return TIPS["skills"]
    if "structure" in text or "star" in text:
        return TIPS["structure"]
    return "Free chat needs the AI, which is turned off right now. Try the three buttons above for tips."


# ---------- Experience cards ----------

SKILL_WORDS = {
    "teamwork": r"\b(team|together|group|colleague|coworker|volunteer)",
    "planning": r"\b(plan|organiz|schedul|prepar|coordinat)",
    "problem solving": r"\b(problem|fix|solv|issue|challenge)",
    "communication": r"\b(explain|present|talk|wrote|email|told|shared)",
    "initiative": r"\b(started|created|made|built|decided|took)",
    "helping others": r"\b(help|support|assist|customer|guest)",
    "learning": r"\b(learn|train|taught|course|new skill)",
}


def skills_in(text: str) -> list:
    found = [name for name, pattern in SKILL_WORDS.items() if re.search(pattern, text, re.IGNORECASE)]
    return found[:3] or ["work experience"]


def card_from_text(text: str, title: str) -> dict:
    parts = sentences(text)
    situation = first_match(parts, SITUATION_WORDS) or (parts[0] if parts else "")
    action = first_match(parts, ACTION_WORDS)
    result = first_match([p for p in parts if p not in (situation, action)], RESULT_WORDS)
    return {"title": title, "situation": situation, "task": "", "action": action,
            "result": result, "skills": skills_in(text)}


def short_title(text: str) -> str:
    words = re.sub(r"[^\w\s-]", "", text).split()
    return " ".join(words[:6]).capitalize() if words else "An experience"


def words_of(card: dict) -> set:
    text = " ".join(card.get(k, "") for k in ("title", "situation", "action", "result"))
    return set(re.findall(r"[a-z]{4,}", text.lower()))


def experiences(resume: str, answers: list, existing: list = ()) -> list:
    """New cards, or updated existing ones (with "id"), from answers and resume lines."""
    found = []
    for question, answer in answers:
        if len(answer.split()) >= 8:
            found.append(card_from_text(answer, short_title(answer)))
    # Resume lines that read like accomplishments (bullets or lines with an action word).
    for line in resume.splitlines():
        line = line.strip(" -*\t")
        if len(line.split()) >= 5 and re.search(r"\b(led|organiz|creat|built|managed|helped|coordinat|train|develop|plan)", line, re.IGNORECASE):
            found.append({"title": short_title(line), "situation": "", "task": "", "action": line,
                          "result": "", "skills": skills_in(line)})

    out = []
    for card in found:
        # Same experience as an existing card if they share most of their words.
        match = next((i for i, old in enumerate(existing)
                      if len(words_of(card) & words_of(old)) >= max(3, len(words_of(card)) // 2)), None)
        if match is None:
            out.append(card)
            continue
        old = existing[match]
        updated = {k: old.get(k) or card.get(k, "") for k in ("title", "situation", "task", "action", "result")}
        updated["skills"] = old.get("skills") or card["skills"]
        if any(updated[k] != old.get(k) for k in ("situation", "task", "action", "result")):
            out.append(dict(updated, id=match))
    return out[:8]


def pick_experience(question: str, cards: list, used: list = ()) -> dict:
    """Picks the card that shares the most words and skills with the question,
    preferring cards not already suggested for other questions."""
    q_words = set(re.findall(r"[a-z]{4,}", question.lower()))
    q_skills = set(skills_in(question))

    def score(card):
        text = " ".join([card.get("title", ""), card.get("situation", ""), card.get("action", ""), card.get("result", "")]).lower()
        return len(q_words & set(re.findall(r"[a-z]{4,}", text))) + 2 * len(q_skills & set(card.get("skills", [])))

    # A used card loses 2 points: it still wins if it fits clearly better than the rest.
    best = max(range(len(cards)), key=lambda i: score(cards[i]) - (2 if i in used else 0))
    return {"index": best, "reason": "This one shares the most with the question."}
