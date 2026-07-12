"""
Modified to connect directly to OpenAI for live cloud deployment.
"""

import json
import os
import re

import httpx
from langfuse.decorators import observe

OPENAI_URL = os.environ.get("OPENAI_API_URL", "https://api.openai.com/v1/chat/completions")
OPENAI_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")

_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


@observe(as_type="generation")
def call_hermes(system: str, user: str, *, temperature: float = 0.3) -> str:
    """POST a standard OpenAI-shaped chat completion to Hermes' local server.

    Raises RuntimeError with a readable message on any transport or
    response-shape failure so callers can turn it into a clean HTTP error.
    """
    payload = {
        "model": OPENAI_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
    }
    headers = {
        "Authorization": f"Bearer {OPENAI_KEY}",
        "Content-Type": "application/json",
    }

    try:
        response = httpx.post(OPENAI_URL, json=payload, headers=headers, timeout=60.0)
        response.raise_for_status()
        data = response.json()
        return data["choices"][0]["message"]["content"]
    except httpx.HTTPError as exc:
        raise RuntimeError(f"Could not reach OpenAI API: {exc}") from exc
    except (KeyError, IndexError, ValueError) as exc:
        raise RuntimeError(f"Unexpected response shape from Hermes: {exc}") from exc


def _strip_json_fences(raw: str) -> str:
    """Hermes/OpenAI sometimes wraps JSON in ```json ... ``` fences. Strip them."""
    return _FENCE_RE.sub("", raw.strip()).strip()


EXTRACTION_SYSTEM_PROMPT = """You are Herald, an assistant that extracts structured follow-up
data from meeting notes. Always respond with valid JSON only, matching
this schema exactly:
{
  "summary": "2-4 sentence summary",
  "members": ["name1", "name2"],
  "action_items": [{"text": "...", "owner": "name or null"}],
  "follow_up_email": "a ready-to-send email drafted in a neutral
    professional voice, referencing the specific action items"
}"""


@observe()
def extract_meeting_data(transcript: str) -> dict:
    """Run the core extraction call and return the parsed dict.

    Raises RuntimeError if Hermes is unreachable, and ValueError if the
    response isn't parseable JSON matching the expected shape.
    """
    raw = call_hermes(EXTRACTION_SYSTEM_PROMPT, transcript)
    cleaned = _strip_json_fences(raw)

    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Hermes did not return valid JSON: {exc}") from exc

    if not isinstance(data, dict):
        raise ValueError("Hermes response JSON was not an object")

    data.setdefault("summary", "")
    data.setdefault("members", [])
    data.setdefault("action_items", [])
    data.setdefault("follow_up_email", "")

    return data


def build_chat_system_prompt(summary: str, members: list, action_items: list, follow_up_email: str) -> str:
    members_str = ", ".join(members) if members else "none detected"

    if action_items:
        items_str = "\n".join(
            f"- {item['text']} (owner: {item['owner'] or 'unassigned'}, status: {item['status']})"
            for item in action_items
        )
    else:
        items_str = "none"

    return f"""You are Herald's follow-up assistant for one specific meeting.
Use ONLY the context below to answer. If asked something not covered,
say so plainly.

Meeting summary: {summary}
Members: {members_str}
Action items: {items_str}
Follow-up email draft: {follow_up_email}"""


@observe()
def chat_reply(summary: str, members: list, action_items: list, follow_up_email: str, message: str) -> str:
    system = build_chat_system_prompt(summary, members, action_items, follow_up_email)
    return call_hermes(system, message)
