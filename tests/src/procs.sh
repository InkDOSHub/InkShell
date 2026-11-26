# Item 78: processes from the catalog's C/Rust WebAssembly tools (compat system/popen, find -exec patch).
# Run by tests/linux-test.mjs with INK_SPAWN=1 INK_WASI_THREADS=1.
/root/awk.wasm 'BEGIN { r = system("sh -c \"exit 4\""); print "awk-sys", r; "echo piped" | getline x; print "awk-get", x; print "z" | "sort"; print "a" | "sort"; close("sort"); print "awk-end" }'
/root/lua.wasm -e 'print("lua-x", os.execute("sh -c \"exit 5\"")); local f = io.popen("echo lp"); print("lua-p", f:read("l")); print("lua-c", f:close())'
mkdir -p /tmp/fx && touch /tmp/fx/a /tmp/fx/b
/root/find.wasm /tmp/fx -type f -exec echo fe {} \; | sort
/root/find.wasm /tmp/fx -type f -exec echo fp {} +
/root/find.wasm /tmp/fx -name a -exec /root/jq.wasm -n '"fj " + "{}"' \;
echo procs-end
