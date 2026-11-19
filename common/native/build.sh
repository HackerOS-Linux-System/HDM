#!/usr/bin/env sh
# Buduje libhdmshim.a (statyczne) -> native/build/bit/ (to widzi `bit` przez native-lib-path).
# `bit` podaje linkerowi tylko LIBRARY_PATH, więc libhdmshim.a w native/build/bit to skrypt linkera GROUP
# wskazujący archiwum rdzeniowe (-fPIC) i -lcrypt.
#   CC / AR   kompilator / archiwizator (domyślnie cc / ar)
set -eu
cd "$(dirname "$0")"
OUT=build
mkdir -p "$OUT/bit"
CC="${CC:-cc}"; AR="${AR:-ar}"
CFLAGS="${CFLAGS:--O2 -fPIC -Wall -Wextra -Wno-unused-parameter}"
echo "[hdm] libhdmshim.a"
# shellcheck disable=SC2086
$CC $CFLAGS -c hdm_shim.c -o "$OUT/hdm_shim.o"
$AR rcs "$OUT/libhdmshim_core.a" "$OUT/hdm_shim.o"
B="$(cd "$OUT/bit" && pwd)"
cp -f "$OUT/libhdmshim_core.a" "$B/libhdmshim_core.a"
# libcrypt: domyślnie DYNAMICZNY (-lcrypt). Systemowe libcrypt.a z dystrybucji zwykle NIE jest -fPIC, a `bit`
# linkuje najpierw bibliotekę współdzieloną (hlib) — statyczne libcrypt.a kończyło się błędem
# "relocation R_X86_64_PC32 ... recompile with -fPIC". Statyczne libcrypt tylko na życzenie i tylko
# jeśli masz wersję PIC:  HDM_STATIC_CRYPT=/ścieżka/do/libcrypt.a sh native/build.sh
CRYPT="-lcrypt"
if [ -n "${HDM_STATIC_CRYPT:-}" ] && [ -f "$HDM_STATIC_CRYPT" ]; then
    cp -f "$HDM_STATIC_CRYPT" "$B/libcrypt_pic.a"; CRYPT="$B/libcrypt_pic.a"
fi
echo "GROUP ( $B/libhdmshim_core.a $CRYPT )" > "$B/libhdmshim.a"
echo "[hdm] native/build/bit/libhdmshim.a gotowe"
