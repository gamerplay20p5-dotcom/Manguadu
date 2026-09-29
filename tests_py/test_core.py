from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from manguadu.friendhost import is_friendhost_data_file, resolve_player_file, resolve_server_file
from manguadu.pz_data import PzData
from manguadu.server_registry import ServerRegistry, describe_missing_config, describe_missing_rcon
from manguadu.utils import read_csv_rows, read_latest_csv_row


def test_server_registry_fallback_and_secret_indirection(tmp_path: Path) -> None:
    missing = tmp_path / "missing.json"
    env = {"PTERO_SERVER_ID": "legacy", "RCON_PORT": "27015", "PTERO_API_KEY": "secret"}
    registry = ServerRegistry(env, missing)
    assert registry.get_default_server()["id"] == "default"
    assert registry.get_server()["ptero"]["serverId"] == "legacy"
    assert registry.get_server()["rcon"]["port"] == 27015

    config = tmp_path / "servers.json"
    config.write_text(json.dumps({"servers": [
        {"id": "hard", "order": 3, "ptero": {"serverId": "s3"}},
        {"id": "facil", "order": 1, "ptero": {"serverId": "s1", "apiKeyEnv": "FACIL_KEY"}, "rcon": {"passwordEnv": "FACIL_RCON"}},
        {"label": "invalid"},
        {"id": "facil", "order": 0},
    ]}), encoding="utf-8")
    registry = ServerRegistry({**env, "PTERO_URL": "https://example.test", "FACIL_KEY": "facil-secret", "FACIL_RCON": "rcon-secret"}, config)
    assert [server["id"] for server in registry.list_servers()] == ["facil", "hard"]
    assert registry.get_server("HARD")["id"] == "hard"
    assert registry.get_server("unknown") is None
    assert registry.has_multiple_servers()
    assert registry.get_default_server()["ptero"]["apiKey"] == "facil-secret"
    assert registry.get_default_server()["rcon"]["password"] == "rcon-secret"
    assert "facil-secret" not in config.read_text(encoding="utf-8")
    assert describe_missing_config(registry.get_default_server()) == []
    assert "rcon.host" in describe_missing_rcon(registry.get_default_server())


def test_server_registry_uses_env_rcon_endpoint_when_json_fields_are_missing(tmp_path: Path) -> None:
    config = tmp_path / "servers.json"
    config.write_text(json.dumps({"servers": [{"id": "pz"}]}), encoding="utf-8")

    server = ServerRegistry({"RCON_HOST": "10.0.0.8", "RCON_PORT": "27016"}, config).get_default_server()

    assert server["rcon"]["host"] == "10.0.0.8"
    assert server["rcon"]["port"] == 27016


def test_invalid_registry_falls_back(tmp_path: Path) -> None:
    config = tmp_path / "servers.json"
    config.write_text("{ invalid", encoding="utf-8")
    assert ServerRegistry({"PTERO_SERVER_ID": "legacy"}, config).get_default_server()["ptero"]["serverId"] == "legacy"


def test_non_finite_order_uses_file_position(tmp_path: Path) -> None:
    config = tmp_path / "servers.json"
    config.write_text(json.dumps({"servers": [{"id": "first", "order": "NaN"}, {"id": "second", "order": 1}]}), encoding="utf-8")
    assert [server["id"] for server in ServerRegistry({}, config).list_servers()] == ["first", "second"]


def test_friendhost_file_precedence_and_csv(tmp_path: Path) -> None:
    player_dir = tmp_path / "Jogadores" / "Menta"
    player_dir.mkdir(parents=True)
    (player_dir / "player_Menta.csv").write_text("username;note\nMenta;old\n", encoding="utf-8")
    assert resolve_player_file(tmp_path / "Jogadores", "Menta").suffix == ".csv"
    (player_dir / "player_Menta.csv.txt").write_text("username;note\nMenta;legacy\n", encoding="utf-8")
    assert resolve_player_file(tmp_path / "Jogadores", "Menta").name.endswith(".csv.txt")
    (player_dir / "player_Menta.txt").write_text('\ufeffUsername;Note\nMenta;"linha 1\nlinha 2"\nMenta;atual\n', encoding="utf-8")
    assert resolve_player_file(tmp_path / "Jogadores", "Menta").name == "player_Menta.txt"
    assert read_csv_rows(player_dir / "player_Menta.txt")[0]["note"] == "linha 1\nlinha 2"
    assert read_latest_csv_row(player_dir / "player_Menta.txt")["note"] == "atual"
    assert is_friendhost_data_file("world_history.txt")
    assert not is_friendhost_data_file("README.txt")


def test_pz_data_reads_existing_friendhost_layout(tmp_path: Path) -> None:
    player_dir = tmp_path / "Jogadores" / "Menta"
    server_dir = tmp_path / "Servidor"
    player_dir.mkdir(parents=True)
    server_dir.mkdir()
    (player_dir / "player_Menta.txt").write_text("username;zombiekills;hourssurvived\nMenta;42;10\n", encoding="utf-8")
    (server_dir / "players_online.txt").write_text("Menta;Malaio", encoding="utf-8")
    (server_dir / "world.txt").write_text("04.08.2026;17:54:00;04.08.2026 12:00;20;22.5;2", encoding="utf-8")
    assert resolve_server_file(server_dir, "world") == server_dir / "world.txt"
    data = PzData(tmp_path)
    assert data.player_names() == ["Menta"]
    assert data.find_player("menta")["nick"] == "Menta"
    assert data.player_rank("Menta")["position"] == 1
    assert data.online_players() == ["Menta", "Malaio"]
    assert data.world_snapshot()["temperature"] == "22.5"


def test_world_time_falls_back_to_player_file(tmp_path: Path) -> None:
    player_dir = tmp_path / "Jogadores" / "Menta"
    player_dir.mkdir(parents=True)
    (player_dir / "player_Menta.txt").write_text("gametime\n04.08.2026 12:00\n", encoding="utf-8")
    world = PzData(tmp_path).world_snapshot()
    assert world["gameDate"] == "04.08.2026"
    assert world["source"] == "player_Menta.txt"


def test_player_log_extract_filters_type_and_time(tmp_path: Path, monkeypatch) -> None:
    log_root = tmp_path / "logs"
    log_root.mkdir()
    now = datetime.now()
    recent = now.strftime("%y-%m-%d %H:%M:%S") + " user Menta joined"
    (log_root / "chat.txt").write_text(f"{recent}\n00-01-01 00:00:00 Menta old entry\n", encoding="utf-8")
    (log_root / "admin.txt").write_text("26-01-01 00:00:00 Menta admin entry\n", encoding="utf-8")
    monkeypatch.setenv("LOGS_PATH", str(log_root))

    result = PzData(None).extract_player_logs("menta", "chat", 24)

    assert len(result["files"]) == 1
    assert len(result["lines"]) == 1
    assert "joined" in result["lines"][0]


def test_friendhost_delete_targets_stay_inside_data_root(tmp_path: Path) -> None:
    base = tmp_path / "FriendHost"
    player = base / "Jogadores" / "Menta"
    server = base / "Servidor"
    player.mkdir(parents=True)
    server.mkdir()
    (player / "player_Menta.txt").write_text("username\nMenta\n", encoding="utf-8")
    (player / "playerperks_Menta.csv").write_text("username;woodwork\nMenta;4\n", encoding="utf-8")
    (player / "playerinventory_Menta.txt").write_text("item\naxe\n", encoding="utf-8")
    (server / "world.txt").write_text("world\ndata\n", encoding="utf-8")
    data = PzData(base)
    targets = data.delete_targets("jogador", "menta")
    everything = data.delete_targets("tudo")

    assert targets is not None
    assert {path.name for path in targets} == {"player_Menta.txt", "playerperks_Menta.csv", "playerinventory_Menta.txt"}
    assert all(base.resolve() in path.resolve().parents for path in everything)
    assert server / "world.txt" in everything


def test_player_snapshot_includes_inventory_faction_safehouse_and_sqlite(tmp_path: Path) -> None:
    import sqlite3

    from manguadu.player_data import collect_player_snapshot
    from manguadu.player_reports import build_status_complete_embed, build_status_complete_report, build_status_embed

    player = tmp_path / "Jogadores" / "Menta"
    server = tmp_path / "Servidor"
    db_dir = tmp_path / "db"
    player.mkdir(parents=True)
    server.mkdir()
    db_dir.mkdir()
    (player / "player_Menta.txt").write_text(
        "username;charname;steamid;isalive;health;zombiekills;hourssurvived;profession;factionname;x;y;z\n"
        "Menta;Menta Vale;76561198000000000;true;85;42;10;Carpenter;Lobos;12;34;0\n", encoding="utf-8",
    )
    (player / "playerperks_Menta.txt").write_text("woodwork;strength\n3;2\n", encoding="utf-8")
    (player / "playerinventory_Menta.txt").write_text(
        "28.09.2026;12:00:00;1;Food;Base.CannedBeans;Canned Beans;fresh\n", encoding="utf-8",
    )
    (server / "factions.txt").write_text("name;owner;tagname;players\nLobos;Menta;LB;Menta\n", encoding="utf-8")
    (server / "safehouses.txt").write_text("title;owner;x;y;x2;y2;players\nBase;Menta;1;2;4;5;Menta\n", encoding="utf-8")
    connection = sqlite3.connect(db_dir / "survivors.sqlite")
    connection.execute("CREATE TABLE survivors (username TEXT, note TEXT)")
    connection.execute("INSERT INTO survivors VALUES ('Menta', 'found in sqlite')")
    connection.commit()
    connection.close()

    snapshot = collect_player_snapshot("menta", data=PzData(tmp_path), include_inventory=True, include_db=True)
    assert snapshot["found"]
    assert snapshot["faction"]["tag"] == "LB"
    assert snapshot["safehouses"][0]["title"] == "Base"
    assert snapshot["inventorySummary"]["totalRows"] == 1
    assert snapshot["dbData"]["sqliteMatches"][0]["tables"][0]["rows"][0]["note"] == "found in sqlite"
    assert build_status_embed(snapshot).title == "🧾 Perfil de Menta Vale"
    assert build_status_complete_embed(snapshot).footer.text == "Relatório completo anexado em .txt"
    assert "Itens agrupados:" in build_status_complete_report(snapshot)
