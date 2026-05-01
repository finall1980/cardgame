#!/usr/bin/env python3
"""
Slice assets/meow/all.png into individual PNGs using beige gutter detection + calibrated regions.

Run from repo root:
  python3 tools/slice_meow_sheet.py
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
    src = root / "assets" / "meow" / "all.png"
    out_dir = root / "assets" / "meow" / "cards"
    manifest_path = root / "assets" / "meow" / "sheet_manifest.json"

    if not src.is_file():
        print(f"Missing source: {src}", file=sys.stderr)
        return 1

    out_dir.mkdir(parents=True, exist_ok=True)
    im = Image.open(src).convert("RGBA")

    crops: list[dict] = []

    def save_crop(name: str, box: tuple[int, int, int, int], notes: str = "") -> None:
        left, top, right, bottom = box
        cropped = im.crop(box)
        path = out_dir / f"{name}.png"
        cropped.save(path)
        crops.append(
            {
                "file": str(path.relative_to(root)),
                "box": [left, top, right, bottom],
                "size": [right - left, bottom - top],
                "notes": notes,
            }
        )

    # --- 9-column rows (same x splits as band A): gutters from density scan ---
    xs9 = [
        (10, 182),
        (196, 348),
        (372, 525),
        (532, 680),
        (686, 836),
        (843, 994),
        (1001, 1156),
        (1178, 1340),
        (1352, 1514),
    ]

    # Row 1 (基础 + 喵叫左段 + 装备右上两格占位): y 32–191
    row1_names = [
        "card_scratch",
        "card_dodge",
        "card_meow_fish",
        "card_meow_teaser",
        "card_meow_bristle",
        "card_meow_sprint",
        "card_meow_bite",
        "card_equip_yarn_ball",
        "card_equip_cat_tree",
    ]
    for i, ((x0, x1), name) in enumerate(zip(xs9, row1_names)):
        save_crop(name, (x0, 32, x1 + 1, 192), "deck row 1; names follow artwork left→right")

    # Row 2 (装备下两格在右列；左侧 7 格用途见 manifest notes)
    row2_semantic = [
        "sheet_row2_slot01",
        "sheet_row2_slot02",
        "sheet_row2_slot03",
        "sheet_row2_slot04",
        "sheet_row2_slot05",
        "sheet_row2_slot06",
        "sheet_row2_slot07",
        "card_equip_cardboard_box",
        "card_equip_laser_pointer",
    ]
    for (x0, x1), name in zip(xs9, row2_semantic):
        note = "sheet extras / verify naming"
        if name.startswith("card_equip_"):
            note = "equipment row 2 right column (2×2 stack)"
        save_crop(name, (x0, 192, x1 + 1, 325), note)

    # --- Middle band (8 columns + right panel): y 337–518 ---
    xs8_b = [
        (23, 154),
        (158, 281),
        (289, 409),
        (418, 538),
        (547, 667),
        (674, 825),
        (832, 985),
        (998, 1146),
    ]
    for idx, (x0, x1) in enumerate(xs8_b):
        save_crop(f"sheet_mid_band_a{idx + 1:02d}", (x0, 337, x1 + 1, 519), "between deck block and breed row; verify purpose")

    save_crop("sheet_mid_band_right_panel", (1179, 337, 1515, 519), "right strip mid sheet")

    # --- Cat breeds (8): y 520–718 ---
    xs8_c = [
        (23, 148),
        (158, 280),
        (289, 408),
        (418, 538),
        (548, 666),
        (674, 822),
        (832, 985),
        (998, 1146),
    ]
    breed_names = [
        "breed_orange",
        "breed_black",
        "breed_white",
        "breed_siamese",
        "breed_british_shorthair",
        "breed_ragdoll",
        "breed_tabby",
        "breed_sphynx",
    ]
    for (x0, x1), name in zip(xs8_c, breed_names):
        save_crop(name, (x0, 520, x1 + 1, 719), "cat breed role card")

    save_crop("sheet_breed_row_right_panel", (1179, 520, 1515, 719), "promo / logo strip beside breeds")

    # --- Bottom rows: identities + wide panel ---
    wide5_d = [(23, 275), (290, 548), (561, 831), (844, 1094), (1127, 1506)]
    id_names = [
        "identity_house_cat",
        "identity_companion_cat",
        "identity_wild_cat",
        "identity_lone_cat",
        "sheet_bottom_banner_wide",
    ]
    for (x0, x1), name in zip(wide5_d, id_names):
        save_crop(name, (x0, 720, x1 + 1, 864), "bottom band D")

    wide5_e = [(23, 275), (290, 548), (561, 831), (844, 1094), (1127, 1518)]
    e_names = [
        "sheet_footer_slot_a",
        "sheet_footer_slot_b",
        "sheet_footer_slot_c",
        "sheet_footer_slot_d",
        "sheet_footer_banner_wide",
    ]
    for (x0, x1), name in zip(wide5_e, e_names):
        save_crop(name, (x0, 865, x1 + 1, 1024), "bottom band E (may contain logo + group art)")

    payload = {
        "source": str(src.relative_to(root)),
        "size": [im.width, im.height],
        "generated_by": "tools/slice_meow_sheet.py",
        "notes": [
            "切片依据米色竖缝/横缝自动校准；9 列与 8 列两套横向网格并存。",
            "sheet_row2_slot01–07 若与设计不符，可在编辑器中对照原图改名或合并。",
            "游戏中 90 张牌共用语义牌面：每种牌名对应一张美术；此处导出的是展示用大图素材。",
        ],
        "crops": crops,
    }
    manifest_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {len(crops)} PNGs under {out_dir.relative_to(root)}")
    print(f"Manifest: {manifest_path.relative_to(root)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
