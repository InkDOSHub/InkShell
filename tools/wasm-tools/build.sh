#!/bin/sh
# Builds WebAssembly (WASI preview1) command-line tools for the catalog (apk add) from upstream sources.
# usage: tools/wasm-tools/build.sh TOOL...   TOOL = ffmpeg | magick | qpdf | 7zz
# env: WASI_SDK (wasi-sdk-33 or later: C++ exceptions), WORK (sources, build dirs), OUT (the .wasm files)
# CI: .github/workflows/wasm-tools.yml builds them and publishes a GitHub release; the catalog points at it.
# No GPL: ffmpeg is built without --enable-gpl and without external libraries (LGPL-2.1+),
# 7-Zip without the unRAR code (LGPL-2.1+ and BSD-3-Clause), qpdf (Apache-2.0), ImageMagick (its own Apache-style license).
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
STACK="-Wl,-z,stack-size=8388608"

ZLIB=1.3.1 PNG=1.6.44 JPEG=3.0.4 FFMPEG=5.1.9 MAGICK=7.1.1-41 QPDF=11.9.1 SEVENZIP=24.08

fetch() { # github repo, tag, dir name: shallow clone once into $WORK/dir; a source tarball goes next to the binaries (LGPL)
  [ -d "$WORK/$3" ] && return 0
  echo "fetch $1 $2"
  git -c advice.detachedHead=false clone -q --depth 1 --branch "$2" "https://github.com/$1.git" "$WORK/$3"
  git -C "$WORK/$3" archive --prefix="$3-$2/" -o "$OUT/src-$3-$2.tar.gz" HEAD
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

for t in "$@"; do case $t in 7zz) sevenzip ;; ffmpeg|magick|qpdf) $t ;; *) echo "unknown tool $t"; exit 2 ;; esac; done
ls -l "$OUT"
