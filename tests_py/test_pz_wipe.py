from __future__ import annotations

import asyncio
import tarfile
from pathlib import Path

from manguadu.pz_data import PzData
from manguadu.pz_wipe import _local_backup, _safe_relative, build_wipe_plan


def test_cell_wipe_excludes_safehouses_unless_forced(tmp_path: Path, monkeypatch) -> None:
    save = tmp_path / "save"
    (save / "chunkdata").mkdir(parents=True)
    (save / "map_0_0.bin").write_bytes(b"map")
    (save / "zpop_0_0.bin").write_bytes(b"zeds")
    server = tmp_path / "FriendHost" / "Servidor"
    server.mkdir(parents=True)
    (server / "safehouses.txt").write_text(
        "title;owner;x;y;x2;y2\nBase;Menta;0;0;299;299\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("PZ_SAVE_ROOT", str(save))
    monkeypatch.setenv("CSV_BASE_PATH", str(tmp_path / "FriendHost"))
    data = PzData(tmp_path / "FriendHost")

    protected = asyncio.run(build_wipe_plan("cell", "0,0", data=data))
    forced = asyncio.run(build_wipe_plan("cell", "0,0", force=True, data=data))

    assert protected["ok"] and protected["files"] == []
    assert protected["skipped"] == [{"target": "celula 0,0", "safehouses": ["Base"]}]
    assert forced["files"] == ["map_0_0.bin", "zpop_0_0.bin"]


def test_local_pre_wipe_archive_contains_requested_files(tmp_path: Path, monkeypatch) -> None:
    save = tmp_path / "save"
    save.mkdir()
    content = save / "map_1_2.bin"
    content.write_bytes(b"save-before-wipe")
    monkeypatch.setenv("PZ_LOCAL_BACKUP_DIR", str(tmp_path / "backups"))
    plan = {"root": str(save), "files": ["map_1_2.bin"], "storage": "local"}

    result = _local_backup(plan)

    assert result["ok"]
    with tarfile.open(result["backup"]["archivePath"], "r:gz") as archive:
        member = archive.extractfile("map_1_2.bin")
        assert member is not None
        assert member.read() == b"save-before-wipe"
    assert content.exists()


def test_wipe_paths_reject_traversal_and_absolute_names() -> None:
    assert _safe_relative("../outside.bin") is None
    assert _safe_relative("/etc/passwd") is None
    assert _safe_relative("chunkdata/map_1_2.bin").as_posix() == "chunkdata/map_1_2.bin"


def test_global_local_plan_only_includes_existing_targets(tmp_path: Path, monkeypatch) -> None:
    cache = tmp_path / "cache"
    (cache / "db").mkdir(parents=True)
    (cache / "Saves").mkdir()
    monkeypatch.setenv("PZ_CACHE_ROOT", str(cache))

    plan = asyncio.run(build_wipe_plan("global"))

    assert plan["storage"] == "local"
    assert plan["files"] == ["db", "Saves"]
