"""Leitura recorrente de mudanças FriendHost e logs nativos do servidor."""

from __future__ import annotations

import asyncio
import logging
import os
import re
from pathlib import Path

import aiohttp
import discord

from .friendhost import resolve_player_file
from .pz_data import PERK_EMOJIS, PERK_LABELS
from .utils import clean_text, read_latest_csv_row, to_number


logger = logging.getLogger(__name__)
IGNORED_PERKS = {"systemdate", "systemtime", "gametime", "steamid", "username", "charname"}


def _latest_log(root: Path, suffix: str) -> Path | None:
    try:
        matches = [path for path in root.iterdir() if path.is_file() and path.name.endswith(suffix)]
        return max(matches, key=lambda path: path.stat().st_mtime, default=None)
    except OSError:
        return None


class FriendHostWatcher:
    def __init__(self, bot):
        self.bot = bot
        self.perks: dict[str, dict[str, str]] = {}
        self.death_count = 0
        self.active_logs: dict[str, Path | None] = {"chat": None, "user": None}
        self.offsets: dict[Path, int] = {}
        self.remainders: dict[Path, str] = {}
        self._initialized = False
        self._last_data_scan = 0.0

    def _read_data_state(self) -> tuple[dict[str, dict[str, str]], int]:
        data = self.bot.pz_data
        perks = {}
        if data.players_path and data.players_path.is_dir():
            for nick in data.player_names():
                row = read_latest_csv_row(resolve_player_file(data.players_path, nick, "perks"))
                if row: perks[nick] = row
        return perks, len(data.death_rows())

    async def initialize(self) -> None:
        self.perks, self.death_count = await asyncio.to_thread(self._read_data_state)
        root_value = clean_text(os.getenv("LOGS_PATH"))
        root = Path(root_value) if root_value else None
        if root and root.is_dir():
            for kind, suffix in (("chat", "_chat.txt"), ("user", "_user.txt")):
                path = _latest_log(root, suffix)
                self.active_logs[kind] = path
                if path:
                    try: self.offsets[path] = path.stat().st_size
                    except OSError: self.offsets[path] = 0
                    self.remainders[path] = ""
        else:
            logger.warning("LOGS_PATH não encontrado; espelho de logs desativado.")
        self._initialized = True

    async def _send_evolution(self, content: str) -> None:
        channels = []
        for guild in self.bot.guilds:
            channel_id = self.bot.store.get_settings(guild.id)["channels"].get("evolution")
            channel = guild.get_channel(channel_id) if channel_id else None
            if isinstance(channel, discord.TextChannel): channels.append(channel)
        legacy_id = clean_text(os.getenv("ID_CANAL_EVOLUCAO"))
        if not channels and legacy_id.isdigit():
            try:
                channel = self.bot.get_channel(int(legacy_id)) or await self.bot.fetch_channel(int(legacy_id))
                if isinstance(channel, discord.TextChannel): channels.append(channel)
            except discord.HTTPException:
                logger.exception("Canal legado de evolução não está disponível")
        for channel in channels:
            try: await channel.send(content)
            except discord.HTTPException: logger.exception("Falha ao enviar notificação de evolução")

    async def _process_perks(self, nick: str, latest: dict[str, str]) -> None:
        previous = self.perks.get(nick)
        if previous:
            for key, value in latest.items():
                if key in IGNORED_PERKS: continue
                old_level, new_level = to_number(previous.get(key)), to_number(value)
                if new_level > old_level:
                    label = PERK_LABELS.get(key, key)
                    emoji = PERK_EMOJIS.get(key, "✨")
                    await self._send_evolution(f"📈 **LEVEL UP**\n🧍 **{nick}** evoluiu {emoji} **{label}** para o nível **{new_level:g}**.")
        self.perks[nick] = latest

    @staticmethod
    def _dead_nick(row: list[str]) -> str:
        for candidate in row[4:7]:
            value = clean_text(candidate)
            if value and not re.fullmatch(r"\d{2}\.\d{2}\.\d{4}|\d{2}:\d{2}:\d{2}", value): return value
        return "Desconhecido"

    async def _scan_data(self) -> None:
        current, death_count = await asyncio.to_thread(self._read_data_state)
        for nick, row in current.items():
            await self._process_perks(nick, row)
        self.perks = {nick: row for nick, row in self.perks.items() if nick in current}
        if death_count > self.death_count:
            rows = await asyncio.to_thread(self.bot.pz_data.death_rows)
            for row in rows[self.death_count:death_count]:
                await self._send_evolution(f"💀 **ALERTA DE MORTE**\n🧍 **{self._dead_nick(row)}** morreu no servidor.")
        self.death_count = death_count

    async def _read_new_lines(self, path: Path) -> list[str]:
        try:
            size = path.stat().st_size
            offset = self.offsets.get(path, 0)
            if size < offset:
                offset = 0
                self.remainders[path] = ""
            if size == offset: return []
            with path.open("rb") as stream:
                stream.seek(offset)
                raw = stream.read(size - offset)
            self.offsets[path] = size
        except OSError:
            return []
        combined = self.remainders.get(path, "") + raw.decode("utf-8", errors="replace")
        parts = re.split(r"\r?\n", combined)
        self.remainders[path] = parts.pop() if parts else ""
        return [line.strip() for line in parts if line.strip()]

    async def _mirror_chat(self, line: str) -> None:
        webhook = clean_text(os.getenv("WEBHOOK_CHAT"))
        match = re.search(r"\[Chat\]\s+\[([^\]]+)\]\s+(.+)", line, re.I)
        if not webhook or not match: return
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
                async with session.post(webhook, json={"content": match.group(2).strip(), "username": match.group(1).strip(), "avatar_url": "https://i.imgur.com/7HnOMg0.png"}) as response:
                    if response.status >= 300: logger.warning("Webhook de chat retornou HTTP %s: %s", response.status, (await response.text())[:200])
        except (aiohttp.ClientError, TimeoutError):
            logger.exception("Falha no espelho de chat")

    async def _mirror_user(self, line: str) -> None:
        match = re.search(r'"(.*?)"\s+(fully connected|disconnected)', line, re.I)
        if not match: return
        nick, action = clean_text(match.group(1)), clean_text(match.group(2)).casefold()
        if action == "fully connected": await self._send_evolution(f"[LOGIN] {nick} entrou no servidor.")
        elif action == "disconnected": await self._send_evolution(f"[LOGOUT] {nick} saiu do servidor.")

    async def _scan_logs(self) -> None:
        root_value = clean_text(os.getenv("LOGS_PATH"))
        if not root_value: return
        root = Path(root_value)
        if not root.is_dir(): return
        for kind, suffix in (("chat", "_chat.txt"), ("user", "_user.txt")):
            latest = _latest_log(root, suffix)
            if latest is None or latest != self.active_logs[kind]:
                self.active_logs[kind] = latest
                if latest:
                    try: self.offsets[latest] = latest.stat().st_size
                    except OSError: self.offsets[latest] = 0
                    self.remainders[latest] = ""
                continue
            if not latest: continue
            lines = await self._read_new_lines(latest)
            for line in lines:
                await (self._mirror_chat(line) if kind == "chat" else self._mirror_user(line))

    async def run(self) -> None:
        if not self._initialized:
            await self.initialize()
        while not self.bot.is_closed():
            try:
                await self._scan_logs()
                now = asyncio.get_running_loop().time()
                if now - self._last_data_scan >= 30:
                    await self._scan_data()
                    self._last_data_scan = now
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Falha nas rotinas de monitoramento FriendHost/logs")
            await asyncio.sleep(2)
