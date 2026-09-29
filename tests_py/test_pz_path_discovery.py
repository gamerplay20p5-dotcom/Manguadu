from __future__ import annotations

from pathlib import Path

from manguadu.pz_path_discovery import (
    choose_candidate,
    choose_ptero_save_candidate,
    find_lua_directories,
    get_lua_candidate,
    persist_env_values,
    score_ptero_save_directory,
)


def test_local_discovery_finds_empty_friendhost_installation(tmp_path: Path, monkeypatch) -> None:
    root = tmp_path / "server"
    lua = root / "Zomboid" / "Lua"
    (lua / "FriendHost_Data" / "Jogadores").mkdir(parents=True)
    (lua / "FriendHost_Data" / "Servidor").mkdir()
    (lua / "FriendHost_Data" / "Servidor" / "world.txt").write_text("world\n", encoding="utf-8")
    (lua / "PZAntiCheat_pending_alerts.csv").write_text("", encoding="utf-8")
    (root / "Zomboid" / "Logs").mkdir()
    save = root / "Zomboid" / "Saves" / "Multiplayer"
    save.mkdir(parents=True)
    (save / "players.db").write_bytes(b"")
    monkeypatch.setenv("PZ_PATH_SCAN_ROOTS", str(root))
    monkeypatch.delenv("PZ_LUA_PATH", raising=False)
    monkeypatch.delenv("PTERO_SERVER_ID", raising=False)
    monkeypatch.delenv("PTERO_SERVER_UUID", raising=False)

    discovered = find_lua_directories()
    candidate = get_lua_candidate(discovered[0])

    assert discovered == [lua]
    assert candidate["friendHostBase"] == str(lua / "FriendHost_Data")
    assert candidate["hasFriendHost"]
    assert candidate["hasAnticheat"]
    assert candidate["logsPath"] == str(root / "Zomboid" / "Logs")
    assert candidate["saveRoot"] == str(save)


def test_discovery_requires_explicit_selection_when_scores_tie() -> None:
    candidates = [
        {"luaDirectory": "/server/a/Lua", "score": 5},
        {"luaDirectory": "/server/b/Lua", "score": 5},
    ]
    selection = choose_candidate(candidates)
    assert selection["ambiguous"]
    assert selection["candidate"] is None


def test_env_persistence_only_fills_empty_values(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("CSV_BASE_PATH=\nKEEP=already set\n", encoding="utf-8")

    changed = persist_env_values(env_file, {
        "CSV_BASE_PATH": "/root/PZ Data/FriendHost_Data",
        "KEEP": "must not replace",
        "LOGS_PATH": "/root/Zomboid/Logs",
    })
    content = env_file.read_text(encoding="utf-8")

    assert changed == ["CSV_BASE_PATH", "LOGS_PATH"]
    assert 'CSV_BASE_PATH="/root/PZ Data/FriendHost_Data"' in content
    assert "KEEP=already set" in content
    assert "LOGS_PATH=/root/Zomboid/Logs" in content


def test_ptero_save_selection_rejects_equal_candidates() -> None:
    candidates = [
        score_ptero_save_directory("/save/a", [{"name": "players.db", "isFile": True}]),
        score_ptero_save_directory("/save/b", [{"name": "players.db", "isFile": True}]),
    ]
    selection = choose_ptero_save_candidate(candidates)
    assert selection["ambiguous"]
    assert selection["candidate"] is None
