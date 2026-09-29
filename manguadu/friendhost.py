"""Resolucao dos nomes de arquivos usados pelas versoes do FriendHost."""

from __future__ import annotations

import re
from pathlib import Path


FRIENDHOST_EXTENSIONS = (".txt", ".csv.txt", ".csv")
SERVER_FILE_STEMS = frozenset((
    "deaths", "event_history", "events", "factions", "players_online",
    "safehouses", "world", "world_history",
))


def get_data_file_candidates(directory: str | Path | None, stem: str | None) -> list[Path]:
    if not directory or not stem:
        return []
    return [Path(directory) / f"{stem}{extension}" for extension in FRIENDHOST_EXTENSIONS]


def resolve_data_file(directory: str | Path | None, stem: str | None) -> Path | None:
    candidates = get_data_file_candidates(directory, stem)
    return next((candidate for candidate in candidates if candidate.is_file()), candidates[0] if candidates else None)


def get_player_file_candidates(players_base_path: str | Path | None, nick: str | None, kind: str = "player") -> list[Path]:
    if not players_base_path or not nick:
        return []
    prefix = {"perks": "playerperks", "inventory": "playerinventory"}.get(kind, "player")
    return get_data_file_candidates(Path(players_base_path) / nick, f"{prefix}_{nick}")


def resolve_player_file(players_base_path: str | Path | None, nick: str | None, kind: str = "player") -> Path | None:
    candidates = get_player_file_candidates(players_base_path, nick, kind)
    return next((candidate for candidate in candidates if candidate.is_file()), candidates[0] if candidates else None)


def resolve_server_file(server_base_path: str | Path | None, stem: str) -> Path | None:
    return resolve_data_file(server_base_path, stem)


def get_server_file_candidates(server_base_path: str | Path | None, stem: str | None) -> list[Path]:
    return get_data_file_candidates(server_base_path, stem)


def strip_friendhost_extension(file_name: str) -> str:
    return re.sub(r"(?:\.csv\.txt|\.txt|\.csv)$", "", file_name, flags=re.IGNORECASE)


def is_friendhost_perks_file(file_name: str) -> bool:
    name = Path(file_name).name
    stem = strip_friendhost_extension(name)
    return stem != name and bool(re.fullmatch(r"playerperks_.+", stem, flags=re.IGNORECASE))


def is_friendhost_data_file(file_name: str) -> bool:
    name = Path(file_name).name
    stem = strip_friendhost_extension(name)
    if stem == name:
        return False
    return stem.lower() in SERVER_FILE_STEMS or bool(re.fullmatch(r"player(?:perks|inventory)?_.+", stem, flags=re.IGNORECASE)) or "vehicle" in stem.lower()
