from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path

from manguadu.anticheat_alerts import _read_state, group_alerts, is_alert_recent, parse_alert_timestamp, parse_alerts


def test_anticheat_csv_handles_quoted_commas_and_alias_headers() -> None:
    alerts = parse_alerts('timestamp,username,steam_id,type,count,detail,position\n2026-09-28 10:00:00,Menta,7656119,speedhack,2,"x was 4, y was 8",4,8,0\n')
    assert len(alerts) == 1
    assert alerts[0]["steamId"] == "7656119"
    assert alerts[0]["cheat"] == "speedhack"
    assert alerts[0]["detail"] == "x was 4, y was 8"


def test_anticheat_deduplicates_by_player_and_cheat_and_parses_epoch(monkeypatch) -> None:
    monkeypatch.setenv("ANTICHEAT_TIMEZONE", "UTC")
    first = {"timestamp": "1780228800", "username": "Menta", "steamId": "765", "cheat": "speed", "count": "1"}
    second = {**first, "timestamp": "1780228860", "count": "2"}
    groups = group_alerts([first, second])
    assert groups[0]["count"] == 2
    assert groups[0]["alert"] == second
    assert parse_alert_timestamp("1780228800") is not None
    assert is_alert_recent(first, datetime.fromtimestamp(1780228800, timezone.utc))


def test_anticheat_state_migrates_javascript_millisecond_cooldowns(tmp_path: Path) -> None:
    state_file = tmp_path / "state.json"
    state_file.write_text(json.dumps({"sentKeys": ["key"], "recentGroups": {"player|cheat": 1780228800000}}), encoding="utf-8")
    state = _read_state(state_file)
    assert state["initialized"]
    assert state["sentKeys"] == ["key"]
    assert state["recentGroups"]["player|cheat"] == 1780228800
