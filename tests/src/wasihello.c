// WASI test program for the kernel (tests/linux-test.mjs): args, stdin, stdout, a file, exit code.
// Built in CI with wasi-sdk: clang -O2 -o tests/wasihello.wasm tests/src/wasihello.c
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  char line[256] = "";
  if (!fgets(line, sizeof line, stdin)) strcpy(line, "(eof)\n");
  line[strcspn(line, "\n")] = 0;
  printf("wasi argc=%d arg1=%s in=%s\n", argc, argc > 1 ? argv[1] : "-", line);
  FILE *f = fopen("/tmp/wasi-made.txt", "w");
  if (f) { fputs("made-by-wasm\n", f); fclose(f); }
  return 3;
}
