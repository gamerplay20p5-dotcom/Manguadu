"""Consulta local dos dados FriendHost sem dependencia do Discord."""

from __future__ import annotations

import re
import json
import math
import os
import time
from pathlib import Path

from .friendhost import (
    get_player_file_candidates,
    get_server_file_candidates,
    is_friendhost_data_file,
    resolve_player_file,
    resolve_server_file,
)
from .utils import clean_text, get_field, read_csv_raw_rows, read_csv_rows, read_latest_csv_row, read_text_file, to_number


PERK_LABELS = {
    "cooking": "Culinária", "fitness": "Preparo físico", "strength": "Força",
    "blunt": "Contundente longa", "axe": "Machado", "lightfoot": "Pés leves",
    "nimble": "Agilidade", "sprinting": "Corrida", "sneak": "Furtividade",
    "woodwork": "Carpintaria", "aiming": "Mira", "reloading": "Recarga",
    "farming": "Agricultura", "fishing": "Pesca", "trapping": "Armadilhas",
    "plantscavenging": "Busca de alimentos", "doctor": "Primeiros socorros",
    "electricity": "Elétrica", "blacksmith": "Ferraria", "metalwelding": "Metalurgia",
    "mechanics": "Mecânica", "spear": "Lança", "maintenance": "Manutenção",
    "smallblade": "Lâmina curta", "longblade": "Lâmina longa",
    "smallblunt": "Contundente curta", "tailoring": "Costura",
}
PERK_EMOJIS = {
    "cooking": "🍳", "fitness": "💪", "strength": "🏋️", "blunt": "🔨", "axe": "🪓",
    "lightfoot": "🦶", "nimble": "🤸", "sprinting": "🏃", "sneak": "🥷", "woodwork": "🪚",
    "aiming": "🎯", "reloading": "🔁", "farming": "🌾", "fishing": "🎣", "trapping": "🪤",
    "plantscavenging": "🍄", "doctor": "🩹", "electricity": "🔌", "blacksmith": "⚒️",
    "metalwelding": "🧰", "mechanics": "🔧", "spear": "🗡️", "maintenance": "🛠️",
    "smallblade": "🔪", "longblade": "⚔️", "smallblunt": "🔩", "tailoring": "🧵",
}


class PzData:
    def __init__(self, csv_base_path: str | Path | None):
        self.base_path = Path(csv_base_path) if csv_base_path else None

    @property
    def players_path(self) -> Path | None:
        return self.base_path / "Jogadores" if self.base_path else None

    @property
    def server_path(self) -> Path | None:
        return self.base_path / "Servidor" if self.base_path else None

    def player_names(self) -> list[str]:
        if not self.players_path or not self.players_path.is_dir():
            return []
        return sorted((path.name for path in self.players_path.iterdir() if path.is_dir()), key=str.casefold)

    def player_rows(self) -> list[dict]:
        rows = []
        for nick in self.player_names():
            row = read_latest_csv_row(resolve_player_file(self.players_path, nick))
            if row:
                rows.append({"nick": nick, "row": row})
        return rows

    def find_player(self, nick_input: str) -> dict | None:
        target = clean_text(nick_input).casefold()
        if not target:
            return None
        rows = self.player_rows()
        exact = next((entry for entry in rows if target in {
            entry["nick"].casefold(), get_field(entry["row"], ["username"]).casefold(),
            get_field(entry["row"], ["charname"]).casefold(),
        }), None)
        if exact:
            return exact
        matches = [entry for entry in rows if any(target in value.casefold() for value in (
            entry["nick"], get_field(entry["row"], ["username"]), get_field(entry["row"], ["charname"]),
        ) if value)]
        return matches[0] if len(matches) == 1 else None

    def player_traits(self, nick_input: str) -> dict | None:
        entry = self.find_player(nick_input)
        if not entry:
            return None
        row = entry["row"]

        def parse(keys: list[str]) -> list[str]:
            value = get_field(row, keys)
            value = re.sub(r"^\[|\]$|^\(|\)$", "", value)
            return [clean_text(item).strip("'\"") for item in re.split(r"[,;|]+", value) if clean_text(item).strip("'\"")]

        return {
            **entry,
            "profession": get_field(row, ["profession", "professionname"], "Não informada"),
            "traits": parse(["traits", "traitlist", "playertraits", "charactertraits"]),
            "positive": parse(["positivetraits", "goodtraits"]),
            "negative": parse(["negativetraits", "badtraits"]),
        }

    def player_skills(self, nick_input: str) -> dict | None:
        entry = self.find_player(nick_input)
        if not entry or not self.players_path:
            return None
        perks_file = resolve_player_file(self.players_path, entry["nick"], "perks")
        perks = read_latest_csv_row(perks_file) or {}
        ignored = {"systemdate", "systemtime", "gametime", "steamid", "username", "charname"}
        skills = [
            {"key": key, "label": PERK_LABELS.get(key, key), "emoji": PERK_EMOJIS.get(key, "✨"), "value": to_number(value)}
            for key, value in perks.items() if key not in ignored
        ]
        skills.sort(key=lambda skill: (-skill["value"], skill["label"].casefold()))
        return {**entry, "skills": skills}

    def player_rank(self, nick_input: str, metric: str = "zombiekills") -> dict | None:
        column = "hourssurvived" if metric == "hours" else "zombiekills"
        rows = self.player_rows()
        rows.sort(key=lambda entry: (-to_number(get_field(entry["row"], [column])), entry["nick"].casefold()))
        target = clean_text(nick_input).casefold()
        for index, entry in enumerate(rows):
            if target in {entry["nick"].casefold(), get_field(entry["row"], ["username"]).casefold(), get_field(entry["row"], ["charname"]).casefold()}:
                return {"metric": column, "position": index + 1, "total": len(rows), "entry": entry, "leaderboard": rows[:10]}
        return None

    def online_players(self) -> list[str]:
        content = read_text_file(resolve_server_file(self.server_path, "players_online"))
        return [name for piece in content.split(";") if (name := clean_text(piece))]

    def world_snapshot(self) -> dict[str, str]:
        path = resolve_server_file(self.server_path, "world")
        lines = [line.strip() for line in read_text_file(path).splitlines() if line.strip()]
        fallback_time = ""
        fallback_source = ""
        player_files = [candidate for nick in self.player_names() if (candidate := resolve_player_file(self.players_path, nick)) and candidate.is_file()]
        if player_files:
            newest = max(player_files, key=lambda candidate: candidate.stat().st_mtime)
            player_row = read_latest_csv_row(newest)
            fallback_time = get_field(player_row, ["gametime"])
            fallback_source = newest.name
        values = [value.strip().strip('"') for value in lines[-1].split(";")] if lines else []
        game_time = next((value for value in values if re.fullmatch(r"\d{1,2}\.\d{1,2}\.\d{4}\s+\d{1,2}:\d{2}", value)), "")
        temperature = next((f"{number:.1f}" for value in values if re.fullmatch(r"-?\d+[.,]\d+", value) and -60 <= (number := to_number(value)) <= 60 and not 0 <= number <= 1), "")
        if not game_time:
            game_time = fallback_time if re.fullmatch(r"\d{1,2}\.\d{1,2}\.\d{4}\s+\d{1,2}:\d{2}", fallback_time) else ""
        date, time = game_time.split() if game_time else ("", "")
        return {"source": path.name if lines and path else fallback_source or "indisponivel", "gameTime": game_time, "gameDate": date, "timeOfDay": time, "temperature": temperature}

    def safehouses(self) -> list[dict[str, str]]:
        return read_csv_rows(resolve_server_file(self.server_path, "safehouses"))

    def faction_rows(self) -> list[dict[str, str]]:
        return read_csv_rows(resolve_server_file(self.server_path, "factions"))

    def death_rows(self) -> list[list[str]]:
        return read_csv_raw_rows(resolve_server_file(self.server_path, "deaths"))

    def extract_player_logs(self, nick: str, log_type: str = "todos", hours: int = 24) -> dict:
        target = clean_text(nick).casefold()
        kind = clean_text(log_type).casefold()
        period = max(1, min(168, int(hours or 24)))
        root = Path(os.getenv("LOGS_PATH", ""))
        if not target or not os.getenv("LOGS_PATH") or not root.is_dir():
            return {"files": [], "lines": [], "hours": period, "type": kind}
        cutoff = time.time() - period * 3600
        candidates = []
        pending = [(root, 0)]
        while pending and len(candidates) < 100:
            folder, depth = pending.pop()
            try:
                entries = list(folder.iterdir())
            except OSError:
                continue
            for path in entries:
                if path.is_symlink():
                    continue
                if path.is_dir() and depth < 2:
                    pending.append((path, depth + 1))
                    continue
                if not path.is_file() or path.suffix.casefold() not in {".txt", ".log"}:
                    continue
                if kind and kind != "todos" and kind not in path.name.casefold():
                    continue
                try:
                    if path.stat().st_mtime >= cutoff:
                        candidates.append(path)
                except OSError:
                    continue
                if len(candidates) >= 100:
                    break
        lines = []
        for path in candidates:
            content = read_text_file(path)
            for line in content.splitlines():
                if target not in line.casefold():
                    continue
                match = re.search(r"(\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})", line)
                if match:
                    from datetime import datetime
                    try:
                        timestamp = datetime(*(2000 + int(match.group(1)), int(match.group(2)), int(match.group(3)), int(match.group(4)), int(match.group(5)), int(match.group(6)))).timestamp()
                        if timestamp < cutoff:
                            continue
                    except ValueError:
                        pass
                shortened = line if len(line) <= 500 else line[:497] + "..."
                lines.append(f"{path.name} | {shortened}")
                if len(lines) >= 1000:
                    break
            if len(lines) >= 1000:
                break
        return {"files": candidates, "lines": lines, "hours": period, "type": kind}

    def delete_targets(self, scope: str, nick: str = "") -> list[Path] | None:
        if not self.base_path or not self.base_path.is_dir():
            return []
        scope = clean_text(scope).casefold()
        candidates: list[Path] = []
        if scope == "ranking":
            if self.players_path:
                for player in self.player_names():
                    candidates.extend(get_player_file_candidates(self.players_path, player, "player"))
                    candidates.extend(get_player_file_candidates(self.players_path, player, "perks"))
            if self.server_path:
                for stem in ("deaths", "factions", "safehouses", "players_online"):
                    candidates.extend(get_server_file_candidates(self.server_path, stem))
        elif scope == "inventarios":
            if self.players_path:
                for player in self.player_names():
                    candidates.extend(get_player_file_candidates(self.players_path, player, "inventory"))
        elif scope == "jogador":
            player = self.find_player(nick)
            if not player or not self.players_path:
                return None
            for kind in ("player", "perks", "inventory"):
                candidates.extend(get_player_file_candidates(self.players_path, player["nick"], kind))
        elif scope == "tudo":
            pending = [(self.base_path, 0)]
            while pending and len(candidates) < 2000:
                folder, depth = pending.pop()
                try:
                    entries = list(folder.iterdir())
                except OSError:
                    continue
                for path in entries:
                    if path.is_symlink():
                        continue
                    if path.is_dir() and depth < 8:
                        pending.append((path, depth + 1))
                    elif path.is_file() and is_friendhost_data_file(path.name):
                        candidates.append(path)
                    if len(candidates) >= 2000:
                        break
        else:
            return []
        root = self.base_path.resolve()
        unique: dict[str, Path] = {}
        for path in candidates:
            try:
                resolved = path.resolve(strict=True)
                resolved.relative_to(root)
                if resolved.is_file():
                    unique[str(resolved)] = resolved
            except (OSError, ValueError):
                continue
        return list(unique.values())

    def find_vehicle(self, vehicle_id: str) -> dict | None:
        target = clean_text(vehicle_id).casefold()
        if not target or not self.server_path or not self.server_path.is_dir():
            return None
        pending = [(self.server_path, 0)]
        while pending:
            directory, depth = pending.pop()
            try:
                entries = list(directory.iterdir())
            except OSError:
                continue
            for path in entries:
                if path.is_symlink():
                    continue
                if path.is_dir() and depth < 3:
                    pending.append((path, depth + 1))
                    continue
                lowered = path.name.casefold()
                if not path.is_file() or "vehicle" not in lowered or not lowered.endswith((".txt", ".csv", ".csv.txt")):
                    continue
                for row in read_csv_rows(path):
                    identifiers = (get_field(row, keys) for keys in (
                        ["vehicleid"], ["id"], ["sqlid"], ["vehicle_id"],
                    ))
                    if target in {value.casefold() for value in identifiers if value}:
                        return {"file": path, "row": row}
        return None

    @staticmethod
    def configured_maps(config_path: str | Path | None = None) -> list[dict]:
        path = Path(config_path) if config_path else Path(__file__).resolve().parent.parent / "config" / "pz-maps.json"
        try:
            parsed = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return []
        raw_maps = parsed if isinstance(parsed, list) else parsed.get("maps") if isinstance(parsed, dict) else None
        if not isinstance(raw_maps, list):
            return []
        maps = []
        for index, raw in enumerate(raw_maps, 1):
            if not isinstance(raw, dict) or raw.get("enabled") is False:
                continue
            x1 = to_number(raw.get("minX", raw.get("x1")))
            y1 = to_number(raw.get("minY", raw.get("y1")))
            x2 = to_number(raw.get("maxX", raw.get("x2")))
            y2 = to_number(raw.get("maxY", raw.get("y2")))
            if x1 == x2 or y1 == y2:
                continue
            name = clean_text(raw.get("name") or raw.get("id") or f"Mapa {index}")
            maps.append({
                "id": clean_text(raw.get("id") or name.casefold().replace(" ", "-")),
                "name": name,
                "minX": min(x1, x2), "minY": min(y1, y2),
                "maxX": max(x1, x2), "maxY": max(y1, y2),
            })
        return maps

    def player_points(self) -> list[dict[str, Any]]:
        points = []
        for entry in self.player_rows():
            row = entry["row"]
            x_raw = get_field(row, ["x", "posx", "positionx"])
            y_raw = get_field(row, ["y", "posy", "positiony"])
            if not x_raw or not y_raw:
                continue
            x = to_number(x_raw, float("nan"))
            y = to_number(y_raw, float("nan"))
            if not (math.isfinite(x) and math.isfinite(y)):
                continue
            points.append({
                "nick": entry["nick"], "x": x, "y": y,
                "z": to_number(get_field(row, ["z", "posz", "positionz"])),
            })
        return points

    def player_point(self, nick: str) -> dict[str, Any] | None:
        entry = self.find_player(nick)
        if not entry:
            return None
        row = entry["row"]
        x_raw = get_field(row, ["x", "posx", "positionx"])
        y_raw = get_field(row, ["y", "posy", "positiony"])
        if not x_raw or not y_raw:
            return None
        x = to_number(x_raw, float("nan"))
        y = to_number(y_raw, float("nan"))
        if not (math.isfinite(x) and math.isfinite(y)):
            return None
        return {"nick": entry["nick"], "x": x, "y": y, "z": to_number(get_field(row, ["z", "posz", "positionz"]))}

    @staticmethod
    def world_bounds(points: list[dict[str, Any]]) -> dict[str, float]:
        maps = PzData.configured_maps()
        xs = [coordinate for item in maps for coordinate in (item["minX"], item["maxX"])]
        ys = [coordinate for item in maps for coordinate in (item["minY"], item["maxY"])]
        for point in points:
            x, y = point.get("x"), point.get("y")
            if isinstance(x, (int, float)) and math.isfinite(x):
                xs.append(float(x))
            if isinstance(y, (int, float)) and math.isfinite(y):
                ys.append(float(y))
        if not xs or not ys:
            return {"minX": 0, "minY": 0, "maxX": 30000, "maxY": 30000}
        return {"minX": min(xs), "minY": min(ys), "maxX": max(xs), "maxY": max(ys)}

    @staticmethod
    def map_for_point(point: dict[str, Any], maps: list[dict[str, Any]] | None = None) -> dict[str, Any] | None:
        maps = maps if maps is not None else PzData.configured_maps()
        return next((item for item in maps if item["minX"] <= point["x"] <= item["maxX"] and item["minY"] <= point["y"] <= item["maxY"]), None)
