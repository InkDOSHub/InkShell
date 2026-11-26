/* WASI has no system log: only git's daemon code calls it (tools/wasm-tools/git, item 75) */
#ifndef INK_SYSLOG_H
#define INK_SYSLOG_H
#define LOG_PID 0x01
#define LOG_DAEMON (3 << 3)
#define LOG_ERR 3
#define LOG_INFO 6
static inline void openlog(const char *i, int o, int f) { (void)i; (void)o; (void)f; }
static inline void syslog(int p, const char *f, ...) { (void)p; (void)f; }
#endif
