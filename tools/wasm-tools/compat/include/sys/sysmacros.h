/* major/minor of a device number, Linux layout (tools/wasm-tools/compat). */
#ifndef COMPAT_SYS_SYSMACROS_H
#define COMPAT_SYS_SYSMACROS_H
#define major(d) ((unsigned)((((d) >> 31 >> 1) & 0xfffff000) | (((d) >> 8) & 0x00000fff)))
#define minor(d) ((unsigned)((((d) >> 12) & 0xffffff00) | ((d) & 0x000000ff)))
#define makedev(x, y) ((((unsigned long long)(x) & 0xfffff000ULL) << 32) | (((unsigned long long)(x) & 0x00000fffULL) << 8) | \
  (((unsigned long long)(y) & 0xffffff00ULL) << 12) | ((unsigned long long)(y) & 0x000000ffULL))
#endif
