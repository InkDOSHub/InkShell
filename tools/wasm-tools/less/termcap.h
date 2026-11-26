/* less on WASI: the termcap interface (termcap.c) for an xterm-style terminal. */
#ifndef INK_TERMCAP_H
#define INK_TERMCAP_H
int tgetent(char *, const char *);
int tgetflag(const char *);
int tgetnum(const char *);
char *tgetstr(const char *, char **);
char *tgoto(const char *, int, int);
int tputs(const char *, int, int (*)(int));
#endif
