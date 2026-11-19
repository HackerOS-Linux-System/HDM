#!/usr/bin/env python3
"""Scala podzbiory latin + latin-ext czcionek @fontsource do jednego pliku TTF na krój.

Silver wybiera krój po rodzinie i grubości (regular/bold) i ignoruje `unicode-range`, więc dwa
@font-face dla tej samej grubości (latin i latin-ext) by się nadpisywały i polskie znaki (ą ć ę ł ń ó ś ź ż)
znikałyby. Jeden scalony plik na krój rozwiązuje to. Wynik trafia do greeter/frontend/fonts/ (w repo).

Użycie (z greeter/frontend po `npm install`):   python3 ../../tools/merge_fonts.py
Wymaga: pip install fonttools brotli
"""
import pathlib, subprocess, sys, tempfile
from fontTools.ttLib import TTFont

fe = pathlib.Path(__file__).resolve().parent.parent / "greeter" / "frontend"
src = fe / "node_modules" / "@fontsource"
out = fe / "fonts"
out.mkdir(exist_ok=True)

FAMILIES = {"oxanium": "Oxanium", "dm-sans": "DM-Sans", "jetbrains-mono": "JetBrains-Mono"}
WEIGHTS = ["400", "700"]
SUBSETS = ["latin", "latin-ext"]

for pkg, nice in FAMILIES.items():
    for w in WEIGHTS:
        parts = []
        for sub in SUBSETS:
            f = src / pkg / "files" / f"{pkg}-{sub}-{w}-normal.woff2"
            if not f.exists():
                sys.exit(f"brak {f} — uruchom najpierw `npm install`")
            t = TTFont(f)
            t.flavor = None
            tmp = pathlib.Path(tempfile.mkdtemp()) / f"{pkg}-{sub}-{w}.ttf"
            t.save(tmp)
            parts.append(str(tmp))
        merged = out / f"{nice}-{w}.ttf"
        subprocess.run([sys.executable, "-m", "fontTools.merge", f"--output-file={merged}", *parts], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        f = TTFont(merged)
        cmap = f.getBestCmap()
        need = [ord(c) for c in "AaŁłąćęńóśźżĄĆĘŃÓŚŹŻ"]
        miss = [chr(c) for c in need if c not in cmap]
        print(f"{merged.name}: {merged.stat().st_size // 1024} KiB, glifów {len(f.getGlyphOrder())}, brak: {''.join(miss) or '-'}")
