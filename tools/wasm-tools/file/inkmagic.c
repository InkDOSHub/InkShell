/* InkShell: loads libmagic's compiled database (magic.mgc) from inside the program, so `file` works with no data
 * file beside it (the catalog installs one file per program). The database is stored gzip-compressed
 * (magic_mgc_gz.h, made by build.sh) and inflated once at start. -m FILE and the MAGIC variable still load a
 * file from disk. BSD-2-Clause, same license as file(1). */
#include <stdlib.h>
#include <string.h>
#include <zlib.h>
#include <magic.h>
#include "magic_mgc_gz.h"

int ink_magic_load(magic_t ms, const char *magicfile) {
	if (magicfile != NULL || getenv("MAGIC") != NULL) return magic_load(ms, magicfile);
	size_t cap = (size_t)magic_mgc_size;
	/* 8-byte aligned: apprentice reads structs straight from the buffer */
	unsigned char *out = aligned_alloc(8, (cap + 7) & ~(size_t)7);
	if (out == NULL) return magic_load(ms, magicfile);
	z_stream z;
	memset(&z, 0, sizeof z);
	if (inflateInit2(&z, 31) != Z_OK) { free(out); return magic_load(ms, magicfile); }
	z.next_in = (Bytef *)magic_mgc_gz; z.avail_in = (uInt)sizeof magic_mgc_gz;
	z.next_out = out; z.avail_out = (uInt)cap;
	int r = inflate(&z, Z_FINISH);
	inflateEnd(&z);
	if (r != Z_STREAM_END || z.total_out != cap) { free(out); return magic_load(ms, magicfile); }
	void *bufs[1] = { out };
	size_t sizes[1] = { cap };
	/* the buffer stays allocated: libmagic keeps pointers into it for the life of the process */
	return magic_load_buffers(ms, bufs, sizes, 1);
}
