# Alpine rootfs and emulation plan

Status: plan only (2026-11-20). No code changed.

## Goal

Keep InkShell's own code MIT while it runs a GPL userland (BusyBox, Alpine
packages, a patched Linux kernel) inside its x86 engine.

## Plan

1. **Separate artifacts.** `alpine-rootfs.tar.gz`, `busybox`, `overlay.tar` and
   the kernel image are build outputs, produced by CI from pinned upstream
   versions plus `linux.patch`, and published as release assets with their
   corresponding source links. The MIT source tree does not contain them.
2. **Download at runtime.** The page fetches the artifacts by URL with a SHA-256
   check, and caches them in OPFS. Same-origin or CORP `cross-origin` so they
   load under COEP `require-corp` inside InkOS.
3. **Source offer.** A `SOURCES.md` lists the exact upstream versions, patch and
   build commands for every GPL artifact (GPL-2.0 section 3).
4. **Memory.** Guest RAM of the engine is the natural place for the InkOS
   software pager (InkOS `docs/adr/ADR-swap.md`, option a).

## Open questions for the operator

- Move artifacts out of git now, or at the next release.
- Hosting: GitHub Releases vs. the Hub worker.
