// Contents of a Linux file. Small files stay in the engine's memory; a file that grows past
// BIG bytes moves to 4 KB blocks kept in swap slots (the page's OPFS swap file, a Map in node),
// so big files (a 1 GB copy, a zip) do not live in the engine's heap. Blocks are read and
// written through a small cache (CACHE pages, write-back, oldest half dropped when full).

use crate::mmu::Mmu;
use std::collections::HashMap;

pub const BLK: usize = 4096;
/// A file written past this size moves to blocks.
pub const BIG: u64 = 1 << 20;
const NONE: u32 = u32::MAX; // a block never written: reads as zeros
const CACHE: usize = 256; // pages (1 MB)

pub enum Data {
    Mem(Vec<u8>),
    /// `slots[i]` holds bytes [i*BLK, (i+1)*BLK); bytes past `len` in the last block are zero.
    Blk { len: u64, slots: Vec<u32> },
}

impl From<Vec<u8>> for Data {
    fn from(v: Vec<u8>) -> Self { Data::Mem(v) }
}

#[derive(Default)]
pub struct Cache { pages: HashMap<u32, (Box<[u8; BLK]>, bool, u64)>, tick: u64 }

impl Cache {
    fn room(&mut self, m: &mut Mmu) {
        if self.pages.len() < CACHE { return; }
        let mut v: Vec<(u64, u32)> = self.pages.iter().map(|(k, p)| (p.2, *k)).collect();
        v.sort_unstable();
        for (_, k) in v.into_iter().take(CACHE / 2) {
            let (b, dirty, _) = self.pages.remove(&k).unwrap();
            if dirty { m.slot_write(k, &b[..]); }
        }
    }
    /// The cached page of slot `s` (read in when missing).
    fn page(&mut self, m: &mut Mmu, s: u32, fresh: bool) -> &mut (Box<[u8; BLK]>, bool, u64) {
        self.tick += 1;
        if !self.pages.contains_key(&s) {
            self.room(m);
            let mut b = Box::new([0u8; BLK]);
            if !fresh { m.slot_read(s, &mut b[..]); }
            self.pages.insert(s, (b, fresh, 0));
        }
        let t = self.tick;
        let p = self.pages.get_mut(&s).unwrap();
        p.2 = t;
        p
    }
    fn forget(&mut self, s: u32) { self.pages.remove(&s); }
    /// Slot `s` as it is now (the cache's copy when it has one).
    fn get(&mut self, m: &mut Mmu, s: u32, b: &mut [u8]) {
        match self.pages.get(&s) { Some(p) => b.copy_from_slice(&p.0[..]), None => m.slot_read(s, b) }
    }
    pub fn cached(&self) -> usize { self.pages.len() }
}

impl Data {
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
            Data::Blk { slots, .. } => {
                let mut out = vec![0u8; k];
                let mut o = 0;
                while o < k {
                    let p = s + o as u64;
                    let (i, at) = ((p / BLK as u64) as usize, (p % BLK as u64) as usize);
                    let t = (BLK - at).min(k - o);
                    let sl = slots[i];
                    if sl != NONE {
                        if t == BLK && !c.pages.contains_key(&sl) { m.slot_read(sl, &mut out[o..o + BLK]); }
                        else { let pg = c.page(m, sl, false); out[o..o + t].copy_from_slice(&pg.0[at..at + t]); }
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
        let Data::Blk { slots, .. } = self else { unreachable!() };
        let mut o = 0;
        while o < d.len() {
            let p = off + o as u64;
            let (i, at) = ((p / BLK as u64) as usize, (p % BLK as u64) as usize);
            let t = (BLK - at).min(d.len() - o);
            let fresh = slots[i] == NONE;
            if fresh { slots[i] = m.slot_new(); }
            let sl = slots[i];
            if t == BLK { c.forget(sl); m.slot_write(sl, &d[o..o + BLK]); }
            else { let pg = c.page(m, sl, fresh); pg.0[at..at + t].copy_from_slice(&d[o..o + t]); pg.1 = true; }
            o += t;
        }
    }

    /// Sets the length (zeros when it grows).
    pub fn resize(&mut self, c: &mut Cache, m: &mut Mmu, n: u64) {
        if let Data::Mem(v) = self { if n <= BIG { v.resize(n as usize, 0); return; } }
        self.spill(m);
        let Data::Blk { len, slots } = self else { unreachable!() };
        let want = n.div_ceil(BLK as u64) as usize;
        while slots.len() > want { let s = slots.pop().unwrap(); if s != NONE { c.forget(s); m.slot_free(s); } }
        if n < *len && n % BLK as u64 != 0 {
            let s = slots[want - 1];
            if s != NONE { let pg = c.page(m, s, false); pg.0[(n % BLK as u64) as usize..].fill(0); pg.1 = true; }
        }
        slots.resize(want, NONE);
        *len = n;
    }

    /// A file in memory moves to blocks.
    fn spill(&mut self, m: &mut Mmu) {
        let Data::Mem(v) = self else { return };
        let v = std::mem::take(v);
        let mut slots = Vec::with_capacity(v.len().div_ceil(BLK));
        for ch in v.chunks(BLK) {
            let s = m.slot_new();
            if ch.len() == BLK { m.slot_write(s, ch); } else { let mut b = [0u8; BLK]; b[..ch.len()].copy_from_slice(ch); m.slot_write(s, &b); }
            slots.push(s);
        }
        *self = Data::Blk { len: v.len() as u64, slots };
    }

    /// Empties the file (its blocks go back to the swap).
    pub fn clear(&mut self, c: &mut Cache, m: &mut Mmu) {
        if let Data::Blk { slots, .. } = self { for &s in slots.iter() { if s != NONE { c.forget(s); m.slot_free(s); } } }
        *self = Data::Mem(Vec::new());
    }

    /// A separate copy (hard links are copies here).
    pub fn dup(&self, c: &mut Cache, m: &mut Mmu) -> Data {
        match self {
            Data::Mem(v) => Data::Mem(v.clone()),
            Data::Blk { len, slots } => {
                let mut b = [0u8; BLK];
                let slots = slots.iter().map(|&s| {
                    if s == NONE { return NONE; }
                    c.get(m, s, &mut b);
                    let n = m.slot_new();
                    m.slot_write(n, &b);
                    n
                }).collect();
                Data::Blk { len: *len, slots }
            }
        }
    }
}
