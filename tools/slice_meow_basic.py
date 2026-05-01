#!/usr/bin/env python3
"""
Slice assets/meow/basic.png (2 rows × 4 cols transparent sprite sheet).

Row 1: 抓挠 SCRATCH × 4（美术变体）
Row 2: 闪躲 DODGE × 4（美术变体）

Run from repo root:
  python3 tools/slice_meow_basic.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    try:
        from PIL import Image
    except ImportError:
        print("Requires Pillow: pip install Pillow", file=sys.stderr)
        return 1

    root = Path(__file__).resolve().parents[1]
    src = root / "assets" / "meow" / "basic.png"
    out_dir = root / "assets" / "meow" / "cards_basic"
    manifest_path = root / "assets" / "meow" / "basic_manifest.json"

    if not src.is_file():
        print(f"Missing source: {src}", file=sys.stderr)
        return 1

    im = Image.open(src).convert("RGBA")
    w, h = im.size
    cols, rows = 4, 2
    if w % cols != 0 or h % rows != 0:
        print(f"Unexpected size {w}x{h}: expected divisible by {cols}x{rows}", file=sys.stderr)
        return 1

    cw, ch = w // cols, h // rows
    out_dir.mkdir(parents=True, exist_ok=True)

    # 文件名：语义序号；同一牌名多实例共用随机池时可任选其一或轮换
    scratch_art = [
        ("basic_scratch_art01_tabby", "抓挠·狸花虎斑扑击"),
        ("basic_scratch_art02_black", "抓挠·黑猫扑击"),
        ("basic_scratch_art03_orange", "抓挠·橘猫扑击"),
        ("basic_scratch_art04_calico", "抓挠·三花扑击"),
    ]
    dodge_art = [
        ("basic_dodge_art01_siamese", "闪躲·暹罗警戒"),
        ("basic_dodge_art02_white", "闪躲·白猫"),
        ("basic_dodge_art03_longhair", "闪躲·长毛"),
        ("basic_dodge_art04_grey", "闪躲·灰猫"),
    ]

    crops: list[dict] = []

    for cx in range(cols):
        left = cx * cw
        right = left + cw
        name, zh = scratch_art[cx]
        box = (left, 0, right, ch)
        im.crop(box).save(out_dir / f"{name}.png")
        crops.append({"file": f"assets/meow/cards_basic/{name}.png", "box": list(box), "kind": "scratch", "label_zh": zh})

    for cx in range(cols):
        left = cx * cw
        right = left + cw
        name, zh = dodge_art[cx]
        box = (left, ch, right, h)
        im.crop(box).save(out_dir / f"{name}.png")
        crops.append({"file": f"assets/meow/cards_basic/{name}.png", "box": list(box), "kind": "dodge", "label_zh": zh})

    payload = {
        "source": str(src.relative_to(root)),
        "size": [w, h],
        "grid": {"cols": cols, "rows": rows, "cell": [cw, ch]},
        "notes": [
            "游戏中「抓挠」「闪躲」各数十张，牌效相同；此处为美术变体，可做随机牌面或轮换。",
        ],
        "crops": crops,
    }
    manifest_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Wrote {len(crops)} PNGs -> {out_dir.relative_to(root)}")
    print(f"Manifest: {manifest_path.relative_to(root)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
