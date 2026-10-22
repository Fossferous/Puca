"""The plugin's settings and the checks on what the page and the frontend send.

Pure (no Decky, no I/O beyond the settings file), so tests/test_backend.py
can run it on any machine. Mirrors src/settings.ts; the frontend checks too,
this side does not trust it.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any, Optional, Tuple
from urllib.parse import urlsplit

DEFAULTS = {
    "appUrl": "",
    "pushToTalk": "off",
    "notifications": True,
    "notificationSound": True,
}

PUSH_TO_TALK = ("off", "L4", "R4", "L5", "R5")

# What the frontend may ask the page to do: window.pucaEmbed's commands
# (docs/EMBEDDING.md). Anything else is refused before it reaches the page.
PAGE_METHODS = frozenset({
    "getState", "listVoiceChannels", "joinVoice", "leaveVoice", "setMuted",
    "setDeafened", "setInputMode", "holdPushToTalk", "activateNotification",
})

REQUEST_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MARKER = re.compile(r"^puca-decky-[0-9a-f]{24}$")
MAX_SDP = 64 * 1024
MAX_PAGE_MESSAGE = 256 * 1024


def normalize_app_url(text: Any) -> Optional[Tuple[str, str]]:
    """The web client's address as (url, origin), or None.

    https only: the web client's encryption runs only in a secure context.
    The exception is http on the loopback (localhost, 127.0.0.1), which
    browsers treat as secure too. "chat.example.com" is enough; a path is
    kept, a query, a fragment and a user:password are not.
    """
    if not isinstance(text, str):
        return None
    text = text.strip()
    if not text:
        return None
    if not re.match(r"^[a-z][a-z0-9+.-]*://", text, re.I):
        text = "https://" + text
    try:
        parts = urlsplit(text)
        port = parts.port  # raises on a malformed port
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower()
    loopback = host in ("localhost", "127.0.0.1")
    if parts.username or parts.password or not (scheme == "https" or (scheme == "http" and loopback)):
        return None
    if not host or ("." not in host and host != "localhost"):
        return None
    if not re.match(r"^[a-z0-9.-]+$", host):
        # The frontend's URL() hands IDNs over punycoded; anything else odd is refused.
        return None
    default_port = 443 if scheme == "https" else 80
    origin = f"{scheme}://{host}" + (f":{port}" if port and port != default_port else "")
    path = parts.path or "/"
    if not path.endswith("/"):
        path += "/"
    return origin + path, origin


def read_settings(raw: Any) -> dict:
    """Settings as stored, with anything missing or malformed at its default."""
    o = raw if isinstance(raw, dict) else {}
    url = normalize_app_url(o.get("appUrl"))
    return {
        "appUrl": url[0] if url else "",
        "pushToTalk": o.get("pushToTalk") if o.get("pushToTalk") in PUSH_TO_TALK else "off",
        "notifications": o["notifications"] if isinstance(o.get("notifications"), bool) else DEFAULTS["notifications"],
        "notificationSound": o["notificationSound"] if isinstance(o.get("notificationSound"), bool) else DEFAULTS["notificationSound"],
    }


def load_settings(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return read_settings(json.load(f))
    except (OSError, ValueError):
        return dict(DEFAULTS)


def save_settings(path: str, settings: dict) -> dict:
    clean = read_settings(settings)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(clean, f, indent=2)
    os.replace(tmp, path)
    return clean


def check_mic_answer(request_id: Any, answer: Any, error: Any) -> Optional[Tuple[str, Optional[dict], Optional[dict]]]:
    """A microphone answer from the frontend, cleaned, or None to drop it."""
    if not isinstance(request_id, str) or not REQUEST_ID.match(request_id):
        return None
    clean_answer = None
    if answer is not None:
        if not (isinstance(answer, dict) and answer.get("type") == "answer"
                and isinstance(answer.get("sdp"), str) and 0 < len(answer["sdp"]) <= MAX_SDP):
            return None
        clean_answer = {"type": "answer", "sdp": answer["sdp"]}
    clean_error = None
    if error is not None:
        if not isinstance(error, dict):
            return None
        name = error.get("name")
        message = error.get("message")
        clean_error = {
            "name": name[:60] if isinstance(name, str) and re.match(r"^[A-Za-z]+$", name) else "NotReadableError",
            "message": message[:200] if isinstance(message, str) else "",
        }
    if clean_answer is None and clean_error is None:
        clean_error = {"name": "NotReadableError", "message": "no microphone"}
    return request_id, clean_answer, clean_error


def read_page_message(payload: Any) -> Optional[dict]:
    """A binding payload from the page: a JSON object of bounded size, or None."""
    if not isinstance(payload, str) or len(payload) > MAX_PAGE_MESSAGE:
        return None
    try:
        msg = json.loads(payload)
    except ValueError:
        return None
    if not isinstance(msg, dict) or not isinstance(msg.get("type"), str):
        return None
    return msg


def origin_of(url: Any) -> Optional[str]:
    if not isinstance(url, str):
        return None
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    if not parts.scheme or not parts.hostname:
        return None
    default = {"https": 443, "http": 80}.get(parts.scheme.lower())
    return f"{parts.scheme.lower()}://{parts.hostname.lower()}" + (f":{port}" if port and port != default else "")
