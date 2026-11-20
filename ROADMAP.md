# InkShell roadmap

InkShell is an Alpine Linux terminal in the browser (x86 engine, BusyBox, apk).

Written on 2026-11-20 during the InkOS autopilot run. Ordered by priority; nothing here is started unless marked.

## Now

- Adopt the InkOS postMessage protocol v1 (`docs/PROTOCOL.md`): theme via `ink-tema`, files via `inkos-vfs-file` (`inkos:file` event from the Hub's `assets/tema.js`).
- Validate parent origin against the InkOS allowlist before acting on any message.
- Rootfs plan: keep `alpine-rootfs.tar.gz`, `busybox` and `overlay.tar` as downloaded artifacts, built by CI, not as source in the MIT tree (GPL-2.0 components).
- Theme: the page sets no `data-theme`; adopt `assets/tema.js` semantics (found by the InkOS apps matrix).

## Next

- Test on iPhone 17 Pro Max and iPad 11" (A16), iOS 27 Safari, and record results.
- Keep third-party components listed in `THIRD_PARTY_LICENSES.md` up to date.

## Not planned in this round

- Large new features. This file only records direction; see the README for the current state.
