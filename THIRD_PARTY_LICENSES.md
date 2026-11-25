# Third-party licenses: InkShell

> Isto é inventário técnico, não parecer jurídico. (Technical inventory, not legal advice.)
>
> Updated 2026-11-24. Each license below was checked in the upstream LICENSE/COPYING file of the version used, unless the row says "not checked".

Code written for this project is MIT ([LICENSE](LICENSE)). Components below keep their own licenses. **REVIEW** = needs a decision by the owner (reason in the row).

## 1. Served by the page (this repository, GitHub Pages)

| Component | Version | Where | License | Obligation | Status |
|---|---|---|---|---|---|
| Page and workers: `app.js`, `worker.js`, `wasi.js`, `wasi-worker.js`, `sw.js`, `inkvideo.js`, `index.html` | this repo | repo root | MIT (own code; no third-party code or notices inside) | keep LICENSE | OK |
| `overlay/` (`overlay.tar`: `/etc/inksoc/*`, `apk`, `sudo`, `inksoc-help`, `inkvideo`, `bench`, `inkvideo-webcodecs` stub module, wasm catalog) | this repo | `overlay/`, `overlay.tar` | MIT (own scripts and data) | none | OK |
| xterm.js (+ `xterm.css`) | 5.3.0 (sha256 of `vendor/xterm.js` = npm `xterm@5.3.0/lib/xterm.js`); no addons | `vendor/` | MIT ([LICENSE](https://github.com/xtermjs/xterm.js/blob/5.3.0/LICENSE); notice kept in the file header) | keep notice | OK |
| InkSoC engine `engine.wasm` | `engine-src/` (base `engine-base.txt` = InkSoC c743c20 + `linux.patch`) | `engine.wasm`, built from `engine-src/` by `engine.yml` | MIT (`engine-src/Cargo.toml` `license = "MIT"`, `engine-src/src/lib.rs` header; relicensed by the InkSoC owner, same as the InkSoC repo). No crate dependencies (`[dependencies]` empty, Cargo.lock has only `inksoc`) | keep LICENSE | OK |
| Tahoma bitmap font (Windows GDI only) | Wine `fonts/tahoma.sfd` (Larry Snyder 2004, based on Bitstream Vera) via `engine-src/fonts/mkfont.py` | `engine-src/fonts/tahoma.bin`, `include_bytes!` in `engine-src/src/wingdi/mod.rs` **only with cargo feature `tahoma`** (off by default) | LGPL-2.1-or-later (Wine tree [LICENSE](https://github.com/wine-mirror/wine/blob/master/LICENSE)); Bitstream Vera origin | none for the terminal: **excluded from the terminal build** (`engine.yml` builds without `tahoma`; the GDI uses a blank metric-only font). Source file stays in the repo, not served | OK |
| `linux.patch` | diff of `engine-src/` over InkSoC c743c20 | repo root; compiled into `engine.wasm` (it *is* part of `engine-src/`: `tools/sync-engine.sh` applies it, `tools/make-patch.sh` regenerates it) | same as the engine (own Rust code: Linux syscall layer, files, sockets). **Not derived from the Linux kernel** (the old "GPL-2.0" note was wrong) | as the engine | OK (follows the engine row) |
| `/assets/*.js`, `/assets/*.css` (`endereco.js`, `inkos-bridge.js`, `tema.js`, `barra.*`, `icones.js`) | InkDOS Hub | loaded from the Hub site, not in this repo | Hub's own | n/a here | not checked (outside this repo) |

## 2. Linux user space (downloaded by the page, run inside the emulator)

These are separate programs executed by the emulator (aggregation), not linked with the page or the engine.

| Component | Version | Where | License | Obligation | Status |
|---|---|---|---|---|---|
| Alpine Linux minirootfs | 3.21.3 (`/etc/alpine-release`) | `alpine-rootfs.tar.gz` | per package (from `/lib/apk/db/installed`): busybox, busybox-binsh, ssl_client 1.37.0-r12 GPL-2.0-only; alpine-baselayout(-data) 3.6.8-r1, apk-tools 2.14.6-r3, scanelf 1.3.8-r1 GPL-2.0-only; musl 1.2.5-r9 MIT; musl-utils MIT AND BSD-2-Clause AND GPL-2.0-or-later; libcrypto3/libssl3 3.3.3-r0 Apache-2.0; zlib 1.3.1-r2 Zlib; ca-certificates-bundle MPL-2.0 AND MIT; alpine-keys, alpine-release MIT | GPL-2.0: offer the corresponding source. Unmodified upstream binaries. Sources: [aports v3.21.3](https://gitlab.alpinelinux.org/alpine/aports/-/tree/v3.21.3), [distfiles v3.21](https://distfiles.alpinelinux.org/distfiles/v3.21/), [busybox-1.37.0.tar.bz2](https://busybox.net/downloads/busybox-1.37.0.tar.bz2), image: [alpine-minirootfs-3.21.3-x86_64.tar.gz](https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/x86_64/alpine-minirootfs-3.21.3-x86_64.tar.gz) | **REVIEW**: links point at upstream; GPL-2.0 §3 is safest with our own copy of the sources (e.g. in a release next to the rootfs). Owner decides link vs mirror |
| BusyBox (standalone, used to start the system) | 1.35.0, official static binary: sha256 `6e123e7f…1348` = [busybox.net 1.35.0-x86_64-linux-musl/busybox](https://busybox.net/downloads/binaries/1.35.0-x86_64-linux-musl/busybox) | `busybox` | GPL-2.0-only | offer source: [busybox-1.35.0.tar.bz2](https://busybox.net/downloads/busybox-1.35.0.tar.bz2) | **REVIEW**: same as above (link vs mirror) |
| x86 packages installed later with `apk add` | Alpine v3.21 | downloaded by the user from Alpine mirrors | per package | Alpine distributes them | OK (not redistributed by us) |

## 3. WebAssembly catalog (`apk add`, `overlay/etc/inksoc/wasm-catalog`)

Separate `.wasm` files downloaded on demand; each can be replaced (`/etc/inksoc/wasm-catalog.local`). Our builds come from `tools/wasm-tools/build.sh` via `.github/workflows/wasm-tools.yml` (wasi-sdk-33) and are published in release [wasm-tools-5](https://github.com/InkDOSHub/InkShell/releases/tag/wasm-tools-5) together with the exact sources (`src-*.tar.gz`, `src-*.zip`).

| Component | Version | Where | License | Obligation | Status |
|---|---|---|---|---|---|
| python3 (CPython, VMware Labs WLR build) | 3.12.0 (+20231211-040d5a6) | [vmware-labs release](https://github.com/vmware-labs/webassembly-language-runtimes/releases/tag/python%2F3.12.0%2B20231211-040d5a6) | PSF-2.0 ([CPython LICENSE](https://github.com/python/cpython/blob/v3.12.0/LICENSE), also covers bundled expat, libmpdec, HACL*); build scripts Apache-2.0. Also linked in (per WLR build script on main, exact commit not checked): zlib 1.2.13 (Zlib), bzip2 1.0.8 (bzip2), SQLite 3.42.0 (public domain), libuuid 1.0.3 (not checked), wasi-vfs (not checked) | permissive notices; we only link to their release | OK |
| ruby | 3.2.2 (+20230714-11be424) | [vmware-labs release](https://github.com/vmware-labs/webassembly-language-runtimes/releases/tag/ruby%2F3.2.2%2B20230714-11be424) | Ruby OR BSD-2-Clause ([COPYING](https://github.com/ruby/ruby/blob/v3_2_2/COPYING)); bundled libraries not checked | permissive; we only link | OK |
| 7-Zip `7zz` | 24.08 | wasm-tools-5 `7zz.wasm`, `src-7zip-24.08.tar.gz` | LGPL-2.1-or-later + BSD-3-Clause (LZFSE, Zstd dec) + BSD-2-Clause (XXH64) ([DOC/License.txt](https://github.com/ip7z/7zip/blob/24.08/DOC/License.txt)); built with `DISABLE_RAR=1`: no unRAR code, no unRAR restriction | LGPL: separate replaceable file + source in the release (done) | OK |
| qpdf | 11.9.1 | wasm-tools-5 `qpdf.wasm`, `src-qpdf-v11.9.1.tar.gz` | Apache-2.0 ([LICENSE.txt](https://github.com/qpdf/qpdf/blob/v11.9.1/LICENSE.txt)); links zlib, libjpeg-turbo | keep notices | OK |
| ImageMagick `magick` | 7.1.1-41 | wasm-tools-5 `magick.wasm`, `src-magick-7.1.1-41.tar.gz` | ImageMagick License (Apache-2.0 style, [LICENSE](https://github.com/ImageMagick/ImageMagick/blob/7.1.1-41/LICENSE)); built in: libpng 1.6.44 (PNG Reference Library License v2), libjpeg-turbo 3.0.4 (IJG + BSD-3-Clause), zlib 1.3.1 (Zlib); all other delegates `--without-*` | keep notices | OK |
| FFmpeg `ffmpeg`, `ffprobe` | 5.1.9 | wasm-tools-5 `ffmpeg.wasm`, `ffprobe.wasm`, `src-ffmpeg-n5.1.9.tar.gz` | LGPL-2.1-or-later ([LICENSE.md](https://github.com/FFmpeg/FFmpeg/blob/n5.1.9/LICENSE.md)): no `--enable-gpl`, no `--enable-version3`/`nonfree`, `--disable-autodetect` (only zlib, Zlib license); build fails unless `config.h` says `FFMPEG_LICENSE "LGPL` | LGPL: separate replaceable file + source in the release (done) | OK |
| SQLite `sqlite3` | 3.47.2 (3470200) | wasm-tools-5 `sqlite3.wasm`, `src-sqlite-amalgamation-3470200.zip` | public domain ([copyright](https://www.sqlite.org/copyright.html)) | none | OK |
| jq | 1.7.1 | wasm-tools-5 `jq.wasm`, `src-jq-1.7.1.tar.gz` | MIT ([COPYING](https://github.com/jqlang/jq/blob/jq-1.7.1/COPYING)); the same file lists bundled decNumber (ICU License) and docs (CC BY 3.0, not in the binary); built without oniguruma | keep notices | OK |
| Lua | 5.4.7 | wasm-tools-5 `lua.wasm`, `src-lua-5.4.7.tar.gz` | MIT ([lua.org/license](https://www.lua.org/license.html)) | keep notice | OK |
| Info-ZIP zip | 3.0 (Debian `zip_3.0.orig.tar.gz`) | wasm-tools-5 `zip.wasm`, `src-zip_3.0.orig.tar.gz` | Info-ZIP License 2007-Mar-4 (`zip30/LICENSE`) | keep notice; modified builds must be marked as not Info-ZIP's (catalog says "built by wasm-tools.yml") | OK |
| Info-ZIP unzip + 26 Debian patches | 6.0 + Debian 6.0-28 patches | wasm-tools-5 `unzip.wasm`, `src-unzip_6.0.orig.tar.gz`, `src-unzip-6.0-debian-patches.tar.gz`; `tools/wasm-tools/patches/unzip/` | Info-ZIP License 2009-Jan-02 ([debian/copyright](https://metadata.ftp-master.debian.org/changelogs/main/u/unzip/unzip_6.0-28_copyright) covers the whole package, no other license stanza). Patch headers: authors from Info-ZIP (S. Schweda, M. Adler), Red Hat, SUSE, Debian, upstream `madler/unzip` commits; none carries a different license | as zip | OK |
| ripgrep `rg` | 14.1.1 | wasm-tools-5 `rg.wasm`, `src-ripgrep-14.1.1.tar.gz` | Unlicense OR MIT ([COPYING](https://github.com/BurntSushi/ripgrep/blob/14.1.1/COPYING)). Crates in Cargo.lock (crates.io metadata): Unlicense/MIT (BurntSushi crates), MIT OR Apache-2.0 (serde, regex, crossbeam, bstr, anyhow, libc…), MIT (lexopt, textwrap), Apache-2.0 OR BSL-1.0 (ryu), (Apache-2.0 OR MIT) AND BSD-3-Clause (encoding_rs), (MIT OR Apache-2.0) AND Unicode-DFS-2016 (unicode-ident, build-time only). pcre2 and jemalloc are not built for wasm32-wasip1 | keep notices | OK |
| hashtools (`md5sum`, `sha1sum`, `sha224/256/384/512sum`, `b2sum`) | this repo | wasm-tools-7 `hashsum.wasm`; `tools/wasm-tools/hashsum/hashsum.c` | MIT (own code, written from RFC 1321, FIPS 180-4, RFC 7693) | none | OK |
| uutils coreutils (`coreutils`: ls, cat, cp, mv, rm, sort, wc, head, tail, cut, tr, uniq...) | 0.8.0 | wasm-tools-8 `coreutils.wasm`, `src-uutils-0.8.0.tar.gz` | MIT ([LICENSE](https://github.com/uutils/coreutils/blob/0.8.0/LICENSE)). Crates in Cargo.lock for wasm32-wasip1 (`cargo metadata`): MIT, MIT OR Apache-2.0, Apache-2.0, Unicode-3.0, Unlicense OR MIT, BSD-2/3-Clause, ISC, Zlib, CC0-1.0, one MPL-2.0 crate (file-level copyleft, unmodified); one crate offers `Apache-2.0 OR GPL-2.0-only`: used under Apache-2.0. No GPL code | keep notices | OK |
| wasi-libc, libc++/libunwind/compiler-rt (wasi-sdk-33, linked into every C/C++ tool above) | wasi-sdk-33 | inside each `.wasm` | wasi-libc: Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT; parts: musl MIT, cloudlibc BSD-2-Clause, musl-fts BSD-3-Clause, dlmalloc CC0, emmalloc MIT ([LICENSE](https://github.com/WebAssembly/wasi-libc/blob/main/LICENSE), main branch, not the exact wasi-sdk-33 commit); LLVM runtimes Apache-2.0 WITH LLVM-exception (not checked) | LLVM exception: no notice needed for compiled code; others permissive | OK |
| `tools/wasm-tools/compat/` (stub headers + `libcompat.a`) | this repo | linked into the C tools | MIT (own code) | none | OK |

## Open points (owner)

1. ~~Engine license header~~: resolved, engine is MIT.
2. ~~Wine Tahoma bitmap~~: resolved, excluded from the terminal build (feature `tahoma` off).
3. **GPL-2.0 source for Alpine and BusyBox**: links to upstream now; mirror the source tarballs in a release if the owner wants the safer form.
4. Binary notices: BSD/MIT/Apache/Info-ZIP notices for the catalog tools live in the `src-*` files of the release and in this file; nothing is installed under `/usr/share/licenses` by `apk add`.
