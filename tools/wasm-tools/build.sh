#!/bin/sh
# Builds WebAssembly (WASI preview1) command-line tools for the catalog (apk add) from upstream sources.
# usage: tools/wasm-tools/build.sh TOOL...   TOOL = ffmpeg | magick | qpdf | 7zz | sqlite3 | jq | lua | zip | unzip | rg | hashsum | coreutils | qjs | sed | find | awk | xz | tar | gzip | bzip2 | zstd | bc | file | less | grep | vim | nano | curl | git | python3 | diffutils | patch | openssl
# env: WASI_SDK (wasi-sdk-33 or later: C++ exceptions), WORK (sources, build dirs), OUT (the .wasm files)
# CI: .github/workflows/wasm-tools.yml builds them and publishes a GitHub release; the catalog points at it.
# No GPL in the engine, the page, or the worker. GPL is only a separate catalog program, source in its release (owner, 26/11): GNU grep, nano, git, diffutils 3.12 and patch 2.8.1 (the b_* recipes in this file; see THIRD_PARTY_LICENSES.md). Everything else: ffmpeg is built without --enable-gpl and without external libraries (LGPL-2.1+),
# 7-Zip without the unRAR code (LGPL-2.1+ and BSD-3-Clause), qpdf (Apache-2.0), ImageMagick (its own Apache-style license),
# SQLite (public domain), jq (MIT), Lua (MIT), Info-ZIP zip/unzip (Info-ZIP license, BSD-style), ripgrep (MIT or Unlicense), hashsum (InkShell's own code, MIT), uutils coreutils (MIT), QuickJS-ng (MIT), uutils sed (MIT), uutils findutils find (MIT; oniguruma BSD-2-Clause inside), one-true-awk (MIT-style Bell Labs license), xz 5.8 (0BSD; liblzma public domain/0BSD), libarchive bsdtar (BSD-2-Clause, BSD-3-Clause; zlib license for zlib, 0BSD for liblzma), gzip (InkShell's own code on zlib, MIT), bzip2 1.0.8 (bzip2 license, BSD-style), zstd 1.5.7 (BSD-3-Clause option of its dual license), Gavin Howard's bc 7.0.3 (BSD-2-Clause; not GNU bc), file/libmagic 5.46 (BSD-2-Clause), less 692 (the BSD-2-Clause style Less License option of its dual license; the GPL-3.0 option is not used), curl (InkShell's own code, MIT).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
: "${WASI_SDK:=/opt/wasi-sdk}" "${WORK:=$PWD/wasm-tools-work}" "${OUT:=$PWD/wasm-tools-out}"
mkdir -p "$WORK" "$OUT"
J=$(nproc 2>/dev/null || echo 2)
S=$WASI_SDK/share/wasi-sysroot
T=wasm32-wasip1
export CC="$WASI_SDK/bin/clang --target=$T --sysroot=$S" CXX="$WASI_SDK/bin/clang++ --target=$T --sysroot=$S"
export AR=$WASI_SDK/bin/llvm-ar RANLIB=$WASI_SDK/bin/llvm-ranlib NM=$WASI_SDK/bin/llvm-nm STRIP=$WASI_SDK/bin/llvm-strip
P=$WORK/prefix # static libraries (zlib, libpng, libjpeg)
EMU="-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID"
EMUL="-lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman -lwasi-emulated-getpid"
EH="-fwasm-exceptions -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false" # C++ exceptions and setjmp/longjmp: standard wasm exception handling
SJLJ="-mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false" # setjmp/longjmp in C (libpng, ImageMagick), link -lsetjmp
# wasi-libc links its working-directory support (__wasilibc_cwd, cwd-relative path lookup) only when the program
# references chdir/getcwd; force it so every tool resolves relative paths against the cwd that wasi.js sets
CWDL="-Wl,--undefined=chdir"
STACK="-Wl,-z,stack-size=8388608 $CWDL" # every tool's link line has $STACK

ZLIB=1.3.1 PNG=1.6.44 JPEG=3.0.4 FFMPEG=5.1.9 MAGICK=7.1.1-41 QPDF=11.9.1 SEVENZIP=24.08
SQLITE=3470200 SQLITE_YEAR=2024 JQ=1.7.1 LUA=5.4.7 ZIP=3.0 UNZIP=6.0 RG=14.1.1 UUTILS=0.8.0 QJS=v0.18.0 USED=0.3.0 UFIND=0.9.1 OTAWK=2025-01-16 XZ=5.8.1 LIBARCHIVE=3.8.1 BZIP2=1.0.8 ZSTD=1.5.7 BC=7.0.3 FILE=5.46 LESS=692 GREP=3.12 VIM=9.1.1400 NANO=8.3 NCURSES=6.5 GIT=2.47.1 DIFFUTILS=3.12 PATCH=2.8.1 OPENSSL=3.5.4
PYWLR=python%2F3.12.0%2B20231211-040d5a6 WASIVFS=0.4.0 BINARYEN=117 PILLOW=11.3.0 PILLOW_SHA=3828ee7586cd0b2091b6209e5ad53e20d0649bbe87164a459d0676e035e8f523
PILLOW_URL=https://files.pythonhosted.org/packages/f3/0d/d0d6dea55cd152ce3d6767bb38a8fc10e33796ba4ba210cbab9354b6d238/pillow-$PILLOW.tar.gz

fetch() { # github repo, tag, dir name: shallow clone once into $WORK/dir; a source tarball goes next to the binaries (LGPL)
  [ -d "$WORK/$3" ] && return 0
  echo "fetch $1 $2"
  git -c advice.detachedHead=false clone -q --depth 1 --branch "$2" "https://github.com/$1.git" "$WORK/$3"
  git -C "$WORK/$3" archive --prefix="$3-$2/" -o "$OUT/src-$3-$2.tar.gz" HEAD
}

dl() { # tarball url, dir name: download and unpack once into $WORK/dir; the tarball goes next to the binaries
  [ -d "$WORK/$2" ] && return 0
  echo "download $1"
  curl -fsSL --retry 3 -o "$OUT/src-${1##*/}" "$1"
  mkdir -p "$WORK/$2" && tar -xf "$OUT/src-${1##*/}" -C "$WORK/$2" --strip-components=1
}

compat() { # stub headers + libcompat.a for what WASI lacks (sys/wait.h, pwd.h, fork/exec/popen...)
  [ -f "$P/lib/libcompat.a" ] && return 0
  mkdir -p "$P/lib" "$P/compat"; cp -r "$here/compat/include/." "$P/compat/"
  $CC -O2 -I"$P/compat" -c "$here/compat/compat.c" -o "$WORK/compat.o" && $AR rcs "$P/lib/libcompat.a" "$WORK/compat.o"
}

zlib() {
  [ -f "$P/lib/libz.a" ] && return 0
  fetch madler/zlib v$ZLIB zlib
  (cd "$WORK/zlib" && CFLAGS=-O2 CHOST=wasm32 ./configure --static --prefix="$P" && make -j"$J" libz.a && make install)
}

libpng() {
  [ -f "$P/lib/libpng.a" ] && return 0; zlib
  fetch pnggroup/libpng v$PNG libpng
  (cd "$WORK/libpng" && CFLAGS="-O2 $SJLJ" CPPFLAGS="-I$P/include" LDFLAGS="-L$P/lib" \
    ./configure --host=$T --prefix="$P" --disable-shared --enable-static --disable-tools --disable-tests 2>&1 | tail -2 &&
    make -j"$J" libpng16.la && make install-libLTLIBRARIES install-pkgincludeHEADERS install-nodist_pkgincludeHEADERS install-pkgconfigDATA install-binSCRIPTS 2>&1 | tail -2 &&
    ln -sf libpng16.a "$P/lib/libpng.a" && ln -sf libpng16.pc "$P/lib/pkgconfig/libpng.pc")
}

libjpeg() {
  [ -f "$P/lib/libjpeg.a" ] && return 0
  fetch libjpeg-turbo/libjpeg-turbo $JPEG libjpeg
  cmake -S "$WORK/libjpeg" -B "$WORK/libjpeg/b" -G Ninja -DCMAKE_TOOLCHAIN_FILE="$WASI_SDK/share/cmake/wasi-sdk-p1.cmake" \
    -DWASI_SDK_PREFIX="$WASI_SDK" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$P" -DCMAKE_INSTALL_LIBDIR=lib \
    -DENABLE_SHARED=OFF -DWITH_SIMD=OFF -DWITH_TURBOJPEG=OFF -DWITH_TOOLS=OFF -DWITH_TESTS=OFF -DCMAKE_C_FLAGS="$SJLJ" -DCMAKE_EXE_LINKER_FLAGS=-lsetjmp
  cmake --build "$WORK/libjpeg/b" -j"$J" && cmake --install "$WORK/libjpeg/b"
}

ffmpeg() { # 5.1: the last ffmpeg CLI that runs without threads (WASI preview1 has none). LGPL: no --enable-gpl, no external libraries (--disable-autodetect), built-in codecs only (+ zlib)
  zlib
  fetch FFmpeg/FFmpeg n$FFMPEG ffmpeg
  # WASI libc has no mkstemp/tempnam: temporary files (two-pass logs) report ENOSYS
  sed -i 's/void \*ptr= tempnam(NULL, prefix);/void *ptr = NULL; (void)prefix; return AVERROR(ENOSYS);/; s/ptr= tempnam(".", prefix);/ptr = NULL;/' "$WORK/ffmpeg/libavutil/file_open.c"
  mkdir -p "$WORK/ffmpeg/b"
  (cd "$WORK/ffmpeg/b" && ../configure --target-os=none --arch=wasm32 --enable-cross-compile \
    --cc="$CC" --cxx="$CXX" --ar="$AR" --ranlib="$RANLIB" --nm="$NM" --strip="$STRIP" \
    --extra-cflags="-O2 $EMU -I$P/include" --extra-ldflags="-L$P/lib $STACK" --extra-libs="$EMUL" \
    --disable-autodetect --enable-zlib --disable-asm --disable-inline-asm --disable-x86asm \
    --disable-pthreads --disable-w32threads --disable-os2threads --disable-network \
    --disable-indevs --disable-outdevs --disable-doc --disable-debug --disable-ffplay --enable-ffprobe \
    --disable-protocols --enable-protocol=file,pipe,data,concat,subfile,crypto,md5 &&
    make -j"$J" ffmpeg ffprobe)
  grep -q 'FFMPEG_LICENSE "LGPL' "$WORK/ffmpeg/b/config.h" || { echo "ffmpeg: not LGPL"; exit 1; }
  cp "$WORK/ffmpeg/b/ffmpeg" "$OUT/ffmpeg.wasm"; cp "$WORK/ffmpeg/b/ffprobe" "$OUT/ffprobe.wasm"
}

magick() { # ImageMagick 7, single program "magick" (convert, identify, mogrify... as links); PNG, JPEG, zlib built in
  libpng; libjpeg; compat
  fetch ImageMagick/ImageMagick $MAGICK magick
  (cd "$WORK/magick" && [ -f Makefile ] || CFLAGS="-O2 $EMU $SJLJ" CPPFLAGS="-I$P/include -I$P/compat -include compat.h" LDFLAGS="-L$P/lib $STACK" LIBS="-lcompat $EMUL -lsetjmp -lc-printscan-long-double" \
    PKG_CONFIG_LIBDIR="$P/lib/pkgconfig" PKG_CONFIG_PATH= ./configure --host=$T --prefix="$P" --disable-shared --enable-static \
    --enable-zero-configuration --disable-openmp --without-threads --disable-opencl --without-modules --disable-docs \
    --without-magick-plus-plus --without-perl --without-x --with-zlib --with-png --with-jpeg \
    --without-bzlib --without-lzma --without-zstd --without-zip --without-xml --without-fontconfig --without-freetype \
    --without-lcms --without-tiff --without-webp --without-heic --without-jxl --without-djvu --without-openexr --without-raw \
    --without-raqm --without-gvc --without-pango --without-rsvg --without-wmf --without-fftw --without-jbig --without-openjp2 \
    --without-dps --without-flif --without-lqr --without-gslib --disable-dependency-tracking 2>&1 | tail -40)
  (cd "$WORK/magick" && make -j"$J" utilities/magick)
  cp "$WORK/magick/utilities/magick" "$OUT/magick.wasm"
}

qpdf() { # C++ with exceptions (wasi-sdk-33+), zlib + libjpeg, native crypto
  zlib; libjpeg; compat
  fetch qpdf/qpdf v$QPDF qpdf
  cmake -S "$WORK/qpdf" -B "$WORK/qpdf/b" -G Ninja -DCMAKE_TOOLCHAIN_FILE="$WASI_SDK/share/cmake/wasi-sdk-p1.cmake" \
    -DWASI_SDK_PREFIX="$WASI_SDK" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DBUILD_STATIC_LIBS=ON -DBUILD_DOC=OFF \
    -DREQUIRE_CRYPTO_NATIVE=ON -DUSE_IMPLICIT_CRYPTO=OFF -DCMAKE_PREFIX_PATH="$P" -DZLIB_ROOT="$P" \
    -DCMAKE_C_FLAGS="$EMU $EH -I$P/compat -include compat.h" -DCMAKE_CXX_FLAGS="$EMU $EH -I$P/compat -include compat.h" \
    -DCMAKE_EXE_LINKER_FLAGS="$EH -L$P/lib -lcompat -lunwind -lsetjmp $EMUL $STACK"
  cmake --build "$WORK/qpdf/b" -j"$J" --target qpdf
  cp "$WORK/qpdf/b/qpdf/qpdf" "$OUT/qpdf.wasm"
}

sevenzip() { # 7-Zip console (7zz), single-threaded (Z7_ST), without the unRAR code (DISABLE_RAR: no unRAR license restriction)
  compat; fetch ip7z/7zip $SEVENZIP 7zip
  (cd "$WORK/7zip/CPP/7zip/Bundles/Alone2" && make -j"$J" -f ../../cmpl_gcc.mak DISABLE_RAR=1 IS_X64= USE_ASM= O=b \
    CC="$CC" CXX="$CXX" CFLAGS_BASE_LIST="-c" CFLAGS_WARN_WALL= \
    LOCAL_FLAGS_ST="-DZ7_ST -DCOMPAT_CHMOD_OK -O2 $EMU $EH -I$P/compat -include compat.h" MY_ARCH= LDFLAGS_STATIC_2= LIB2="$EH -L$P/lib -lcompat -lunwind -lsetjmp $EMUL $STACK")
  cp "$WORK/7zip/CPP/7zip/Bundles/Alone2/b/7zz" "$OUT/7zz.wasm"
}

b_sqlite3() { # amalgamation + its shell; sqlite3.c turns on its WASI mode by itself (no threads, no WAL, no extensions, dot-file locks)
  compat
  if [ ! -d "$WORK/sqlite" ]; then
    curl -fsSL --retry 3 -o "$OUT/src-sqlite-amalgamation-$SQLITE.zip" "https://www.sqlite.org/$SQLITE_YEAR/sqlite-amalgamation-$SQLITE.zip"
    unzip -q "$OUT/src-sqlite-amalgamation-$SQLITE.zip" -d "$WORK" && mv "$WORK/sqlite-amalgamation-$SQLITE" "$WORK/sqlite"
  fi
  $CC -O2 $EMU -I"$P/compat" -include compat.h -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_OMIT_WAL \
    -DSQLITE_NOHAVE_SYSTEM -DSQLITE_OMIT_POPEN -DSQLITE_ENABLE_MATH_FUNCTIONS -DSQLITE_ENABLE_FTS5 \
    "$WORK/sqlite/shell.c" "$WORK/sqlite/sqlite3.c" -o "$OUT/sqlite3.wasm" -L"$P/lib" -lcompat $EMUL $STACK -lm
}

b_jq() { # no oniguruma (regex builtins test/match/sub report an error), decNumber kept
  compat; dl "https://github.com/jqlang/jq/releases/download/jq-$JQ/jq-$JQ.tar.gz" jq
  (cd "$WORK/jq" && [ -f Makefile ] || CFLAGS="-O2 $EMU -I$P/compat -include compat.h" LDFLAGS="-L$P/lib $STACK" LIBS="-lcompat $EMUL" \
    ./configure --host=$T --disable-shared --enable-static --without-oniguruma --disable-docs --disable-valgrind --disable-maintainer-mode 2>&1 | tail -5)
  (cd "$WORK/jq" && make src/builtin.inc src/version.h && make -j"$J" jq) # make jq alone skips BUILT_SOURCES
  cp "$WORK/jq/jq" "$OUT/jq.wasm"
}

b_lua() { # Lua 5.4 interpreter (C setjmp/longjmp errors); io.popen and os.execute through compat's popen/system (host channel, item 78); os.tmpname, io.tmpfile report failure
  compat; dl "https://www.lua.org/ftp/lua-$LUA.tar.gz" lua
  printf '%s\n' '#include <errno.h>' '#include <setjmp.h>' '#include <string.h>' '#include <unistd.h>' 'int system(const char *);' \
    '#define l_popen(L,c,m) (fflush(NULL), popen(c,m))' '#define l_pclose(L,file) (pclose(file))' \
    '#define l_inspectstat(stat,what) if (((stat) & 0x7f) == 0) { stat = ((stat) >> 8) & 0xff; } else { stat = (stat) & 0x7f; what = "signal"; }' \
    '#define LUAI_THROW(L,c) longjmp((c)->b, 1)' '#define LUAI_TRY(L,c,a) if (setjmp((c)->b) == 0) { a }' '#define luai_jmpbuf jmp_buf' \
    '#define LUA_TMPNAMBUFSIZE 32' '#define lua_tmpnam(b,e) { strcpy(b, "/tmp/lua_XXXXXX"); e = -1; }' \
    '#define tmpfile() (errno = ENOSYS, (FILE *)0)' '#define lua_stdin_is_tty() isatty(0)' > "$WORK/lua/wasi.h"
  (cd "$WORK/lua/src" && $CC -O2 $EMU $SJLJ -I"$P/compat" -include compat.h -include ../wasi.h $(ls *.c | grep -v '^luac\.c$') \
    -o "$OUT/lua.wasm" -L"$P/lib" -lcompat -lsetjmp $EMUL $STACK -lm)
}

IZ="-DUNIX -DLARGE_FILE_SUPPORT -DHAVE_TERMIOS_H -DCOMPAT_CHMOD_OK -I$here/compat/termios -include unistd.h -include utime.h" # Info-ZIP: no configure (it runs test programs)

b_zip() { # Info-ZIP zip 3.0 (Debian's copy of the upstream tarball), no bzip2; temporary archive via compat mkstemp
  compat; dl "http://deb.debian.org/debian/pool/main/z/zip/zip_$ZIP.orig.tar.gz" zip
  (cd "$WORK/zip" && $CC -O2 $EMU -I"$P/compat" -include compat.h $IZ -I. -DHAVE_DIRENT_H -DNO_BZIP2_SUPPORT -DZIP64_SUPPORT -DNO_ASM -DUIDGID_NOT_16BIT \
    zip.c zipfile.c zipup.c fileio.c util.c globals.c crypt.c ttyio.c crc32.c zbz2err.c deflate.c trees.c unix/unix.c \
    -o "$OUT/zip.wasm" -L"$P/lib" -lcompat $EMUL $STACK)
}

b_unzip() { # Info-ZIP unzip 6.0 (Debian's copy of the upstream tarball) with Debian's security fixes, no bzip2; times are UTC (no time zones); its ztimbuf has the layout of struct utimbuf
  compat; dl "http://deb.debian.org/debian/pool/main/u/unzip/unzip_$UNZIP.orig.tar.gz" unzip
  # patches/unzip: Debian 6.0-28 fixes (CVE-2014-8139/8140/8141, CVE-2014-9636, CVE-2014-9913, CVE-2015-7696/7697,
  # CVE-2016-9844, CVE-2018-1000035, CVE-2019-13232 zip bomb with overlapped entries, CVE-2022-0529/0530); Info-ZIP license
  if [ ! -f "$WORK/unzip/.patched" ]; then
    for f in $(grep -v '^#' "$here/patches/unzip/series"); do echo "patch $f"; patch -p1 -s -d "$WORK/unzip" < "$here/patches/unzip/$f"; done
    touch "$WORK/unzip/.patched"; tar -czf "$OUT/src-unzip-$UNZIP-debian-patches.tar.gz" -C "$here/patches" unzip
  fi
  sed -i 's/^    m_time += timezone; /    m_time += 0; /' "$WORK/unzip/fileio.c"
  (cd "$WORK/unzip" && $CC -O2 $EMU -I"$P/compat" -include compat.h $IZ -I. -DDIRENT -DNO_LCHMOD -DDATE_FORMAT=DF_YMD -Wno-error=incompatible-pointer-types \
    unzip.c crc32.c crypt.c envargs.c explode.c extract.c fileio.c globals.c inflate.c list.c match.c process.c ttyio.c \
    ubz2err.c unreduce.c unshrink.c zipinfo.c unix/unix.c -o "$OUT/unzip.wasm" -L"$P/lib" -lcompat $EMUL $STACK)
}

b_rg() { # ripgrep (Rust, wasm32-wasip1): one thread (WASI has none), no PCRE2
  fetch BurntSushi/ripgrep $RG ripgrep
  rustup target add wasm32-wasip1
  (cd "$WORK/ripgrep" && env -u CC -u CXX -u AR -u RANLIB -u NM -u STRIP CARGO_PROFILE_RELEASE_DEBUG=0 CARGO_PROFILE_RELEASE_STRIP=true \
    CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="-C link-arg=--undefined=chdir" \
    cargo build --release --locked --target wasm32-wasip1)
  cp "$WORK/ripgrep/target/wasm32-wasip1/release/rg.wasm" "$OUT/rg.wasm"
}

b_hashsum() { # md5sum, sha1sum, sha224/256/384/512sum, b2sum: one small C program of this repo (hashsum/hashsum.c, MIT), picked by its name
  $CC -O3 -Wall "$here/hashsum/hashsum.c" -o "$OUT/hashsum.wasm" $CWDL
}

b_curl() { # curl: InkShell's own curl-compatible HTTP/HTTPS client (curl/curl.c, MIT; no code of curl itself), connections through the terminal's network helper inksoc-net (item 76: /dev/tcp in wasi.js, TLS by Alpine's ssl_client)
  $CC -O2 -Wall "$here/curl/curl.c" -o "$OUT/curl.wasm" $CWDL
}

b_coreutils() { # uutils coreutils 0.8.0 (Rust, wasm32-wasip1), multicall "coreutils": the utilities upstream builds for WASI (feat_wasm), picked by argv[0] (ls, cat, cp, sort...)
  fetch uutils/coreutils $UUTILS uutils
  rustup target add wasm32-wasip1
  (cd "$WORK/uutils" && env -u CC -u CXX -u AR -u RANLIB -u NM -u STRIP CARGO_PROFILE_RELEASE_DEBUG=0 CARGO_PROFILE_RELEASE_STRIP=true \
    CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="-C link-arg=--undefined=chdir" \
    cargo build --release --locked --target wasm32-wasip1 --no-default-features --features feat_wasm)
  cp "$WORK/uutils/target/wasm32-wasip1/release/coreutils.wasm" "$OUT/coreutils.wasm"
}

b_qjs() { # QuickJS-ng (MIT) `qjs`: JavaScript (ES2023+, modules, std/os libs, REPL), WASI build upstream supports (no threads, no atomics); compiled directly, no CMake; std.popen/pclose and os.exec (blocking) through compat's popen/system (host channel, item 79)
  compat; fetch quickjs-ng/quickjs $QJS quickjs
  # upstream leaves popen and os.exec out of WASI builds: the patch turns them on (std.popen, File.close of a pipe; os.exec -> system())
  grep -q 'InkShell' "$WORK/quickjs/quickjs-libc.c" || (cd "$WORK/quickjs" && patch -p1 < "$here/patches/quickjs/exec-wasi.patch")
  (cd "$WORK/quickjs" && $CC -O2 -fwrapv -D_GNU_SOURCE -DQJS_BUILD_LIBC $EMU -I"$P/compat" -include compat.h dtoa.c libregexp.c libunicode.c quickjs.c quickjs-libc.c gen/repl.c gen/standalone.c qjs.c \
    -o "$OUT/qjs.wasm" -L"$P/lib" -lcompat $EMUL $STACK -lm)
}

b_sed() { # uutils sed 0.3.0 (MIT, Rust, wasm32-wasip1): -n -e -f -E -i -s -z, y///, hold space, w files; one thread (WASI has none)
  fetch uutils/sed $USED uutilssed
  rustup target add wasm32-wasip1
  (cd "$WORK/uutilssed" && env -u CC -u CXX -u AR -u RANLIB -u NM -u STRIP CARGO_PROFILE_RELEASE_DEBUG=0 CARGO_PROFILE_RELEASE_STRIP=true \
    CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="-C link-arg=--undefined=chdir" \
    cargo build --release --locked --target wasm32-wasip1 --bin sed)
  cp "$WORK/uutilssed/target/wasm32-wasip1/release/sed.wasm" "$OUT/sed.wasm"
}

b_find() { # uutils findutils 0.9.1 `find` (MIT, Rust, wasm32-wasip1; its regex crate onig_sys compiles oniguruma, BSD-2-Clause, C, with wasi-sdk); -exec/-ok/-execdir through the host channel (item 78)
  fetch uutils/findutils $UFIND uutilsfind
  # std::process has no processes on WASI: -exec runs its command through wasi.js's /dev/inksoc channel (spawn + wait)
  grep -q inksoc_status "$WORK/uutilsfind/src/find/matchers/exec.rs" || (cd "$WORK/uutilsfind" && patch -p1 < "$here/patches/findutils/exec-wasi.patch")
  # wasi.js sets the shell folder as the working directory when the program reads its environment (environ_get); find never does before it walks,
  # so a relative path would be looked up from "/": read PWD first thing in main (the only change to upstream)
  grep -q 'var_os("PWD")' "$WORK/uutilsfind/src/find/main.rs" || sed -i 's|^fn main() {|fn main() {\n    let _ = std::env::var_os("PWD"); // InkShell/WASI: makes the host set the working directory|' "$WORK/uutilsfind/src/find/main.rs"
  rustup target add wasm32-wasip1
  (cd "$WORK/uutilsfind" && env CC_wasm32_wasip1="$CC" AR_wasm32_wasip1="$AR" CARGO_PROFILE_RELEASE_DEBUG=0 CARGO_PROFILE_RELEASE_STRIP=true \
    CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="-C link-arg=--undefined=chdir" \
    cargo build --release --locked --target wasm32-wasip1 --bin find)
  cp "$WORK/uutilsfind/target/wasm32-wasip1/release/find.wasm" "$OUT/find.wasm"
}

b_awk() { # one-true-awk (Bell Labs, MIT-style license, C): the parser comes from bison (its output is not GPL: bison's exception), maketab runs on the build host; system() and pipes ("cmd" | getline, print | "cmd") through compat (host channel, item 78)
  compat
  dl "http://deb.debian.org/debian/pool/main/o/original-awk/original-awk_$OTAWK.orig.tar.gz" awk # Debian's copy of the upstream tarball
  (cd "$WORK/awk" && bison -d awkgram.y && gcc -O1 -w maketab.c -o maketab && ./maketab awkgram.tab.h > proctab.c)
  printf '%s\n' 'int system(const char *);' > "$WORK/awk/wasi.h"
  (cd "$WORK/awk" && $CC -O2 -w $EMU $SJLJ -I"$P/compat" -include compat.h -include wasi.h -Wno-implicit-function-declaration \
    awkgram.tab.c b.c lex.c lib.c main.c parse.c proctab.c run.c tran.c -o "$OUT/awk.wasm" -L"$P/lib" -lcompat -lsetjmp $EMUL $STACK -lm)
}

liblzma() { # xz-utils 5.8 (release tarball: configure included): liblzma + the xz program, one thread (WASI has none), no scripts (GPL), no docs/translations
  [ -f "$P/lib/liblzma.a" ] && return 0; compat
  dl "https://github.com/tukaani-project/xz/releases/download/v$XZ/xz-$XZ.tar.gz" xz
  # WASI has no signals (sigaction), pipes or geteuid: the xz program only used them to stop cleanly on Ctrl-C and to warn about chown
  if [ ! -f "$WORK/xz/.patched" ]; then
    printf '%s\n' '#include "private.h"' 'volatile sig_atomic_t user_abort = 0;' 'void signals_init(void) {}' 'void signals_block(void) {}' \
      'void signals_unblock(void) {}' 'void signals_exit(void) {}' > "$WORK/xz/src/xz/signals.c"
    sed -i 's/if (pipe(user_abort_pipe))/if (0)/; s/for (unsigned i = 0; i < 2; ++i) {/for (unsigned i = 0; i < 0; ++i) {/; s/warn_fchown = geteuid() == 0;/warn_fchown = false;/; s/\bO_NONBLOCK\b/0/g' "$WORK/xz/src/xz/file_io.c"
    sed -i '0,/#include "private.h"/s//#include "private.h"\n#undef SIGALRM \/\/ no alarm(): upstream polls the clock then/' "$WORK/xz/src/xz/message.c"
    touch "$WORK/xz/.patched"
  fi
  (cd "$WORK/xz" && CFLAGS="-O2 -DCOMPAT_CHMOD_OK $EMU -I$P/compat -include compat.h" LDFLAGS="-L$P/lib $STACK" LIBS="-lcompat $EMUL" \
    ./configure --host=$T --prefix="$P" --disable-shared --enable-static --disable-threads --disable-nls --disable-scripts --disable-doc \
    --disable-lzmainfo --disable-lzmadec --disable-xzdec --disable-sandbox --disable-dependency-tracking 2>&1 | tail -5 &&
    make -j"$J" -C src/liblzma && make -C src/liblzma install >/dev/null && make -j"$J" -C src/xz xz)
}

b_xz() { # xz 5.8.1 (0BSD; xz, unxz, xzcat, lzma: by argv[0])
  liblzma
  cp "$WORK/xz/src/xz/xz" "$OUT/xz.wasm"
}

b_tar() { # libarchive 3.8 bsdtar (BSD-2/3-Clause): tar -c -x -t, -z (zlib) -J (liblzma) in the process, also zip/7z/cpio/ar formats; no openssl, xml, iconv, acl, xattr, bzip2, zstd, lz4
  zlib; liblzma; compat
  dl "https://github.com/libarchive/libarchive/releases/download/v$LIBARCHIVE/libarchive-$LIBARCHIVE.tar.gz" libarchive
  # patches/libarchive/wasi.patch: the directory walker (tar -c) needs fchdir() and dup(), which WASI lacks, and the external-program filters need fork() (BSD-2-Clause, same license as the file)
  if [ ! -f "$WORK/libarchive/.patched" ]; then
    patch -p1 -s -d "$WORK/libarchive" < "$here/patches/libarchive/wasi.patch" && touch "$WORK/libarchive/.patched"
  fi
  cmake -S "$WORK/libarchive" -B "$WORK/libarchive/b" -G Ninja -DCMAKE_TOOLCHAIN_FILE="$WASI_SDK/share/cmake/wasi-sdk-p1.cmake" \
    -DWASI_SDK_PREFIX="$WASI_SDK" -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH="$P" -DCMAKE_FIND_ROOT_PATH="$P" \
    -DENABLE_TEST=OFF -DENABLE_INSTALL=OFF -DENABLE_CPIO=OFF -DENABLE_CAT=OFF -DENABLE_UNZIP=OFF -DENABLE_TAR=ON \
    -DENABLE_OPENSSL=OFF -DENABLE_LIBXML2=OFF -DENABLE_EXPAT=OFF -DENABLE_ICONV=OFF -DENABLE_ACL=OFF -DENABLE_XATTR=OFF \
    -DENABLE_BZip2=OFF -DENABLE_ZSTD=OFF -DENABLE_LZ4=OFF -DENABLE_LZO=OFF -DENABLE_LIBB2=OFF -DENABLE_MBEDTLS=OFF -DENABLE_NETTLE=OFF \
    -DREGEX_INCLUDE_DIR="$S/include" -DHAVE_REGCOMP_LIBC=1 -DHAVE_CHOWN=1 -DHAVE_FCHOWN=1 -DHAVE_LCHOWN=1 -DHAVE_FCHMOD=1 -DHAVE_STATVFS=0 -DHAVE_FSTATVFS=0 -DHAVE_STATFS=0 -DHAVE_FSTATFS=0 -DENABLE_CNG=OFF -DENABLE_PCREPOSIX=OFF -DENABLE_PCRE2POSIX=OFF -DENABLE_LIBGCC=OFF -DENABLE_ZLIB=ON -DENABLE_LZMA=ON \
    -DZLIB_ROOT="$P" -DLIBLZMA_INCLUDE_DIR="$P/include" -DLIBLZMA_LIBRARY="$P/lib/liblzma.a" -DLZMA_INCLUDE_DIR="$P/include" -DLZMA_LIBRARY="$P/lib/liblzma.a" \
    -DCMAKE_C_FLAGS="-O2 -DCOMPAT_CHMOD_OK $EMU -I$P/compat -include compat.h" -DCMAKE_EXE_LINKER_FLAGS="-L$P/lib -lcompat $EMUL $STACK"
  cmake --build "$WORK/libarchive/b" -j"$J" --target bsdtar
  cp "$WORK/libarchive/b/bin/bsdtar" "$OUT/bsdtar.wasm"
}

b_gzip() { # gzip, gunzip, zcat: InkShell's own program (gzip/gzip.c, MIT) over zlib (zlib license), by argv[0]
  zlib
  $CC -O2 -Wall -I"$P/include" "$here/gzip/gzip.c" -o "$OUT/gzip.wasm" -L"$P/lib" -lz $CWDL
}

b_bzip2() { # bzip2 1.0.8 (bzip2 license, BSD-style): bzip2, bunzip2, bzcat by argv[0] (the program looks for "unzip"/"zcat" in its name); no signals needed beyond the emulated ones
  compat; dl "https://sourceware.org/pub/bzip2/bzip2-$BZIP2.tar.gz" bzip2
  (cd "$WORK/bzip2" && $CC -O2 -Wall -Winline -D_FILE_OFFSET_BITS=64 -DCOMPAT_CHMOD_OK $EMU -I"$P/compat" -include compat.h \
    blocksort.c huffman.c crctable.c randtable.c compress.c decompress.c bzlib.c bzip2.c -o "$OUT/bzip2.wasm" -L"$P/lib" -lcompat $EMUL $STACK)
}

b_zstd() { # zstd 1.5.7 (BSD-3-Clause; the GPL-2.0 option of its dual license is not used): zstd, unzstd, zstdcat by argv[0]; one thread (no ZSTD_MULTITHREAD), no zlib/lzma/lz4 formats, no asm
  compat; dl "https://github.com/facebook/zstd/releases/download/v$ZSTD/zstd-$ZSTD.tar.gz" zstd
  (cd "$WORK/zstd" && $CC -O2 -DZSTD_LEGACY_SUPPORT=0 -DDYNAMIC_BMI2=0 -DZSTD_DISABLE_ASM=1 -DCOMPAT_CHMOD_OK $EMU -I"$P/compat" -include compat.h \
    -Ilib -Ilib/common -Ilib/compress -Ilib/decompress -Ilib/dictBuilder -Iprograms \
    lib/common/*.c lib/compress/*.c lib/decompress/*.c lib/dictBuilder/*.c programs/*.c -o "$OUT/zstd.wasm" -L"$P/lib" -lcompat $EMUL $STACK)
}

b_bc() { # Gavin Howard's bc 7.0.3 (BSD-2-Clause; not GNU bc): bc and dc are one program, picked by argv[0]; no readline/history, no NLS, no man pages
  compat; dl "https://github.com/gavinhoward/bc/releases/download/$BC/bc-$BC.tar.gz" bc
  # WASI has no sigaction/sigsetjmp: the program's own Windows branch (signal()) handles SIGINT/SIGTERM, and setjmp stands in for sigsetjmp
  sed -i '/^bc_vm_sigaction(void)/,/^}/ s/^#ifndef _WIN32$/#if !defined(_WIN32) \&\& !defined(__wasi__)/' "$WORK/bc/src/vm.c"
  printf '#include <setjmp.h>\n#define sigjmp_buf jmp_buf\n#define sigsetjmp(j, s) setjmp(j)\n#define siglongjmp longjmp\n' > "$WORK/bc/wasi_sj.h"
  (cd "$WORK/bc" && HOSTCC=cc HOSTCFLAGS=-O2 CFLAGS="-O2 $SJLJ -include $WORK/bc/wasi_sj.h $EMU" LDFLAGS="-lsetjmp $EMUL $STACK" \
    ./configure.sh --disable-nls --disable-history --disable-man-pages --disable-generated-tests -O3 >/dev/null && make -j"$J" && cp bin/bc "$OUT/bc.wasm")
}

b_file() { # file(1) 5.46 / libmagic (BSD-2-Clause), no external decompressors; the compiled magic database (magic.mgc, made by a native file of the same version) is inside the program, gzip-compressed (file/inkmagic.c); -m FILE still works
  zlib; compat
  dl "https://astron.com/pub/file/file-$FILE.tar.gz" file
  if [ ! -f "$WORK/file/.host" ]; then # native build, only for magic.mgc
    mkdir -p "$WORK/file-host" && (cd "$WORK/file-host" && export CC=cc CXX=c++ AR=ar RANLIB=ranlib NM=nm STRIP=strip && "$WORK/file/configure" --disable-shared --disable-libseccomp --disable-zlib --disable-bzlib --disable-xzlib --disable-zstdlib --disable-lzlib >/dev/null && make -j"$J" >/dev/null && touch "$WORK/file/.host")
  fi
  mgc=$WORK/file-host/magic/magic.mgc
  { echo "static const unsigned long magic_mgc_size = $(wc -c < "$mgc");"; echo 'static const unsigned char magic_mgc_gz[] = {'
    gzip -9nc "$mgc" | od -An -v -tx1 | sed 's/ \([0-9a-f][0-9a-f]\)/0x\1,/g'; echo '};'; } > "$WORK/file/src/magic_mgc_gz.h"
  cp "$here/file/inkmagic.c" "$WORK/file/src/inkmagic.c"
  sed -i 's/if (magic_load(magic, magicfile) == -1) {/if (ink_magic_load(magic, magicfile) == -1) {/' "$WORK/file/src/file.c"
  grep -q ink_magic_load "$WORK/file/src/file.c" && sed -i '0,/^#include "file.h"/s//#include "file.h"\nint ink_magic_load(struct magic_set *, const char *);/' "$WORK/file/src/file.c"
  # file_pipe2file() (stdin to a temp file, only for external decompressors, which are off) calls dup2, and the pipe helper pipe, which WASI lacks: make them fail with ENOSYS
  printf '#include <errno.h>\n#define dup2(a, b) (errno = ENOSYS, -1)\n#define pipe(a) (errno = ENOSYS, -1)\n' > "$WORK/file/ink_file.h"
  rm -rf "$WORK/file/b" && mkdir -p "$WORK/file/b" && (cd "$WORK/file/b" && CFLAGS="-O2 -include compat.h -include $WORK/file/ink_file.h -I$P/compat $EMU" CPPFLAGS="-I$P/include" LDFLAGS="-L$P/lib" LIBS="-lcompat $EMUL" \
    ac_cv_func_mkstemp=yes ../configure --host=$T --disable-shared --enable-static --disable-libseccomp --disable-zlib --disable-bzlib --disable-xzlib --disable-zstdlib --disable-lzlib >/dev/null &&
    make -C src magic.h >/dev/null && make -C src -j"$J" libmagic.la >/dev/null &&
    $CC -O2 $EMU -I"$P/include" -Isrc -I../src -c ../src/inkmagic.c -o src/inkmagic.o &&
    make -C src -j"$J" file LIBS="inkmagic.o -lz -lcompat $EMUL $STACK" && cp src/file "$OUT/file.wasm")
}

b_less() { # less 692 (Less License, BSD-2-Clause style; the GPL-3.0 option of its dual license is not used): own termcap (xterm capabilities) and termios over host calls (less/termcap.c), size from the host or LINES/COLUMNS, built --with-secure (no shell escapes, pipes, editor, log file, tags, lesskey file: WASI has no processes)
  compat; dl "https://www.greenwoodsoftware.com/less/less-$LESS.tar.gz" less
  tc=$WORK/less-tc; mkdir -p "$tc/include" "$tc/lib"; cp "$here/less/termios.h" "$here/less/termcap.h" "$tc/include/"
  $CC -O2 -I"$tc/include" -c "$here/less/termcap.c" -o "$tc/termcap.o" && $AR rcs "$tc/lib/libtermcap.a" "$tc/termcap.o"
  printf '#include <errno.h>\n#include <setjmp.h>\n#define kill(p, s) (errno = ENOSYS, -1)\n#define sigjmp_buf jmp_buf\n#define sigsetjmp(j, s) setjmp(j)\n#define siglongjmp longjmp\n' > "$WORK/less/ink_less.h" # kill: Ctrl-Z (SIGTSTP to itself) has no job control; setjmp stands in for sigsetjmp (as in bc)
  rm -rf "$WORK/less/b" && mkdir -p "$WORK/less/b" && (cd "$WORK/less/b" && CFLAGS="-O2 $SJLJ -include compat.h -include $WORK/less/ink_less.h -I$tc/include -I$P/compat $EMU" LDFLAGS="-L$tc/lib" LIBS="-ltermcap -lsetjmp $EMUL" \
    ../configure --host=$T --with-regex=posix --with-secure >/dev/null && make -j"$J" less LDFLAGS="-L$tc/lib $STACK" && cp less "$OUT/less.wasm")
}

b_grep() { # GNU grep 3.12 (GPL-3.0-or-later; a separate catalog program, source release in the GitHub release): grep, egrep, fgrep by argv[0]; no PCRE (-P), no NLS; gnulib's own regex/dfa
  compat; dl "https://ftp.gnu.org/gnu/grep/grep-$GREP.tar.xz" grep
  # gnulib needs config.h before any system header: no -include compat.h here. What WASI lacks and gnulib calls: dup, dup2, fchdir, pipe (ENOSYS stubs;
  # grep -r walks with openat/fts without them), getdtablesize, flockfile/funlockfile (no threads); wasi-libc's own opendirat (2 args) clashes with gnulib's (4 args): gnulib's is renamed in its three files
  printf 'int dup(int);\nint dup2(int, int);\nint fchdir(int);\nint getdtablesize(void);\nint pipe(int[2]);\n#define flockfile(f) ((void)0)\n#define funlockfile(f) ((void)0)\n' > "$WORK/grep/ink_grep.h"
  printf '#include <errno.h>\nint dup(int f) { (void)f; errno = ENOSYS; return -1; }\nint dup2(int f, int g) { (void)f; (void)g; errno = ENOSYS; return -1; }\nint fchdir(int f) { (void)f; errno = ENOSYS; return -1; }\nint getdtablesize(void) { return 1024; }\nint pipe(int p[2]) { (void)p; errno = ENOSYS; return -1; }\n' > "$WORK/grep/ink_grep.c"
  $CC -O2 -c "$WORK/grep/ink_grep.c" -o "$WORK/grep/ink_grep.o"
  sed -i "s/\\bopendirat\\b\\([^.]\\)/ink_opendirat\\1/g" "$WORK/grep/lib/fts.c" "$WORK/grep/lib/opendirat.c" "$WORK/grep/lib/opendirat.h"
  # fts: no FTS_CWDFD (it duplicates descriptors with fcntl F_DUPFD_CLOEXEC, which WASI lacks): FTS_NOCHDIR, paths relative to the working directory
  sed -i 's#FTS_CWDFD | FTS_NOSTAT#FTS_NOCHDIR | FTS_NOSTAT#' "$WORK/grep/src/grep.c"
  # program name (wasi-libc leaves program_invocation_short_name empty: "(null): file: error"); egrep/fgrep links run -E/-F
  sed -i 's#^  initialize_main (&argc, &argv);#&\n  { char *b = strrchr (argv[0], 0x2f); b = b ? b + 1 : argv[0]; program_invocation_name = argv[0]; program_invocation_short_name = b;\n    if (!strcmp (b, "egrep")) matcher = setmatcher ("egrep", matcher); else if (!strcmp (b, "fgrep")) matcher = setmatcher ("fgrep", matcher); }#' "$WORK/grep/src/grep.c"
  rm -rf "$WORK/grep/b" && mkdir -p "$WORK/grep/b" && (cd "$WORK/grep/b" && CFLAGS="-O2 -DCOMPAT_CHMOD_OK $EMU -I$P/compat -include $WORK/grep/ink_grep.h" LDFLAGS="-L$P/lib $STACK" LIBS="$WORK/grep/ink_grep.o -lcompat $EMUL" \
    ac_cv_func_fchdir=yes ac_cv_func_getdtablesize=yes ac_cv_func_pipe=yes gl_cv_func_fcntl_f_dupfd_cloexec=yes gl_cv_func_dup2_works=yes gl_cv_func_fdopendir_works=yes \
    ../configure --host=$T --disable-nls --disable-perl-regexp --disable-threads --disable-assert >/dev/null &&
    make -j"$J" -C lib GL_CFLAG_GNULIB_WARNINGS= >/dev/null && make -j"$J" -C src grep GL_CFLAG_GNULIB_WARNINGS= && cp src/grep "$OUT/grep.wasm")
}

b_nano() { # GNU nano 8.3 (GPL-3.0-or-later; a separate catalog program, source release in the GitHub release) over ncurses 6.5 (MIT-style license; terminal database = the built-in xterm-256color entry); termios/ioctl size over host calls (nano/tty.c); ASCII (no UTF-8), no spell checker, no ^T execute (no fork/pipe), no libmagic/mouse/browser
  compat; dl "https://ftp.gnu.org/gnu/ncurses/ncurses-$NCURSES.tar.gz" ncurses; dl "https://ftp.gnu.org/gnu/nano/nano-$NANO.tar.xz" nano
  tc=$WORK/nano-tc; mkdir -p "$tc/include" "$tc/lib"; cp "$here/nano/termios.h" "$here/nano/ink_nano.h" "$here/nano/ink_lib.h" "$tc/include/"
  $CC -O2 $EMU -include "$tc/include/ink_nano.h" -I"$tc/include" -c "$here/nano/tty.c" -o "$tc/tty.o" && $AR rcs "$tc/lib/libinktty.a" "$tc/tty.o"
  # ncurses: static, no widec, no database (the xterm-256color entry is compiled in, by the build host's tic/infocmp)
  rm -rf "$WORK/ncurses/b" && mkdir -p "$WORK/ncurses/b" && (cd "$WORK/ncurses/b" && CFLAGS="-O2 $EMU -include $tc/include/ink_nano.h -I$tc/include" LDFLAGS="-L$tc/lib" LIBS="-linktty $EMUL" CC_FOR_BUILD=cc \
    ../configure --host=$T --prefix="$tc/ncp" --without-progs --without-tests --without-manpages --without-cxx --without-cxx-binding --without-ada --disable-database --with-fallbacks=xterm-256color \
      --with-tic-path=/usr/bin/tic --with-infocmp-path=/usr/bin/infocmp --without-shared --without-debug --without-gpm --without-sysmouse --disable-widec --disable-home-terminfo --disable-leaks \
      --without-pthread --disable-stripping --disable-rpath --enable-pc-files=no --without-dlsym --disable-echo >/dev/null &&
    make -j"$J" -C include >/dev/null && make -j"$J" -C ncurses >/dev/null && make -C include install >/dev/null && make -C ncurses install >/dev/null)
  # gnulib (nano's lib/): no config.h-less system headers before config.h; what WASI lacks is stubbed (nano/tty.c) or cached as present; three gnulib files replaced by stubs (no rlimit, no sigaction struct of its own)
  printf '#include <config.h>\n#include <unistd.h>\nint getdtablesize (void) { return 1024; }\n' > "$WORK/nano/lib/getdtablesize.c"
  printf '#include <config.h>\n' > "$WORK/nano/lib/sig-handler.c"; printf '#include <config.h>\n' > "$WORK/nano/lib/sigaction.c"
  rm -rf "$WORK/nano/b" && mkdir -p "$WORK/nano/b" && (cd "$WORK/nano/b" && CFLAGS="-O2 $EMU -include $tc/include/ink_lib.h -I$P/compat -I$tc/include" CPPFLAGS="-I$tc/ncp/include -I$tc/ncp/include/ncurses" LDFLAGS="-L$tc/lib -L$tc/ncp/lib -L$P/lib $STACK" LIBS="-linktty -lcompat $EMUL" \
    NCURSES_CFLAGS="-I$tc/ncp/include/ncurses" NCURSES_LIBS="-L$tc/ncp/lib -lncurses" \
    gl_cv_func_fcntl_f_dupfd_cloexec=yes gl_cv_func_fcntl_f_dupfd_works=yes gl_cv_func_getdtablesize_works=yes ac_cv_func_sigaction=yes ac_cv_func_sigprocmask=yes ac_cv_func_dup2=yes gl_cv_func_dup2_works=yes ac_cv_func_pipe=yes ac_cv_func_fchdir=yes ac_cv_func_getdtablesize=yes \
    ../configure --host=$T --disable-nls --disable-utf8 --disable-libmagic --disable-speller --disable-browser --disable-threads --disable-mouse >/dev/null &&
    make -j"$J" -C lib GL_CFLAG_GNULIB_WARNINGS= >/dev/null &&
    printf '#define COMPAT_CHMOD_OK 1\n#include <compat.h>\n#include <ink_nano.h>\n' >> config.h && # after gnulib's config.h part: the system headers it wants first
    make -j"$J" -C src nano GL_CFLAG_GNULIB_WARNINGS= CFLAGS="-O2 $EMU -I$P/compat -I$tc/include" >/dev/null && cp src/nano "$OUT/nano.wasm")
}

b_git() { # git 2.47 (GPL-2.0-only; a separate catalog program, source release in the GitHub release): every builtin in one program; no threads, no curl/https (clone/fetch/push over https: apk add --x86 git), no perl/python/tcl commands, no gettext/iconv; child processes (pager, editor, hooks, git maintenance) through the host channel (git/ink_git.c: start_command over compat_spawn); pager off by default (cat), core.filemode false (WASI has no permission bits)
  compat; zlib; dl "https://mirrors.edge.kernel.org/pub/software/scm/git/git-$GIT.tar.xz" git
  g=$WORK/git; cp "$here/git/ink_git.c" "$g/compat/ink_git.c"
  # start_command: the host starts the child and makes its pipes (WASI has no fork/pipe): ink_start_command in compat/ink_git.c
  grep -q ink_start_command "$g/run-command.c" || sed -i '/^int start_command(struct child_process \*cmd)$/,/^\tconst char \*str;$/ s/^\tconst char \*str;$/&\n#ifdef __wasi__\n\treturn ink_start_command(cmd);\n#endif/' "$g/run-command.c"
  grep -q ink_start_command "$g/run-command.c"
  # no "git maintenance run --auto" after commit/merge unless maintenance.auto is set (each run is one more WebAssembly process)
  sed -i 's/^\tif (!git_config_get_bool("maintenance.auto", &enabled) &&$/\tif (git_config_get_bool("maintenance.auto", \&enabled))\n\t\tenabled = 0;\n\tif (!enabled \&\&/' "$g/run-command.c"
  grep -q '^		enabled = 0;$' "$g/run-command.c"
  # merge: "git stash create" (a child process) only when there are local changes to keep; with none it makes no stash anyway
  sed -i 's/^\tif (save_state(&stash))$/\tif ((has_unstaged_changes(the_repository, 1) || has_uncommitted_changes(the_repository, 1)) \&\& save_state(\&stash))/' "$g/builtin/merge.c"
  grep -q 'has_unstaged_changes(the_repository, 1) ||' "$g/builtin/merge.c"
  # pager: only GIT_PAGER or core.pager start one (the terminal's $PAGER is less, a child process): by default git writes straight to the terminal
  sed -i 's/^\t\tpager = getenv("PAGER");$/\t\tpager = NULL;/' "$g/pager.c"; ! grep -q 'getenv("PAGER")' "$g/pager.c"
  # init: no warning when the templates folder is missing (the catalog installs the program only)
  sed -i 's/^\t\twarning(_("templates not found in %s"), template_dir);$/\t\tif (errno != ENOENT)\n&/' "$g/setup.c"
  # 2.47's NO_UNIX_SOCKETS stand-in for credential-cache lacks the repository argument every builtin got
  sed -i 's/^int cmd_credential_cache(int argc, const char \*\*argv, const char \*prefix)$/int cmd_credential_cache(int argc, const char **argv, const char *prefix, struct repository *repo UNUSED)/' "$g/builtin/credential-cache.c"
  cat > "$g/config.mak" <<EOF
CC = $CC
AR = $AR
CFLAGS = -O2 $EMU -DCOMPAT_CHMOD_OK -I$here/git/include -I$P/compat -I$here/compat/termios -I$P/include -include $here/git/ink_git.h
LDFLAGS = -L$P/lib $STACK
EXTLIBS = -lcompat $EMUL
ZLIB_PATH = $P
prefix = /usr/local
sysconfdir = /etc
NO_PTHREADS = YesPlease
NO_MMAP = YesPlease
NO_OPENSSL = YesPlease
NO_CURL = YesPlease
NO_EXPAT = YesPlease
NO_GETTEXT = YesPlease
NO_ICONV = YesPlease
NO_PERL = YesPlease
NO_PYTHON = YesPlease
NO_TCLTK = YesPlease
NO_UNIX_SOCKETS = YesPlease
NO_IPV6 = YesPlease
NO_SETITIMER = YesPlease
NO_STRUCT_ITIMERVAL = YesPlease
NO_TRUSTABLE_FILEMODE = YesPlease
NO_SYMLINK_HEAD = YesPlease
NO_INSTALL_HARDLINKS = YesPlease
NO_POSIX_GOODIES = UnfortunatelyYes
NO_INITGROUPS = YesPlease
NO_MKDTEMP = YesPlease
NO_STRCASESTR = YesPlease
NO_REGEX = YesPlease
NO_GECOS_IN_PWENT = YesPlease
HAVE_CLOCK_GETTIME = YesPlease
HAVE_CLOCK_MONOTONIC = YesPlease
HAVE_GETDELIM = YesPlease
HAVE_ALLOCA_H = YesPlease
CSPRNG_METHOD = getentropy
OBJECT_CREATION_MODE = 1
DEFAULT_PAGER = cat
SHELL_PATH = /bin/sh
COMPAT_OBJS += compat/ink_git.o
EOF
  (cd "$g" && make -k -j"$J" uname_S=WASI uname_M=wasm32 uname_O=WASI uname_R=1 uname_P=wasm32 uname_V=1 V=1 git >"$WORK/git-make.log" 2>&1 || { grep -n "error" "$WORK/git-make.log" | head -40; tail -5 "$WORK/git-make.log"; exit 1; }
    cp git "$OUT/git.wasm")
}

b_vim() { # Vim 9.1 (Vim license: charityware, GPL-compatible; a separate catalog program): normal features, no GUI/X11/channels/jobs/terminal/scripting languages; builtin terminal entries (no termcap library); raw keys and window size through the host's "inksoc" imports (vim/ink_term.c); no fork: :! and :shell report failure; no runtime files (VIMINIT in the program turns nocompatible on)
  compat
  fetch vim/vim v$VIM vim
  v=$WORK/vim/src
  if [ ! -f "$P/lib/libtinfo.a" ]; then # configure insists on a terminal library to link with; HAVE_TGETENT is undone below, so this one is never used
    echo 'int tgetent(char *b, const char *n) { (void)b; (void)n; return 0; }' > "$WORK/tinfo.c"
    $CC -O2 -c "$WORK/tinfo.c" -o "$WORK/tinfo.o" && $AR rcs "$P/lib/libtinfo.a" "$WORK/tinfo.o"
  fi
  $CC -O2 -I"$here/vim/include" -I"$here/vim" -c "$here/vim/ink_term.c" -o "$WORK/ink_term.o" && $AR rcs "$P/lib/libinkterm.a" "$WORK/ink_term.o"
  VCF="-O2 $EMU -I$here/vim/include -I$P/compat -include compat.h -include $here/vim/ink_vim.h"
  (cd "$v" && make distclean >/dev/null 2>&1 || true
    CFLAGS="$VCF" CPPFLAGS="$VCF" LDFLAGS="-L$P/lib $STACK" LIBS="-lcompat -linkterm $EMUL" \
    vim_cv_toupper_broken=no vim_cv_terminfo=yes vim_cv_tgetent=zero vim_cv_getcwd_broken=no vim_cv_stat_ignores_slash=no \
    vim_cv_memmove_handles_overlap=yes vim_cv_memcpy_handles_overlap=no vim_cv_bcopy_handles_overlap=no \
    vim_cv_timer_create=no vim_cv_timer_create_with_lrt=no vim_cv_timer_create_works=no vim_cv_ipv4_networking=no vim_cv_ipv6_networking=no \
    vim_cv_uname_output=Linux vim_cv_uname_r_output=6 vim_cv_uname_m_output=x86_64 \
    ./configure --host=$T --build=x86_64-linux-gnu --with-features=normal --disable-gui --without-x --disable-channel --disable-terminal \
      --disable-netbeans --disable-nls --disable-acl --disable-gpm --disable-sysmouse --disable-selinux --disable-canberra --disable-libsodium \
      --disable-darwin --disable-smack --disable-xim --disable-fontset --disable-icon-cache-update --disable-desktop-database-update \
      --disable-perlinterp --disable-pythoninterp --disable-python3interp --disable-rubyinterp --disable-luainterp --disable-tclinterp --disable-mzschemeinterp \
      --disable-cscope --with-tlib=tinfo --enable-fail-if-missing=no >"$WORK/vim-configure.log" 2>&1 || { tail -60 "$WORK/vim-configure.log"; exit 1; }
    # no termcap library (builtin terminal entries), no dlopen, no gettimeofday (that switches off reltime/timers/profile, which need setitimer);
    # osdef.h (prototypes configure derives from the host's headers) is left empty: wasi-libc's headers are right
    sed -i 's/^#define HAVE_TGETENT 1/\/* #undef HAVE_TGETENT *\//; s/^#define TERMINFO 1/\/* #undef TERMINFO *\//; s/^#define HAVE_DLOPEN 1/\/* #undef HAVE_DLOPEN *\//; s/^#define HAVE_DLSYM 1/\/* #undef HAVE_DLSYM *\//; s/^#define HAVE_GETTIMEOFDAY 1/\/* #undef HAVE_GETTIMEOFDAY *\//' auto/config.h
    : > auto/osdef.h
    sed -i 's/^    mch_early_init();$/    mch_early_init();\n    ink_defaults();/' main.c; grep -q ink_defaults main.c
    sed -i 's/^    return statb.st_mode;$/    return statb.st_mode | 0600; \/* WASI stat has no permission bits: without this every file is read-only *\//' os_unix.c; grep -q '| 0600' os_unix.c
    sed -i 's/\(define mch_stat(n, p)\)\tstat(/\1\tink_stat(/; s/\(define mch_fstat(n, p)\)\tfstat(/\1\tink_fstat(/' macros.h; grep -q ink_stat macros.h; grep -q ink_fstat macros.h
    make -j"$J" vim LIBS="-lm -lcompat -linkterm $EMUL" CC="$CC" >"$WORK/vim-make.log" 2>&1 || { grep -n "error" "$WORK/vim-make.log" | head -30; tail -5 "$WORK/vim-make.log"; exit 1; }
    cp vim "$OUT/vim.wasm")
}

b_diffutils() { # GNU diffutils 3.12 (GPL-3.0-or-later; a separate catalog program, source release in the GitHub release): diff, cmp, diff3, sdiff; no NLS. diff3 and sdiff run diff through popen (the host process channel): WASI has no fork. Stack is 8 MB (diff of a big file used to abort on the 1 MB default).
  compat; dl "https://ftp.gnu.org/gnu/diffutils/diffutils-$DIFFUTILS.tar.xz" diffutils
  d=$WORK/diffutils
  # what WASI lacks and gnulib may call: dup, dup2, fchdir, pipe, getdtablesize (ENOSYS); flockfile has no threads
  printf 'int dup(int);\nint dup2(int, int);\nint fchdir(int);\nint getdtablesize(void);\nint pipe(int[2]);\n#define flockfile(f) ((void)0)\n#define funlockfile(f) ((void)0)\n' > "$d/ink_diff.h"
  printf '#include <errno.h>\nint dup(int f) { (void)f; errno = ENOSYS; return -1; }\nint dup2(int f, int g) { (void)f; (void)g; errno = ENOSYS; return -1; }\nint fchdir(int f) { (void)f; errno = ENOSYS; return -1; }\nint getdtablesize(void) { return 1024; }\nint pipe(int p[2]) { (void)p; errno = ENOSYS; return -1; }\n' > "$d/ink_diff.c"
  $CC -O2 -c "$d/ink_diff.c" -o "$d/ink_diff.o"
  # sdiff without -o replaces itself by execvp("diff"). WASI cannot exec: run that diff through system() (host channel) and leave with its status.
  python3 - "$d/src/sdiff.c" << 'PY'
import sys
from pathlib import Path
p = Path(sys.argv[1])
t = p.read_text()
old = """      diffarg (nullptr);
      execvp (diffargv[0], (char **) diffargv);
      perror_fatal (squote (0, diffargv[0]));"""
new = """      diffarg (nullptr);
#if ! HAVE_WORKING_FORK
      {
        char *command = system_quote_argv (SCI_SYSTEM, (char **) diffargv);
        int st = system (command);
        if (st == -1)
          perror_fatal (command);
        free (command);
        exit ((st & 0xff) == 0 ? (st >> 8) & 0xff : 2);
      }
#else
      execvp (diffargv[0], (char **) diffargv);
      perror_fatal (squote (0, diffargv[0]));
#endif"""
if old not in t:
    if "HAVE_WORKING_FORK" in t and "system_quote_argv (SCI_SYSTEM, (char **) diffargv)" in t:
        sys.exit(0)
    raise SystemExit("sdiff.c: execvp block not found")
p.write_text(t.replace(old, new, 1))
PY
  # WASI's NSIG is 65. Gnulib's fallback sigset is a 32-bit mask and will not compile (verify_NSIG_constraint).
  python3 - "$d/lib/signal.in.h" << 'PY'
import sys
from pathlib import Path
p = Path(sys.argv[1])
t = p.read_text()
old = "#  ifndef NSIG\n#   define NSIG 32\n#  endif\n"
new = "#  undef NSIG\n#  define NSIG 32\n"
if old not in t:
    if new not in t:
        raise SystemExit("signal.in.h: NSIG block not found")
else:
    p.write_text(t.replace(old, new, 1))
PY
  # WASI defines SIGCHLD, so gnulib's Windows sigaction replacement refuses to compile.
  # There is still no sigaction in wasi-libc: keep the replacement (signal() underneath).
  sed -i 's/# error "Revisit the assumptions made in the sigaction module"/\/\* WASI defines SIGCHLD but has no sigaction: keep gnulib'\''s replacement. *\//' "$d/lib/sigaction.c"
  rm -rf "$d/b" && mkdir -p "$d/b" && (cd "$d/b" && CFLAGS="-O2 -DCOMPAT_CHMOD_OK $EMU $SJLJ -I$P/compat -include $d/ink_diff.h" LDFLAGS="-L$P/lib $STACK" LIBS="$d/ink_diff.o -lcompat -lsetjmp $EMUL" \
    ac_cv_func_fork_works=no ac_cv_func_vfork_works=no ac_cv_func_fchdir=yes ac_cv_func_getdtablesize=yes ac_cv_func_pipe=yes ac_cv_func_dup2=yes \
    gl_cv_func_fcntl_f_dupfd_cloexec=yes gl_cv_func_dup2_works=yes gl_cv_func_fdopendir_works=yes \
    gl_cv_func_strcasecmp_works=yes gl_cv_func_getopt_posix=yes \
    ../configure --host=$T --disable-nls --disable-rpath --disable-gcc-warnings >"$WORK/diff-configure.log" 2>&1 || { tail -80 "$WORK/diff-configure.log"; exit 1; }
    # popen/pclose/system and tzset: after config.h (gnulib wants that first). compat.h is the host process channel.
    cfg=lib/config.h; [ -f "$cfg" ] || cfg=config.h
    printf '\n#include <compat.h>\n' >> "$cfg"
    make -j"$J" -C lib GL_CFLAG_GNULIB_WARNINGS= >"$WORK/diff-lib.log" 2>&1 || { grep -n "error:" "$WORK/diff-lib.log" | head -40; tail -20 "$WORK/diff-lib.log"; exit 1; }
    make -j"$J" -C src cmp diff diff3 sdiff GL_CFLAG_GNULIB_WARNINGS= >"$WORK/diff-src.log" 2>&1 || { grep -n "error:" "$WORK/diff-src.log" | head -40; tail -30 "$WORK/diff-src.log"; exit 1; }
    cp src/diff "$OUT/diff.wasm" && cp src/cmp "$OUT/cmp.wasm" && cp src/diff3 "$OUT/diff3.wasm" && cp src/sdiff "$OUT/sdiff.wasm")
}

b_patch() { # GNU patch 2.8.1 (GPL-3.0-or-later; a separate catalog program, source release in the GitHub release): apply a diff; no NLS. Same WASI stubs as diffutils (dup/pipe/fchdir); gnulib opendirat renamed (it clashes with wasi-libc's).
  compat; dl "https://ftp.gnu.org/gnu/patch/patch-$PATCH.tar.xz" patch
  g=$WORK/patch
  printf 'typedef unsigned long rlim_t;\nstruct rlimit { rlim_t rlim_cur; rlim_t rlim_max; };\n#define RLIMIT_NOFILE 7\n#define RLIM_INFINITY (~0UL)\nint dup(int);\nint dup2(int, int);\nint fchdir(int);\nint getdtablesize(void);\nint pipe(int[2]);\nint getrlimit(int, struct rlimit *);\n#define flockfile(f) ((void)0)\n#define funlockfile(f) ((void)0)\n' > "$g/ink_patch.h"
  # no COMPAT_CHMOD_OK: gnulib's rpl_chmod #undefs that macro and then calls chmod, which wasi-libc does provide
  # getrlimit: WASI has no rlimit. safe.c only uses it to size a dirfd cache and already falls back when it fails.
  printf '#include <errno.h>\n#include "ink_patch.h"\nint dup(int f) { (void)f; errno = ENOSYS; return -1; }\nint dup2(int f, int g) { (void)f; (void)g; errno = ENOSYS; return -1; }\nint fchdir(int f) { (void)f; errno = ENOSYS; return -1; }\nint getdtablesize(void) { return 1024; }\nint pipe(int p[2]) { (void)p; errno = ENOSYS; return -1; }\nint getrlimit(int r, struct rlimit *l) { (void)r; (void)l; errno = ENOSYS; return -1; }\n' > "$g/ink_patch.c"
  $CC -O2 -c "$g/ink_patch.c" -o "$g/ink_patch.o"
  sed -i "s/\\bopendirat\\b\\([^.]\\)/ink_opendirat\\1/g" "$g/lib/backupfile.c" "$g/lib/opendirat.c" "$g/lib/opendirat.h"
  # WASI has no permission bits (fchmodat/fchmod are ENOSYS): patch's "set the permissions of the new file" step is a no-op that succeeds
  sed -i 's/return fchmodat (dirfd, pathname, mode, 0);/(void) dirfd; (void) pathname; (void) mode; return 0;/' "$g/src/safe.c"
  sed -i 's/(tofd < 0 ? safe_chmod (to, mode) : fchmod (tofd, mode)) < 0/(tofd < 0 ? safe_chmod (to, mode) : 0) < 0/' "$g/src/util.c"
  grep -q "(void) dirfd; (void) pathname" "$g/src/safe.c" && grep -q "safe_chmod (to, mode) : 0" "$g/src/util.c"
  if [ -f "$g/lib/sigaction.c" ]; then
    sed -i 's/# error "Revisit the assumptions made in the sigaction module"/\/\* WASI defines SIGCHLD but has no sigaction: keep gnulib'\''s replacement. *\//' "$g/lib/sigaction.c"
  fi
  python3 - "$g/lib/signal.in.h" << 'PY'
import sys
from pathlib import Path
p = Path(sys.argv[1])
t = p.read_text()
old = "#  ifndef NSIG\n#   define NSIG 32\n#  endif\n"
new = "#  undef NSIG\n#  define NSIG 32\n"
if old not in t:
    if new not in t:
        raise SystemExit("signal.in.h: NSIG block not found")
else:
    p.write_text(t.replace(old, new, 1))
PY
  rm -rf "$g/b" && mkdir -p "$g/b" && (cd "$g/b" && CFLAGS="-O2 $EMU $SJLJ -I$P/compat -include $g/ink_patch.h" LDFLAGS="-L$P/lib $STACK" LIBS="$g/ink_patch.o -lcompat -lsetjmp $EMUL" \
    ac_cv_func_fork_works=no ac_cv_func_vfork_works=no ac_cv_func_fchdir=yes ac_cv_func_getdtablesize=yes ac_cv_func_pipe=yes ac_cv_func_dup2=yes \
    gl_cv_func_fcntl_f_dupfd_cloexec=yes gl_cv_func_dup2_works=yes gl_cv_func_fdopendir_works=yes \
    gl_cv_func_strcasecmp_works=yes gl_cv_func_getopt_posix=yes \
    ../configure --host=$T --disable-nls --disable-rpath --disable-gcc-warnings >"$WORK/patch-configure.log" 2>&1 || { tail -80 "$WORK/patch-configure.log"; exit 1; }
    cfg=lib/config.h; [ -f "$cfg" ] || cfg=config.h
    printf '\n#include <compat.h>\n' >> "$cfg"
    # cross guess said GETGROUPS_T is int; the declaration uses gid_t (unsigned)
    sed -i 's/^#define GETGROUPS_T int$/#define GETGROUPS_T gid_t/' "$cfg"
    make -j"$J" -C lib GL_CFLAG_GNULIB_WARNINGS= >"$WORK/patch-lib.log" 2>&1 || { grep -n "error:" "$WORK/patch-lib.log" | head -40; tail -20 "$WORK/patch-lib.log"; exit 1; }
    make -j"$J" -C src patch GL_CFLAG_GNULIB_WARNINGS= >"$WORK/patch-src.log" 2>&1 || { grep -n "error:" "$WORK/patch-src.log" | head -40; tail -30 "$WORK/patch-src.log"; exit 1; }
    cp src/patch "$OUT/patch.wasm")
}

b_openssl() { # OpenSSL 3.5 `openssl` command (Apache-2.0): dgst, enc, rand, genpkey, req, x509, passwd, base64, pkey, verify...; no sockets (no s_client/s_server: TLS goes through the x86 helper), no threads, no engines, no asm, no tests/docs; random bytes from WASI random_get
  compat; dl "https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL/openssl-$OPENSSL.tar.gz" openssl
  g=$WORK/openssl
  # `openssl speed` times itself with alarm()/fork: WASI has neither, so it runs without them (HAVE_FORK=0, alarm is a no-op: speed -seconds is not honored)
  printf '#include <compat.h>\n#define alarm(s) ((void)(s), 0u)\n' > "$g/ink_openssl.h"
  (cd "$g" && CFLAGS="-O2 $EMU -I$P/compat -include $g/ink_openssl.h -DHAVE_FORK=0" LDFLAGS="-L$P/lib $STACK" ./Configure linux-generic32 no-asm no-threads no-sock no-dso no-shared no-afalgeng no-ui-console no-tests no-docs no-engine no-async no-secure-memory no-ktls no-comp no-module no-atexit no-autoload-config \
      -lcompat $EMUL --prefix=/usr/local --openssldir=/etc/ssl >"$WORK/openssl-configure.log" 2>&1 || { tail -40 "$WORK/openssl-configure.log"; exit 1; }
    make -j"$J" build_programs >"$WORK/openssl-make.log" 2>&1 || { grep -n "error" "$WORK/openssl-make.log" | head -40; tail -20 "$WORK/openssl-make.log"; exit 1; }
    cp apps/openssl "$OUT/openssl.wasm")
}

b_python3() { # python3 = CPython 3.12.0 (PSF-2.0) from VMware Labs' libpython (the same build as the earlier catalog python3, stdlib zip
  # inside by wasi-vfs) + Pillow 11.3.0 (MIT-CMU) with libjpeg-turbo 3.0.4 (IJG/BSD-3-Clause/zlib); zlib comes in libpython. WASI has no dlopen:
  # Pillow's C modules (_imaging, _imagingmath, _imagingmorph) are built-in modules (python/main.c), its Python package is in the
  # packed /usr/local/lib/python3.12/site-packages. Built with wasi-sdk 20 like libpython, no setjmp (python/shim/setjmp.h): wizer
  # (wasi-vfs pack) takes no wasm exceptions. No freetype/lcms/webp/tiff/openjpeg (ImageFont: only the built-in bitmap font).
  py=$WORK/py; mkdir -p "$py"; C20=$py/wasi-sdk-20.0
  [ -d "$C20" ] || curl -fsSL --retry 3 https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-20/wasi-sdk-20.0-linux.tar.gz | tar -xz -C "$py"
  [ -d "$py/vfs" ] || { curl -fsSL --retry 3 -o "$py/l.zip" https://github.com/kateinoigakukun/wasi-vfs/releases/download/v$WASIVFS/libwasi_vfs-wasm32-unknown-unknown.zip &&
    curl -fsSL --retry 3 -o "$py/c.zip" https://github.com/kateinoigakukun/wasi-vfs/releases/download/v$WASIVFS/wasi-vfs-cli-x86_64-unknown-linux-gnu.zip &&
    mkdir -p "$py/vfs" && unzip -q -o "$py/l.zip" -d "$py/vfs" && unzip -q -o "$py/c.zip" -d "$py/vfs" && chmod +x "$py/vfs/wasi-vfs"; }
  [ -d "$py/binaryen" ] || { mkdir -p "$py/binaryen" && curl -fsSL --retry 3 https://github.com/WebAssembly/binaryen/releases/download/version_$BINARYEN/binaryen-version_$BINARYEN-x86_64-linux.tar.gz | tar -xz -C "$py/binaryen" --strip-components=1; }
  [ -d "$py/lp" ] || { mkdir -p "$py/lp" && curl -fsSL --retry 3 "https://github.com/vmware-labs/webassembly-language-runtimes/releases/download/$PYWLR/libpython-3.12.0-wasi-sdk-20.0.tar.gz" | tar -xz -C "$py/lp"; }
  [ -d "$py/pillow" ] || { curl -fsSL --retry 3 -o "$OUT/src-pillow-$PILLOW.tar.gz" "$PILLOW_URL" && echo "$PILLOW_SHA  $OUT/src-pillow-$PILLOW.tar.gz" | sha256sum -c - &&
    mkdir -p "$py/pillow" && tar -xzf "$OUT/src-pillow-$PILLOW.tar.gz" -C "$py/pillow" --strip-components=1; }
  c20="$C20/bin/clang --target=wasm32-wasi --sysroot=$C20/share/wasi-sysroot"; jp=$py/jpeg
  if [ ! -f "$jp/lib/libjpeg.a" ]; then # libjpeg-turbo with wasi-sdk 20, the library only (its tools and examples use setjmp)
    [ -d "$WORK/libjpeg" ] || { mkdir -p "$WORK/libjpeg" && curl -fsSL --retry 3 https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/$JPEG/libjpeg-turbo-$JPEG.tar.gz | tar -xz -C "$WORK/libjpeg" --strip-components=1; }
    CMAKE_POLICY_VERSION_MINIMUM=3.5 cmake -S "$WORK/libjpeg" -B "$py/jpeg-b" -G Ninja -DCMAKE_TOOLCHAIN_FILE="$C20/share/cmake/wasi-sdk.cmake" -DWASI_SDK_PREFIX="$C20" \
      -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_BUILD_TYPE=Release -DENABLE_SHARED=OFF -DWITH_SIMD=OFF -DWITH_TURBOJPEG=OFF -DWITH_TOOLS=OFF -DWITH_TESTS=OFF >/dev/null
    cmake --build "$py/jpeg-b" -j"$J" --target jpeg-static
    mkdir -p "$jp/lib" "$jp/include" && cp "$py/jpeg-b/libjpeg.a" "$jp/lib/" &&
      cp "$WORK/libjpeg/jpeglib.h" "$WORK/libjpeg/jmorecfg.h" "$WORK/libjpeg/jerror.h" "$py/jpeg-b/jconfig.h" "$jp/include/"
  fi
  z=$py/zinc # zlib headers only: libpython has zlib inside
  [ -f "$z/zlib.h" ] || { mkdir -p "$z" && curl -fsSL --retry 3 https://github.com/madler/zlib/releases/download/v$ZLIB/zlib-$ZLIB.tar.gz | tar -xz -C "$z" --strip-components=1; }
  s=$py/pillow/src; o=$py/obj; rm -rf "$o"; mkdir -p "$o"; n=0
  for f in "$s"/_imaging.c "$s"/decode.c "$s"/encode.c "$s"/map.c "$s"/display.c "$s"/outline.c "$s"/path.c "$s"/libImaging/*.c "$s"/_imagingmath.c "$s"/_imagingmorph.c; do
    $c20 -O2 -w -I"$here/python/shim" -I"$py/lp/include/python3.12" -I"$jp/include" -I"$z" -I"$s" -I"$s/libImaging" \
      -DHAVE_LIBJPEG -DHAVE_LIBZ -DPILLOW_VERSION="\"$PILLOW\"" -c "$f" -o "$o/$(basename "$(dirname "$f")")_$(basename "$f" .c).o" &
    n=$((n + 1)); [ $((n % J)) -eq 0 ] && wait
  done; wait
  for f in "$s"/_imaging.c "$s"/decode.c "$s"/libImaging/*.c "$s"/_imagingmath.c "$s"/_imagingmorph.c; do
    [ -f "$o/$(basename "$(dirname "$f")")_$(basename "$f" .c).o" ] || { echo "python3: $f did not compile"; exit 1; }; done
  $c20 -O2 -I"$py/lp/include/python3.12" -c "$here/python/main.c" -o "$o/main.o"
  $c20 -o "$py/python.wasm" "$o"/*.o "$jp/lib/libjpeg.a" -L"$py/lp/lib/wasm32-wasi" -lpython3.12 -L"$py/vfs" -lwasi_vfs \
    -Wl,-z,stack-size=524288 -Wl,--stack-first -Wl,--initial-memory=10485760 -lwasi-emulated-getpid -lwasi-emulated-signal -lwasi-emulated-process-clocks
  r=$py/root; rm -rf "$r"; d=$r/usr/local/lib/python3.12; mkdir -p "$d" # the tree VMware packs (stdlib zip, os.py landmark) + PIL
  cp -r "$py/lp/usr/local/lib/." "$r/usr/local/lib/"; mkdir -p "$d/site-packages"; cp -r "$s/PIL" "$d/site-packages/"; rm -f "$d/site-packages/PIL/"*.pyi
  if python3 -c 'import sys; sys.exit(sys.version_info[:2] != (3, 12))' 2>/dev/null; then # the packed tree is read-only: ship the bytecode
    python3 -m compileall -q --invalidation-mode unchecked-hash "$d/site-packages/PIL"; fi
  "$py/vfs/wasi-vfs" pack "$py/python.wasm" --mapdir /usr::"$r/usr" -o "$py/packed.wasm"
  "$py/binaryen/bin/wasm-opt" -O2 -o "$OUT/python3.wasm" "$py/packed.wasm" # libpython is built -O0 for this step, as VMware does
}

# b_ prefix: functions named zip, unzip... would hide those commands
for t in "$@"; do case $t in 7zz) sevenzip ;; ffmpeg|magick|qpdf) $t ;; sqlite3|jq|lua|zip|unzip|rg|hashsum|coreutils|qjs|sed|find|awk|xz|tar|gzip|bzip2|zstd|bc|file|less|grep|vim|nano|curl|git|python3|diffutils|patch|openssl) b_$t ;; *) echo "unknown tool $t"; exit 2 ;; esac; done
ls -l "$OUT"
