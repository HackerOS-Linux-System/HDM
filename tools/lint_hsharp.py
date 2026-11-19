#!/usr/bin/env python3
"""Prosty linter składni H# (bez kompilatora): bilans bloków is/end, nawiasy, cudzysłowy, klamry w literałach.

Nie zastępuje `h# check` — łapie tylko oczywiste błędy (zapomniane `end`, niezamknięty napis, pojedyncza
klamra w literale, która H# wziąłby za interpolację). Użycie: python3 tools/lint_hsharp.py [pliki/katalogi]
"""
import re, sys, pathlib

def strip_line(line):
    """Zwraca (kod_bez_napisow_i_komentarza, lista_napisow, błąd)."""
    out, strs, i, n = [], [], 0, len(line)
    while i < n:
        c = line[i]
        if c == ';' and i + 1 < n and line[i+1] == ';':
            break
        if c == '"':
            j, buf = i + 1, []
            while j < n and line[j] != '"':
                if line[j] == '\\' and j + 1 < n:
                    buf.append(line[j:j+2]); j += 2; continue
                buf.append(line[j]); j += 1
            if j >= n:
                return ''.join(out), strs, "niezamknięty napis"
            strs.append(''.join(buf)); out.append('""'); i = j + 1; continue
        out.append(c); i += 1
    return ''.join(out), strs, None

def check_literal(s):
    """Klamry w literale muszą być podwojone ({{ i }})."""
    t = s.replace('{{', '').replace('}}', '')
    return '{' not in t and '}' not in t

def lint(path):
    errs, depth, stack = [], 0, []
    in_extern = False
    for ln, raw in enumerate(path.read_text(encoding='utf-8').split('\n'), 1):
        code, strs, err = strip_line(raw)
        if err: errs.append(f"{path}:{ln}: {err}")
        for s in strs:
            if not check_literal(s): errs.append(f"{path}:{ln}: pojedyncza klamra w literale: {s[:40]!r}")
        if code.strip().startswith(';;'): continue
        words = re.findall(r"[A-Za-z_]+", code)
        opens = sum(1 for w in words if w == 'is')
        branch = sum(1 for w in words if w in ('elsif',)) + len(re.findall(r"\belse\s+is\b", code))
        closes = sum(1 for w in words if w == 'end')
        # `x then a else b` nie ma `is`; `else is` / `elsif ... is` nie zmieniają głębokości
        delta = opens - branch - closes
        depth += delta
        if depth < 0:
            errs.append(f"{path}:{ln}: nadmiarowe `end`"); depth = 0
    if depth != 0: errs.append(f"{path}: niezbilansowane bloki is/end (głębokość {depth})")
    return errs

files = []
for a in (sys.argv[1:] or ['.']):
    p = pathlib.Path(a)
    files += [p] if p.is_file() else sorted(q for q in p.rglob('*.h#') if 'node_modules' not in q.parts)
bad = 0
for f in files:
    for e in lint(f): print(e); bad += 1
print(f"{len(files)} plików, {bad} problemów")
sys.exit(1 if bad else 0)
