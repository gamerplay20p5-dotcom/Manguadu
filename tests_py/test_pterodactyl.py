from __future__ import annotations

import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from manguadu.pterodactyl import PterodactylClient


def test_pterodactyl_client_contract() -> None:
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args: object) -> None:
            pass

        def do_GET(self) -> None:
            self._respond()

        def do_POST(self) -> None:
            self._respond()

        def do_DELETE(self) -> None:
            self._respond()

        def _respond(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length).decode("utf-8")
            requests.append((self.command, self.path, body, self.headers.get("Authorization")))
            if "/files/list" in self.path:
                data = {"data": [{"attributes": {"name": "map_1_2.bin", "is_file": True, "size": 123}}]}
            elif self.path.endswith("/backups?per_page=100"):
                data = {"data": [{"attributes": {"uuid": "backup-id", "name": "Safehouses geral - antigo", "is_locked": True, "bytes": 55}}]}
            elif self.path.endswith("/backups") and self.command == "POST":
                data = {"attributes": {"uuid": "new-backup", "name": "Pre-wipe", "is_locked": True}}
            elif "/backups/backup-id" in self.path:
                data = {"attributes": {"uuid": "backup-id", "is_successful": True}}
            elif "/resources" in self.path:
                data = {"attributes": {"current_state": "running", "resources": {"memory_bytes": 123}}}
            else:
                data = None
            payload = json.dumps(data).encode("utf-8") if data is not None else b"timestamp,username\n"
            self.send_response(200)
            self.send_header("Content-Type", "application/json" if data is not None else "text/plain")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    config = {"ptero": {"url": f"http://127.0.0.1:{server.server_port}", "serverId": "server-id", "apiKey": "test-key"}}

    async def run() -> None:
        async with PterodactylClient(config) as client:
            files = await client.list_files("/Zomboid/Saves")
            read = await client.read_file("/Zomboid/Lua/pending.csv")
            write = await client.write_file("/Zomboid/Lua/pending.csv", "timestamp,username\n")
            backup = await client.get_backup("backup-id")
            resources = await client.resources()
            backups = await client.list_backups()
            created = await client.create_backup("Pre-wipe", is_locked=True)
            restored = await client.restore_backup("backup-id", truncate=False)
            deleted = await client.delete_backup("backup-id")
            assert files["files"][0]["name"] == "map_1_2.bin"
            assert read["text"] == "timestamp,username\n"
            assert write["ok"]
            assert backup["backup"]["isSuccessful"]
            assert resources["state"] == "running"
            assert backups["backups"][0]["isLocked"]
            assert created["backup"]["uuid"] == "new-backup"
            assert restored["ok"] and deleted["ok"]

    try:
        asyncio.run(run())
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    assert len(requests) == 9
    assert all(authorization == "Bearer test-key" for _, _, _, authorization in requests)
    assert requests[2][2] == "timestamp,username\n"
    assert json.loads(requests[6][2])["is_locked"] is True
    assert json.loads(requests[7][2]) == {"truncate": False}
    assert requests[8][0] == "DELETE"
