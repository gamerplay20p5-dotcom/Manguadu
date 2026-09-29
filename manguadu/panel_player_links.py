"""Vinculos entre nomes do Project Zomboid e contas do Discord."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .utils import clean_text


LINKS_FILE = Path(__file__).resolve().parent.parent / "data" / "panel-player-links.json"


def load_player_links(path: str | Path = LINKS_FILE) -> dict[str, str]:
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {clean_text(key): clean_text(value) for key, value in raw.items() if clean_text(key) and clean_text(value)}


def _save(links: dict[str, str], path: str | Path = LINKS_FILE) -> None:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f"{destination.name}.tmp-{os.getpid()}")
    temporary.write_text(json.dumps(links, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(destination)


def set_player_link(nick: str, discord_user_id: int | str, path: str | Path = LINKS_FILE) -> bool:
    nick, user_id = clean_text(nick), clean_text(discord_user_id)
    if not nick or not user_id:
        return False
    links = load_player_links(path)
    existing = next((key for key in links if key.casefold() == nick.casefold()), None)
    if existing and existing != nick:
        links.pop(existing)
    links[nick] = user_id
    _save(links, path)
    return True


def remove_player_link(nick: str, path: str | Path = LINKS_FILE) -> bool:
    target = clean_text(nick).casefold()
    links = load_player_links(path)
    existing = next((key for key in links if key.casefold() == target), None)
    if existing is None:
        return False
    links.pop(existing)
    _save(links, path)
    return True


def get_player_link(nick: str, path: str | Path = LINKS_FILE) -> str:
    target = clean_text(nick).casefold()
    links = load_player_links(path)
    return next((value for key, value in links.items() if key.casefold() == target), "")
