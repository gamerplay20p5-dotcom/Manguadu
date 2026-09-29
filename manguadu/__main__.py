"""Diagnóstico e entrada do Friendhost - PZ/Bot: python -m manguadu."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os

from .environment import load_project_environment
from .pz_path_discovery import discover_and_persist_pz_paths
from .pterodactyl import PterodactylClient, extract_ptero_error
from .pz_data import PzData
from .server_registry import ServerRegistry, describe_missing_config, describe_missing_rcon


async def inspect(probe: bool) -> int:
    registry = ServerRegistry()
    data = PzData(os.getenv("CSV_BASE_PATH"))
    servers = []
    for server in registry.list_servers():
        entry = {
            "id": server["id"], "label": server["label"],
            "pterodactylMissing": describe_missing_config(server),
            "rconMissing": describe_missing_rcon(server),
        }
        if probe and not entry["pterodactylMissing"]:
            async with PterodactylClient(server) as client:
                response = await client.resources()
            entry["pterodactyl"] = {"ok": response["ok"], "state": response.get("state")} if response["ok"] else {"ok": False, "error": extract_ptero_error(response)}
        servers.append(entry)
    print(json.dumps({
        "servers": servers,
        "friendHost": {
            "configured": bool(os.getenv("CSV_BASE_PATH")),
            "players": len(data.player_names()),
            "onlineFallback": data.online_players(),
            "world": data.world_snapshot(),
        },
    }, ensure_ascii=False, indent=2))
    return 0


async def run_bot(token: str) -> None:
    discover_and_persist_pz_paths()
    from .discord_bot import ManguaduBot

    bot = ManguaduBot()
    try:
        await bot.start(token)
    finally:
        await bot.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Friendhost - PZ/Bot")
    parser.add_argument("--probe", action="store_true", help="Consulta apenas o estado dos servidores na API do Pterodactyl")
    parser.add_argument("--bot", action="store_true", help="Inicia o bot Discord e seus paineis e tarefas")
    args = parser.parse_args()
    load_project_environment()
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
    if args.bot:
        token = os.getenv("DISCORD_TOKEN", "").strip()
        if not token:
            parser.error("DISCORD_TOKEN ausente. Configure o token na VM para iniciar o bot.")
        try:
            asyncio.run(run_bot(token))
        except KeyboardInterrupt:
            logging.info("Encerramento do bot solicitado.")
        return 0
    return asyncio.run(inspect(args.probe))


if __name__ == "__main__":
    raise SystemExit(main())
