from __future__ import annotations

import io

from PIL import Image

from manguadu.pz_map_renderer import create_map_png


def test_map_renderer_returns_valid_png_with_overlay() -> None:
    content = create_map_png({
        "bounds": {"minX": 0, "minY": 0, "maxX": 3000, "maxY": 3000},
        "maps": [{"name": "Muldraugh", "minX": 500, "minY": 500, "maxX": 2000, "maxY": 2200}],
        "safehouses": [{"x": 1000, "y": 1100, "x2": 1200, "y2": 1300}],
        "points": [{"nick": "Menta", "x": 1100, "y": 1200, "z": 0}],
        "focus": "Menta",
        "focusCell": {"minX": 900, "minY": 900, "maxX": 1199, "maxY": 1199},
        "focusChunk": {"minX": 1100, "minY": 1200, "maxX": 1109, "maxY": 1209},
    })

    assert content.startswith(b"\x89PNG\r\n\x1a\n")
    with Image.open(io.BytesIO(content)) as image:
        assert image.format == "PNG"
        assert image.size == (1000, 700)
