# Third-party licenses: InkShell

Code written for this project is MIT ([LICENSE](LICENSE)). Components below keep their own licenses. Rows marked **REVIEW** need a human decision (see InkOS autopilot run, 2026-11-20).

| Component | Location | License | Status |
|---|---|---|---|
| Alpine Linux rootfs and packages | `alpine-rootfs.tar.gz`, `overlay.tar` | mixed (GPL-2.0, MIT, BSD, …) per package | **REVIEW**: keep as a separate downloaded artifact, never mixed into MIT sources |
| BusyBox | `busybox` | GPL-2.0 | **REVIEW**: same as above; publish corresponding source or link |
| Linux patch | `linux.patch` | GPL-2.0 (derived from Linux) | **REVIEW** |
| xterm.js | `vendor/` | MIT | OK |
