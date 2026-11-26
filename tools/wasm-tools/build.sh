#!/bin/sh
# Builds WebAssembly (WASI preview1) command-line tools for the catalog (apk add) from upstream sources.
# usage: tools/wasm-tools/build.sh TOOL...   TOOL = ffmpeg | magick | qpdf | 7zz | sqlite3 | jq | lua | zip | unzip | rg | hashsum | coreutils | qjs | sed | find | awk
# env: WASI_SDK (wasi-sdk-33 or later: C++ exceptions), WORK (sources, build dirs), OUT (the .wasm files)
# CI: .github/workflows/wasm-tools.yml builds them and publishes a GitHub release; the catalog points at it.
# No GPL: ffmpeg is built without --enable-gpl and without external libraries (LGPL-2.1+),
# 7-Zip without the unRAR code (LGPL-2.1+ and BSD-3-Clause), qpdf (Apache-2.0), ImageMagick (its own Apache-style license),
# SQLite (public domain), jq (MIT), Lua (MIT), Info-ZIP zip/unzip (Info-ZIP license, BSD-style), ripgrep (MIT or Unlicense), hashsum (InkShell's own code, MIT), uutils coreutils (MIT), QuickJS-ng (MIT), uutils sed (MIT), uutils findutils find (MIT; oniguruma BSD-2-Clause inside), one-true-awk (MIT-style Bell Labs license).
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
SQLITE=3470200 SQLITE_YEAR=2024 JQ=1.7.1 LUA=5.4.7 ZIP=3.0 UNZIP=6.0 RG=14.1.1 UUTILS=0.8.0 QJS=v0.18.0 USED=0.3.0 UFIND=0.9.1 OTAWK=20240728

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
  mkdir -p "$WORK/$2" && tar -xzf "$OUT/src-${1##*/}" -C "$WORK/$2" --strip-components=1
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

b_lua() { # Lua 5.4 interpreter (C setjmp/longjmp errors), no POSIX extras: io.popen, os.execute, os.tmpname, io.tmpfile report failure
  compat; dl "https://www.lua.org/ftp/lua-$LUA.tar.gz" lua
  printf '%s\n' '#include <errno.h>' '#include <setjmp.h>' '#include <string.h>' '#include <unistd.h>' 'int system(const char *);' \
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

b_coreutils() { # uutils coreutils 0.8.0 (Rust, wasm32-wasip1), multicall "coreutils": the utilities upstream builds for WASI (feat_wasm), picked by argv[0] (ls, cat, cp, sort...)
  fetch uutils/coreutils $UUTILS uutils
  rustup target add wasm32-wasip1
  (cd "$WORK/uutils" && env -u CC -u CXX -u AR -u RANLIB -u NM -u STRIP CARGO_PROFILE_RELEASE_DEBUG=0 CARGO_PROFILE_RELEASE_STRIP=true \
    CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="-C link-arg=--undefined=chdir" \
    cargo build --release --locked --target wasm32-wasip1 --no-default-features --features feat_wasm)
  cp "$WORK/uutils/target/wasm32-wasip1/release/coreutils.wasm" "$OUT/coreutils.wasm"
}

b_qjs() { # QuickJS-ng (MIT) `qjs`: JavaScript (ES2023+, modules, std/os libs, REPL), WASI build upstream supports (no threads, no atomics); compiled directly, no CMake
  fetch quickjs-ng/quickjs $QJS quickjs
  (cd "$WORK/quickjs" && $CC -O2 -fwrapv -D_GNU_SOURCE -DQJS_BUILD_LIBC $EMU dtoa.c libregexp.c libunicode.c quickjs.c quickjs-libc.c gen/repl.c gen/standalone.c qjs.c \
    -o "$OUT/qjs.wasm" $EMUL $STACK -lm)
}

b_sed() { # uutils sed 0.3.0 (MIT, Rust, wasm32-wasip1): -n -e -f -E -i -s -z, y///, hold space, w files; one thread (WASI has none)
  fetch uutils/sed $USED uutilssed
  rustup target add wasm32-wasip1
  (cd "$WORK/uutilssed" && env -u CC -u CXX -u AR -u RANLIB -u NM -u STRIP CARGO_PROFILE_RELEASE_DEBUG=0 CARGO_PROFILE_RELEASE_STRIP=true \
    CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="-C link-arg=--undefined=chdir" \
    cargo build --release --locked --target wasm32-wasip1 --bin sed)
  cp "$WORK/uutilssed/target/wasm32-wasip1/release/sed.wasm" "$OUT/sed.wasm"
}

b_find() { # uutils findutils 0.9.1 `find` (MIT, Rust, wasm32-wasip1; its regex crate onig_sys compiles oniguruma, BSD-2-Clause, C, with wasi-sdk); no -exec/-ok (WASI has no processes)
  fetch uutils/findutils $UFIND uutilsfind
  rustup target add wasm32-wasip1
  (cd "$WORK/uutilsfind" && env CC_wasm32_wasip1="$CC" AR_wasm32_wasip1="$AR" CARGO_PROFILE_RELEASE_DEBUG=0 CARGO_PROFILE_RELEASE_STRIP=true \
    CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="-C link-arg=--undefined=chdir" \
    cargo build --release --locked --target wasm32-wasip1 --bin find)
  cp "$WORK/uutilsfind/target/wasm32-wasip1/release/find.wasm" "$OUT/find.wasm"
}

b_awk() { # one-true-awk (Bell Labs, MIT-style license, C): the parser comes from bison (its output is not GPL: bison's exception), maketab runs on the build host
  compat
  if [ ! -d "$WORK/awk" ]; then
    git -c advice.detachedHead=false clone -q --depth 1 --branch "$OTAWK" https://github.com/onetrue-awk/awk.git "$WORK/awk" ||
      git clone -q --depth 1 https://github.com/onetrue-awk/awk.git "$WORK/awk"
    git -C "$WORK/awk" rev-parse HEAD; git -C "$WORK/awk" archive --prefix="awk-$OTAWK/" -o "$OUT/src-awk-$OTAWK.tar.gz" HEAD
  fi
  (cd "$WORK/awk" && bison -y -d awkgram.y && cp y.tab.c ytab.c && cp y.tab.h ytab.h && gcc -O1 -w maketab.c -o maketab && ./maketab ytab.h > proctab.c)
  printf '%s\n' 'int system(const char *);' > "$WORK/awk/wasi.h"
  (cd "$WORK/awk" && $CC -O2 -w $EMU -I"$P/compat" -include compat.h -include wasi.h -Wno-implicit-function-declaration \
    ytab.c b.c lex.c lib.c main.c parse.c proctab.c run.c tran.c -o "$OUT/awk.wasm" -L"$P/lib" -lcompat $EMUL $STACK -lm)
}

# b_ prefix: functions named zip, unzip... would hide those commands
for t in "$@"; do case $t in 7zz) sevenzip ;; ffmpeg|magick|qpdf) $t ;; sqlite3|jq|lua|zip|unzip|rg|hashsum|coreutils|qjs|sed|find|awk) b_$t ;; *) echo "unknown tool $t"; exit 2 ;; esac; done
ls -l "$OUT"
