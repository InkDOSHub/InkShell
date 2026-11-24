# Syscall audit (bench.yml): x86 programs from Alpine the terminal uses, run in the engine as root;
# after each one "@@A name: nr\tcount ..." = system calls answered ENOSYS so far (/proc/inksoc/enosys).
a() { echo "@@A $1: $(cat /proc/inksoc/enosys 2>/dev/null | tr '\t\n' ': ')"; }
export GIT_PAGER=cat PAGER=cat TERM=dumb HOME=/root PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd /tmp && a start
ls -la / >/dev/null; stat /etc/passwd; du -sh /usr/lib | tail -1; cp /bin/busybox /tmp/bb; cp --reflink=auto /tmp/bb /tmp/bb2; cmp /tmp/bb /tmp/bb2 && echo cp-ok
sort /etc/passwd | head -1; find /etc -newer /etc/passwd -name '*.conf' | head -2; grep -r root /etc/passwd; date; df -h / | tail -1; a coreutils
bash -c 'echo bash $BASH_VERSION; x=$(seq 3 | tr "\n" +); echo ${x}0; read -t 0.1 y < /dev/null; mapfile l < /etc/passwd; echo ${#l[@]} lines'; a bash
seq 20000 > s.txt; gzip -k s.txt && gzip -t s.txt.gz && xz -k s.txt && xz -t s.txt.xz && tar -cJf s.tar.xz s.txt && tar -tJf s.tar.xz && tar -czf s.tgz s.txt && tar -xzf s.tgz -C /root && echo pack-ok; a tar-gzip-xz
sqlite3 /tmp/d.db 'create table t(a,b); insert into t values(1,'"'"'x'"'"'),(2,'"'"'y'"'"'); select count(*), sum(a) from t; pragma journal_mode=wal; insert into t values(3,'"'"'z'"'"'); select * from t;'; a sqlite3
python3 - <<'PY'
import os, sys, json, sqlite3, subprocess, shutil, tempfile, hashlib, socket, threading, time, select, mmap, signal
print("py", sys.version.split()[0])
d = tempfile.mkdtemp(); p = os.path.join(d, "f"); open(p, "wb").write(os.urandom(300000))
shutil.copyfile(p, p + "2"); shutil.copy2(p, p + "3"); print("copy", open(p, "rb").read() == open(p + "2", "rb").read())
print(subprocess.run(["echo", "sub"], capture_output=True, text=True).stdout.strip(), subprocess.check_output("echo sh", shell=True).decode().strip())
c = sqlite3.connect(os.path.join(d, "x.db")); c.execute("create table t(a)"); c.execute("insert into t values (1)"); c.commit(); print("sqlite", c.execute("select * from t").fetchall())
t = threading.Thread(target=lambda: time.sleep(0.05)); t.start(); t.join(); print("thread ok")
a, b = socket.socketpair(); a.send(b"hi"); print("sock", b.recv(2))
with open(p, "r+b") as f: m = mmap.mmap(f.fileno(), 0); print("mmap", len(m)); m.close()
print("stat", os.stat(p).st_size, len(os.listdir(d)), hashlib.sha256(b"x").hexdigest()[:8], json.dumps({"a": 1}))
shutil.rmtree(d); print("py-done")
PY
a python3
git config --global user.email t@t; git config --global user.name t; git config --global init.defaultBranch main
rm -rf /tmp/r && git init -q /tmp/r && cd /tmp/r && seq 100 > a && git add a && git commit -qm one && echo x >> a && git commit -qam two && git log --oneline | wc -l && git diff HEAD~1 --stat && git status --short && git gc -q && git clone -q /tmp/r /tmp/r2 && ls /tmp/r2 && echo git-ok; cd /tmp; a git
apk info -v 2>/dev/null | head -3; apk --no-network update 2>&1 | tail -1; getent passwd root; echo hé | iconv -f UTF-8 -t ASCII//TRANSLIT; scanelf -q /bin/busybox; a apk-and-friends
timeout 1 tail -f /etc/passwd >/dev/null; seq 50000 | sort --parallel=2 -n | tail -1; xz -T2 -k -f s.txt && echo xzT-ok; ls --color=always / >/dev/null; a coreutils-2
python3 -c 'import os, concurrent.futures as c; print("pool", sum(c.ThreadPoolExecutor(2).map(abs, [-1, -2])), os.cpu_count(), len(os.sched_getaffinity(0)))'; python3 -m pip --version 2>&1 | tail -1; python3 -c 'import ssl, urllib.request, asyncio; asyncio.run(asyncio.sleep(0.01)); print("asyncio ok")'; a python3-2
cd /tmp/r && git blame a | tail -1 && git grep -c 1 && echo y >> a && git stash -q && git stash pop -q && git checkout -qb b2 && git log --stat -1 | tail -1 && echo git2-ok; cd /tmp; a git-2
wget -q -T 2 -O - http://127.0.0.1:9/ 2>&1 | tail -1; a wget
echo "@@ENOSYS-TOTAL $(cat /proc/inksoc/enosys | tr '\t\n' ': ')"
echo "@@T done"
