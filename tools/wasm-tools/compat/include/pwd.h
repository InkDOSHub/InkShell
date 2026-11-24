/* WASI has no user database: getpw* find nobody (tools/wasm-tools/compat). */
#ifndef COMPAT_PWD_H
#define COMPAT_PWD_H
#include <sys/types.h>
struct passwd { char *pw_name, *pw_passwd; uid_t pw_uid; gid_t pw_gid; char *pw_gecos, *pw_dir, *pw_shell; };
#ifdef __cplusplus
extern "C" {
#endif
struct passwd *getpwuid(uid_t);
struct passwd *getpwnam(const char *);
int getpwnam_r(const char *, struct passwd *, char *, size_t, struct passwd **);
int getpwuid_r(uid_t, struct passwd *, char *, size_t, struct passwd **);
#ifdef __cplusplus
}
#endif
#endif
