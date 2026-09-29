"""Leitura dos arquivos FriendHost e pequenos utilitarios compartilhados."""

from __future__ import annotations

import csv
import logging
import re
from pathlib import Path
from typing import Any


logger = logging.getLogger(__name__)


def clean_text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def to_number(value: Any, fallback: float = 0) -> float:
    match = re.match(r"^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][+-]?\d+)?", clean_text(value).replace(",", "."))
    if not match:
        return fallback
    try:
        return float(match.group())
    except ValueError:
        return fallback


def get_field(record: dict[str, str] | None, keys: list[str] | tuple[str, ...], fallback: str = "") -> str:
    for key in keys:
        value = clean_text((record or {}).get(key))
        if value:
            return value
    return fallback


def read_text_file(file_path: str | Path | None) -> str:
    if not file_path:
        return ""
    try:
        return Path(file_path).read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return ""
    except (OSError, UnicodeError) as exc:
        logger.error("Falha ao ler %s: %s", file_path, exc)
        return ""


def parse_delimited_csv(content: str, *, delimiter: str = ";", trim: bool = True) -> list[list[str]]:
    normalized = content.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    rows = csv.reader(normalized.splitlines(keepends=True), delimiter=delimiter)
    result = []
    for row in rows:
        cells = [cell.strip() if trim else cell for cell in row]
        if any(clean_text(cell) for cell in cells):
            result.append(cells)
    return result


def read_csv_raw_rows(file_path: str | Path | None) -> list[list[str]]:
    content = read_text_file(file_path)
    if not content.strip():
        return []
    try:
        return parse_delimited_csv(content)
    except csv.Error as exc:
        logger.error("Falha ao ler CSV %s: %s", file_path, exc)
        return []


def read_csv_rows(file_path: str | Path | None) -> list[dict[str, str]]:
    rows = read_csv_raw_rows(file_path)
    if not rows:
        return []
    headers = [clean_text(value).lstrip("\ufeff\u200b").lower() for value in rows[0]]
    return [
        {header: clean_text(row[index]) if index < len(row) else "" for index, header in enumerate(headers) if header}
        for row in rows[1:]
    ]


def read_latest_csv_row(file_path: str | Path | None) -> dict[str, str] | None:
    if not file_path:
        return None
    try:
        with Path(file_path).open("r", encoding="utf-8-sig", newline="") as stream:
            reader = csv.reader(stream, delimiter=";")
            headers = None
            latest = None
            for row in reader:
                cells = [cell.strip() for cell in row]
                if not any(cells):
                    continue
                if headers is None:
                    headers = [cell.lstrip("\ufeff\u200b").lower() for cell in cells]
                    continue
                latest = {header: cells[index] if index < len(cells) else "" for index, header in enumerate(headers) if header}
            return latest
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError, csv.Error) as exc:
        logger.error("Falha ao ler ultima linha CSV %s: %s", file_path, exc)
        return None
