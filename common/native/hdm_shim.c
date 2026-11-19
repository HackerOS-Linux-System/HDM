#define _GNU_SOURCE
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <signal.h>
#include <time.h>
#include <poll.h>
#include <pwd.h>
#include <dirent.h>
#include <grp.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/ioctl.h>
#include <crypt.h>

typedef int64_t hint;

/* ---------- bufor wyniku (rosnący) ---------- */
typedef struct { char *p; size_t cap; } Ret;
static const char *ret_set(Ret *r, const char *s, size_t n) {
    if (n + 1 > r->cap) {
        size_t nc = r->cap ? r->cap : 256;
        while (nc < n + 1) nc *= 2;
        char *np = realloc(r->p, nc);
        if (!np) return "";
        r->p = np; r->cap = nc;
    }
    memcpy(r->p, s, n); r->p[n] = 0;
    return r->p;
}

/* ============================================================================
 *  JSON
 * ========================================================================== */
static Ret r_esc, r_gs, r_arr;

const char *hdm_json_escape(const char *s) {
    if (!s) s = "";
    size_t n = strlen(s);
    char *o = malloc(n * 6 + 1);
    if (!o) return "";
    size_t w = 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        switch (c) {
        case '"':  o[w++] = '\\'; o[w++] = '"'; break;
        case '\\': o[w++] = '\\'; o[w++] = '\\'; break;
        case '\n': o[w++] = '\\'; o[w++] = 'n'; break;
        case '\r': o[w++] = '\\'; o[w++] = 'r'; break;
        case '\t': o[w++] = '\\'; o[w++] = 't'; break;
        default:
            if (c < 0x20) w += (size_t)sprintf(o + w, "\\u%04x", c);
            else o[w++] = (char)c;
        }
    }
    o[w] = 0;
    const char *r = ret_set(&r_esc, o, w);
    free(o);
    return r;
}

static const char *skip_ws(const char *p) { while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++; return p; }

/* Pomija wartość JSON zaczynającą się w p; zwraca wskaźnik za nią (lub NULL przy błędzie). */
static const char *skip_value(const char *p) {
    p = skip_ws(p);
    if (*p == '"') {
        p++;
        while (*p && *p != '"') { if (*p == '\\' && p[1]) p++; p++; }
        return *p == '"' ? p + 1 : NULL;
    }
    if (*p == '{' || *p == '[') {
        char open = *p, close = open == '{' ? '}' : ']';
        int depth = 0;
        while (*p) {
            if (*p == '"') { p = skip_value(p); if (!p) return NULL; continue; }
            if (*p == open) depth++;
            else if (*p == close) { depth--; if (depth == 0) return p + 1; }
            p++;
        }
        return NULL;
    }
    while (*p && *p != ',' && *p != '}' && *p != ']' && *p != ' ' && *p != '\n' && *p != '\r' && *p != '\t') p++;
    return p;
}

/* Szuka klucza na najwyższym poziomie obiektu. Zwraca wskaźnik na początek wartości. */
static const char *find_key(const char *json, const char *key) {
    if (!json || !key) return NULL;
    const char *p = skip_ws(json);
    if (*p != '{') return NULL;
    p++;
    size_t kl = strlen(key);
    for (;;) {
        p = skip_ws(p);
        if (*p == '}' || !*p) return NULL;
        if (*p == ',') { p++; continue; }
        if (*p != '"') return NULL;
        const char *ks = p + 1;
        const char *ke = skip_value(p);
        if (!ke) return NULL;
        const char *kend = ke - 1;                 /* wskazuje na zamykający " */
        p = skip_ws(ke);
        if (*p != ':') return NULL;
        p = skip_ws(p + 1);
        /* klucze porównujemy bez dekodowania escape'ów (nasze klucze są ASCII) */
        if ((size_t)(kend - ks) == kl && memcmp(ks, key, kl) == 0) return p;
        p = skip_value(p);
        if (!p) return NULL;
    }
}

static int hexv(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}
static size_t put_utf8(char *o, unsigned cp) {
    if (cp < 0x80) { o[0] = (char)cp; return 1; }
    if (cp < 0x800) { o[0] = (char)(0xC0 | (cp >> 6)); o[1] = (char)(0x80 | (cp & 63)); return 2; }
    if (cp < 0x10000) { o[0] = (char)(0xE0 | (cp >> 12)); o[1] = (char)(0x80 | ((cp >> 6) & 63)); o[2] = (char)(0x80 | (cp & 63)); return 3; }
    o[0] = (char)(0xF0 | (cp >> 18)); o[1] = (char)(0x80 | ((cp >> 12) & 63)); o[2] = (char)(0x80 | ((cp >> 6) & 63)); o[3] = (char)(0x80 | (cp & 63));
    return 4;
}

/* Wartość napisowa (z dekodowaniem escape'ów, w tym \uXXXX i par zastępczych); nie-napis -> surowy tekst. */
const char *hdm_json_get_str(const char *json, const char *key) {
    const char *v = find_key(json, key);
    if (!v) return "";
    if (*v != '"') {
        const char *e = skip_value(v);
        if (!e) return "";
        if (strncmp(v, "null", 4) == 0 && e - v == 4) return "";
        return ret_set(&r_gs, v, (size_t)(e - v));
    }
    const char *e = skip_value(v);
    if (!e) return "";
    size_t cap = (size_t)(e - v) + 8;
    char *o = malloc(cap);
    if (!o) return "";
    size_t w = 0;
    for (const char *p = v + 1; p < e - 1; p++) {
        if (*p != '\\') { o[w++] = *p; continue; }
        p++;
        switch (*p) {
        case 'n': o[w++] = '\n'; break;
        case 'r': o[w++] = '\r'; break;
        case 't': o[w++] = '\t'; break;
        case 'b': o[w++] = '\b'; break;
        case 'f': o[w++] = '\f'; break;
        case 'u': {
            unsigned cp = 0; int ok = 1;
            for (int i = 1; i <= 4; i++) { int h = hexv(p[i]); if (h < 0) { ok = 0; break; } cp = cp * 16 + (unsigned)h; }
            if (!ok) { o[w++] = 'u'; break; }
            p += 4;
            if (cp >= 0xD800 && cp < 0xDC00 && p[1] == '\\' && p[2] == 'u') {
                unsigned lo = 0; int ok2 = 1;
                for (int i = 3; i <= 6; i++) { int h = hexv(p[i]); if (h < 0) { ok2 = 0; break; } lo = lo * 16 + (unsigned)h; }
                if (ok2 && lo >= 0xDC00 && lo < 0xE000) { cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); p += 6; }
            }
            w += put_utf8(o + w, cp);
            break;
        }
        default: o[w++] = *p; /* \" \\ \/ */
        }
    }
    o[w] = 0;
    const char *r = ret_set(&r_gs, o, w);
    free(o);
    return r;
}

hint hdm_json_get_int(const char *json, const char *key, hint def) {
    const char *v = find_key(json, key);
    if (!v) return def;
    char *end;
    long long n = strtoll(v, &end, 10);
    return end == v ? def : (hint)n;
}

hint hdm_json_get_bool(const char *json, const char *key, hint def) {
    const char *v = find_key(json, key);
    if (!v) return def;
    if (strncmp(v, "true", 4) == 0) return 1;
    if (strncmp(v, "false", 5) == 0) return 0;
    return def;
}

/* Tablica liczb całkowitych -> "1,2,3" (pusty napis gdy brak/zła). */
const char *hdm_json_get_int_array(const char *json, const char *key) {
    const char *v = find_key(json, key);
    if (!v || *v != '[') return "";
    char buf[4096]; size_t w = 0;
    const char *p = v + 1;
    for (;;) {
        p = skip_ws(p);
        if (*p == ']' || !*p) break;
        if (*p == ',') { p++; continue; }
        char *end;
        long long n = strtoll(p, &end, 10);
        if (end == p) return "";
        if (w + 24 >= sizeof buf) return "";
        w += (size_t)snprintf(buf + w, sizeof buf - w, "%s%lld", w ? "," : "", n);
        p = end;
    }
    return ret_set(&r_arr, buf, w);
}

/* ============================================================================
 *  SHA-256 + hash wzorca
 * ========================================================================== */
typedef struct { uint32_t h[8]; uint64_t len; uint8_t buf[64]; size_t n; } Sha;
static const uint32_t K256[64] = {
0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
#define ROR(x,n) (((x) >> (n)) | ((x) << (32 - (n))))
static void sha_block(Sha *s, const uint8_t *b) {
    uint32_t w[64], a, bb, c, d, e, f, g, h;
    for (int i = 0; i < 16; i++) w[i] = (uint32_t)b[i*4] << 24 | (uint32_t)b[i*4+1] << 16 | (uint32_t)b[i*4+2] << 8 | b[i*4+3];
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = ROR(w[i-15],7) ^ ROR(w[i-15],18) ^ (w[i-15] >> 3);
        uint32_t s1 = ROR(w[i-2],17) ^ ROR(w[i-2],19) ^ (w[i-2] >> 10);
        w[i] = w[i-16] + s0 + w[i-7] + s1;
    }
    a = s->h[0]; bb = s->h[1]; c = s->h[2]; d = s->h[3]; e = s->h[4]; f = s->h[5]; g = s->h[6]; h = s->h[7];
    for (int i = 0; i < 64; i++) {
        uint32_t S1 = ROR(e,6) ^ ROR(e,11) ^ ROR(e,25), ch = (e & f) ^ (~e & g);
        uint32_t t1 = h + S1 + ch + K256[i] + w[i];
        uint32_t S0 = ROR(a,2) ^ ROR(a,13) ^ ROR(a,22), mj = (a & bb) ^ (a & c) ^ (bb & c);
        uint32_t t2 = S0 + mj;
        h = g; g = f; f = e; e = d + t1; d = c; c = bb; bb = a; a = t1 + t2;
    }
    s->h[0] += a; s->h[1] += bb; s->h[2] += c; s->h[3] += d; s->h[4] += e; s->h[5] += f; s->h[6] += g; s->h[7] += h;
}
static void sha_init(Sha *s) {
    static const uint32_t i0[8] = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
    memcpy(s->h, i0, sizeof i0); s->len = 0; s->n = 0;
}
static void sha_update(Sha *s, const void *data, size_t len) {
    const uint8_t *p = data;
    s->len += len;
    while (len) {
        size_t k = 64 - s->n; if (k > len) k = len;
        memcpy(s->buf + s->n, p, k); s->n += k; p += k; len -= k;
        if (s->n == 64) { sha_block(s, s->buf); s->n = 0; }
    }
}
static void sha_final(Sha *s, uint8_t out[32]) {
    uint64_t bits = s->len * 8;
    uint8_t pad = 0x80;
    sha_update(s, &pad, 1);
    uint8_t z = 0;
    while (s->n != 56) sha_update(s, &z, 1);
    uint8_t lb[8];
    for (int i = 0; i < 8; i++) lb[i] = (uint8_t)(bits >> (56 - 8 * i));
    sha_update(s, lb, 8);
    for (int i = 0; i < 8; i++) { out[i*4] = (uint8_t)(s->h[i] >> 24); out[i*4+1] = (uint8_t)(s->h[i] >> 16); out[i*4+2] = (uint8_t)(s->h[i] >> 8); out[i*4+3] = (uint8_t)s->h[i]; }
}
static Ret r_sha;
const char *hdm_sha256_hex(const char *s) {
    Sha c; uint8_t d[32]; char hex[65];
    sha_init(&c); sha_update(&c, s ? s : "", s ? strlen(s) : 0); sha_final(&c, d);
    for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", d[i]);
    return ret_set(&r_sha, hex, 64);
}
/* SHA-256( username ":" bajty wzorca ), bajty z listy "0,1,2,4" — to samo co hash_pattern() w Rust. */
const char *hdm_pattern_hash(const char *user, const char *csv) {
    Sha c; uint8_t d[32]; char hex[65];
    sha_init(&c);
    sha_update(&c, user ? user : "", user ? strlen(user) : 0);
    sha_update(&c, ":", 1);
    const char *p = csv ? csv : "";
    while (*p) {
        char *end; long v = strtol(p, &end, 10);
        if (end == p) break;
        uint8_t b = (uint8_t)v; sha_update(&c, &b, 1);
        p = *end == ',' ? end + 1 : end;
    }
    sha_final(&c, d);
    for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", d[i]);
    return ret_set(&r_sha, hex, 64);
}

/* ============================================================================
 *  crypt(3) — weryfikacja hasła względem wpisu z /etc/shadow
 * ========================================================================== */
hint hdm_crypt_verify(const char *password, const char *hash) {
    if (!password || !hash || !hash[0]) return 0;
    struct crypt_data *cd = calloc(1, sizeof *cd);
    if (!cd) return 0;
    char *res = crypt_r(password, hash, cd);
    int ok = 0;
    if (res && res[0] != '*') {
        size_t a = strlen(res), b = strlen(hash);
        unsigned char diff = (unsigned char)(a != b);
        size_t n = a < b ? a : b;
        for (size_t i = 0; i < n; i++) diff |= (unsigned char)(res[i] ^ hash[i]);   /* stały czas */
        ok = diff == 0;
    }
    explicit_bzero(cd, sizeof *cd);
    free(cd);
    return ok;
}

/* ============================================================================
 *  Sygnały, czas, różne
 * ========================================================================== */
static volatile sig_atomic_t g_term = 0;
static void on_term(int s) { (void)s; g_term = 1; }
hint hdm_install_signals(void) {
    struct sigaction sa; memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_term; sigemptyset(&sa.sa_mask);
    sigaction(SIGTERM, &sa, NULL); sigaction(SIGINT, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);
    return 0;
}
hint hdm_term_requested(void) { return g_term; }
hint hdm_getuid(void) { return (hint)getuid(); }
hint hdm_now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (hint)t.tv_sec * 1000 + t.tv_nsec / 1000000; }
hint hdm_sleep_ms(hint ms) { struct timespec t = { ms / 1000, (ms % 1000) * 1000000 }; nanosleep(&t, NULL); return 0; }
hint hdm_exit(hint code) { _exit((int)code); }

static Ret r_time;
const char *hdm_strftime(const char *fmt) {
    char b[256]; time_t t = time(NULL); struct tm tm;
    localtime_r(&t, &tm);
    size_t n = strftime(b, sizeof b, fmt, &tm);
    return ret_set(&r_time, b, n);
}
static Ret r_uuid;
const char *hdm_uuid4(void) {
    unsigned char b[16]; char s[40];
    int fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
    if (fd < 0 || read(fd, b, 16) != 16) { if (fd >= 0) close(fd); for (int i = 0; i < 16; i++) b[i] = (unsigned char)rand(); }
    else close(fd);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    snprintf(s, sizeof s, "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
             b[0],b[1],b[2],b[3],b[4],b[5],b[6],b[7],b[8],b[9],b[10],b[11],b[12],b[13],b[14],b[15]);
    return ret_set(&r_uuid, s, strlen(s));
}

/* ============================================================================
 *  Pliki / uprawnienia / VT
 * ========================================================================== */
hint hdm_chown(const char *path, hint uid, hint gid) { return chown(path, (uid_t)uid, (gid_t)gid) == 0; }
hint hdm_chmod(const char *path, hint mode) { return chmod(path, (mode_t)mode) == 0; }
hint hdm_readable(const char *path) { return access(path, R_OK) == 0; }
hint hdm_mkdir_p(const char *path, hint mode) {
    char tmp[4096];
    if (strlen(path) >= sizeof tmp) return 0;
    strcpy(tmp, path);
    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/') { *p = 0; mkdir(tmp, 0755); *p = '/'; }
    }
    if (mkdir(tmp, (mode_t)mode) != 0 && errno != EEXIST) return 0;
    return 1;
}
#define VT_ACTIVATE 0x5606
#define VT_WAITACTIVE 0x5607
/* 0 = OK, -1 = nie da się otworzyć /dev/tty0, -2 = VT_ACTIVATE padło, 1 = aktywowano, ale VT_WAITACTIVE ostrzega */
hint hdm_vt_switch(hint vt) {
    int fd = open("/dev/tty0", O_RDWR | O_CLOEXEC);
    if (fd < 0) return -1;
    int rc = 0;
    if (ioctl(fd, VT_ACTIVATE, (int)vt) != 0) rc = -2;
    else if (ioctl(fd, VT_WAITACTIVE, (int)vt) != 0) rc = 1;
    close(fd);
    return rc;
}

/* ============================================================================
 *  Gniazda Unix + bufory linii
 * ========================================================================== */
#define MAXFD 1024
static char  *g_buf[MAXFD];
static size_t g_len[MAXFD], g_cap[MAXFD];
static int    g_eof[MAXFD];
static hint   g_io_status = 0;

static void buf_reset(int fd) { if (fd >= 0 && fd < MAXFD) { free(g_buf[fd]); g_buf[fd] = NULL; g_len[fd] = g_cap[fd] = 0; g_eof[fd] = 0; } }

hint hdm_listen_unix(const char *path, hint mode) {
    struct sockaddr_un a; memset(&a, 0, sizeof a); a.sun_family = AF_UNIX;
    if (strlen(path) >= sizeof a.sun_path) return -1;
    strcpy(a.sun_path, path);
    unlink(path);
    int s = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (s < 0) return -1;
    if (bind(s, (struct sockaddr *)&a, sizeof a) != 0 || listen(s, 16) != 0) { close(s); return -1; }
    chmod(path, (mode_t)mode);
    return s;
}
hint hdm_connect_unix(const char *path) {
    struct sockaddr_un a; memset(&a, 0, sizeof a); a.sun_family = AF_UNIX;
    if (strlen(path) >= sizeof a.sun_path) return -1;
    strcpy(a.sun_path, path);
    int s = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (s < 0) return -1;
    if (connect(s, (struct sockaddr *)&a, sizeof a) != 0) { close(s); return -1; }
    buf_reset(s);
    return s;
}
hint hdm_accept(hint lfd) {
    int c = accept4((int)lfd, NULL, NULL, SOCK_CLOEXEC);
    if (c >= 0) buf_reset(c);
    return c;
}
hint hdm_close(hint fd) { buf_reset((int)fd); return close((int)fd) == 0; }

static Ret r_poll;
/* fds "3,5,7" -> lista gotowych do odczytu (lub z HUP) "5,7"; timeout w ms (<0 = bez limitu). */
const char *hdm_poll(const char *fds, hint timeout_ms) {
    struct pollfd pf[256]; int n = 0;
    const char *p = fds ? fds : "";
    while (*p && n < 256) {
        char *end; long v = strtol(p, &end, 10);
        if (end == p) break;
        pf[n].fd = (int)v; pf[n].events = POLLIN; pf[n].revents = 0; n++;
        p = *end == ',' ? end + 1 : end;
    }
    int rc = poll(pf, (nfds_t)n, (int)timeout_ms);
    char out[2048]; size_t w = 0;
    if (rc > 0) for (int i = 0; i < n; i++) if (pf[i].revents & (POLLIN | POLLHUP | POLLERR))
        w += (size_t)snprintf(out + w, sizeof out - w, "%s%d", w ? "," : "", pf[i].fd);
    return ret_set(&r_poll, out, w);
}

/* Czyta to, co jest dostępne, do bufora fd. >=0: liczba bajtów, -1: EOF/błąd. */
hint hdm_fill(hint fdh) {
    int fd = (int)fdh;
    if (fd < 0 || fd >= MAXFD) return -1;
    char tmp[4096];
    ssize_t r = recv(fd, tmp, sizeof tmp, MSG_DONTWAIT);
    if (r == 0) { g_eof[fd] = 1; return -1; }
    if (r < 0) return (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) ? 0 : (g_eof[fd] = 1, -1);
    if (g_len[fd] + (size_t)r + 1 > g_cap[fd]) {
        size_t nc = g_cap[fd] ? g_cap[fd] : 1024;
        while (nc < g_len[fd] + (size_t)r + 1) nc *= 2;
        if (nc > (1u << 20)) { g_eof[fd] = 1; return -1; }          /* linia > 1 MiB: odrzuć klienta */
        char *np = realloc(g_buf[fd], nc);
        if (!np) return -1;
        g_buf[fd] = np; g_cap[fd] = nc;
    }
    memcpy(g_buf[fd] + g_len[fd], tmp, (size_t)r);
    g_len[fd] += (size_t)r; g_buf[fd][g_len[fd]] = 0;
    return r;
}
static Ret r_line;
/* Następna kompletna linia z bufora ("" gdy brak). Bez końcowego \n / \r. */
const char *hdm_next_line(hint fdh) {
    int fd = (int)fdh;
    if (fd < 0 || fd >= MAXFD || !g_buf[fd]) return "";
    char *nl = memchr(g_buf[fd], '\n', g_len[fd]);
    if (!nl) return "";
    size_t n = (size_t)(nl - g_buf[fd]);
    size_t m = n; if (m && g_buf[fd][m - 1] == '\r') m--;
    const char *r = ret_set(&r_line, g_buf[fd], m);
    memmove(g_buf[fd], nl + 1, g_len[fd] - n - 1);
    g_len[fd] -= n + 1; g_buf[fd][g_len[fd]] = 0;
    return r;
}
/* Blokująco (z limitem) czeka na linię. Status: hdm_io_status() 0 ok / 1 timeout / 2 EOF. */
const char *hdm_read_line(hint fdh, hint timeout_ms) {
    int fd = (int)fdh;
    int64_t deadline = hdm_now_ms() + timeout_ms;
    g_io_status = 0;
    for (;;) {
        const char *l = hdm_next_line(fd);
        if (l[0] || (fd >= 0 && fd < MAXFD && g_buf[fd] && memchr(g_buf[fd], '\n', g_len[fd]))) return l;
        if (fd >= 0 && fd < MAXFD && g_eof[fd]) { g_io_status = 2; return ""; }
        int64_t left = deadline - hdm_now_ms();
        if (left <= 0) { g_io_status = 1; return ""; }
        struct pollfd p = { fd, POLLIN, 0 };
        int rc = poll(&p, 1, (int)left);
        if (rc == 0) { g_io_status = 1; return ""; }
        if (rc < 0 && errno != EINTR) { g_io_status = 2; return ""; }
        if (rc > 0 && hdm_fill(fd) < 0) {
            const char *l2 = hdm_next_line(fd);
            if (l2[0]) return l2;
            g_io_status = 2; return "";
        }
    }
}
hint hdm_io_status(void) { return g_io_status; }
/* Linia z bufora albo (bez blokowania) z gniazda: do odpytywania w pętli on_tick. */
const char *hdm_try_line(hint fd) {
    const char *l = hdm_next_line(fd);
    if (l[0]) return l;
    if (hdm_fill(fd) < 0) g_io_status = 2; else g_io_status = 0;
    return hdm_next_line(fd);
}
hint hdm_send(hint fd, const char *data) {
    size_t len = strlen(data), off = 0;
    while (off < len) {
        ssize_t w = send((int)fd, data + off, len - off, MSG_NOSIGNAL);
        if (w < 0) { if (errno == EINTR) continue; if (errno == EAGAIN) { struct pollfd p = { (int)fd, POLLOUT, 0 }; poll(&p, 1, 1000); continue; } return 0; }
        off += (size_t)w;
    }
    return 1;
}

/* ============================================================================
 *  Procesy
 * ========================================================================== */
static char **split_list(const char *s, int *count) {
    int cap = 8, n = 0;
    char **v = calloc((size_t)cap + 1, sizeof *v);
    if (!s) s = "";
    const char *p = s;
    while (*p) {
        const char *e = strchr(p, '\n');
        size_t l = e ? (size_t)(e - p) : strlen(p);
        if (n == cap) { cap *= 2; v = realloc(v, ((size_t)cap + 1) * sizeof *v); }
        v[n] = strndup(p, l); n++;
        p += l; if (*p == '\n') p++;
    }
    v[n] = NULL; *count = n;
    return v;
}
static void free_list(char **v) { for (int i = 0; v[i]; i++) free(v[i]); free(v); }

/*
 * Uruchamia program: argv i env rozdzielone '\n'. Środowisko jest CZYSTE (tylko env).
 * drop_user != "" -> initgroups + setgid + setuid (z weryfikacją); uid/gid podawane jawnie.
 * Zwraca PID albo -1. Dziecko robi setsid() i podpina stdin do /dev/null.
 */
hint hdm_spawn(const char *argv_s, const char *env_s, const char *cwd, const char *drop_user, hint uid, hint gid) {
    int argc, envc;
    char **argv = split_list(argv_s, &argc), **envp = split_list(env_s, &envc);
    if (argc == 0) { free_list(argv); free_list(envp); return -1; }
    int ep[2];
    if (pipe2(ep, O_CLOEXEC) != 0) { free_list(argv); free_list(envp); return -1; }
    pid_t pid = fork();
    if (pid < 0) { close(ep[0]); close(ep[1]); free_list(argv); free_list(envp); return -1; }
    if (pid == 0) {
        signal(SIGPIPE, SIG_DFL); signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL);
        sigset_t all; sigemptyset(&all); sigprocmask(SIG_SETMASK, &all, NULL);
        setsid();
        int nul = open("/dev/null", O_RDONLY); if (nul >= 0) { dup2(nul, 0); if (nul > 2) close(nul); }
        int err = 0;
        if (drop_user && drop_user[0]) {
            if (initgroups(drop_user, (gid_t)gid) != 0) err = 1;
            else if (setgid((gid_t)gid) != 0) err = 2;
            else if (setuid((uid_t)uid) != 0) err = 3;
            else if (uid != 0 && (setuid(0) == 0 || getuid() != (uid_t)uid || geteuid() != (uid_t)uid)) err = 4;   /* nie da się odzyskać roota */
        }
        if (err) { (void)!write(ep[1], &err, sizeof err); _exit(126); }
        if (cwd && cwd[0] && chdir(cwd) != 0) { (void)!chdir("/"); }
        execvpe(argv[0], argv, envp);
        err = 100 + errno;
        (void)!write(ep[1], &err, sizeof err);
        _exit(127);
    }
    close(ep[1]);
    int err = 0;
    ssize_t r = read(ep[0], &err, sizeof err);
    close(ep[0]);
    free_list(argv); free_list(envp);
    if (r == (ssize_t)sizeof err) { int st; waitpid(pid, &st, 0); g_io_status = err; return -1; }
    return (hint)pid;
}
/* Kod błędu ostatniego nieudanego hdm_spawn: 1-4 = drop uprawnień, >=100 = 100+errno z exec. */
hint hdm_spawn_error(void) { return g_io_status; }

/* -1 = działa, >=0 = kod wyjścia (128+sygnał gdy zabity), -2 = nieznany PID. */
hint hdm_child_poll(hint pid) {
    int st;
    pid_t r = waitpid((pid_t)pid, &st, WNOHANG);
    if (r == 0) return -1;
    if (r < 0) return -2;
    if (WIFEXITED(st)) return WEXITSTATUS(st);
    if (WIFSIGNALED(st)) return 128 + WTERMSIG(st);
    return 255;
}
/* Suma RSS (MiB) procesu `pid` i wszystkich jego potomków (kompozytor + greeter). 0 = brak procesu / brak /proc.
 * Nadzór pamięci greetera (daemon): H# nie ma GC, więc długo działający interfejs może rosnąć — patrz main.h#::tick. */
hint hdm_tree_rss_mb(hint pid) {
    enum { MAXP = 4096 };
    static int pids[MAXP], ppids[MAXP];
    static long rss[MAXP];
    int n = 0;
    DIR *d = opendir("/proc");
    if (!d) return 0;
    struct dirent *e;
    while ((e = readdir(d)) != NULL && n < MAXP) {
        char *end; long p = strtol(e->d_name, &end, 10);
        if (*end || p <= 0) continue;
        char path[64]; snprintf(path, sizeof path, "/proc/%ld/status", p);
        FILE *f = fopen(path, "r");
        if (!f) continue;
        char line[256]; long pp = -1, kb = 0;
        while (fgets(line, sizeof line, f)) {
            if (strncmp(line, "PPid:", 5) == 0) pp = atol(line + 5);
            else if (strncmp(line, "VmRSS:", 6) == 0) kb = atol(line + 6);
        }
        fclose(f);
        pids[n] = (int)p; ppids[n] = (int)pp; rss[n] = kb; n++;
    }
    closedir(d);
    /* zbiór potomków: iteracyjnie, aż nic nowego nie dojdzie (głębokość drzewa jest mała) */
    static char in[MAXP];
    memset(in, 0, (size_t)n);
    int found = 0;
    for (int i = 0; i < n; i++) if (pids[i] == (int)pid) { in[i] = 1; found = 1; }
    if (!found) return 0;
    for (int changed = 1; changed;) {
        changed = 0;
        for (int i = 0; i < n; i++) {
            if (in[i]) continue;
            for (int j = 0; j < n; j++) if (in[j] && pids[j] == ppids[i]) { in[i] = 1; changed = 1; break; }
        }
    }
    long total = 0;
    for (int i = 0; i < n; i++) if (in[i]) total += rss[i];
    return (hint)(total / 1024);
}
hint hdm_kill(hint pid, hint sig) { return kill((pid_t)pid, (int)sig) == 0; }

/* Polecenie powłoki „odpal i zapomnij” (podwójny fork — brak zombie). */
hint hdm_spawn_detached(const char *shell_cmd) {
    pid_t p = fork();
    if (p < 0) return 0;
    if (p == 0) {
        pid_t q = fork();
        if (q != 0) _exit(0);
        setsid();
        int nul = open("/dev/null", O_RDWR); if (nul >= 0) { dup2(nul, 0); dup2(nul, 1); dup2(nul, 2); }
        execl("/bin/sh", "sh", "-c", shell_cmd, (char *)NULL);
        _exit(127);
    }
    int st; waitpid(p, &st, 0);
    return 1;
}
