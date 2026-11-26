/* Force-included while building gnulib (before config.h: no system headers here): no threads, so no stdio locking. MIT, InkShell. */
#define flockfile(f) ((void)0)
#define funlockfile(f) ((void)0)
