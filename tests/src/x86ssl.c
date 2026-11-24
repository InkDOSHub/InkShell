// SHA-256 and SHA-1 through the system's libcrypto (OpenSSL: what python3 hashlib, apk and
// curl use), dynamically linked like the Alpine programs. OpenSSL picks its SHA-NI code when
// CPUID announces SHA; OPENSSL_ia32cap=:~0x20000000 masks it (the code used before).
// usage: x86ssl [MB]   prints "x86ssl sha256: N MB in S s = R MB/s <digest prefix>" and sha1,
// after aes-128-cbc and chacha20 encryption (OpenSSL's vpaes and ChaCha20_ssse3 need SSSE3 in CPUID).
// Built: gcc -O2 -o tests/x86ssl tests/src/x86ssl.c -lcrypto   (Alpine, openssl-dev)
#include <openssl/evp.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec / 1e9; }

int main(int argc, char **argv) {
  int mb = argc > 1 ? atoi(argv[1]) : 64;
  unsigned char *buf = malloc(1 << 20), md[EVP_MAX_MD_SIZE];
  unsigned int len;
  for (int i = 0; i < 1 << 20; i++) buf[i] = (unsigned char)(i * 2654435761u >> 24);
  const char *mask = getenv("OPENSSL_ia32cap");
  unsigned char *ct = malloc((1 << 20) + 64), key[32] = {1, 2, 3}, iv[16] = {4, 5, 6};
  for (int k = 0; k < 2; k++) {
    EVP_CIPHER_CTX *c = EVP_CIPHER_CTX_new();
    int n;
    double t0 = now();
    EVP_EncryptInit_ex(c, k ? EVP_chacha20() : EVP_aes_128_cbc(), NULL, key, iv);
    for (int i = 0; i < mb; i++) EVP_EncryptUpdate(c, ct, &n, buf, 1 << 20);
    double s = now() - t0;
    EVP_CIPHER_CTX_free(c);
    printf("x86ssl %s%s%s%s: %d MB in %.2f s = %.1f MB/s %02x%02x%02x%02x\n", k ? "chacha20" : "aes-128-cbc", mask ? " (ia32cap " : "", mask ? mask : "", mask ? ")" : "", mb, s, mb / s,
           ct[0], ct[1], ct[2], ct[3]);
  }
  free(ct);
  for (int k = 0; k < 2; k++) {
    EVP_MD_CTX *c = EVP_MD_CTX_new();
    double t0 = now();
    EVP_DigestInit_ex(c, k ? EVP_sha1() : EVP_sha256(), NULL);
    for (int i = 0; i < mb; i++) EVP_DigestUpdate(c, buf, 1 << 20);
    EVP_DigestFinal_ex(c, md, &len);
    double s = now() - t0;
    EVP_MD_CTX_free(c);
    printf("x86ssl %s%s%s%s: %d MB in %.2f s = %.1f MB/s %02x%02x%02x%02x\n", k ? "sha1" : "sha256", mask ? " (ia32cap " : "", mask ? mask : "", mask ? ")" : "", mb, s, mb / s,
           md[0], md[1], md[2], md[3]);
  }
  free(buf);
  return 0;
}
