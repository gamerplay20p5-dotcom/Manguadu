from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from manguadu.automation_scheduler import AutomationScheduler, format_days, normalize_time, parse_days


def test_schedule_input_normalization() -> None:
    assert normalize_time("9h05") == "09:05"
    assert normalize_time("2400") == ""
    assert parse_days("dias úteis") == [1, 2, 3, 4, 5]
    assert parse_days("dom, qua, sab") == [0, 3, 6]
    assert parse_days("") == list(range(7))
    assert format_days([0, 6]) == "fim de semana (1,7)"


def test_automation_store_round_trip_and_validation(tmp_path: Path) -> None:
    scheduler = AutomationScheduler(tmp_path / "automations.json")
    assert not scheduler.create("other", "10:00")["ok"]
    assert not scheduler.create("command", "10:00")["ok"]
    result = scheduler.create("backup", "03:30", "uteis", retain_backups=3)
    assert result["ok"]
    assert scheduler.get_automations()[0]["days"] == [1, 2, 3, 4, 5]
    automation_id = result["automation"]["id"]
    assert scheduler.set_enabled(automation_id, False)["enabled"] is False
    assert "pausada" in scheduler.format_list()
    assert scheduler.remove(automation_id)
    assert not scheduler.remove(automation_id)


@pytest.mark.asyncio
async def test_due_automation_runs_once_within_grace_window(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("AUTOMATION_TIMEZONE", "UTC")
    monkeypatch.setenv("AUTOMATION_GRACE_MINUTES", "5")
    scheduler = AutomationScheduler(tmp_path / "automations.json", server_provider=lambda: {})
    automation = scheduler.create("save", "12:01", "segunda")["automation"]
    runs = []

    async def execute(item):
        runs.append(item["id"])
        return {"ok": True, "message": "save enviado"}

    scheduler.execute = execute
    now = datetime(2026, 6, 29, 12, 3, tzinfo=timezone.utc)
    await scheduler.run_due(now=now)
    await scheduler.run_due(now=now)

    assert runs == [automation["id"]]
    saved = scheduler.get_automations()[0]
    assert saved["lastRunKey"] == "2026-06-29 12:01"
    assert saved["lastResult"]["ok"] is True
