#ifndef HDM_SHIM_H
#define HDM_SHIM_H
#include <stdint.h>
const char *hdm_json_escape(const char *s);
const char *hdm_json_get_str(const char *json, const char *key);
int64_t hdm_json_get_int(const char *json, const char *key, int64_t def);
int64_t hdm_json_get_bool(const char *json, const char *key, int64_t def);
const char *hdm_json_get_int_array(const char *json, const char *key);
const char *hdm_sha256_hex(const char *s);
const char *hdm_pattern_hash(const char *user, const char *csv);
int64_t hdm_crypt_verify(const char *password, const char *hash);
int64_t hdm_install_signals(void);
int64_t hdm_term_requested(void);
int64_t hdm_getuid(void);
int64_t hdm_now_ms(void);
int64_t hdm_sleep_ms(int64_t ms);
int64_t hdm_exit(int64_t code);
const char *hdm_strftime(const char *fmt);
const char *hdm_uuid4(void);
int64_t hdm_chown(const char *path, int64_t uid, int64_t gid);
int64_t hdm_chmod(const char *path, int64_t mode);
int64_t hdm_readable(const char *path);
int64_t hdm_mkdir_p(const char *path, int64_t mode);
int64_t hdm_vt_switch(int64_t vt);
int64_t hdm_listen_unix(const char *path, int64_t mode);
int64_t hdm_connect_unix(const char *path);
int64_t hdm_accept(int64_t lfd);
int64_t hdm_close(int64_t fd);
const char *hdm_poll(const char *fds, int64_t timeout_ms);
int64_t hdm_fill(int64_t fd);
const char *hdm_next_line(int64_t fd);
const char *hdm_read_line(int64_t fd, int64_t timeout_ms);
int64_t hdm_io_status(void);
const char *hdm_try_line(int64_t fd);
int64_t hdm_send(int64_t fd, const char *data);
int64_t hdm_spawn(const char *argv, const char *env, const char *cwd, const char *drop_user, int64_t uid, int64_t gid);
int64_t hdm_spawn_error(void);
int64_t hdm_child_poll(int64_t pid);
int64_t hdm_tree_rss_mb(int64_t pid);
int64_t hdm_kill(int64_t pid, int64_t sig);
int64_t hdm_spawn_detached(const char *shell_cmd);
#endif
