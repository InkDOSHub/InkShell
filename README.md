# InkShell

Linux terminal of [InkDOS Hub](https://inkdoshub.github.io/), served by GitHub Pages at https://inkdoshub.github.io/InkShell/.

- Root: the Linux terminal (v86, x86 Linux in the browser, `tools/linux/` builds its kernel and overlay).
- [alpine/](alpine/): Alpine Linux on the InkSoC engine (experimental, faster). Its engine follows the
  InkSoC engine plus `alpine/linux.patch`; see [alpine/README.md](alpine/README.md). The sync scripts read
  the engine from a clone of InkDOSHub/InkSoC (`INKSOC`, `ENGINE`). The commit in `alpine/engine-base.txt`
  is still from the Hub repository: use `INKSOC=<Hub clone> ENGINE=apps/inksoc/src/engine` for it.

Shared Hub files (theme, language, bar, session) come from `/assets/` on the same site.
