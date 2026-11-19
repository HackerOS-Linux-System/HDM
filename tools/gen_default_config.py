#!/usr/bin/env python3
"""Generuje daemon/src/default_config.h# z config/hdm.hk (kanoniczne źródło domyślnej konfiguracji).

Uruchom po każdej zmianie config/hdm.hk:   python3 tools/gen_default_config.py
Test `test_packaged_config_matches_default_config` pilnuje, żeby oba pozostały zgodne.
"""
import pathlib, re, sys

root = pathlib.Path(__file__).resolve().parent.parent
src = (root / "config" / "hdm.hk").read_text(encoding="utf-8")
out = root / "daemon" / "src" / "default_config.h#"

ASCII = {"—": "-", "–": "-", "→": "->", "’": "'", "“": '"', "”": '"', "…": "...", "ł": "l", "ą": "a"}

def lit(line: str) -> str:
    for k, v in ASCII.items():
        line = line.replace(k, v)
    line = line.encode("ascii", "replace").decode("ascii")
    line = line.replace("\\", "\\\\").replace('"', '\\"').replace("{", "{{").replace("}", "}}")
    return line

lines = src.rstrip("\n").split("\n")
body = []
for ln in lines:
    body.append('    out = out + "%s\\n"' % lit(ln))

text = (
    ";; GENEROWANY przez tools/gen_default_config.py z config/hdm.hk — nie edytuj ręcznie.\n"
    ";; Tekst zapisywany do /etc/hdm/hdm.hk, gdy plik nie istnieje (config::ensure_default_config).\n\n"
    "pub fn text() -> string is\n"
    '    let mut out: string = ""\n' + "\n".join(body) + "\n    return out\nend\n"
)
out.write_text(text, encoding="utf-8")
print("zapisano", out, len(lines), "linii")
