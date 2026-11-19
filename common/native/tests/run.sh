#!/usr/bin/env sh
# Test warstwy natywnej: kompilacja (-Wall -Wextra) + selftest (JSON, SHA-256, crypt, gniazda, procesy).
set -eu
cd "$(dirname "$0")/.."
CC="${CC:-cc}"
mkdir -p build
$CC -O1 -g -Wall -Wextra -Wno-unused-parameter -o build/selftest tests/selftest.c hdm_shim.c -lcrypt
HASH=""; PW="test-haslo-123"
if command -v openssl >/dev/null 2>&1; then HASH="$(openssl passwd -6 "$PW")"; fi
if [ -n "$HASH" ]; then ./build/selftest "$HASH" "$PW"; else ./build/selftest; fi
