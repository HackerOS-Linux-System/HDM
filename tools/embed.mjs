#!/usr/bin/env node
// Wbudowuje zbudowany frontend (index.html + dist/**) w binarkę greetera: generuje src/assets_gen.h#
// w TYM SAMYM formacie co `silver embed` (app::register_asset(ścieżka, base64)), ale bez potrzeby posiadania
// CLI `silver` — wystarczy Node (który i tak buduje frontend). Wołane z hooka pre-build w greeter/Bit.hk.
//
//   node ../tools/embed.mjs [--dir frontend] [--out src/assets_gen.h#] [--quiet]     (z katalogu greeter/)
//
// Osadzamy WYNIK (dist/), nie źródła ani czcionki źródłowe (fonts/ — kopie trafiają do dist/fonts/).
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const dir = opt('--dir', 'frontend');
const out = opt('--out', 'src/assets_gen.h#');
const quiet = args.includes('--quiet') || args.includes('-q');

// projekt bez assets_gen.h# nie włączył wbudowywania — pomiń po cichu (np. hook pre-build)
if (quiet && !existsSync(out)) process.exit(0);
if (!existsSync(join(dir, 'dist', 'app.js'))) {
  if (quiet) process.exit(0);
  console.error(`błąd: brak ${dir}/dist/app.js — najpierw zbuduj frontend (cd ${dir} && npm run build)`);
  process.exit(1);
}

function walk(d) {
  const res = [];
  for (const name of readdirSync(d).sort()) {
    const p = join(d, name);
    if (name.endsWith('.map') || name === '.DS_Store') continue;
    if (statSync(p).isDirectory()) res.push(...walk(p));
    else res.push(p);
  }
  return res;
}

const files = [join(dir, 'index.html'), ...walk(join(dir, 'dist'))];
let body = '';
let total = 0;
for (const f of files) {
  const rel = relative('.', f).split(sep).join('/');
  const b64 = readFileSync(f).toString('base64');
  body += `    app::register_asset("${rel}", "${b64}")\n`;
  total += b64.length;
}

const header =
  ';; GENEROWANY przez tools/embed.mjs (format jak `silver embed`) — nie edytuj ręcznie.\n' +
  `;; Źródło: ${dir}/ (${files.length} plików). Wołaj assets_gen::install() na początku main().\n` +
  'use "bit -> silver" from "silver"\n\n';
const text = header + 'pub fn install() -> int is\n' + body + '    return app::embedded_count()\nend\n';

mkdirSync(dirname(out), { recursive: true });
if (existsSync(out) && readFileSync(out, 'utf8') === text) {
  if (!quiet) console.log(`[hdm] embed: bez zmian (${files.length} plików)`);
} else {
  writeFileSync(out, text);
  if (!quiet) console.log(`[hdm] embed: ${files.length} plików z ${dir}/ → ${out} (${Math.round(total / 1024)} KiB base64)`);
}
