/* InkShell (item 86): the wasi-sdk 20 sysroot (libpython's) has no setjmp.h. The Pillow JPEG coders and FreeType are
   compiled by wasi-sdk 33's clang with -mllvm -wasm-enable-sjlj (wasm exception handling, exnref) and linked with
   wasi-sdk 33's libsetjmp, so libjpeg's error_exit longjmps back into Pillow and a fatal error is a Python OSError.
   Same layout as wasi-libc's jmp_buf. */
#ifndef INK_SETJMP_H
#define INK_SETJMP_H
#ifdef __cplusplus
extern "C" {
#endif
typedef struct __jmp_buf_tag {
    unsigned long __jb[8];
    unsigned long __fl;
    unsigned long __ss[128 / sizeof(long)];
} jmp_buf[1];
int setjmp(jmp_buf) __attribute__((__returns_twice__));
_Noreturn void longjmp(jmp_buf, int);
#define setjmp setjmp
#ifdef __cplusplus
}
#endif
#endif
