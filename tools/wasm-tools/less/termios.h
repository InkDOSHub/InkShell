/* less on WASI: Linux's struct termios (the kernel layout, 36 bytes) and constants. WASI has no ioctl: tcgetattr/tcsetattr go to
   the host (wasi.js, import module "inksoc"), which does TCGETS/TCSETS on the Linux terminal (termcap.c). MIT, InkShell. */
#ifndef INK_TERMIOS_H
#define INK_TERMIOS_H
typedef unsigned char cc_t;
typedef unsigned int speed_t, tcflag_t;
#define NCCS 19
struct termios { tcflag_t c_iflag, c_oflag, c_cflag, c_lflag; cc_t c_line, c_cc[NCCS]; };
#define VINTR 0
#define VQUIT 1
#define VERASE 2
#define VKILL 3
#define VEOF 4
#define VTIME 5
#define VMIN 6
#define VSTART 8
#define VSTOP 9
#define VSUSP 10
#define VEOL 11
#define VREPRINT 12
#define VDISCARD 13
#define VWERASE 14
#define VLNEXT 15
#define VEOL2 16
#define IGNBRK 0000001
#define BRKINT 0000002
#define INLCR 0000100
#define IGNCR 0000200
#define ICRNL 0000400
#define IXON 0002000
#define OPOST 0000001
#define ONLCR 0000004
#define OCRNL 0000010
#define ONOCR 0000020
#define ONLRET 0000040
#define CBAUD 0010017
#define B0 0
#define B50 1
#define B75 2
#define B110 3
#define B134 4
#define B150 5
#define B200 6
#define B300 7
#define B600 8
#define B1200 9
#define B1800 10
#define B2400 11
#define B4800 12
#define B9600 13
#define B19200 14
#define B38400 15
#define B57600 0010001
#define B115200 0010002
#define EXTA B19200
#define EXTB B38400
#define CS8 0000060
#define CREAD 0000200
#define ISIG 0000001
#define ICANON 0000002
#define ECHO 0000010
#define ECHOE 0000020
#define ECHOK 0000040
#define ECHONL 0000100
#define NOFLSH 0000200
#define IEXTEN 0100000
#define TCSANOW 0
#define TCSADRAIN 1
#define TCSAFLUSH 2
int tcgetattr(int, struct termios *);
int tcsetattr(int, int, const struct termios *);
speed_t cfgetospeed(const struct termios *);
#endif
