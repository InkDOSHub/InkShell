/* gzip, gunzip, zcat for the InkShell WebAssembly catalog: one program over zlib, picked by its name (argv[0]).
 * Own code, MIT license; the compression is zlib's (zlib license). Options: -c -d -f -k -l -n -N -q -t -v -S .suf -1..-9 --fast --best
 * and long forms of those; several files; "-" or no file = standard input; -r is not supported (WASI has no processes, no globbing).
 * Compresses with zlib's gzip format (file name and modification time stored unless -n); decompresses concatenated members.
 * Exit status: 0 ok, 1 error, 2 warning (trailing garbage ignored). */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include <zlib.h>

#define BUF (256 * 1024)

static const char *prog = "gzip";
static int opt_c, opt_d, opt_f, opt_k, opt_l, opt_n, opt_q, opt_t, opt_v, level = 6;
static const char *suffix = ".gz";
static int status;
static unsigned char *ibuf, *obuf;

static void warn(const char *what, const char *name) {
  if (!opt_q) fprintf(stderr, "%s: %s: %s\n", prog, name, what);
}

static int rd(int fd, void *b, size_t n) { /* read all that is asked unless EOF; -1 on error */
  size_t got = 0;
  while (got < n) {
    ssize_t r = read(fd, (char *)b + got, n - got);
    if (r < 0) { if (errno == EINTR) continue; return -1; }
    if (r == 0) break;
    got += (size_t)r;
  }
  return (int)got;
}

static int wr(int fd, const void *b, size_t n) {
  size_t put = 0;
  while (put < n) {
    ssize_t r = write(fd, (const char *)b + put, n - put);
    if (r < 0) { if (errno == EINTR) continue; return -1; }
    put += (size_t)r;
  }
  return 0;
}

static int has_suffix(const char *name, const char **suf) { /* .gz -z .Z -gz _z .tgz .taz, or the -S one */
  static const char *known[] = { ".gz", "-gz", ".z", "-z", "_z", ".Z", ".tgz", ".taz", NULL };
  size_t n = strlen(name);
  const char *tries[10]; int k = 0;
  tries[k++] = suffix;
  for (int i = 0; known[i]; i++) tries[k++] = known[i];
  for (int i = 0; i < k; i++) {
    size_t m = strlen(tries[i]);
    if (n > m && strcmp(name + n - m, tries[i]) == 0) { *suf = tries[i]; return 1; }
  }
  return 0;
}

/* compress fd in -> fd out; returns 0 ok, -1 read error, -2 write error. orig/mtime go into the header when orig is not NULL */
static int do_compress(int in, int out, const char *orig, time_t mtime, unsigned long long *csize) {
  z_stream z; gz_header h; int ret = 0, flush;
  memset(&z, 0, sizeof z);
  if (deflateInit2(&z, level, Z_DEFLATED, 15 + 16, 9, Z_DEFAULT_STRATEGY) != Z_OK) return -1;
  memset(&h, 0, sizeof h);
  h.os = 3; h.time = (uLong)mtime;
  if (orig) h.name = (Bytef *)orig;
  if (level == 9) h.xflags = 2; else if (level == 1) h.xflags = 4;
  deflateSetHeader(&z, &h);
  *csize = 0;
  do {
    ssize_t n;
    do n = read(in, ibuf, BUF); while (n < 0 && errno == EINTR);
    if (n < 0) { ret = -1; break; }
    z.next_in = ibuf; z.avail_in = (uInt)n;
    flush = n == 0 ? Z_FINISH : Z_NO_FLUSH;
    do {
      z.next_out = obuf; z.avail_out = BUF;
      if (deflate(&z, flush) == Z_STREAM_ERROR) { ret = -1; break; }
      size_t have = BUF - z.avail_out;
      if (have) { if (wr(out, obuf, have) < 0) { ret = -2; break; } *csize += have; }
    } while (z.avail_out == 0);
    if (ret) break;
  } while (flush != Z_FINISH);
  deflateEnd(&z);
  return ret;
}

/* one read into the free tail of ibuf; returns 0 ok, -1 read error; eof set when the input is over */
static int fill(int in, size_t *have, int *eof) {
  ssize_t n;
  do n = read(in, ibuf + *have, BUF - *have); while (n < 0 && errno == EINTR);
  if (n < 0) return -1;
  if (n == 0) *eof = 1;
  *have += (size_t)n;
  return 0;
}

/* decompress every member of fd in -> fd out (out < 0: test only).
 * returns 0 ok, -1 read error, -2 write error, -3 not in gzip format, -4 corrupt data, -5 unexpected end of file */
static int do_decompress(int in, int out, unsigned long long *usize, int *garbage) {
  z_stream z; int ret = 0, eof = 0, first = 1;
  size_t have = 0;
  *usize = 0; *garbage = 0;
  memset(&z, 0, sizeof z);
  if (inflateInit2(&z, 15 + 16) != Z_OK) return -4;
  for (;;) { /* one gzip member per round */
    while (have < 2 && !eof) if (fill(in, &have, &eof) < 0) { ret = -1; goto done; }
    if (have == 0) { if (first) ret = -5; break; }
    if (have < 2 || ibuf[0] != 0x1f || ibuf[1] != 0x8b) { if (first) ret = -3; else *garbage = 1; break; }
    first = 0;
    inflateReset(&z);
    for (;;) {
      int zr;
      if (have == 0) {
        if (eof || fill(in, &have, &eof) < 0 || have == 0) { ret = eof ? -5 : -1; goto done; }
      }
      z.next_in = ibuf; z.avail_in = (uInt)have;
      do {
        z.next_out = obuf; z.avail_out = BUF;
        zr = inflate(&z, Z_NO_FLUSH);
        if (zr != Z_OK && zr != Z_STREAM_END && zr != Z_BUF_ERROR) { ret = -4; goto done; }
        size_t got = BUF - z.avail_out;
        if (got) { *usize += got; if (out >= 0 && wr(out, obuf, got) < 0) { ret = -2; goto done; } }
      } while (zr == Z_OK && z.avail_out == 0);
      have = z.avail_in;
      if (have) memmove(ibuf, z.next_in, have);
      if (zr == Z_STREAM_END) break;
    }
  }
done:
  inflateEnd(&z);
  return ret;
}

static const char *dmsg(int r) {
  switch (r) {
  case -1: return "read error";
  case -2: return "write error";
  case -3: return "not in gzip format";
  case -5: return "unexpected end of file";
  default: return "invalid compressed data--format violated";
  }
}

static void copy_times(int fd, const struct stat *st) {
  struct timespec ts[2] = { st->st_atim, st->st_mtim };
  futimens(fd, ts);
}

static int listed;

static void list_one(const char *name, int fd, const struct stat *st) {
  unsigned char t[8]; unsigned long long isize; unsigned crc;
  if (st->st_size < 18 || lseek(fd, -8, SEEK_END) < 0 || rd(fd, t, 8) != 8) { warn("not in gzip format", name); status = 1; return; }
  crc = t[0] | t[1] << 8 | t[2] << 16 | (unsigned)t[3] << 24; isize = t[4] | t[5] << 8 | t[6] << 16 | (unsigned long long)t[7] << 24;
  (void)crc;
  if (!listed++) printf("         compressed        uncompressed  ratio uncompressed_name\n");
  double ratio = isize ? 100.0 * ((double)isize - (double)st->st_size) / (double)isize : 0.0;
  char un[4096]; size_t n = strlen(name); const char *suf;
  strncpy(un, name, sizeof un - 1); un[sizeof un - 1] = 0;
  if (has_suffix(name, &suf)) un[n - strlen(suf)] = 0;
  printf("%19llu %19llu %5.1f%% %s\n", (unsigned long long)st->st_size, isize, ratio, un);
}

static void process(const char *name) {
  int std = !name || strcmp(name, "-") == 0;
  int in = 0, out = 1, r = 0;
  struct stat st; char *oname = NULL;
  unsigned long long a = 0; int garbage = 0;
  if (!std) {
    if (stat(name, &st) < 0) { fprintf(stderr, "%s: %s: %s\n", prog, name, strerror(errno)); status = 1; return; }
    if (S_ISDIR(st.st_mode)) { warn("is a directory -- ignored", name); if (!status) status = 2; return; }
    if (!S_ISREG(st.st_mode)) { warn("not a regular file -- ignored", name); if (!status) status = 2; return; }
    in = open(name, O_RDONLY);
    if (in < 0) { fprintf(stderr, "%s: %s: %s\n", prog, name, strerror(errno)); status = 1; return; }
  }
  if (opt_l) { if (std) warn("cannot list standard input", "stdin"); else list_one(name, in, &st); if (!std) close(in); return; }
  if (!std && !opt_c && !opt_t) {
    const char *suf = NULL; size_t n = strlen(name);
    if (opt_d) {
      if (!has_suffix(name, &suf)) { warn("unknown suffix -- ignored", name); if (!status) status = 2; close(in); return; }
      oname = malloc(n + 8); memcpy(oname, name, n - strlen(suf)); oname[n - strlen(suf)] = 0;
      if (strcmp(suf, ".tgz") == 0 || strcmp(suf, ".taz") == 0) strcat(oname, ".tar");
    } else {
      if (has_suffix(name, &suf) && strcmp(suf, suffix) == 0) { warn("already has the suffix -- unchanged", name); if (!status) status = 2; close(in); return; }
      oname = malloc(n + strlen(suffix) + 1); strcpy(oname, name); strcat(oname, suffix);
    }
    out = open(oname, O_WRONLY | O_CREAT | (opt_f ? O_TRUNC : O_EXCL), 0644);
    if (out < 0) {
      if (errno == EEXIST) fprintf(stderr, "%s: %s already exists; not overwritten\n", prog, oname);
      else fprintf(stderr, "%s: %s: %s\n", prog, oname, strerror(errno));
      status = 1; close(in); free(oname); return;
    }
  } else if (opt_t) out = -1;
  if (std && !opt_d && !opt_t && isatty(1) && !opt_f) { fprintf(stderr, "%s: compressed data not written to a terminal. Use -f to force compression.\n", prog); status = 1; return; }
  if (std && (opt_d || opt_t) && isatty(0) && !opt_f) { fprintf(stderr, "%s: compressed data not read from a terminal. Use -f to force decompression.\n", prog); status = 1; return; }
  const char *label = std ? "stdin" : name;
  if (opt_d || opt_t) {
    r = do_decompress(in, out, &a, &garbage);
    if (r) warn(dmsg(r), label);
    else if (garbage) { warn("decompression OK, trailing garbage ignored", label); if (!status) status = 2; }
  } else {
    const char *stored = NULL; time_t mt = 0;
    if (!std && !opt_n) { stored = name; const char *sl = strrchr(name, '/'); if (sl) stored = sl + 1; }
    if (!std) mt = st.st_mtime;
    r = do_compress(in, out, stored, mt, &a);
    if (r == -1) warn("read error", label); else if (r == -2) warn("write error", label);
  }
  if (!std) close(in);
  if (oname) {
    if (r == 0) { copy_times(out, &st); close(out); if (!opt_k && unlink(name) < 0) warn(strerror(errno), name); }
    else { close(out); unlink(oname); }
    if (r == 0 && opt_v) fprintf(stderr, "%s:\t%s\n", name, opt_d ? "decompressed" : "compressed");
    free(oname);
  }
  if (r) status = 1;
  else if (opt_t && opt_v) fprintf(stderr, "%s:\tOK\n", label);
}

int main(int argc, char **argv) {
  (void)getenv("PWD"); /* InkShell/WASI: reading the environment makes the host set the working directory (relative paths follow the shell folder) */
  const char *b = strrchr(argv[0], '/'); b = b ? b + 1 : argv[0];
  if (strncmp(b, "gunzip", 6) == 0 || strncmp(b, "ungzip", 6) == 0) { prog = "gunzip"; opt_d = 1; }
  else if (strncmp(b, "zcat", 4) == 0 || strncmp(b, "gzcat", 5) == 0) { prog = "zcat"; opt_d = 1; opt_c = 1; }
  char **files = malloc(sizeof(char *) * (size_t)(argc + 1)); int nf = 0, endopts = 0;
  for (int i = 1; i < argc; i++) {
    char *a = argv[i];
    if (endopts || a[0] != '-' || a[1] == 0) { files[nf++] = a; continue; }
    if (a[1] == '-') {
      if (a[2] == 0) { endopts = 1; continue; }
      if (!strcmp(a, "--stdout") || !strcmp(a, "--to-stdout")) opt_c = 1;
      else if (!strcmp(a, "--decompress") || !strcmp(a, "--uncompress")) opt_d = 1;
      else if (!strcmp(a, "--force")) opt_f = 1;
      else if (!strcmp(a, "--keep")) opt_k = 1;
      else if (!strcmp(a, "--list")) opt_l = 1;
      else if (!strcmp(a, "--no-name")) opt_n = 1;
      else if (!strcmp(a, "--name")) opt_n = 0;
      else if (!strcmp(a, "--quiet")) opt_q = 1;
      else if (!strcmp(a, "--test")) opt_t = 1;
      else if (!strcmp(a, "--verbose")) opt_v = 1;
      else if (!strcmp(a, "--fast")) level = 1;
      else if (!strcmp(a, "--best")) level = 9;
      else if (!strcmp(a, "--suffix") && i + 1 < argc) suffix = argv[++i];
      else if (!strncmp(a, "--suffix=", 9)) suffix = a + 9;
      else if (!strcmp(a, "--version")) { printf("%s (InkShell WebAssembly gzip over zlib %s)\n", prog, zlibVersion()); return 0; }
      else if (!strcmp(a, "--help")) { printf("Usage: %s [-cdfklnqtv1-9] [-S SUF] [FILE...]\n", prog); return 0; }
      else { fprintf(stderr, "%s: unrecognized option '%s'\n", prog, a); return 1; }
      continue;
    }
    for (char *p = a + 1; *p; p++) {
      switch (*p) {
      case 'c': opt_c = 1; break;
      case 'd': opt_d = 1; break;
      case 'f': opt_f = 1; break;
      case 'k': opt_k = 1; break;
      case 'l': opt_l = 1; break;
      case 'n': opt_n = 1; break;
      case 'N': opt_n = 0; break;
      case 'q': opt_q = 1; break;
      case 't': opt_t = 1; break;
      case 'v': opt_v = 1; break;
      case 'h': printf("Usage: %s [-cdfklnqtv1-9] [-S SUF] [FILE...]\n", prog); return 0;
      case 'V': printf("%s (InkShell WebAssembly gzip over zlib %s)\n", prog, zlibVersion()); return 0;
      case 'S': if (p[1]) { suffix = p + 1; p += strlen(p) - 1; } else if (i + 1 < argc) suffix = argv[++i]; break;
      case 'r': fprintf(stderr, "%s: -r (recursive) is not supported; use find\n", prog); return 1;
      default:
        if (*p >= '1' && *p <= '9') level = *p - '0';
        else { fprintf(stderr, "%s: invalid option -- '%c'\n", prog, *p); return 1; }
      }
    }
  }
  ibuf = malloc(BUF); obuf = malloc(BUF);
  if (!ibuf || !obuf) { fprintf(stderr, "%s: out of memory\n", prog); return 1; }
  if (nf == 0) { opt_c = !opt_t && !opt_l ? 1 : opt_c; process(NULL); }
  else for (int i = 0; i < nf; i++) process(files[i]);
  fflush(stdout);
  return status;
}
