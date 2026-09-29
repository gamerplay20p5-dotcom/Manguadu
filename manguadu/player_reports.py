"""Embeds e relatorios completos produzidos a partir de uma ficha PZ."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import discord

from .player_data import get_perk_entries
from .utils import get_field, to_number


def _truthy(value: str) -> bool:
    return value.strip().casefold() in {"1", "true", "yes", "sim", "alive"}


def _health_emoji(alive: bool, value: str) -> str:
    if not alive: return "💀"
    health = to_number(value, float("nan"))
    if health != health: return "🫀"
    return "💚" if health >= 75 else "💛" if health >= 40 else "❤️"


def _format_perks(perks: list[dict], limit: int) -> str:
    if not perks: return "✨ Nenhuma skill acima de 0 registrada."
    return "\n".join(f"{item['emoji']} {item['label']} • `{item['value']:g}`" for item in perks[:limit])


def _format_safehouse(row: dict) -> str:
    title = get_field(row, ["title"], "Sem título")
    owner = get_field(row, ["owner"], "Sem dono")
    return f"{title} | dono: {owner} | área: ({get_field(row, ['x'], '?')}, {get_field(row, ['y'], '?')}) -> ({get_field(row, ['x2'], '?')}, {get_field(row, ['y2'], '?')})"


def build_status_embed(snapshot: dict) -> discord.Embed:
    row = snapshot.get("playerRow") or {}
    alive = _truthy(get_field(row, ["isalive"]))
    emoji = _health_emoji(alive, get_field(row, ["health"]))
    title = get_field(row, ["charname"], snapshot["actualNick"])
    faction = snapshot.get("faction") or {}
    faction_name = faction.get("name") or get_field(row, ["factionname"], "Lobo solitário")
    faction_tag = faction.get("tag") or get_field(row, ["factiontag"])
    safehouses = snapshot.get("safehouses", [])
    safehouse = get_field(row, ["safehousetitle"]) or get_field(safehouses[0] if safehouses else {}, ["title"], "Nenhuma vinculada")
    perks = get_perk_entries(snapshot.get("perksRow"), False)
    embed = discord.Embed(title=f"🧾 Perfil de {title}", color=0x2ECC71 if alive else 0xE74C3C, timestamp=datetime.now(timezone.utc))
    embed.description = "\n".join((
        f"🎮 **Nick:** {snapshot['actualNick']}", f"{emoji} **Status:** {'Vivo' if alive else 'Morto'}",
        f"🛡️ **Facção:** {faction_name}{f' [{faction_tag}]' if faction_tag else ''}", f"🏠 **Safehouse:** {safehouse}",
    ))
    fields = [
        ("🧰 Profissão", get_field(row, ["profession"], "N/A"), True),
        ("🧟 Zumbis mortos", f"{to_number(get_field(row, ['zombiekills'])):g}", True),
        ("⏳ Horas vividas", f"{to_number(get_field(row, ['hourssurvived'])):.1f}", True),
        (f"{emoji} Vida", get_field(row, ["health"], "N/A"), True),
        ("🆔 SteamID", get_field(row, ["steamid"], "N/A"), True),
        ("📍 Posição", f"{get_field(row, ['x'], '?')}, {get_field(row, ['y'], '?')}, {get_field(row, ['z'], '?')}", True),
        ("✨ Skills em destaque", "\n".join(f"{item['emoji']} {item['label']} • `{item['value']:g}`" for item in perks[:5]) or "✨ Nenhuma skill acima de 0 registrada.", False),
        ("⚔️ Arma favorita", get_field(row, ["favoriteweapon"], "Nenhuma"), False),
    ]
    for name, value, inline in fields: embed.add_field(name=name, value=(value or "N/A")[:1024], inline=inline)
    return embed


def build_status_complete_embed(snapshot: dict) -> discord.Embed:
    row = snapshot.get("playerRow") or {}
    alive = _truthy(get_field(row, ["isalive"]))
    emoji = _health_emoji(alive, get_field(row, ["health"]))
    perks = get_perk_entries(snapshot.get("perksRow"), False)
    faction = snapshot.get("faction") or {}
    faction_name = faction.get("name") or get_field(row, ["factionname"], "Sem facção")
    tag = faction.get("tag") or get_field(row, ["factiontag"])
    inventory = snapshot["inventorySummary"]
    db_data = snapshot["dbData"]
    embed = discord.Embed(title=f"📚 Ficha completa de {get_field(row, ['charname'], snapshot['actualNick'])}", color=0x1ABC9C if alive else 0xC0392B, timestamp=datetime.now(timezone.utc))
    embed.description = f"🎮 **Nick:** {snapshot['actualNick']}\n{emoji} **Status:** {'Vivo' if alive else 'Morto'}\n🛡️ **Facção:** {faction_name}{f' [{tag}]' if tag else ''}\n🏠 **Safehouses vinculadas:** {len(snapshot['safehouses'])}"
    embed.add_field(name="🫀 Sobrevivência", value=f"🧟 Zumbis: `{to_number(get_field(row, ['zombiekills'])):g}`\n⏳ Horas: `{to_number(get_field(row, ['hourssurvived'])):.1f}`\n{emoji} Vida: `{get_field(row, ['health'], 'N/A')}`\n🦠 Infecção: `{get_field(row, ['infectionlevel'], '0')}`", inline=True)
    embed.add_field(name="🎒 Inventário", value=f"📦 Linhas: `{inventory['totalRows']}`\n🧩 Itens únicos: `{inventory['uniqueItems']}`\n🗃️ Categorias: `{len(inventory['categories'])}`", inline=True)
    embed.add_field(name="🛰️ Extras", value=f"✨ Skills > 0: `{len(perks)}`\n💾 DBs com match: `{len(db_data['sqliteMatches'])}`\n📄 Arquivos com match: `{len(db_data['textMatches'])}`", inline=True)
    embed.add_field(name="🌟 Skills em destaque", value=_format_perks(perks, 8), inline=False)
    category_lines = [f"• {item['name']}: `{item['count']}`" for item in inventory["categories"][:5]] or ["📦 Sem categorias registradas."]
    embed.add_field(name="📦 Categorias do inventário", value="\n".join(category_lines)[:1024], inline=False)
    embed.set_footer(text="Relatório completo anexado em .txt")
    return embed


def build_status_complete_report(snapshot: dict) -> str:
    row = snapshot.get("playerRow") or {}
    all_perks = get_perk_entries(snapshot.get("perksRow"), True)
    alive = _truthy(get_field(row, ["isalive"]))
    faction = snapshot.get("faction") or {}
    summary = snapshot["inventorySummary"]
    lines: list[str] = []

    def section(title: str) -> None:
        if lines: lines.append("")
        lines.extend((title, "-" * len(title)))

    lines.extend((f"STATUS COMPLETO - {snapshot['actualNick']}", f"Gerado em: {datetime.now(timezone.utc).isoformat()}"))
    section("Arquivos lidos")
    for label, key in (("player", "playerFile"), ("perks", "perksFile"), ("inventário", "inventoryFile")): lines.append(f"{label}: {snapshot['files'][key]}")
    section("Identificação")
    for label, keys, fallback in (("Nick", ["username"], snapshot["actualNick"]), ("Personagem", ["charname"], snapshot["actualNick"]), ("SteamID", ["steamid"], "N/A"), ("Profissão", ["profession"], "N/A"), ("Traits", ["traits"], "N/A")):
        lines.append(f"{label}: {get_field(row, keys, fallback)}")
    section("Sobrevivência")
    for label, keys, fallback in (("Status", [], "Vivo" if alive else "Morto"), ("Zumbis mortos", ["zombiekills"], "0"), ("Horas vividas", ["hourssurvived"], "0"), ("Tempo sobrevivido", ["timesurvived"], "N/A"), ("Vida", ["health"], "N/A"), ("Lesão", ["hasinjury"], "N/A"), ("Infecção", ["infectionlevel"], "0"), ("Falsa infecção", ["fakeinfectionlevel"], "N/A"), ("Molhado", ["wetness"], "N/A"), ("Peso", ["weight"], "N/A"), ("Arma favorita", ["favoriteweapon"], "Nenhuma"), ("Golpes com arma favorita", ["favoriteweaponhit"], "0")):
        value = fallback if not keys else get_field(row, keys, fallback)
        lines.append(f"{label}: {value}")
    lines.append(f"Posição: {get_field(row, ['x'], '?')}, {get_field(row, ['y'], '?')}, {get_field(row, ['z'], '?')}")
    section("Facção")
    lines.extend((f"Nome: {faction.get('name') or get_field(row, ['factionname'], 'Sem facção')}", f"Tag: {faction.get('tag') or get_field(row, ['factiontag'], 'Sem tag')}", f"Dono: {faction.get('owner') or 'Não informado'}", f"Membros: {', '.join(faction.get('players') or []) or 'Nenhum/não informado'}"))
    section("Safehouses")
    lines.extend([f"{index}. {_format_safehouse(house)}" for index, house in enumerate(snapshot["safehouses"], 1)] or ["Nenhuma safehouse vinculada."])
    section("Skills")
    lines.extend([f"{perk['label']}: {perk['value']:g}" for perk in all_perks] or ["Nenhuma skill registrada."])
    section("Inventário")
    lines.extend((f"Linhas brutas: {summary['totalRows']}", f"Itens únicos: {summary['uniqueItems']}", "Categorias: " + (", ".join(f"{item['name']}={item['count']}" for item in summary["categories"]) or "Nenhuma")))
    if not summary["items"]: lines.append("Nenhum item encontrado.")
    else:
        lines.append("Itens agrupados:")
        for item in summary["items"]:
            details = (f" | id: {item['itemId']}" if item["itemId"] else "") + (f" | extra: {item['extra']}" if item["extra"] else "")
            lines.append(f"x{item['count']} {item['name']} | categoria: {item['category']}{details}")
    if snapshot["inventoryRows"]:
        lines.extend(("", "Linhas brutas do inventário (primeiras 250):"))
        lines.extend(f"{index}. {item['raw']}" for index, item in enumerate(snapshot["inventoryRows"][:250], 1))
        if len(snapshot["inventoryRows"]) > 250: lines.append(f"... {len(snapshot['inventoryRows']) - 250} linha(s) omitidas.")
    db_data = snapshot["dbData"]
    section("DB externa")
    lines.append("Diretórios candidatos: " + (" | ".join(db_data["roots"]) if db_data["roots"] else "Nenhum diretório candidato de DB perto do FriendHost."))
    if not db_data["sqliteMatches"] and not db_data["textMatches"]: lines.append("Nenhum registro adicional encontrado para este jogador.")
    for match in db_data["sqliteMatches"]:
        lines.append(f"SQLite: {match['filePath']}")
        for table in match["tables"]:
            lines.append(f"  Tabela: {table['name']}")
            for values in table["rows"]: lines.append("    " + " | ".join(f"{key}={value}" for key, value in values.items()))
    for match in db_data["textMatches"]:
        lines.append(f"Arquivo texto: {match['filePath']}")
        lines.extend(f"  {line}" for line in match["lines"])
    return "\n".join(lines) + "\n"
