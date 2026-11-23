// Contents of a Linux file. Small files stay in the engine's memory; a file that grows past
// BIG bytes moves to 64 KB extents (16 contiguous 4 KB swap slots: the page's OPFS swap file, a
// Map in node), so big files (a 1 GB copy, a zip) do not live in the engine's heap. An extent is
// read or written with one host call (host_swap_readv/writev), through a write-back cache of
// CACHE extents (oldest half dropped when full); a write that reaches the end of an extent sends
// it out at once (streaming writes do not fill the cache), a read of part of one reads it whole.

use crate::mmu::Mmu;
use std::collections::HashMap;

pub const BLK: usize = 4096;
/// 4 KB blocks per extent.
pub const EXT_BLKS: u32 = 16;
pub const EXT: usize = BLK * EXT_BLKS as usize;
/// A file written past this size moves to blocks.
pub const BIG: u64 = 1 << 20;
const NONE: u32 = u32::MAX; // an extent never written: reads as zeros
const CACHE: usize = 64; // extents (4 MB)

pub enum Data {
    Mem(Vec<u8>),
    /// `ext[j] = (first slot, written blocks)` holds bytes [j*EXT, (j+1)*EXT); a block whose bit
    /// is clear reads as zeros, and so do bytes past `len`.
    Blk { len: u64, ext: Vec<(u32, u16)> },
}

impl From<Vec<u8>> for Data {
    fn from(v: Vec<u8>) -> Self { Data::Mem(v) }
}

struct Ent { b: Vec<u8>, dirty: bool, tick: u64 }

#[derive(Default)]
pub struct Cache { ext: HashMap<u32, Ent>, tick: u64 }

/// The bits of blocks [a, b) of an extent.
fn bits(a: usize, b: usize) -> u16 { (((1u32 << b) - 1) & !((1u32 << a) - 1)) as u16 }

/// Zeros the blocks of `b` (one extent) whose bit is clear in `mask`.
fn zero_unwritten(b: &mut [u8], mask: u16) {
    if mask == 0xFFFF { return; }
    for k in 0..EXT_BLKS as usize { if mask & (1 << k) == 0 { b[k * BLK..(k + 1) * BLK].fill(0); } }
}

impl Cache {
    fn room(&mut self, m: &mut Mmu) {
        if self.ext.len() < CACHE { return; }
        let mut v: Vec<(u64, u32)> = self.ext.iter().map(|(k, p)| (p.tick, *k)).collect();
        v.sort_unstable();
        for (_, k) in v.into_iter().take(CACHE / 2) {
            let p = self.ext.remove(&k).unwrap();
            if p.dirty { m.slot_writev(k, &p.b); }
        }
    }
    /// The cached extent starting at slot `s` (read in when missing; `mask`: its written blocks).
    fn load(&mut self, m: &mut Mmu, s: u32, mask: u16) -> &mut Ent {
        self.tick += 1;
        if !self.ext.contains_key(&s) {
            self.room(m);
            let mut b = vec![0u8; EXT];
            if mask != 0 { m.slot_readv(s, &mut b); zero_unwritten(&mut b, mask); }
            self.ext.insert(s, Ent { b, dirty: false, tick: 0 });
        }
        let t = self.tick;
        let p = self.ext.get_mut(&s).unwrap();
        p.tick = t;
        p
    }
    /// Writes the extent out now (when dirty) and drops it.
    fn flush(&mut self, m: &mut Mmu, s: u32) {
        if let Some(p) = self.ext.remove(&s) { if p.dirty { m.slot_writev(s, &p.b); } }
    }
    fn forget(&mut self, s: u32) { self.ext.remove(&s); }
    /// The extent as it is now, whole, in `b`.
    fn get(&mut self, m: &mut Mmu, s: u32, mask: u16, b: &mut [u8]) {
        match self.ext.get(&s) {
            Some(p) => b.copy_from_slice(&p.b),
            None => { if mask != 0 { m.slot_readv(s, b); zero_unwritten(b, mask); } else { b.fill(0); } }
        }
    }
    pub fn cached(&self) -> usize { self.ext.len() }
}

impl Data {
    /// An empty file that keeps its bytes in blocks from the start (a big file being unpacked).
    pub fn new_blk() -> Data { Data::Blk { len: 0, ext: Vec::new() } }
    pub fn len(&self) -> u64 { match self { Data::Mem(v) => v.len() as u64, Data::Blk { len, .. } => *len } }
    pub fn is_empty(&self) -> bool { self.len() == 0 }
    pub fn is_blk(&self) -> bool { matches!(self, Data::Blk { .. }) }
    /// The bytes of a file kept in memory (empty for one in blocks): for small system files.
    pub fn mem(&self) -> &[u8] { match self { Data::Mem(v) => v, Data::Blk { .. } => &[] } }

    /// Up to `n` bytes from `off` (fewer at the end of the file).
    pub fn read(&self, c: &mut Cache, m: &mut Mmu, off: u64, n: usize) -> Vec<u8> {
        let len = self.len();
        let s = off.min(len);
        let k = (n as u64).min(len - s) as usize;
        match self {
            Data::Mem(v) => v[s as usize..s as usize + k].to_vec(),
            Data::Blk { ext, .. } => {
                let mut out = vec![0u8; k];
                let mut o = 0;
                while o < k {
                    let p = s + o as u64;
                    let (j, at) = ((p / EXT as u64) as usize, (p % EXT as u64) as usize);
                    let t = (EXT - at).min(k - o);
                    let (sl, mask) = ext[j];
                    if sl != NONE && mask != 0 {
                        // a whole extent nobody has in the cache: straight into the result
                        if t == EXT && !c.ext.contains_key(&sl) { m.slot_readv(sl, &mut out[o..o + EXT]); zero_unwritten(&mut out[o..o + EXT], mask); }
                        else { let pg = c.load(m, sl, mask); out[o..o + t].copy_from_slice(&pg.b[at..at + t]); }
                    }
                    o += t;
                }
                out
            }
        }
    }
    /// The whole file.
    pub fn all(&self, c: &mut Cache, m: &mut Mmu) -> Vec<u8> {
        match self { Data::Mem(v) => v.clone(), Data::Blk { len, .. } => self.read(c, m, 0, *len as usize) }
    }

    /// Writes `d` at `off`, growing the file (with zeros in any gap).
    pub fn write(&mut self, c: &mut Cache, m: &mut Mmu, off: u64, d: &[u8]) {
        let end = off + d.len() as u64;
        if let Data::Mem(v) = self {
            if end <= BIG {
                if (v.len() as u64) < end { v.resize(end as usize, 0); }
                v[off as usize..end as usize].copy_from_slice(d);
                return;
            }
        }
        self.spill(m);
        if end > self.len() { self.resize(c, m, end); }
        let Data::Blk { ext, .. } = self else { unreachable!() };
        let mut o = 0;
        while o < d.len() {
            let p = off + o as u64;
            let (j, at) = ((p / EXT as u64) as usize, (p % EXT as u64) as usize);
            let t = (EXT - at).min(d.len() - o);
            if ext[j].0 == NONE { ext[j] = (m.run_new(EXT_BLKS), 0); }
            let (sl, mask) = ext[j];
            if t == EXT { c.forget(sl); m.slot_writev(sl, &d[o..o + EXT]); ext[j].1 = 0xFFFF; }
            else {
                let pg = c.load(m, sl, mask);
                pg.b[at..at + t].copy_from_slice(&d[o..o + t]);
                pg.dirty = true;
                ext[j].1 = mask | bits(at / BLK, (at + t).div_ceil(BLK));
                // the write reached the end of the extent: out at once (sequential writes)
                if at + t == EXT { c.flush(m, sl); }
            }
            o += t;
        }
    }

    /// Sets the length (zeros when it grows).
    pub fn resize(&mut self, c: &mut Cache, m: &mut Mmu, n: u64) {
        if let Data::Mem(v) = self { if n <= BIG { v.resize(n as usize, 0); return; } }
        self.spill(m);
        let Data::Blk { len, ext } = self else { unreachable!() };
        let want = n.div_ceil(EXT as u64) as usize;
        while ext.len() > want { let (s, _) = ext.pop().unwrap(); if s != NONE { c.forget(s); m.run_free(s, EXT_BLKS); } }
        if n < *len && n % EXT as u64 != 0 {
            // the bytes past the new end in the last extent become zeros (they read as zeros if it grows again)
            let at = (n % EXT as u64) as usize;
            let (s, mask) = ext[want - 1];
            if s != NONE && mask != 0 {
                let pg = c.load(m, s, mask);
                pg.b[at..].fill(0);
                pg.dirty = true;
                ext[want - 1].1 = mask & bits(0, at.div_ceil(BLK));
            }
        }
        ext.resize(want, (NONE, 0));
        *len = n;
    }

    /// A file in memory moves to blocks.
    fn spill(&mut self, m: &mut Mmu) {
        let Data::Mem(v) = self else { return };
        let v = std::mem::take(v);
        let mut ext = Vec::with_capacity(v.len().div_ceil(EXT));
        let mut b = vec![0u8; EXT];
        for ch in v.chunks(EXT) {
            let s = m.run_new(EXT_BLKS);
            if ch.len() == EXT { m.slot_writev(s, ch); } else { b.fill(0); b[..ch.len()].copy_from_slice(ch); m.slot_writev(s, &b); }
            ext.push((s, bits(0, ch.len().div_ceil(BLK))));
        }
        *self = Data::Blk { len: v.len() as u64, ext };
    }

    /// Empties the file (its blocks go back to the swap).
    pub fn clear(&mut self, c: &mut Cache, m: &mut Mmu) {
        if let Data::Blk { ext, .. } = self { for &(s, _) in ext.iter() { if s != NONE { c.forget(s); m.run_free(s, EXT_BLKS); } } }
        *self = Data::Mem(Vec::new());
    }

    /// A separate copy (hard links are copies here).
    pub fn dup(&self, c: &mut Cache, m: &mut Mmu) -> Data {
        match self {
            Data::Mem(v) => Data::Mem(v.clone()),
            Data::Blk { len, ext } => {
                let mut b = vec![0u8; EXT];
                let ext = ext.iter().map(|&(s, mask)| {
                    if s == NONE { return (NONE, 0); }
                    c.get(m, s, mask, &mut b);
                    let n = m.run_new(EXT_BLKS);
                    m.slot_writev(n, &b);
                    (n, 0xFFFF)
                }).collect();
                Data::Blk { len: *len, ext }
            }
        }
    }
}
