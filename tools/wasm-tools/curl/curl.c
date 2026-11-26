/* curl for InkShell: a curl-compatible HTTP/HTTPS client as one WASI program (item 82).
   Written for InkShell (no code copied from curl or other projects); same license as InkShell (MIT).
   WASI has no sockets: every connection goes through the terminal's network helper (/usr/local/sbin/inksoc-net,
   the one python3's urllib uses): open "/dev/tcp/127.0.0.1/9417?t=MS" (wasi.js makes it a TCP socket), send
   "tcp|tls HOST PORT SECONDS", read "OK" (or an error line), then speak HTTP/1.1 over the stream. TLS is done
   on the x86 side by Alpine's ssl_client (certificates checked). Options: the common ones of curl (see usage()).
   Exit codes follow curl's (1 protocol, 2 option, 3 URL, 6 resolve, 7 connect, 22 HTTP error with -f,
   23 write, 26 read, 28 timeout, 35 TLS, 47 redirects, 52 empty reply, 56 receive). */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>
#include <unistd.h>

#define VERSION "8.11.1"
#define HELPER 9417

static int silent, showerr, verbose, fail_mode, fail_body, follow, maxredirs = 50, include_hdr, head_only, get_mode;
static int connect_to = 60, max_time; /* seconds; 0 = no overall limit */
static const char *method, *user_agent = "curl/" VERSION, *userpw, *referer, *cookie, *range_hdr, *writeout, *dumpfile, *upload;
static char *hdrs[128];
static int nhdrs;
static char *data; /* -d/--data-* joined with '&' */
static size_t datalen;
static int has_data;
static double t_start;

static double now(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec + ts.tv_nsec / 1e9;
}

static int err(int code, const char *fmt, ...) {
  if (!silent || showerr) {
    va_list ap;
    va_start(ap, fmt);
    fprintf(stderr, "curl: (%d) ", code);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
  }
  return code;
}

static void vlog(const char *fmt, ...) {
  if (!verbose) return;
  va_list ap;
  va_start(ap, fmt);
  vfprintf(stderr, fmt, ap);
  va_end(ap);
}

static void *xmalloc(size_t n) {
  void *p = malloc(n ? n : 1);
  if (!p) { fputs("curl: out of memory\n", stderr); exit(27); }
  return p;
}

static void add_data(const char *d, size_t n) {
  data = realloc(data, datalen + n + 2);
  if (!data) { fputs("curl: out of memory\n", stderr); exit(27); }
  if (has_data) data[datalen++] = '&';
  memcpy(data + datalen, d, n);
  datalen += n;
  data[datalen] = 0;
  has_data = 1;
}

/* whole file (or stdin for "-") into memory; strip = drop CR/LF (-d @file does) */
static int read_file(const char *name, int strip, char **out, size_t *outn) {
  FILE *f = strcmp(name, "-") ? fopen(name, "rb") : stdin;
  if (!f) return err(26, "Failed to open/read local data from file/application");
  size_t cap = 65536, n = 0;
  char *b = xmalloc(cap);
  for (;;) {
    if (n == cap) b = realloc(b, cap *= 2);
    if (!b) exit(27);
    size_t k = fread(b + n, 1, cap - n, f);
    if (!k) break;
    n += k;
  }
  if (f != stdin) fclose(f);
  if (strip) {
    size_t j = 0;
    for (size_t i = 0; i < n; i++)
      if (b[i] != '\r' && b[i] != '\n') b[j++] = b[i];
    n = j;
  }
  *out = b;
  *outn = n;
  return 0;
}

static char *urlencode(const char *s, size_t n) {
  char *o = xmalloc(n * 3 + 1), *p = o;
  for (size_t i = 0; i < n; i++) {
    unsigned char c = s[i];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || strchr("-._~", c)) *p++ = c;
    else p += sprintf(p, "%%%02X", c);
  }
  *p = 0;
  return o;
}

static char *b64(const char *s) {
  static const char t[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t n = strlen(s);
  char *o = xmalloc(n * 4 / 3 + 5), *p = o;
  for (size_t i = 0; i < n; i += 3) {
    uint32_t v = (unsigned char)s[i] << 16 | (i + 1 < n ? (unsigned char)s[i + 1] << 8 : 0) | (i + 2 < n ? (unsigned char)s[i + 2] : 0);
    *p++ = t[v >> 18 & 63];
    *p++ = t[v >> 12 & 63];
    *p++ = i + 1 < n ? t[v >> 6 & 63] : '=';
    *p++ = i + 2 < n ? t[v & 63] : '=';
  }
  *p = 0;
  return o;
}

/* ---- URL ---- */
typedef struct {
  char scheme[8], host[256], path[8192], user[512];
  int port, tls;
} url_t;

static int parse_url(const char *u, url_t *o) {
  memset(o, 0, sizeof *o);
  const char *p = strstr(u, "://");
  if (p) {
    size_t n = p - u;
    if (n >= sizeof o->scheme) return err(1, "Protocol \"%.*s\" not supported", (int)n, u);
    for (size_t i = 0; i < n; i++) o->scheme[i] = (char)(u[i] | 0x20);
    p += 3;
  } else {
    strcpy(o->scheme, "http");
    p = u;
  }
  if (!strcmp(o->scheme, "https")) o->tls = 1;
  else if (strcmp(o->scheme, "http")) return err(1, "Protocol \"%s\" not supported", o->scheme);
  const char *end = p + strcspn(p, "/?#");
  const char *at = NULL;
  for (const char *q = p; q < end; q++)
    if (*q == '@') at = q;
  if (at) {
    if ((size_t)(at - p) >= sizeof o->user) return err(3, "URL rejected: Malformed input to a URL function");
    memcpy(o->user, p, at - p);
    p = at + 1;
  }
  const char *hs = p, *he, *pc = NULL;
  if (*p == '[') {
    he = memchr(p, ']', end - p);
    if (!he) return err(3, "URL rejected: Bad IPv6 address");
    hs = p + 1;
    if (he + 1 < end && he[1] == ':') pc = he + 1;
  } else {
    pc = memchr(p, ':', end - p);
    he = pc ? pc : end;
  }
  if (he == hs || (size_t)(he - hs) >= sizeof o->host) return err(3, "URL rejected: No host part in the URL");
  memcpy(o->host, hs, he - hs);
  o->port = o->tls ? 443 : 80;
  if (pc) {
    char *e;
    long v = strtol(pc + 1, &e, 10);
    if (e == pc + 1) v = o->port;
    if (e != end || v < 1 || v > 65535) return err(3, "URL rejected: Port number was not a decimal number between 0 and 65535");
    o->port = (int)v;
  }
  const char *rest = end;
  size_t rl = strcspn(rest, "#");
  if (rl + 2 >= sizeof o->path) return err(3, "URL rejected: Malformed input to a URL function");
  if (*rest != '/') o->path[0] = '/';
  strncat(o->path, rest, rl);
  for (char *q = o->path; *q; q++)
    if (*q == ' ') return err(3, "URL rejected: Malformed input to a URL function");
  return 0;
}

/* Location relative to the current URL: the new absolute URL (malloc) */
static char *resolve(const url_t *b, const char *loc) {
  size_t n = strlen(loc) + strlen(b->host) + strlen(b->path) + 64;
  char *o = xmalloc(n);
  if (strstr(loc, "://") && strcspn(loc, ":") < strcspn(loc, "/?")) snprintf(o, n, "%s", loc);
  else if (loc[0] == '/' && loc[1] == '/') snprintf(o, n, "%s:%s", b->scheme, loc);
  else {
    char hp[300];
    if (strchr(b->host, ':')) snprintf(hp, sizeof hp, "[%s]:%d", b->host, b->port);
    else snprintf(hp, sizeof hp, "%s:%d", b->host, b->port);
    if (loc[0] == '/') snprintf(o, n, "%s://%s%s", b->scheme, hp, loc);
    else if (loc[0] == '?') {
      size_t k = strcspn(b->path, "?");
      snprintf(o, n, "%s://%s%.*s%s", b->scheme, hp, (int)k, b->path, loc);
    } else {
      size_t k = strcspn(b->path, "?");
      while (k && b->path[k - 1] != '/') k--;
      snprintf(o, n, "%s://%s%.*s%s", b->scheme, hp, (int)k, b->path, loc);
    }
  }
  return o;
}

/* ---- connection through the helper ---- */
typedef struct {
  int fd, eof, err, got; /* err: errno of a failed read; got: bytes received after OK */
  size_t pos, len;
  char buf[65536];
} conn_t;

static int idle_ms(void) {
  if (max_time) {
    double left = max_time - (now() - t_start);
    if (left < 0.001) return 1;
    return (int)(left * 1000);
  }
  return 300000; /* no endless hang when the link dies */
}

static int wr_all(int fd, const char *b, size_t n) {
  while (n) {
    ssize_t k = write(fd, b, n);
    if (k < 0) { if (errno == EINTR) continue; return -1; }
    b += k;
    n -= (size_t)k;
  }
  return 0;
}

static int fill(conn_t *c) {
  if (c->eof || c->err) return 0;
  if (max_time && now() - t_start > max_time) { c->err = ETIMEDOUT; return 0; }
  ssize_t k;
  do k = read(c->fd, c->buf, sizeof c->buf); while (k < 0 && errno == EINTR);
  if (k < 0) { c->err = errno ? errno : EIO; return 0; }
  if (k == 0) { c->eof = 1; return 0; }
  c->pos = 0;
  c->len = (size_t)k;
  c->got += (int)k;
  return 1;
}

/* one line without CR/LF into l (at most cap-1 bytes); -1 at the end of the stream */
static int getln(conn_t *c, char *l, size_t cap, int keep) {
  size_t n = 0;
  int any = 0;
  for (;;) {
    if (c->pos == c->len && !fill(c)) return any ? (int)n : -1;
    any = 1;
    char ch = c->buf[c->pos++];
    if (ch == '\n') break;
    if (n + 1 < cap) l[n++] = ch;
  }
  if (!keep && n && l[n - 1] == '\r') n--;
  l[n] = 0;
  return (int)n;
}

static int helper_open(const url_t *u, conn_t *c) {
  char path[64], line[512];
  memset(c, 0, offsetof(conn_t, buf));
  snprintf(path, sizeof path, "/dev/tcp/127.0.0.1/%d?t=%d", HELPER, idle_ms());
  c->fd = open(path, O_RDWR);
  if (c->fd < 0)
    return err(7, "Failed to connect to %s port %d: the InkShell network helper (inksoc-net, 127.0.0.1:%d) is not reachable: %s",
               u->host, u->port, HELPER, strerror(errno));
  for (const char *q = u->host; *q; q++)
    if (!((*q >= 'a' && *q <= 'z') || (*q >= 'A' && *q <= 'Z') || (*q >= '0' && *q <= '9') || strchr(".:_-", *q))) {
      close(c->fd);
      return err(6, "Could not resolve host: %s", u->host);
    }
  int ct = connect_to;
  if (max_time && max_time < ct) ct = max_time;
  if (ct < 1) ct = 1;
  snprintf(line, sizeof line, "%s %s %d %d\n", u->tls ? "tls" : "tcp", u->host, u->port, ct);
  vlog("*   Trying %s:%d...\n", u->host, u->port);
  if (wr_all(c->fd, line, strlen(line)) < 0) { close(c->fd); return err(7, "Failed to connect to %s port %d: %s", u->host, u->port, strerror(errno)); }
  int n = getln(c, line, sizeof line, 0);
  c->got = 0;
  if (n < 0 && c->err == ETIMEDOUT) { close(c->fd); return err(28, "Failed to connect to %s port %d after %d ms: Timeout was reached", u->host, u->port, (int)((now() - t_start) * 1000)); }
  if (n >= 0 && !strcmp(line, "OK")) {
    c->got = (int)(c->len - c->pos);
    vlog("* Connected to %s port %d\n", u->host, u->port);
    return 0;
  }
  close(c->fd);
  const char *m = n >= 0 ? line : "no answer (no network?)";
  int ms = (int)((now() - t_start) * 1000);
  if (strcasestr(m, "bad address") || strcasestr(m, "resolve") || strcasestr(m, "unknown host") || strcasestr(m, "bad host"))
    return err(6, "Could not resolve host: %s", u->host);
  if (strcasestr(m, "timed out") || strcasestr(m, "timeout")) return err(28, "Failed to connect to %s port %d after %d ms: Timeout was reached", u->host, u->port, ms);
  if (strcasestr(m, "refused")) return err(7, "Failed to connect to %s port %d after %d ms: Couldn't connect to server", u->host, u->port, ms);
  if (strcasestr(m, "unreachable")) return err(7, "Failed to connect to %s port %d after %d ms: Network is unreachable", u->host, u->port, ms);
  return err(7, "Failed to connect to %s port %d after %d ms: %s", u->host, u->port, ms, m);
}

/* ---- output ---- */
typedef struct {
  const char *name; /* NULL = stdout */
  FILE *f;
  int failed;
  long long bytes;
} out_t;

static int out_write(out_t *o, const char *b, size_t n) {
  if (!n || o->failed) return o->failed;
  if (!o->f) {
    if (o->name && strcmp(o->name, "-")) {
      o->f = fopen(o->name, "wb");
      if (!o->f) { o->failed = 1; return err(23, "Failure writing output to destination, passed %zu returned 0 (%s: %s)", n, o->name, strerror(errno)); }
    } else o->f = stdout;
  }
  if (fwrite(b, 1, n, o->f) != n) { o->failed = 1; return err(23, "Failure writing output to destination, passed %zu returned 0", n); }
  o->bytes += (long long)n;
  return 0;
}

static int out_close(out_t *o) {
  int r = 0;
  if (o->f && o->f != stdout && fclose(o->f)) r = err(23, "Failure writing output to destination");
  else if (o->f == stdout && fflush(stdout)) r = err(23, "Failure writing output to destination");
  o->f = NULL;
  return r;
}

static int has_hdr(const char *name) {
  size_t n = strlen(name);
  for (int i = 0; i < nhdrs; i++)
    if (!strncasecmp(hdrs[i], name, n) && (hdrs[i][n] == ':' || hdrs[i][n] == ';')) return 1;
  return 0;
}

/* -w variables of the last transfer */
static struct { int code, redirects; long long size_dl, size_hdr; char ctype[256], effective[8192], redirect[8192]; } info;

static void write_out(void) {
  if (!writeout) return;
  const char *w = writeout;
  char tmp[64];
  if (*w == '@') return; /* -w @file: not supported */
  for (const char *p = w; *p; p++) {
    if (*p == '\\' && p[1]) {
      p++;
      putchar(*p == 'n' ? '\n' : *p == 't' ? '\t' : *p == 'r' ? '\r' : *p);
    } else if (p[0] == '%' && p[1] == '{') {
      const char *e = strchr(p, '}');
      if (!e) { fputs(p, stdout); break; }
      size_t n = e - p - 2;
      const char *v = NULL;
#define IS(s) (n == strlen(s) && !strncmp(p + 2, s, n))
      if (IS("http_code") || IS("response_code")) { snprintf(tmp, sizeof tmp, "%03d", info.code); v = tmp; }
      else if (IS("url_effective") || IS("url")) v = info.effective;
      else if (IS("content_type")) v = info.ctype;
      else if (IS("redirect_url")) v = info.redirect;
      else if (IS("num_redirects")) { snprintf(tmp, sizeof tmp, "%d", info.redirects); v = tmp; }
      else if (IS("size_download")) { snprintf(tmp, sizeof tmp, "%lld", info.size_dl); v = tmp; }
      else if (IS("size_header")) { snprintf(tmp, sizeof tmp, "%lld", info.size_hdr); v = tmp; }
      else if (IS("time_total")) { snprintf(tmp, sizeof tmp, "%.6f", now() - t_start); v = tmp; }
      else if (IS("exitcode")) v = "0";
#undef IS
      fputs(v ? v : "", stdout);
      p = e;
    } else if (p[0] == '%' && p[1] == '%') {
      putchar('%');
      p++;
    } else putchar(*p);
  }
  fflush(stdout);
}

/* ---- one URL (with its redirects) ---- */
static int transfer(const char *start_url, out_t *o) {
  char *cur = strdup(start_url);
  const char *meth = method;
  int send_body = has_data && !get_mode, redirects = 0;
  char *body = data;
  size_t bodylen = datalen;
  FILE *dump = NULL;
  if (upload) {
    int r = read_file(upload, 0, &body, &bodylen);
    if (r) return r;
    send_body = 1;
    if (!meth) meth = "PUT";
  }
  if (dumpfile) dump = strcmp(dumpfile, "-") ? fopen(dumpfile, "wb") : stdout;
  info.size_hdr = 0;
  for (;;) {
    url_t u;
    int r = parse_url(cur, &u);
    if (r) return r;
    if (get_mode && has_data) { /* -G: the data goes in the query */
      size_t n = strlen(u.path);
      if (n + datalen + 2 >= sizeof u.path) return err(3, "URL rejected: Malformed input to a URL function");
      u.path[n] = strchr(u.path, '?') ? '&' : '?';
      memcpy(u.path + n + 1, data, datalen + 1);
    }
    snprintf(info.effective, sizeof info.effective, "%s", cur);
    conn_t *c = xmalloc(sizeof *c);
    if ((r = helper_open(&u, c))) { free(c); return r; }
    const char *m = meth ? meth : head_only ? "HEAD" : send_body ? "POST" : "GET";
    int is_head = head_only || !strcmp(m, "HEAD");
    /* request */
    size_t cap = 8192 + strlen(u.path) + (size_t)nhdrs * 64;
    for (int i = 0; i < nhdrs; i++) cap += strlen(hdrs[i]);
    char *rq = xmalloc(cap), hostv[300];
    size_t n = 0;
    int defport = u.port == (u.tls ? 443 : 80);
    if (strchr(u.host, ':')) snprintf(hostv, sizeof hostv, defport ? "[%s]" : "[%s]:%d", u.host, u.port);
    else snprintf(hostv, sizeof hostv, defport ? "%s" : "%s:%d", u.host, u.port);
    n += snprintf(rq + n, cap - n, "%s %s HTTP/1.1\r\n", m, u.path);
    if (!has_hdr("Host")) n += snprintf(rq + n, cap - n, "Host: %s\r\n", hostv);
    const char *auth = userpw ? userpw : u.user[0] ? u.user : NULL;
    if (auth && !has_hdr("Authorization")) {
      char *a = b64(auth);
      n += snprintf(rq + n, cap - n, "Authorization: Basic %s\r\n", a);
      free(a);
    }
    if (!has_hdr("User-Agent") && user_agent && *user_agent) n += snprintf(rq + n, cap - n, "User-Agent: %s\r\n", user_agent);
    if (!has_hdr("Accept")) n += snprintf(rq + n, cap - n, "Accept: */*\r\n");
    if (referer && !has_hdr("Referer")) n += snprintf(rq + n, cap - n, "Referer: %s\r\n", referer);
    if (cookie && !has_hdr("Cookie")) n += snprintf(rq + n, cap - n, "Cookie: %s\r\n", cookie);
    if (range_hdr && !has_hdr("Range")) n += snprintf(rq + n, cap - n, "Range: bytes=%s\r\n", range_hdr);
    if (send_body) {
      if (!has_hdr("Content-Type") && !upload) n += snprintf(rq + n, cap - n, "Content-Type: application/x-www-form-urlencoded\r\n");
      if (!has_hdr("Content-Length")) n += snprintf(rq + n, cap - n, "Content-Length: %zu\r\n", bodylen);
    }
    for (int i = 0; i < nhdrs; i++) {
      const char *h = hdrs[i], *colon = strchr(h, ':'), *semi = strchr(h, ';');
      if (colon && (!semi || colon < semi)) {
        const char *v = colon + 1;
        while (*v == ' ' || *v == '\t') v++;
        if (!*v) continue; /* "Name:" removes the header */
        n += snprintf(rq + n, cap - n, "%s\r\n", h);
      } else if (semi && !semi[1]) n += snprintf(rq + n, cap - n, "%.*s:\r\n", (int)(semi - h), h); /* "Name;" = empty value */
    }
    n += snprintf(rq + n, cap - n, "\r\n");
    if (verbose) {
      for (char *l = rq; l < rq + n;) {
        char *e = strstr(l, "\r\n");
        if (!e) break;
        fprintf(stderr, "> %.*s\n", (int)(e - l), l);
        l = e + 2;
      }
    }
    if (wr_all(c->fd, rq, n) < 0 || (send_body && bodylen && wr_all(c->fd, body, bodylen) < 0)) {
      free(rq);
      close(c->fd);
      free(c);
      return err(55, "Failed sending data to the peer");
    }
    free(rq);
    /* answer: status line and headers (1xx answers skipped) */
    char line[16384], loc[8192] = "";
    int code = 0, chunked = 0, has_len = 0;
    long long clen = 0;
    for (;;) {
      int k = getln(c, line, sizeof line, 1);
      if (k < 0) {
        int got = c->got, e = c->err;
        close(c->fd);
        free(c);
        if (e == ETIMEDOUT) return err(28, "Operation timed out after %d milliseconds with 0 bytes received", (int)((now() - t_start) * 1000));
        if (e) return err(56, "Recv failure: %s", strerror(e));
        if (!got && u.tls) return err(35, "TLS connect error: the secure connection to %s could not be made (certificate or protocol refused)", u.host);
        return err(52, "Empty reply from server");
      }
      if (strncmp(line, "HTTP/", 5)) {
        close(c->fd);
        free(c);
        return err(1, "Received HTTP/0.9 when not allowed");
      }
      code = atoi(line + strcspn(line, " "));
      int info_only = code >= 100 && code < 200 && code != 101;
      /* status and header lines, with their CR LF as they came */
      for (;;) {
        size_t ll = strlen(line);
        int blank = !ll || (ll == 1 && line[0] == '\r');
        char shown[16400];
        snprintf(shown, sizeof shown, "%s\n", line);
        info.size_hdr += (long long)ll + 1;
        if (dump) fputs(shown, dump);
        if ((include_hdr || is_head) && !info_only) out_write(o, shown, strlen(shown));
        if (verbose) fprintf(stderr, "< %.*s\n", (int)(ll && line[ll - 1] == '\r' ? ll - 1 : ll), line);
        if (blank) break;
        if (ll && line[ll - 1] == '\r') line[--ll] = 0;
        char *v = strchr(line, ':');
        if (v) {
          *v++ = 0;
          while (*v == ' ' || *v == '\t') v++;
          if (!strcasecmp(line, "Content-Length")) { clen = atoll(v); has_len = 1; }
          else if (!strcasecmp(line, "Transfer-Encoding") && strcasestr(v, "chunked")) chunked = 1;
          else if (!strcasecmp(line, "Location")) snprintf(loc, sizeof loc, "%s", v);
          else if (!strcasecmp(line, "Content-Type")) snprintf(info.ctype, sizeof info.ctype, "%s", v);
        }
        if (getln(c, line, sizeof line, 1) < 0) { line[0] = 0; break; }
      }
      if (!info_only) break;
      chunked = has_len = 0;
      clen = 0;
      loc[0] = 0;
    }
    info.code = code;
    info.redirect[0] = 0;
    if (loc[0] && code >= 300 && code < 400) {
      char *nu = resolve(&u, loc);
      snprintf(info.redirect, sizeof info.redirect, "%s", nu);
      if (follow) {
        close(c->fd);
        free(c);
        if (redirects >= maxredirs) { free(nu); return err(47, "Maximum (%d) redirects followed", maxredirs); }
        redirects++;
        vlog("* Issue another request to this URL: '%s'\n", nu);
        if ((code == 301 || code == 302 || code == 303) && !(meth && code != 303)) {
          if (send_body && !upload) send_body = 0;
          if (code == 303) meth = NULL;
        }
        if (strcmp(u.host, "") && auth && !u.user[0]) { /* credentials only to the same host */
          url_t nx;
          if (!parse_url(nu, &nx) && strcasecmp(nx.host, u.host)) userpw = NULL;
        }
        free(cur);
        cur = nu;
        if ((include_hdr || is_head)) {} /* headers of every answer were shown */
        continue;
      }
      free(nu);
    }
    info.redirects = redirects;
    if (fail_mode && code >= 400) {
      close(c->fd);
      free(c);
      if (dump && dump != stdout) fclose(dump);
      return err(22, "The requested URL returned error: %d", code);
    }
    /* body */
    long long left = is_head || code == 204 || code == 304 ? 0 : has_len ? clen : -1;
    int rc = 0;
    if (left != 0 && chunked && !is_head) {
      for (;;) {
        if (getln(c, line, sizeof line, 0) < 0) { rc = c->err == ETIMEDOUT ? 28 : 18; break; }
        long long sz = strtoll(line, NULL, 16);
        if (sz <= 0) {
          while (getln(c, line, sizeof line, 0) > 0) {} /* trailers */
          break;
        }
        while (sz > 0) {
          if (c->pos == c->len && !fill(c)) { rc = c->err == ETIMEDOUT ? 28 : 18; break; }
          size_t k = c->len - c->pos;
          if ((long long)k > sz) k = (size_t)sz;
          if (out_write(o, c->buf + c->pos, k)) { rc = 23; break; }
          info.size_dl += (long long)k;
          c->pos += k;
          sz -= (long long)k;
        }
        if (rc) break;
        getln(c, line, sizeof line, 0); /* CR LF after the chunk */
      }
    } else if (left != 0) {
      for (;;) {
        if (c->pos == c->len && !fill(c)) {
          if (c->err == ETIMEDOUT) rc = 28;
          else if (c->err) rc = 56;
          else if (left > 0) rc = 18;
          break;
        }
        size_t k = c->len - c->pos;
        if (left >= 0 && (long long)k > left) k = (size_t)left;
        if (out_write(o, c->buf + c->pos, k)) { rc = 23; break; }
        info.size_dl += (long long)k;
        c->pos += k;
        if (left > 0 && (left -= (long long)k) == 0) break;
      }
    }
    close(c->fd);
    free(c);
    free(cur);
    if (dump && dump != stdout) fclose(dump);
    else if (dump) fflush(stdout);
    if (rc == 28) return err(28, "Operation timed out after %d milliseconds with %lld bytes received", (int)((now() - t_start) * 1000), info.size_dl);
    if (rc == 18) return err(18, "transfer closed with %lld bytes remaining to read", left > 0 ? left : 0);
    if (rc == 56) return err(56, "Recv failure: Connection reset by peer");
    if (rc) return rc;
    if (fail_body && code >= 400) return err(22, "The requested URL returned error: %d", code);
    return 0;
  }
}

static void usage(void) {
  puts("Usage: curl [options...] <url>\n"
       " -d, --data <data>          HTTP POST data (--data-raw, --data-binary, --data-urlencode; @file, @- = stdin)\n"
       " -D, --dump-header <file>   Write the received headers to <file>\n"
       " -f, --fail                 Fail fast with no output on HTTP errors (exit 22); --fail-with-body keeps the body\n"
       " -G, --get                  Put the post data in the URL and use GET\n"
       " -H, --header <header>      Pass custom header(s) to server (\"Name:\" removes, \"Name;\" sends empty)\n"
       " -i, --include              Include response headers in the output\n"
       " -I, --head                 Show document info only (HEAD)\n"
       " -L, --location             Follow redirects (--max-redirs <num>, default 50)\n"
       " -m, --max-time <seconds>   Maximum time allowed for the transfer (--connect-timeout <seconds>)\n"
       " -o, --output <file>        Write to file instead of stdout\n"
       " -O, --remote-name          Write output to a file named as the remote file\n"
       " -r, --range <range>        Retrieve only the bytes within RANGE\n"
       " -s, --silent               Silent mode (-S, --show-error: still show errors)\n"
       " -T, --upload-file <file>   Transfer local FILE to destination (PUT)\n"
       " -u, --user <user:password> Server user and password (Basic)\n"
       " -A, --user-agent <name>    Send User-Agent <name> to server\n"
       " -e, --referer <URL>        Referrer URL;  -b, --cookie <data>  Send cookies (\"name=value; ...\")\n"
       " -v, --verbose              Show the request and response headers on stderr\n"
       " -w, --write-out <format>   %{http_code} %{url_effective} %{content_type} %{size_download} %{redirect_url} ...\n"
       " -X, --request <method>     Specify request method to use\n"
       " -V, --version              Show version number and quit\n"
       "InkShell curl: HTTP/1.1 and HTTPS (TLS by Alpine's ssl_client through the network helper inksoc-net).\n"
       "Not supported: FTP and other protocols, -F multipart, cookie jars, proxies, HTTP/2, --compressed decoding, -k.\n"
       "The x86 curl of Alpine stays available: apk add --x86 curl, then /usr/bin/curl.");
}

int main(int argc, char **argv) {
  const char *urls[64], *outs[64];
  int nurls = 0, nouts = 0, nremote = 0;
  t_start = now();
  /* reading the environment makes wasi.js hand the shell's folder to wasi-libc as its cwd (environ_get writes PWD,
     see wasi.js cwdSlot); chdir to it too, so -o/-O/-T/-D relative names follow the shell's folder */
  const char *pwd = getenv("PWD");
  if (pwd && pwd[0] == '/') chdir(pwd);
  /* long options -> short letters (0 = flag handled inline) */
  static const struct { const char *l; char s; int arg; } L[] = {
    {"data", 'd', 1}, {"data-ascii", 'd', 1}, {"data-raw", 1, 1}, {"data-binary", 2, 1}, {"data-urlencode", 3, 1},
    {"dump-header", 'D', 1}, {"fail", 'f', 0}, {"fail-with-body", 4, 0}, {"get", 'G', 0}, {"header", 'H', 1},
    {"include", 'i', 0}, {"head", 'I', 0}, {"location", 'L', 0}, {"location-trusted", 'L', 0}, {"max-redirs", 5, 1},
    {"max-time", 'm', 1}, {"connect-timeout", 6, 1}, {"output", 'o', 1}, {"remote-name", 'O', 0}, {"range", 'r', 1},
    {"silent", 's', 0}, {"show-error", 'S', 0}, {"upload-file", 'T', 1}, {"user", 'u', 1}, {"user-agent", 'A', 1},
    {"referer", 'e', 1}, {"cookie", 'b', 1}, {"verbose", 'v', 0}, {"write-out", 'w', 1}, {"request", 'X', 1},
    {"version", 'V', 0}, {"help", 'h', 0}, {"url", 7, 1}, {"insecure", 'k', 0}, {"compressed", 8, 0},
    {"progress-bar", '#', 0}, {"no-progress-meter", 8, 0}, {"no-buffer", 'N', 0}, {"http1.1", 8, 0}, {"http1.0", '0', 0},
    {"http2", 8, 0}, {"retry", 9, 1}, {"retry-delay", 9, 1}, {"retry-max-time", 9, 1}, {"cookie-jar", 'c', 1},
    {"proxy", 'x', 1}, {"noproxy", 9, 1}, {"globoff", 'g', 0}, {"ipv4", '4', 0}, {"ipv6", '6', 0}, {"create-dirs", 8, 0},
    {"tlsv1.2", 8, 0}, {"tlsv1.3", 8, 0}, {"no-keepalive", 8, 0}, {"raw", 8, 0}, {"remote-header-name", 'J', 0},
    {"stderr", 9, 1}, {"post301", 8, 0}, {"post302", 8, 0}, {"post303", 8, 0},
  };
  for (int i = 1; i < argc; i++) {
    const char *a = argv[i];
    char s = 0;
    const char *val = NULL;
    int needs = 0, isopt = a[0] == '-' && a[1];
    if (isopt && a[1] == '-' && !a[2]) { /* "--": the rest are URLs */
      for (i++; i < argc && nurls < 64; i++) urls[nurls++] = argv[i];
      break;
    }
    if (!isopt) {
      if (nurls < 64) urls[nurls++] = a;
      continue;
    }
    const char *cluster = NULL;
    if (a[1] == '-') {
      const char *name = a + 2;
      int neg = !strncmp(name, "no-", 3) && strcmp(name, "no-progress-meter") && strcmp(name, "no-buffer") && strcmp(name, "no-keepalive") && strcmp(name, "noproxy");
      if (neg) name += 3;
      size_t k;
      for (k = 0; k < sizeof L / sizeof *L; k++)
        if (!strcmp(L[k].l, name)) break;
      if (k == sizeof L / sizeof *L) {
        fprintf(stderr, "curl: option %s: is unknown\ncurl: try 'curl --help' for more information\n", a);
        return 2;
      }
      s = L[k].s;
      needs = L[k].arg;
      if (neg) { /* --no-silent, --no-location... */
        if (s == 's') silent = 0; else if (s == 'L') follow = 0; else if (s == 'f') fail_mode = 0; else if (s == 'i') include_hdr = 0; else if (s == 'v') verbose = 0;
        continue;
      }
      if (needs) {
        if (i + 1 >= argc) { fprintf(stderr, "curl: option %s: requires parameter\ncurl: try 'curl --help' for more information\n", a); return 2; }
        val = argv[++i];
      }
    } else cluster = a + 1;
    for (;;) {
      if (cluster) {
        if (!*cluster) break;
        s = *cluster++;
        needs = strchr("dDHmorTuAebwXcxCzEKY", s) != NULL;
        if (!strchr("dDfGHiILmoOrsSTuAebvwXVhkN#0cxgJ46CzEKYZ", s) || strchr("CzEKYZ", s)) {
          fprintf(stderr, "curl: option -%c: is unknown\ncurl: try 'curl --help' for more information\n", s);
          return 2;
        }
        if (needs) {
          if (*cluster) { val = cluster; cluster = ""; }
          else if (i + 1 < argc) val = argv[++i];
          else { fprintf(stderr, "curl: option -%c: requires parameter\ncurl: try 'curl --help' for more information\n", s); return 2; }
        }
      }
      switch (s) {
      case 'd': case 1: case 2: { /* -d strips CR/LF of an @file; --data-raw takes '@' as is */
        if (s != 1 && val[0] == '@') {
          char *b; size_t n;
          int r = read_file(val + 1, s == 'd', &b, &n);
          if (r) return r;
          add_data(b, n);
          free(b);
        } else add_data(val, strlen(val));
        break;
      }
      case 3: { /* --data-urlencode: content | =content | name=content | @file | name@file */
        const char *eq = strchr(val, '='), *at = strchr(val, '@');
        char *enc;
        if (at && (!eq || at < eq)) {
          char *b; size_t n;
          int r = read_file(at + 1, 0, &b, &n);
          if (r) return r;
          enc = urlencode(b, n);
          free(b);
          if (at > val) { size_t pl = at - val; char *t = xmalloc(pl + strlen(enc) + 2); sprintf(t, "%.*s=%s", (int)pl, val, enc); free(enc); enc = t; }
        } else if (eq) {
          char *v = urlencode(eq + 1, strlen(eq + 1));
          size_t pl = eq - val;
          enc = xmalloc(pl + strlen(v) + 2);
          if (pl) sprintf(enc, "%.*s=%s", (int)pl, val, v); else strcpy(enc, v);
          free(v);
        } else enc = urlencode(val, strlen(val));
        add_data(enc, strlen(enc));
        free(enc);
        break;
      }
      case 'D': dumpfile = val; break;
      case 'f': fail_mode = 1; break;
      case 4: fail_body = 1; break;
      case 'G': get_mode = 1; break;
      case 'H':
        if (val[0] == '@') { fprintf(stderr, "curl: -H @file is not supported\n"); return 2; }
        if (nhdrs < 128) hdrs[nhdrs++] = (char *)val;
        break;
      case 'i': include_hdr = 1; break;
      case 'I': head_only = 1; break;
      case 'L': follow = 1; break;
      case 5: maxredirs = atoi(val); if (maxredirs < 0) maxredirs = 1 << 30; break;
      case 'm': max_time = (int)(atof(val) + 0.999); break;
      case 6: connect_to = (int)(atof(val) + 0.999); break;
      case 'o': if (nouts < 64) outs[nouts++] = val; break;
      case 'O': nremote++; break;
      case 'r': range_hdr = val; break;
      case 's': silent = 1; break;
      case 'S': showerr = 1; break;
      case 'T': upload = val; break;
      case 'u': userpw = val; break;
      case 'A': user_agent = val; break;
      case 'e': referer = val; break;
      case 'b': if (strchr(val, '=')) cookie = val; break; /* a cookie file is not read */
      case 'v': verbose = 1; break;
      case 'w': writeout = val; break;
      case 'X': method = val; break;
      case 'V':
        printf("curl %s (wasm32-wasip1) InkShell curl (MIT)\nProtocols: http https\nFeatures: HTTPS-proxy-less TLS-by-helper\n", VERSION);
        return 0;
      case 'h': usage(); return 0;
      case 7: if (nurls < 64) urls[nurls++] = val; break;
      case 'x': fprintf(stderr, "curl: note: proxies are not supported, ignoring --proxy\n"); break;
      default: break; /* accepted and ignored: -k, -#, -N, -0, -4, -6, -g, -J, -c, --compressed, --retry... */
      }
      if (!cluster) break;
    }
  }
  if (!nurls) {
    fprintf(stderr, "curl: no URL specified\ncurl: try 'curl --help' for more information\n");
    return 2;
  }
  int rc = 0, ri = 0;
  for (int i = 0; i < nurls; i++) {
    out_t o = {0};
    char *rname = NULL;
    if (i < nouts) o.name = outs[i];
    else if (ri < nremote) {
      ri++;
      const char *u = urls[i], *p = strstr(u, "://");
      p = p ? p + 3 : u;
      size_t e = strcspn(p, "?#");
      const char *s = p, *last = NULL;
      for (const char *q = p; q < p + e; q++)
        if (*q == '/') last = q;
      if (!last || last + 1 >= p + e) {
        rc = err(23, "Remote file name has no length");
        continue;
      }
      s = last + 1;
      rname = strndup(s, p + e - s);
      o.name = rname;
    }
    memset(&info, 0, sizeof info);
    int r = transfer(urls[i], &o);
    int r2 = out_close(&o);
    if (!r) r = r2;
    if (!r) write_out();
    if (r) rc = r;
    free(rname);
  }
  return rc;
}
