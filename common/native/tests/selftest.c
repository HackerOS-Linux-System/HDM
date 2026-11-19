#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include "../hdm_shim.h"

static int fails = 0;
#define CHECK(c) do { if (!(c)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #c); fails++; } } while (0)
#define STREQ(a, b) do { const char *_a = (a), *_b = (b); if (strcmp(_a, _b)) { printf("FAIL %s:%d  \"%s\" != \"%s\"\n", __FILE__, __LINE__, _a, _b); fails++; } } while (0)

int main(int argc, char **argv) {
    /* --- JSON --- */
    STREQ(hdm_json_escape("a\"b\\c\n\x01"), "a\\\"b\\\\c\\n\\u0001");
    const char *req = "{\"cmd\":\"authenticate\",\"username\":\"al\\\"ice\",\"password\":\"p\\u0105ss\\\\\",\"n\":42,\"ok\":true,\"pattern\":[0,1, 2,4],\"nested\":{\"cmd\":\"x\"}}";
    STREQ(hdm_json_get_str(req, "cmd"), "authenticate");
    STREQ(hdm_json_get_str(req, "username"), "al\"ice");
    STREQ(hdm_json_get_str(req, "password"), "p\xc4\x85ss\\");
    CHECK(hdm_json_get_int(req, "n", -1) == 42);
    CHECK(hdm_json_get_int(req, "missing", -7) == -7);
    CHECK(hdm_json_get_bool(req, "ok", 0) == 1);
    STREQ(hdm_json_get_int_array(req, "pattern"), "0,1,2,4");
    STREQ(hdm_json_get_str(req, "nope"), "");
    STREQ(hdm_json_get_str("{\"e\":\"\\ud83d\\ude00\"}", "e"), "\xf0\x9f\x98\x80");
    STREQ(hdm_json_get_str("{\"a\":{\"cmd\":\"inner\"},\"cmd\":\"outer\"}", "cmd"), "outer");   /* tylko najwyższy poziom */

    /* --- SHA-256 --- */
    STREQ(hdm_sha256_hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    STREQ(hdm_sha256_hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    /* hash wzorca == sha256("alice:" + bajty 0,1,2,4) */
    {
        const char *p = hdm_pattern_hash("alice", "0,1,2,4");
        CHECK(strlen(p) == 64);
        char a[65]; strcpy(a, p);
        STREQ(hdm_pattern_hash("alice", "0,1,2,4"), a);
        CHECK(strcmp(hdm_pattern_hash("bob", "0,1,2,4"), a) != 0);
        CHECK(strcmp(hdm_pattern_hash("alice", "0,1,3,4"), a) != 0);
    }

    /* --- crypt: hash podany w argv[1], hasło w argv[2] (opcjonalnie) --- */
    if (argc >= 3) {
        CHECK(hdm_crypt_verify(argv[2], argv[1]) == 1);
        CHECK(hdm_crypt_verify("zle-haslo", argv[1]) == 0);
    }
    CHECK(hdm_crypt_verify("x", "") == 0);

    /* --- gniazda + procesy --- */
    const char *path = "/tmp/hdm-selftest.sock";
    long ls = hdm_listen_unix(path, 0666);
    CHECK(ls >= 0);
    long cl = hdm_connect_unix(path);
    CHECK(cl >= 0);
    long sv = hdm_accept(ls);
    CHECK(sv >= 0);
    CHECK(hdm_send(cl, "{\"cmd\":\"get_info\"}\n{\"cmd\":\"par") == 1);
    STREQ(hdm_poll("", 10), "");
    char fds[32]; snprintf(fds, sizeof fds, "%ld", sv);
    STREQ(hdm_poll(fds, 500), fds);
    CHECK(hdm_fill(sv) > 0);
    STREQ(hdm_next_line(sv), "{\"cmd\":\"get_info\"}");
    STREQ(hdm_next_line(sv), "");                          /* druga linia jeszcze niekompletna */
    hdm_send(cl, "tial\"}\r\n");
    CHECK(hdm_fill(sv) > 0);
    STREQ(hdm_next_line(sv), "{\"cmd\":\"partial\"}");     /* złożona + obcięte \r */
    STREQ(hdm_read_line(cl, 50), "");                      /* timeout */
    CHECK(hdm_io_status() == 1);
    hdm_send(sv, "pong\n");
    STREQ(hdm_read_line(cl, 1000), "pong");
    hdm_close(cl);
    CHECK(hdm_poll(fds, 500)[0] != 0);                     /* HUP/EOF gotowe do odczytu */
    CHECK(hdm_fill(sv) < 0);
    hdm_close(sv); hdm_close(ls); unlink(path);

    long pid = hdm_spawn("sh\n-c\necho $FOO; exit 7", "FOO=bar\nPATH=/usr/bin:/bin", "/", "", 0, 0);
    CHECK(pid > 0);
    long st = -1;
    for (int i = 0; i < 200 && st == -1; i++) { st = hdm_child_poll(pid); if (st == -1) hdm_sleep_ms(10); }
    CHECK(st == 7);
    CHECK(hdm_spawn("/nonexistent/binary", "", "/", "", 0, 0) == -1);
    CHECK(hdm_spawn_error() == 100 + 2);                   /* ENOENT */
    long p2 = hdm_spawn("sleep\n30", "PATH=/usr/bin:/bin", "/", "", 0, 0);
    CHECK(p2 > 0 && hdm_child_poll(p2) == -1);
    /* nadzór pamięci: własny proces ma niezerowe RSS (z potomkami), nieistniejący PID = 0 */
    CHECK(hdm_tree_rss_mb((int64_t)getpid()) > 0);
    CHECK(hdm_tree_rss_mb(2147483646) == 0);
    hdm_kill(p2, 15);
    st = -1; for (int i = 0; i < 200 && st == -1; i++) { st = hdm_child_poll(p2); if (st == -1) hdm_sleep_ms(10); }
    CHECK(st == 128 + 15);
    CHECK(hdm_spawn_detached("exit 0") == 1);
    CHECK(strlen(hdm_uuid4()) == 36);
    CHECK(hdm_mkdir_p("/tmp/hdm-selftest-dir/a/b", 0700) == 1);
    rmdir("/tmp/hdm-selftest-dir/a/b"); rmdir("/tmp/hdm-selftest-dir/a"); rmdir("/tmp/hdm-selftest-dir");

    if (fails) { printf("%d testów NIE przeszło\n", fails); return 1; }
    printf("OK: warstwa natywna HDM — wszystkie testy przeszły\n");
    return 0;
}
