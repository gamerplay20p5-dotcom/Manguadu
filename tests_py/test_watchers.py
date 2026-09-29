from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from manguadu.watchers import FriendHostWatcher


@pytest.mark.asyncio
async def test_log_follower_preserves_partial_lines_and_handles_truncation(tmp_path: Path) -> None:
    watcher = FriendHostWatcher(SimpleNamespace())
    log = tmp_path / "server_chat.txt"
    log.write_text("primeira\nparcial", encoding="utf-8")

    assert await watcher._read_new_lines(log) == ["primeira"]
    assert watcher.remainders[log] == "parcial"
    with log.open("a", encoding="utf-8") as stream:
        stream.write(" terminada\n")
    assert await watcher._read_new_lines(log) == ["parcial terminada"]
    log.write_text("apos truncar\n", encoding="utf-8")
    assert await watcher._read_new_lines(log) == ["apos truncar"]


@pytest.mark.asyncio
async def test_watcher_announces_only_increased_perks() -> None:
    watcher = FriendHostWatcher(SimpleNamespace())
    sent = []

    async def record(message: str) -> None:
        sent.append(message)

    watcher._send_evolution = record
    watcher.perks["Menta"] = {"woodwork": "2", "strength": "1", "username": "Menta"}
    await watcher._process_perks("Menta", {"woodwork": "3", "strength": "1", "username": "Menta"})
    await watcher._process_perks("Menta", {"woodwork": "3", "strength": "1", "username": "Menta"})

    assert len(sent) == 1
    assert "Menta" in sent[0]
    assert "3" in sent[0]
