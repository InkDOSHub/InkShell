/* WASI preview1 has no name lookup: git's network code compiles, lookups fail (tools/wasm-tools/git, item 75) */
#ifndef INK_NETDB_H
#define INK_NETDB_H
#include <sys/socket.h>
#include <netinet/in.h>
struct hostent { char *h_name; char **h_aliases; int h_addrtype, h_length; char **h_addr_list; };
#define h_addr h_addr_list[0]
struct addrinfo { int ai_flags, ai_family, ai_socktype, ai_protocol; socklen_t ai_addrlen; struct sockaddr *ai_addr; char *ai_canonname; struct addrinfo *ai_next; };
struct servent { char *s_name; char **s_aliases; int s_port; char *s_proto; };
#define AI_PASSIVE 1
#define AI_CANONNAME 2
#define AI_NUMERICHOST 4
#define NI_MAXHOST 1025
#define NI_MAXSERV 32
#define NI_NUMERICHOST 1
#define NI_NUMERICSERV 2
#define EAI_NONAME (-2)
#define EAI_FAIL (-4)
static inline struct hostent *gethostbyname(const char *n) { (void)n; return 0; }
static inline struct servent *getservbyname(const char *n, const char *p) { (void)n; (void)p; return 0; }
static inline int getaddrinfo(const char *h, const char *s, const struct addrinfo *i, struct addrinfo **r) { (void)h; (void)s; (void)i; *r = 0; return EAI_FAIL; }
static inline void freeaddrinfo(struct addrinfo *a) { (void)a; }
static inline const char *gai_strerror(int e) { (void)e; return "no name lookup in WebAssembly"; }
static inline int getnameinfo(const struct sockaddr *a, socklen_t l, char *h, socklen_t hl, char *s, socklen_t sl, int f) { (void)a; (void)l; (void)h; (void)hl; (void)s; (void)sl; (void)f; return EAI_FAIL; }
#define h_errno 0
static inline const char *hstrerror(int e) { (void)e; return "no name lookup in WebAssembly"; }
#endif
