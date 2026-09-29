"""Renderizacao PNG de mapas, coordenadas de jogadores e safehouses do PZ."""

from __future__ import annotations

import io
import math
import unicodedata
from typing import Any

from PIL import Image, ImageDraw, ImageFont


WIDTH, HEIGHT, PADDING = 1000, 700, 42
COLORS = {
    "background": (13, 18, 20, 255), "panel": (20, 28, 31, 255),
    "grid": (43, 55, 60, 255), "grid_major": (72, 92, 98, 255),
    "border": (132, 158, 154, 255), "map": (49, 112, 80, 255),
    "map_fill": (24, 52, 42, 255), "safehouse": (226, 176, 64, 255),
    "focus_cell": (100, 128, 82, 255), "focus_chunk": (188, 83, 74, 255),
    "player": (80, 200, 255, 255), "focus": (255, 82, 82, 255),
    "text": (220, 234, 231, 255), "muted": (139, 164, 162, 255),
}


def _font(size: int) -> ImageFont.ImageFont:
    try:
        return ImageFont.truetype("DejaVuSans.ttf", size)
    except OSError:
        return ImageFont.load_default()


def _finite(value: Any, fallback: float = 0) -> float:
    try:
        number = float(value)
        return number if math.isfinite(number) else fallback
    except (TypeError, ValueError):
        return fallback


def _normalize_bounds(bounds: dict[str, Any]) -> dict[str, float]:
    min_x, min_y = _finite(bounds.get("minX")), _finite(bounds.get("minY"))
    max_x, max_y = _finite(bounds.get("maxX"), min_x + 1), _finite(bounds.get("maxY"), min_y + 1)
    if max_x <= min_x:
        max_x = min_x + 1
    if max_y <= min_y:
        max_y = min_y + 1
    margin_x, margin_y = max(100, (max_x - min_x) * 0.04), max(100, (max_y - min_y) * 0.04)
    return {"minX": min_x - margin_x, "minY": min_y - margin_y, "maxX": max_x + margin_x, "maxY": max_y + margin_y}


def _project(point: dict[str, Any], bounds: dict[str, float], width: int, height: int) -> tuple[int, int]:
    usable_w, usable_h = width - 2 * PADDING, height - 2 * PADDING
    x_ratio = (_finite(point.get("x")) - bounds["minX"]) / max(1, bounds["maxX"] - bounds["minX"])
    y_ratio = (_finite(point.get("y")) - bounds["minY"]) / max(1, bounds["maxY"] - bounds["minY"])
    return round(PADDING + x_ratio * usable_w), round(PADDING + y_ratio * usable_h)


def _world_line(draw: ImageDraw.ImageDraw, bounds: dict[str, float], width: int, height: int, *, x: float | None = None, y: float | None = None, color: tuple[int, ...]) -> None:
    if x is not None:
        start = _project({"x": x, "y": bounds["minY"]}, bounds, width, height)
        end = _project({"x": x, "y": bounds["maxY"]}, bounds, width, height)
    else:
        start = _project({"x": bounds["minX"], "y": y}, bounds, width, height)
        end = _project({"x": bounds["maxX"], "y": y}, bounds, width, height)
    draw.line((start, end), fill=color, width=1)


def _grid(draw: ImageDraw.ImageDraw, bounds: dict[str, float], width: int, height: int, step: int, color: tuple[int, ...]) -> None:
    if step <= 0:
        return
    start_x = math.floor(bounds["minX"] / step) * step
    end_x = math.ceil(bounds["maxX"] / step) * step
    start_y = math.floor(bounds["minY"] / step) * step
    end_y = math.ceil(bounds["maxY"] / step) * step
    for world_x in range(start_x, end_x + 1, step):
        _world_line(draw, bounds, width, height, x=world_x, color=color)
    for world_y in range(start_y, end_y + 1, step):
        _world_line(draw, bounds, width, height, y=world_y, color=color)


def _rectangle(
    draw: ImageDraw.ImageDraw,
    bounds: dict[str, float],
    width: int,
    height: int,
    rectangle: dict[str, Any],
    outline: tuple[int, ...],
    line_width: int = 1,
    fill: tuple[int, ...] | None = None,
) -> tuple[tuple[int, int], tuple[int, int]]:
    first = _project({"x": rectangle.get("minX"), "y": rectangle.get("minY")}, bounds, width, height)
    second = _project({"x": rectangle.get("maxX"), "y": rectangle.get("maxY")}, bounds, width, height)
    xy = (first[0], first[1], second[0], second[1])
    draw.rectangle(xy, outline=outline, fill=fill, width=line_width)
    return first, second


def create_map_png(options: dict[str, Any] | None = None) -> bytes:
    options = options or {}
    width, height = max(500, int(options.get("width", WIDTH))), max(350, int(options.get("height", HEIGHT)))
    bounds = _normalize_bounds(options.get("bounds") or {})
    image = Image.new("RGBA", (width, height), COLORS["background"])
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, width, PADDING - 8), fill=COLORS["panel"])
    draw.text((16, 12), _safe_text(options.get("title") or "PROJECT ZOMBOID MAPA"), font=_font(17), fill=COLORS["text"])
    subtitle = _safe_text(options.get("subtitle", ""))
    if subtitle:
        draw.text((max(16, width - 560), 14), subtitle, font=_font(11), fill=COLORS["muted"])
    minor_step = max(1, int(options.get("minorGridStep") or 100))
    major_step = max(1, int(options.get("majorGridStep") or 300))
    _grid(draw, bounds, width, height, minor_step, COLORS["grid"])
    _grid(draw, bounds, width, height, major_step, COLORS["grid_major"])
    draw.rectangle((PADDING, PADDING, width - PADDING, height - PADDING), outline=COLORS["border"], width=2)

    maps = options.get("maps") or []
    for map_entry in maps:
        first, _ = _rectangle(draw, bounds, width, height, map_entry, COLORS["map"], 3, COLORS["map_fill"])
        if map_entry.get("name"):
            draw.text((first[0] + 8, first[1] + 8), _safe_text(map_entry["name"]), font=_font(11), fill=COLORS["muted"])
    _grid(draw, bounds, width, height, minor_step, COLORS["grid"])
    _grid(draw, bounds, width, height, major_step, COLORS["grid_major"])
    for map_entry in maps:
        first = _project({"x": map_entry.get("minX"), "y": map_entry.get("minY")}, bounds, width, height)
        draw.text((first[0] + 8, first[1] + 8), _safe_text(map_entry.get("name", "")), font=_font(11), fill=COLORS["muted"])

    if options.get("focusCell"):
        _rectangle(draw, bounds, width, height, options["focusCell"], COLORS["focus_cell"], 2)
    if options.get("focusChunk"):
        _rectangle(draw, bounds, width, height, options["focusChunk"], COLORS["focus_chunk"], 3)
    for house in options.get("safehouses") or []:
        x1 = _finite(house.get("x", house.get("minX")), math.nan)
        y1 = _finite(house.get("y", house.get("minY")), math.nan)
        x2 = _finite(house.get("x2", house.get("maxX")), math.nan)
        y2 = _finite(house.get("y2", house.get("maxY")), math.nan)
        if all(math.isfinite(value) for value in (x1, y1, x2, y2)):
            _rectangle(draw, bounds, width, height, {"minX": x1, "minY": y1, "maxX": x2, "maxY": y2}, COLORS["safehouse"], 2)
    focus = options.get("focus")
    for point in options.get("points") or []:
        x, y = _finite(point.get("x"), math.nan), _finite(point.get("y"), math.nan)
        if not math.isfinite(x) or not math.isfinite(y):
            continue
        px, py = _project(point, bounds, width, height)
        focused = bool(focus and point.get("nick") == focus)
        radius = 8 if focused else 5
        color = COLORS["focus"] if focused else COLORS["player"]
        draw.ellipse((px - radius, py - radius, px + radius, py + radius), fill=color)
        if focused:
            draw.ellipse((px - 13, py - 13, px + 13, py + 13), outline=color, width=1)
            draw.text((px + 18, py - 10), _safe_text(point.get("nick") or "PLAYER"), font=_font(11), fill=COLORS["text"])
        elif options.get("showPlayerLabels"):
            draw.text((px + 8, py - 6), _safe_text(point.get("nick", "")), font=_font(10), fill=COLORS["muted"])
    footer = f"X {round(bounds['minX'])}-{round(bounds['maxX'])}  Y {round(bounds['minY'])}-{round(bounds['maxY'])}  GRID {major_step}"
    draw.text((16, height - 24), _safe_text(footer), font=_font(10), fill=COLORS["muted"])
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True)
    return output.getvalue()


def _safe_text(value: Any) -> str:
    text = unicodedata.normalize("NFD", str(value or ""))
    text = "".join(character for character in text if not unicodedata.combining(character))
    text = text.upper()
    return "".join(character for character in text if character.isascii() and (character.isalnum() or character in " .,:/-"))
