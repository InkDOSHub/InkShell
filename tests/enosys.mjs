// Audit of Linux system calls the engine answered ENOSYS (export linux_enosys, also /proc/inksoc/enosys).
// enosys(x, mem) -> [[nr, name, times], ...] sorted by times; report() prints one line.
const N = { 9: 'mmap', 27: 'mincore', 29: 'shmget', 30: 'shmat', 31: 'shmctl', 64: 'semget', 65: 'semop', 66: 'semctl', 67: 'shmdt', 68: 'msgget',
  101: 'ptrace', 103: 'syslog', 125: 'capget', 126: 'capset', 133: 'mknod', 135: 'personality', 136: 'ustat', 139: 'sysfs', 148: 'sched_rr_get_interval',
  153: 'vhangup', 155: 'pivot_root', 161: 'chroot', 163: 'acct', 164: 'settimeofday', 165: 'mount', 166: 'umount2', 169: 'reboot', 170: 'sethostname',
  175: 'init_module', 205: 'set_thread_area', 206: 'io_setup', 211: 'get_thread_area', 216: 'remap_file_pages', 219: 'restart_syscall',
  220: 'semtimedop', 227: 'clock_settime', 237: 'mbind', 238: 'set_mempolicy', 239: 'get_mempolicy', 240: 'mq_open', 248: 'add_key', 249: 'request_key',
  250: 'keyctl', 251: 'ioprio_set', 252: 'ioprio_get', 253: 'inotify_init', 254: 'inotify_add_watch', 255: 'inotify_rm_watch', 259: 'mknodat',
  261: 'futimesat', 272: 'unshare', 274: 'get_robust_list', 275: 'splice', 276: 'tee', 278: 'vmsplice', 279: 'move_pages', 282: 'signalfd',
  289: 'signalfd4', 294: 'inotify_init1', 297: 'rt_tgsigqueueinfo', 298: 'perf_event_open', 299: 'recvmmsg', 300: 'fanotify_init', 303: 'name_to_handle_at',
  305: 'clock_adjtime', 307: 'sendmmsg', 308: 'setns', 310: 'process_vm_readv', 312: 'kcmp', 314: 'sched_setattr', 315: 'sched_getattr', 317: 'seccomp',
  319: 'memfd_create', 321: 'bpf', 323: 'userfaultfd', 324: 'membarrier', 329: 'pkey_mprotect', 330: 'pkey_alloc', 333: 'io_pgetevents',
  424: 'pidfd_send_signal', 425: 'io_uring_setup', 426: 'io_uring_enter', 427: 'io_uring_register', 434: 'pidfd_open', 435: 'clone3', 437: 'openat2',
  438: 'pidfd_getfd', 440: 'process_madvise', 442: 'mount_setattr', 447: 'memfd_secret', 448: 'process_mrelease', 449: 'futex_waitv', 450: 'set_mempolicy_home_node',
  451: 'cachestat', 453: 'map_shadow_stack', 454: 'futex_wake', 457: 'statmount', 458: 'listmount', 462: 'mseal' };
export const sysName = (n) => N[n] || `#${n}`;
export function enosys(x, mem) {
  if (!x.linux_enosys) return null; // an older engine
  const n = x.linux_enosys();
  const t = new TextDecoder().decode(new Uint8Array(mem.buffer, x.out_ptr(), n).slice());
  return t.split('\n').filter(Boolean).map((l) => l.split('\t').map(Number)).map(([nr, k]) => [nr, sysName(nr), k]).sort((a, b) => b[2] - a[2] || a[0] - b[0]);
}
export function report(x, mem, tag = 'ENOSYS') {
  const r = enosys(x, mem);
  return r === null ? `${tag}: (engine without linux_enosys)` : `${tag}: ${r.length ? r.map(([nr, nm, k]) => `${nr} ${nm} ×${k}`).join(', ') : 'none'}`;
}
