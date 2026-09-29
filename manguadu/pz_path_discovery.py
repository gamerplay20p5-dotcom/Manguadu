"""Descoberta automatica dos arquivos locais e remotos do Project Zomboid."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from .friendhost import is_friendhost_data_file
from .pterodactyl import PterodactylClient
from .server_registry import ServerRegistry
from .utils import clean_text


logger = logging.getLogger(__name__)
ANTICHEAT_PENDING_FILE = "PZAntiCheat_pending_alerts.csv"
FRIENDHOST_DIRECTORY = "FriendHost_Data"
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ENV_PATH = PROJECT_ROOT / ".env"
VOLUME_PATTERN = re.compile(r"/var/lib/pterodactyl/volumes/([^/]+)", re.I)


def _enabled() -> bool:
    return clean_text(os.getenv("PZ_AUTO_DISCOVER_PATHS", "1")).casefold() not in {"0", "false", "nao", "não", "no", "off"}


def _unique_existing_directories(values: list[str | Path]) -> list[Path]:
    result, seen = [], set()
    for value in values:
        raw = clean_text(value)
        if not raw:
            continue
        path = Path(raw).expanduser().resolve()
        key = str(path).casefold() if os.name == "nt" else str(path)
        if key not in seen and path.is_dir():
            seen.add(key)
            result.append(path)
    return result


def parse_scan_roots() -> list[Path]:
    configured = [part.strip() for part in re.split(r"[,;\n]+", os.getenv("PZ_PATH_SCAN_ROOTS", "")) if part.strip()]
    if configured:
        return _unique_existing_directories(configured)
    if os.name == "nt":
        defaults = [Path.home(), Path.cwd(), PROJECT_ROOT]
    else:
        defaults = [Path.home(), Path("/root"), Path("/home"), Path("/home/container"), Path("/mnt/server"), Path("/srv"), Path("/var/lib/pterodactyl/volumes")]
    return _unique_existing_directories(defaults)


def _safe_child_directories(directory: Path, limit: int = 2000) -> list[Path]:
    try:
        return [entry for entry in directory.iterdir() if entry.is_dir() and not entry.is_symlink()][:limit]
    except OSError:
        return []


def is_lua_directory(directory: str | Path) -> bool:
    path = Path(directory)
    if path.name.casefold() != "lua":
        return False
    parent = path.parent.name.casefold()
    return parent in {"zomboid", ".cache"} or (path / FRIENDHOST_DIRECTORY).is_dir() or (path / ANTICHEAT_PENDING_FILE).exists()


def find_lua_ancestor(value: str | Path) -> Path | None:
    current = Path(value).expanduser().resolve()
    for _ in range(6):
        if current.name.casefold() == "lua" and current.is_dir():
            return current
        if current.parent == current:
            break
        current = current.parent
    return None


def find_lua_directories() -> list[Path]:
    candidates: list[Path] = []
    manual: list[Path] = []
    configured = clean_text(os.getenv("PZ_LUA_PATH"))
    if configured and Path(configured).is_dir():
        manual.append(Path(configured))
    elif configured:
        logger.warning("PZ_LUA_PATH configurado, mas nao encontrado: %s", configured)
    for name in ("CSV_BASE_PATH", "ANTICHEAT_CSV_PATH", "PZ_CACHE_ROOT", "ZOMBOID_HOME", "PZ_HOME"):
        hint = clean_text(os.getenv(name))
        if not hint:
            continue
        ancestor = find_lua_ancestor(hint)
        if ancestor:
            candidates.append(ancestor)
        candidates.extend((Path(hint) / "Lua", Path(hint) / "Zomboid" / "Lua"))
    for root in parse_scan_roots():
        candidates.extend((root, root / "Lua", root / "Zomboid" / "Lua", root / ".cache" / "Lua", root / ".cache" / "Zomboid" / "Lua"))
        for child in _safe_child_directories(root):
            candidates.extend((child / "Lua", child / ".cache" / "Lua", child / ".cache" / "Zomboid" / "Lua", child / "Zomboid" / "Lua"))
            if child.name.casefold() == "zomboid":
                candidates.append(child / "Lua")
            if child.name.casefold() == ".cache":
                candidates.append(child / "Lua")
    return _unique_existing_directories(manual + [path for path in candidates if is_lua_directory(path)])


def is_friendhost_base(directory: str | Path) -> bool:
    path = Path(directory)
    if not path.is_dir():
        return False
    return path.name.casefold() == FRIENDHOST_DIRECTORY.casefold() or (path / "Jogadores").is_dir() or (path / "Servidor").is_dir()


def find_friendhost_base(lua_directory: str | Path) -> Path | None:
    lua = Path(lua_directory)
    preferred = lua / FRIENDHOST_DIRECTORY
    if is_friendhost_base(preferred):
        return preferred
    return next((path for path in _safe_child_directories(lua, 200) if is_friendhost_base(path)), None)


def count_friendhost_signals(base: str | Path | None) -> int:
    if not base or not Path(base).is_dir():
        return 0
    path = Path(base)
    signals = 1
    players, server = path / "Jogadores", path / "Servidor"
    signals += int(players.is_dir()) + int(server.is_dir())
    try:
        if server.is_dir() and any(is_friendhost_data_file(item.name) for item in server.iterdir()):
            signals += 2
    except OSError:
        pass
    try:
        for directory in _safe_child_directories(players, 20):
            if any(is_friendhost_data_file(item.name) for item in directory.iterdir()):
                signals += 2
                break
    except OSError:
        pass
    return signals


def get_pz_root_from_lua_directory(lua_directory: str | Path) -> Path:
    path = Path(lua_directory).resolve()
    parent = path.parent
    if parent.name.casefold() == ".cache":
        return parent
    return parent if parent.name.casefold() == "zomboid" else parent.parent


def get_ptero_volume_id_from_path(value: str) -> str:
    match = VOLUME_PATTERN.search(clean_text(value).replace("\\", "/"))
    return clean_text(match.group(1)) if match else ""


def score_ptero_save_directory(directory: str, files: list[dict[str, Any]]) -> dict[str, Any]:
    names = {clean_text(item.get("name")).casefold() for item in files if item.get("isFile")}
    directories = {clean_text(item.get("name")).casefold() for item in files if item.get("isDirectory")}
    score = 5 * ("players.db" in names) + 4 * ("map_meta.bin" in names) + 3 * ("map_ver.bin" in names)
    score += 3 * any(re.fullmatch(r"map_-?\d+_-?\d+\.bin", name) for name in names)
    score += 2 * any(re.fullmatch(r"zpop_-?\d+_-?\d+\.bin", name) for name in names)
    score += 2 * ("chunkdata" in directories)
    return {"directory": directory, "score": score, "fileCount": len(names) + len(directories)}


def choose_ptero_save_candidate(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    ranked = sorted(candidates, key=lambda item: (item["score"], item["fileCount"]), reverse=True)
    if not ranked:
        return {"candidate": None, "ambiguous": False}
    best = [item for item in ranked if item["score"] == ranked[0]["score"] and item["fileCount"] == ranked[0]["fileCount"]]
    return {"candidate": best[0], "ambiguous": False} if len(best) == 1 else {"candidate": None, "ambiguous": True, "matches": best}


def _local_save_candidates(pz_root: Path) -> list[dict[str, Any]]:
    multiplayer = pz_root / "Saves" / "Multiplayer"
    if not multiplayer.is_dir():
        return []
    directories = [multiplayer, *_safe_child_directories(multiplayer, 200)]
    candidates = []
    for directory in directories:
        try:
            entries = list(directory.iterdir())
        except OSError:
            candidates.append({"directory": str(directory), "score": 0, "fileCount": 0})
            continue
        candidates.append(score_ptero_save_directory(
            str(directory),
            [{"name": item.name, "isFile": item.is_file(), "isDirectory": item.is_dir()} for item in entries],
        ))
    scored = [item for item in candidates if item["score"] > 0]
    return scored or [item for item in candidates if item["fileCount"] > 0]


def get_lua_candidate(lua_directory: str | Path) -> dict[str, Any]:
    lua = Path(lua_directory).resolve()
    pz_root = get_pz_root_from_lua_directory(lua)
    detected_base = find_friendhost_base(lua)
    friendhost_base = detected_base or lua / FRIENDHOST_DIRECTORY
    anticheat = lua / ANTICHEAT_PENDING_FILE
    logs = pz_root / "Logs"
    has_anticheat, has_logs = anticheat.exists(), logs.is_dir()
    signals = count_friendhost_signals(detected_base)
    save_selection = choose_ptero_save_candidate(_local_save_candidates(pz_root))
    volume = get_ptero_volume_id_from_path(str(lua))
    server_id = clean_text(os.getenv("PTERO_SERVER_ID") or os.getenv("PTERO_SERVER_UUID"))
    matches = bool(server_id and (volume.casefold().startswith(server_id.casefold()) or server_id.casefold() in str(lua).casefold()))
    score = (10 if matches else 0) + (4 + min(signals, 4) if detected_base else 0)
    score += (3 if has_anticheat else 0) + (3 if save_selection.get("candidate") else 0) + (1 if has_logs else 0)
    return {
        "luaDirectory": str(lua), "pzRoot": str(pz_root), "volumeId": volume,
        "friendHostBase": str(friendhost_base), "anticheatPath": str(anticheat),
        "logsPath": str(logs) if has_logs else "",
        "saveRoot": save_selection["candidate"]["directory"] if save_selection.get("candidate") else "",
        "hasFriendHost": bool(detected_base), "friendHostSignals": signals,
        "hasAnticheat": has_anticheat, "score": score,
    }


def choose_candidate(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    configured = clean_text(os.getenv("PZ_LUA_PATH"))
    if configured:
        exact = next((item for item in candidates if Path(item["luaDirectory"]).resolve() == Path(configured).resolve()), None)
        if exact:
            return {"candidate": exact, "ambiguous": False}
    ranked = sorted((item for item in candidates if item["score"] > 0), key=lambda item: item["score"], reverse=True)
    if not ranked:
        return {"candidate": candidates[0], "ambiguous": False} if len(candidates) == 1 else {"candidate": None, "ambiguous": False}
    best = [item for item in ranked if item["score"] == ranked[0]["score"]]
    return {"candidate": best[0], "ambiguous": False} if len(best) == 1 else {"candidate": None, "ambiguous": True, "matches": best}


def quote_env_value(value: str) -> str:
    return json.dumps(str(value), ensure_ascii=False) if re.search(r"[\s#\"']", str(value)) else str(value)


def persist_env_values(env_path: str | Path, updates: dict[str, str]) -> list[str]:
    path = Path(env_path)
    if not updates:
        return []
    content = path.read_text(encoding="utf-8") if path.exists() else ""
    newline = "\r\n" if "\r\n" in content else "\n"
    changed = []
    for key, value in updates.items():
        expression = re.compile(rf"^(\s*{re.escape(key)}\s*=)(.*)$", re.M)
        match = expression.search(content)
        if match:
            existing = re.sub(r"^['\"]|['\"]$", "", clean_text(match.group(2)))
            if existing:
                continue
            content = expression.sub(lambda found: found.group(1) + quote_env_value(value), content, count=1)
        else:
            separator = "" if not content or content.endswith(("\n", "\r")) else newline
            content += f"{separator}{key}={quote_env_value(value)}{newline}"
        changed.append(key)
    if not changed:
        return []
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=path.name + ".tmp-", dir=path.parent)
    try:
        try:
            os.fchmod(handle, 0o600)
        except (AttributeError, OSError):
            os.chmod(temporary, 0o600)
        with os.fdopen(handle, "w", encoding="utf-8", newline="") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
    return changed


def discover_and_persist_pz_paths(*, env_path: str | Path = DEFAULT_ENV_PATH) -> dict[str, Any]:
    if not _enabled():
        return {"enabled": False, "updates": {}, "candidates": []}
    candidates = [get_lua_candidate(path) for path in find_lua_directories()]
    selection = choose_candidate(candidates)
    if selection["ambiguous"]:
        logger.warning("Mais de uma pasta PZ Lua foi encontrada: %s. Configure PZ_LUA_PATH.", " | ".join(item["luaDirectory"] for item in selection["matches"]))
        return {"enabled": True, "ambiguous": True, "updates": {}, "candidates": candidates}
    selected = selection.get("candidate")
    if not selected:
        logger.warning("Nenhuma pasta Zomboid/Lua reconhecida. Caminhos manuais continuam validos.")
        return {"enabled": True, "updates": {}, "candidates": candidates}
    discovered = {
        "PZ_LUA_PATH": selected["luaDirectory"], "PZ_CACHE_ROOT": selected["pzRoot"],
        "PTERO_VOLUME_ID": selected["volumeId"], "CSV_BASE_PATH": selected["friendHostBase"],
        "ANTICHEAT_CSV_PATH": selected["anticheatPath"], "LOGS_PATH": selected["logsPath"],
        "PZ_SAVE_ROOT": selected["saveRoot"],
    }
    updates = {}
    for key, value in discovered.items():
        if value and not clean_text(os.getenv(key)):
            os.environ[key] = value
            updates[key] = value
    try:
        persisted = persist_env_values(env_path, updates)
    except OSError as exc:
        logger.warning("Caminhos PZ encontrados, mas nao foi possivel atualizar %s: %s", env_path, exc)
        persisted = []
    if updates:
        logger.info("Descoberta PZ: %s", " | ".join(f"{key}={value}" for key, value in updates.items()))
    else:
        logger.info("Descoberta PZ confirmou a pasta Lua: %s", selected["luaDirectory"])
    return {"enabled": True, "updates": updates, "persisted": persisted, "selected": selected, "candidates": candidates}


async def find_ptero_save_candidates(server: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    server = server or ServerRegistry().get_default_server()
    roots = (
        "/Zomboid/Saves/Multiplayer", "/.cache/Zomboid/Saves/Multiplayer",
        "/.cache/Saves/Multiplayer", "/home/container/Zomboid/Saves/Multiplayer",
        "/home/container/.cache/Zomboid/Saves/Multiplayer", "/home/container/.cache/Saves/Multiplayer",
    )
    async with PterodactylClient(server) as client:
        root_results = await asyncio.gather(*(client.list_files(root) for root in roots))
        candidates, requests = [], []
        for root, result in zip(roots, root_results, strict=True):
            if not result["ok"]:
                continue
            score = score_ptero_save_directory(root, result.get("files", []))
            if score["score"] > 0:
                candidates.append(score)
            requests.extend([root.rstrip("/") + "/" + entry["name"] for entry in result.get("files", []) if entry.get("isDirectory")][:100])
        semaphore = asyncio.Semaphore(12)

        async def list_candidate(directory: str) -> dict[str, Any] | None:
            async with semaphore:
                result = await client.list_files(directory)
            return score_ptero_save_directory(directory, result.get("files", [])) if result["ok"] else None

        for result in await asyncio.gather(*(list_candidate(directory) for directory in dict.fromkeys(requests))):
            if result:
                candidates.append(result)
    scored = [item for item in candidates if item["score"] > 0]
    return scored if scored else (candidates if len(candidates) == 1 else [])


async def find_ptero_anticheat_path(server: dict[str, Any] | None = None) -> str:
    server = server or ServerRegistry().get_default_server()
    candidates = (
        "/Zomboid/Lua/PZAntiCheat_pending_alerts.csv", "/.cache/Zomboid/Lua/PZAntiCheat_pending_alerts.csv",
        "/.cache/Lua/PZAntiCheat_pending_alerts.csv", "/home/container/Zomboid/Lua/PZAntiCheat_pending_alerts.csv",
    )
    async with PterodactylClient(server) as client:
        for path in candidates:
            result = await client.read_file(path)
            if result["ok"]:
                return path
    return ""


async def discover_and_persist_ptero_paths(*, env_path: str | Path = DEFAULT_ENV_PATH) -> dict[str, Any]:
    if not _enabled():
        return {"enabled": False, "updates": {}}
    server = ServerRegistry().get_default_server()
    ptero = server.get("ptero", {})
    if not all(clean_text(ptero.get(key)) for key in ("url", "serverId", "apiKey")):
        return {"enabled": True, "configured": False, "updates": {}}
    updates: dict[str, str] = {}
    if not clean_text(os.getenv("PZ_SAVE_ROOT")):
        candidates = await find_ptero_save_candidates(server)
        selection = choose_ptero_save_candidate(candidates)
        if selection["ambiguous"]:
            logger.warning("Mais de um save PZ foi encontrado no Pterodactyl: %s. Configure PZ_SAVE_ROOT.", " | ".join(item["directory"] for item in selection["matches"]))
        elif selection.get("candidate"):
            value = selection["candidate"]["directory"]
            os.environ["PZ_SAVE_ROOT"] = value
            updates["PZ_SAVE_ROOT"] = value
    if not clean_text(os.getenv("ANTICHEAT_PTERO_CSV_PATH")):
        path = await find_ptero_anticheat_path(server)
        if path:
            os.environ["ANTICHEAT_PTERO_CSV_PATH"] = path
            updates["ANTICHEAT_PTERO_CSV_PATH"] = path
    try:
        persisted = persist_env_values(env_path, updates)
    except OSError as exc:
        logger.warning("Caminhos Pterodactyl encontrados, mas nao foi possivel atualizar %s: %s", env_path, exc)
        persisted = []
    if updates:
        logger.info("Descoberta Pterodactyl: %s", " | ".join(f"{key}={value}" for key, value in updates.items()))
    return {"enabled": True, "configured": True, "updates": updates, "persisted": persisted}
