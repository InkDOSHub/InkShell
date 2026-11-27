/* InkShell (item 84): wasi-sdk 20 has no setjmp/longjmp, and the program is packed by wasi-vfs (wizer), which
   takes no wasm exception instructions. Pillow's JPEG coder only longjmps on a fatal libjpeg error
   (garbage data, not a truncated file: that is a warning): report it and end the program. */
#ifndef INK_SETJMP_H
#define INK_SETJMP_H
#include <stdio.h>
#include <stdlib.h>
typedef int jmp_buf[1];
#define setjmp(b) ((void)(b), 0)
#define longjmp(b, v) (fputs("python3: fatal JPEG error (libjpeg); the WebAssembly build cannot recover\n", stderr), exit(1))
#endif
