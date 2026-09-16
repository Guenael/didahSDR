#!/usr/bin/env python3
"""
scripts/convert_palette.py

Utility to convert SpectrumLab / Windows .pal color palettes and Matplotlib
colormaps into JavaScript lookup tables for didahSDR (app/js/colormaps.js).

Supported Formats:
1. SpectrumLab .pal files (Color0=00BBGGRR format, 256 entries).
2. Matplotlib colormap names (e.g. GnBu, PuBu, YlGnBu, etc.). cmocean ("cmo.thermal") and
   colorcet ("cet_kbc") names work too when those packages are installed.

Example (regenerate the extra palettes appended to colormaps.js):
  uv run --with matplotlib,numpy,cmocean,colorcet python scripts/convert_palette.py \
      --matplotlib inferno=Inferno cmo.thermal=Thermal cet_kbc=CET-KBC

Output:
JavaScript definitions containing:
- label: Human-readable label
- packed: Uint32Array(256) of packed 32-bit ABGR values (0xFFBBGGRR) for direct WebGL upload.
  (RGB triplets are derived from `packed` at runtime by Colormaps.getRgb.)
"""

import argparse
import re
import sys
from pathlib import Path


def parse_pal_file(filepath: str | Path) -> tuple[list[list[int]], list[int]]:
    """
    Parses a SpectrumLab .pal file.
    Format:
      [Colors]
      Color0=00BBGGRR
      ...
      Color255=00BBGGRR

    Returns (rgb_list, packed_list).
    """
    path = Path(filepath)
    if not path.is_file():
        raise FileNotFoundError(f"Palette file not found: {filepath}")

    color_pattern = re.compile(r"^Color(\d+)\s*=\s*([0-9a-fA-F]{8})", re.IGNORECASE)
    entries = {}

    with open(path, "r", encoding="latin-1") as f:
        for line in f:
            line = line.strip()
            m = color_pattern.match(line)
            if m:
                idx = int(m.group(1))
                hex_str = m.group(2)
                entries[idx] = hex_str

    if len(entries) < 256:
        raise ValueError(f"Expected 256 color entries in {filepath}, found {len(entries)}")

    rgb_list = []
    packed_list = []

    for i in range(256):
        hex_val = entries[i]
        # Format is 00 BB GG RR
        bb = int(hex_val[2:4], 16)
        gg = int(hex_val[4:6], 16)
        rr = int(hex_val[6:8], 16)

        rgb_list.append([rr, gg, bb])

        # ABGR 32-bit: Alpha=0xFF in highest byte, Blue, Green, Red
        packed = (0xFF << 24) | (bb << 16) | (gg << 8) | rr
        packed_list.append(packed)

    return rgb_list, packed_list


def get_matplotlib_colormap(name: str, reverse: bool = False) -> tuple[list[list[int]], list[int]]:
    """
    Extracts a 256-entry colormap from Matplotlib.
    Returns (rgb_list, packed_list).
    """
    try:
        import matplotlib as mpl
        import numpy as np

        # Optional: importing these registers "cmo.*" and "cet_*" colormaps with matplotlib
        for extra in ("cmocean", "colorcet"):
            try:
                __import__(extra)
            except ImportError:
                pass
    except ImportError:
        sys.stderr.write("Error: matplotlib and numpy are required to extract matplotlib colormaps.\n")
        sys.stderr.write("Run with: uv run --with matplotlib,numpy python scripts/convert_palette.py ...\n")
        sys.exit(1)

    cmap_name = f"{name}_r" if reverse else name
    try:
        cmap = mpl.colormaps.get_cmap(cmap_name)
    except KeyError:
        raise ValueError(f"Colormap '{cmap_name}' not found in matplotlib")

    samples = np.linspace(0.0, 1.0, 256)
    rgba = cmap(samples)
    rgb_255 = (rgba[:, :3] * 255.0).round().astype(int)

    rgb_list = []
    packed_list = []

    for i in range(256):
        rr = int(rgb_255[i, 0])
        gg = int(rgb_255[i, 1])
        bb = int(rgb_255[i, 2])
        rgb_list.append([rr, gg, bb])

        packed = (0xFF << 24) | (bb << 16) | (gg << 8) | rr
        packed_list.append(packed)

    return rgb_list, packed_list


def generate_js_snippet(key: str, label: str, rgb_list: list[list[int]], packed_list: list[int]) -> str:
    """Generates the JavaScript object assignment for Colormaps definitions in colormaps.js."""
    packed_json = "new Uint32Array([" + ", ".join(str(p) for p in packed_list) + "])"

    return f"""    definitions["{key}"] = {{
        label: "{label}",
        packed: {packed_json}
    }};"""


def main():
    parser = argparse.ArgumentParser(description="Convert .pal files or Matplotlib colormaps to didahSDR JS format")
    parser.add_argument("pal_file", nargs="?", help="Path to .pal file")
    parser.add_argument("--key", help="Identifier key for JS definition (e.g. 'didahSDR')")
    parser.add_argument("--label", help="Display label (e.g. 'DidahSDR')")
    parser.add_argument(
        "--matplotlib", nargs="+", help="Matplotlib colormap names to convert, optionally 'name=Label' (key = name)"
    )
    parser.add_argument(
        "--include-reversed", action="store_true", help="Also generate reversed versions for matplotlib"
    )
    parser.add_argument("--output", "-o", help="Output file (default: stdout)")

    args = parser.parse_args()

    snippets = []

    if args.pal_file:
        key = args.key or Path(args.pal_file).stem.lstrip("_").lower()
        label = args.label or key.capitalize()
        rgb, packed = parse_pal_file(args.pal_file)
        snippets.append(generate_js_snippet(key, label, rgb, packed))

    if args.matplotlib:
        for spec in args.matplotlib:
            name, _, label = spec.partition("=")
            label = label or name
            rgb, packed = get_matplotlib_colormap(name, reverse=False)
            snippets.append(generate_js_snippet(name, label, rgb, packed))

            if args.include_reversed:
                rev_key = f"{name}.reversed()"
                rev_label = f"{name} (Reversed)"
                rgb_r, packed_r = get_matplotlib_colormap(name, reverse=True)
                snippets.append(generate_js_snippet(rev_key, rev_label, rgb_r, packed_r))

    if not snippets:
        parser.print_help()
        sys.exit(1)

    result = "\n".join(snippets)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(result + "\n")
        print(f"Written to {args.output}")
    else:
        print(result)


if __name__ == "__main__":
    main()
