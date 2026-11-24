/* WASI has no group database: getgr* find nothing (tools/wasm-tools/compat). */
#ifndef COMPAT_GRP_H
#define COMPAT_GRP_H
#include <sys/types.h>
struct group { char *gr_name, *gr_passwd; gid_t gr_gid; char **gr_mem; };
#ifdef __cplusplus
extern "C" {
#endif
struct group *getgrgid(gid_t);
struct group *getgrnam(const char *);
#ifdef __cplusplus
}
#endif
#endif
