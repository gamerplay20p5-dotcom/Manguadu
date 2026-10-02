#!/usr/bin/env python3
"""Atualiza a instalacao Python do bot e, por padrao, reinicia o PM2."""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from manguadu.bot_updater import BotUpdater  # noqa: E402
from manguadu.environment import load_project_environment  # noqa: E402


async def main() -> int:
    parser = argparse.ArgumentParser(description="Atualiza o Friendhost - PZ/Bot em Python")
    parser.add_argument("--skip-restart", action="store_true", help="Deixa o processo chamador reiniciar o PM2")
    args = parser.parse_args()
    load_project_environment()
    result = await BotUpdater().update(skip_restart=args.skip_restart)
    print(result["output"])
    if not result["ok"]:
        if result.get("error"):
            print(result["error"], file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
