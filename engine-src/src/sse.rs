// SSE / SSE2 (the vector unit every x86-64 program uses for floating point,
// copies and string code). XMM registers are u128 values; lanes are read and
// written through little-endian casts.

use crate::cpu::{ea, modrm, reg_loc, Dec, Loc, ModRm};
use crate::Engine;

#[inline(always)]
fn u8s(v: u128) -> [u8; 16] {
    v.to_le_bytes()
}
#[inline(always)]
fn from_u8s(a: [u8; 16]) -> u128 {
    u128::from_le_bytes(a)
}
#[inline(always)]
fn u16s(v: u128) -> [u16; 8] {
    let b = u8s(v);
    core::array::from_fn(|i| u16::from_le_bytes([b[2 * i], b[2 * i + 1]]))
}
#[inline(always)]
fn from_u16s(a: [u16; 8]) -> u128 {
    let mut b = [0u8; 16];
    for i in 0..8 {
        b[2 * i..2 * i + 2].copy_from_slice(&a[i].to_le_bytes());
    }
    from_u8s(b)
}
#[inline(always)]
fn u32s(v: u128) -> [u32; 4] {
    core::array::from_fn(|i| (v >> (32 * i)) as u32)
}
#[inline(always)]
fn from_u32s(a: [u32; 4]) -> u128 {
    a.iter().enumerate().fold(0u128, |acc, (i, &x)| acc | (x as u128) << (32 * i))
}
#[inline(always)]
fn u64s(v: u128) -> [u64; 2] {
    [v as u64, (v >> 64) as u64]
}
#[inline(always)]
fn from_u64s(a: [u64; 2]) -> u128 {
    a[0] as u128 | (a[1] as u128) << 64
}
#[inline(always)]
fn f32s(v: u128) -> [f32; 4] {
    u32s(v).map(f32::from_bits)
}
#[inline(always)]
fn from_f32s(a: [f32; 4]) -> u128 {
    from_u32s(a.map(f32::to_bits))
}
#[inline(always)]
fn f64s(v: u128) -> [f64; 2] {
    u64s(v).map(f64::from_bits)
}
#[inline(always)]
fn from_f64s(a: [f64; 2]) -> u128 {
    from_u64s(a.map(f64::to_bits))
}

fn map_u8(a: u128, b: u128, f: impl Fn(u8, u8) -> u8) -> u128 {
    let (x, y) = (u8s(a), u8s(b));
    from_u8s(core::array::from_fn(|i| f(x[i], y[i])))
}
fn map_u16(a: u128, b: u128, f: impl Fn(u16, u16) -> u16) -> u128 {
    let (x, y) = (u16s(a), u16s(b));
    from_u16s(core::array::from_fn(|i| f(x[i], y[i])))
}
fn map_u32(a: u128, b: u128, f: impl Fn(u32, u32) -> u32) -> u128 {
    let (x, y) = (u32s(a), u32s(b));
    from_u32s(core::array::from_fn(|i| f(x[i], y[i])))
}
fn map_u64(a: u128, b: u128, f: impl Fn(u64, u64) -> u64) -> u128 {
    let (x, y) = (u64s(a), u64s(b));
    from_u64s(core::array::from_fn(|i| f(x[i], y[i])))
}

fn sat_i8(v: i32) -> u8 {
    v.clamp(-128, 127) as i8 as u8
}
fn sat_u8(v: i32) -> u8 {
    v.clamp(0, 255) as u8
}
fn sat_i16(v: i32) -> u16 {
    v.clamp(-32768, 32767) as i16 as u16
}

fn cvt_i32(v: f64, trunc: bool) -> u32 {
    let r = if trunc { v.trunc() } else { v.round_ties_even() };
    if r.is_nan() || r < -2147483648.0 || r > 2147483647.0 {
        0x8000_0000
    } else {
        r as i32 as u32
    }
}
fn cvt_i64(v: f64, trunc: bool) -> u64 {
    let r = if trunc { v.trunc() } else { v.round_ties_even() };
    if r.is_nan() || r < -9.223372036854775808e18 || r >= 9.223372036854775808e18 {
        0x8000_0000_0000_0000
    } else {
        r as i64 as u64
    }
}

fn cmp_pred(a: f64, b: f64, p: u8) -> bool {
    let un = a.is_nan() || b.is_nan();
    match p & 7 {
        0 => a == b,
        1 => a < b,
        2 => a <= b,
        3 => un,
        4 => !(a == b),
        5 => !(a < b),
        6 => !(a <= b),
        _ => !un,
    }
}

impl Engine {
    fn read128(&mut self, a: u64) -> Result<u128, ()> {
        let lo = self.mmu.read64(a).map_err(|_| self.fault(a))?;
        let hi = self.mmu.read64(a + 8).map_err(|_| self.fault(a + 8))?;
        Ok(lo as u128 | (hi as u128) << 64)
    }
    fn write128(&mut self, a: u64, v: u128) -> Result<(), ()> {
        self.mmu.write64(a, v as u64).map_err(|_| self.fault(a))?;
        self.mmu.write64(a + 8, (v >> 64) as u64).map_err(|_| self.fault(a + 8))
    }
    /// Source operand of `bytes` size (4, 8 or 16): xmm register or memory (zero-extended).
    fn xsrc(&mut self, m: &ModRm, next: u64, bytes: u32) -> Result<u128, ()> {
        if m.md == 3 {
            return Ok(self.cpu.xmm[m.rm as usize]);
        }
        let a = ea(self, m, next);
        match bytes {
            2 => self.mmu.read16(a).map(|v| v as u128).map_err(|_| self.fault(a)),
            4 => self.mmu.read32(a).map(|v| v as u128).map_err(|_| self.fault(a)),
            8 => self.mmu.read64(a).map(|v| v as u128).map_err(|_| self.fault(a)),
            _ => self.read128(a),
        }
    }
    fn xstore(&mut self, m: &ModRm, next: u64, bytes: u32, v: u128) -> Result<(), ()> {
        if m.md == 3 {
            let r = &mut self.cpu.xmm[m.rm as usize];
            *r = match bytes {
                4 => (*r & !0xFFFF_FFFF) | (v & 0xFFFF_FFFF),
                8 => (*r & !(u64::MAX as u128)) | (v & u64::MAX as u128),
                _ => v,
            };
            return Ok(());
        }
        let a = ea(self, m, next);
        match bytes {
            4 => self.mmu.write32(a, v as u32).map_err(|_| self.fault(a)),
            8 => self.mmu.write64(a, v as u64).map_err(|_| self.fault(a)),
            _ => self.write128(a, v),
        }
    }
}

macro_rules! g {
    ($e:expr, $x:expr) => {
        match $x {
            Ok(v) => v,
            Err(_) => return true,
        }
    };
}

/// Returns true when the opcode was handled here.
pub fn sse(e: &mut Engine, d: &mut Dec, buf: &[u8; 16], rip: u64, rex: u8, p66: bool, rep: u8, op: u8) -> bool {
    let w = rex & 8 != 0;
    let is_sse = matches!(op, 0x10..=0x17 | 0x28..=0x2F | 0x50..=0x7F | 0xC2 | 0xC4 | 0xC5 | 0xC6 | 0xD0..=0xFE);
    if !is_sse {
        return false;
    }
    // 0x60..0x7F and 0xD1..0xFE without 66/F3/F2 are MMX: not supported
    if (matches!(op, 0x60..=0x7F) || op >= 0xD0) && !p66 && rep == 0 {
        e.unsupported(buf);
        return true;
    }
    let m = modrm(d, e, rex);
    let imm_ops = matches!(op, 0x70..=0x73 | 0xC2 | 0xC4 | 0xC5 | 0xC6);
    let imm = if imm_ops { d.u8() } else { 0 };
    let next = rip + d.p as u64;
    let r = m.reg as usize;
    let dst = e.cpu.xmm[r];
    // scalar kind: 0 = packed single, 1 = packed double (66), 2 = scalar single (F3), 3 = scalar double (F2)
    let kind = if rep == 0xF3 {
        2
    } else if rep == 0xF2 {
        3
    } else if p66 {
        1
    } else {
        0
    };
    let mut out: Option<u128> = None;
    match op {
        0x10 => {
            out = Some(match kind {
                2 => {
                    let s = g!(e, e.xsrc(&m, next, 4));
                    if m.md == 3 {
                        (dst & !0xFFFF_FFFF) | (s & 0xFFFF_FFFF)
                    } else {
                        s
                    }
                }
                3 => {
                    let s = g!(e, e.xsrc(&m, next, 8));
                    if m.md == 3 {
                        (dst & !(u64::MAX as u128)) | (s & u64::MAX as u128)
                    } else {
                        s
                    }
                }
                _ => g!(e, e.xsrc(&m, next, 16)),
            })
        }
        0x11 | 0x29 | 0x2B | 0x7F | 0xE7 => {
            let b = if op == 0x11 && kind == 2 {
                4
            } else if op == 0x11 && kind == 3 {
                8
            } else {
                16
            };
            g!(e, e.xstore(&m, next, b, dst));
        }
        // F2: movddup (low double twice); F3: movsldup (even singles twice)
        0x12 if kind == 3 => {
            let s = g!(e, e.xsrc(&m, next, 8)) & u64::MAX as u128;
            out = Some(s | (s << 64));
        }
        0x12 if kind == 2 => {
            let s = g!(e, e.xsrc(&m, next, 16));
            let a = s & 0xFFFF_FFFF;
            let c = (s >> 64) & 0xFFFF_FFFF;
            out = Some(a | a << 32 | c << 64 | c << 96);
        }
        // F3: movshdup (odd singles twice)
        0x16 if kind == 2 => {
            let s = g!(e, e.xsrc(&m, next, 16));
            let b = (s >> 32) & 0xFFFF_FFFF;
            let d = s >> 96;
            out = Some(b | b << 32 | d << 64 | d << 96);
        }
        0x12 => {
            let s = g!(e, e.xsrc(&m, next, if m.md == 3 { 16 } else { 8 }));
            let lo = if m.md == 3 && !p66 { s >> 64 } else { s };
            out = Some((dst & !(u64::MAX as u128)) | (lo & u64::MAX as u128));
        }
        0x13 => {
            g!(e, e.xstore(&m, next, 8, dst));
        }
        0x16 => {
            let s = g!(e, e.xsrc(&m, next, if m.md == 3 { 16 } else { 8 }));
            out = Some((dst & u64::MAX as u128) | (s << 64));
        }
        0x17 => {
            g!(e, e.xstore(&m, next, 8, dst >> 64));
        }
        0x14 | 0x15 => {
            let s = g!(e, e.xsrc(&m, next, 16));
            out = Some(if p66 {
                let (a, b) = (u64s(dst), u64s(s));
                if op == 0x14 {
                    from_u64s([a[0], b[0]])
                } else {
                    from_u64s([a[1], b[1]])
                }
            } else {
                let (a, b) = (u32s(dst), u32s(s));
                if op == 0x14 {
                    from_u32s([a[0], b[0], a[1], b[1]])
                } else {
                    from_u32s([a[2], b[2], a[3], b[3]])
                }
            });
        }
        0x28 => out = Some(g!(e, e.xsrc(&m, next, 16))),
        0xD0 if kind == 1 || kind == 3 => {
            // addsubpd / addsubps: even lanes subtract, odd lanes add
            let sv = g!(e, e.xsrc(&m, next, 16));
            out = Some(if kind == 1 {
                let (a, b) = (f64s(dst), f64s(sv));
                from_f64s([a[0] - b[0], a[1] + b[1]])
            } else {
                let (a, b) = (f32s(dst), f32s(sv));
                from_f32s([a[0] - b[0], a[1] + b[1], a[2] - b[2], a[3] + b[3]])
            });
        }
        // SSE3 haddpd / hsubpd (66) and haddps / hsubps (F2): pairs of dst, then pairs of src
        0x7C | 0x7D if kind == 1 || kind == 3 => {
            let sv = g!(e, e.xsrc(&m, next, 16));
            let sub = op == 0x7D;
            out = Some(if kind == 1 {
                let (a, b) = (f64s(dst), f64s(sv));
                if sub {
                    from_f64s([a[0] - a[1], b[0] - b[1]])
                } else {
                    from_f64s([a[0] + a[1], b[0] + b[1]])
                }
            } else {
                let (a, b) = (f32s(dst), f32s(sv));
                if sub {
                    from_f32s([a[0] - a[1], a[2] - a[3], b[0] - b[1], b[2] - b[3]])
                } else {
                    from_f32s([a[0] + a[1], a[2] + a[3], b[0] + b[1], b[2] + b[3]])
                }
            });
        }
        // SSE3 lddqu (F2 0F F0 m128)
        0xF0 if kind == 3 && m.md != 3 => out = Some(g!(e, e.xsrc(&m, next, 16))),
        0x2A => {
            if kind < 2 {
                e.unsupported(buf);
                return true;
            }
            let sz = if w { 64 } else { 32 };
            let v = g!(e, e.get(crate::cpu::rm_loc(e, &m, next, sz, rex), sz));
            let f = if w { v as i64 as f64 } else { v as u32 as i32 as f64 };
            out = Some(if kind == 2 {
                (dst & !0xFFFF_FFFF) | (if w { v as i64 as f32 } else { v as u32 as i32 as f32 }).to_bits() as u128
            } else {
                (dst & !(u64::MAX as u128)) | f.to_bits() as u128
            });
        }
        0x2C | 0x2D => {
            if kind < 2 {
                e.unsupported(buf);
                return true;
            }
            let s = g!(e, e.xsrc(&m, next, if kind == 2 { 4 } else { 8 }));
            let f = if kind == 2 { f32::from_bits(s as u32) as f64 } else { f64::from_bits(s as u64) };
            let trunc = op == 0x2C;
            let v = if w { cvt_i64(f, trunc) } else { cvt_i32(f, trunc) as u64 };
            let _ = e.set(Loc::Reg(m.reg, false), if w { 64 } else { 32 }, v);
        }
        0x2E | 0x2F => {
            let s = g!(e, e.xsrc(&m, next, if p66 { 8 } else { 4 }));
            let (a, b) = if p66 {
                (f64::from_bits(dst as u64), f64::from_bits(s as u64))
            } else {
                (f32::from_bits(dst as u32) as f64, f32::from_bits(s as u32) as f64)
            };
            let c = &mut e.cpu;
            c.of = false;
            c.sf = false;
            if a.is_nan() || b.is_nan() {
                c.zf = true;
                c.pf = true;
                c.cf = true;
            } else {
                c.pf = false;
                c.zf = a == b;
                c.cf = a < b;
            }
        }
        0x50 => {
            let v = if p66 {
                let a = u64s(dst_of(e, &m));
                (a[0] >> 63) | ((a[1] >> 63) << 1)
            } else {
                let a = u32s(dst_of(e, &m));
                (0..4).fold(0, |acc, i| acc | (((a[i] >> 31) as u64) << i))
            };
            let _ = e.set(Loc::Reg(m.reg, false), 32, v);
        }
        0x51 | 0x58 | 0x59 | 0x5C | 0x5D | 0x5E | 0x5F => {
            let s = g!(
                e,
                e.xsrc(
                    &m,
                    next,
                    match kind {
                        2 => 4,
                        3 => 8,
                        _ => 16,
                    }
                )
            );
            let f64op = |a: f64, b: f64| -> f64 {
                match op {
                    0x51 => b.sqrt(),
                    0x58 => a + b,
                    0x59 => a * b,
                    0x5C => a - b,
                    0x5D => {
                        if a < b {
                            a
                        } else {
                            b
                        }
                    }
                    0x5E => a / b,
                    _ => {
                        if a > b {
                            a
                        } else {
                            b
                        }
                    }
                }
            };
            let f32op = |a: f32, b: f32| -> f32 {
                match op {
                    0x51 => b.sqrt(),
                    0x58 => a + b,
                    0x59 => a * b,
                    0x5C => a - b,
                    0x5D => {
                        if a < b {
                            a
                        } else {
                            b
                        }
                    }
                    0x5E => a / b,
                    _ => {
                        if a > b {
                            a
                        } else {
                            b
                        }
                    }
                }
            };
            out = Some(match kind {
                0 => {
                    let (a, b) = (f32s(dst), f32s(s));
                    from_f32s(core::array::from_fn(|i| f32op(a[i], b[i])))
                }
                1 => {
                    let (a, b) = (f64s(dst), f64s(s));
                    from_f64s(core::array::from_fn(|i| f64op(a[i], b[i])))
                }
                2 => (dst & !0xFFFF_FFFF) | f32op(f32::from_bits(dst as u32), f32::from_bits(s as u32)).to_bits() as u128,
                _ => (dst & !(u64::MAX as u128)) | f64op(f64::from_bits(dst as u64), f64::from_bits(s as u64)).to_bits() as u128,
            });
        }
        0x54..=0x57 => {
            let s = g!(e, e.xsrc(&m, next, 16));
            out = Some(match op {
                0x54 => dst & s,
                0x55 => !dst & s,
                0x56 => dst | s,
                _ => dst ^ s,
            });
        }
        0x5A => {
            let s = g!(
                e,
                e.xsrc(
                    &m,
                    next,
                    match kind {
                        0 => 8,
                        2 => 4,
                        3 => 8,
                        _ => 16,
                    }
                )
            );
            out = Some(match kind {
                0 => {
                    let a = f32s(s);
                    from_f64s([a[0] as f64, a[1] as f64])
                }
                1 => {
                    let a = f64s(s);
                    from_f32s([a[0] as f32, a[1] as f32, 0.0, 0.0]) & u64::MAX as u128
                }
                2 => (dst & !(u64::MAX as u128)) | (f32::from_bits(s as u32) as f64).to_bits() as u128,
                _ => (dst & !0xFFFF_FFFF) | (f64::from_bits(s as u64) as f32).to_bits() as u128,
            });
        }
        0x5B => {
            let s = g!(e, e.xsrc(&m, next, 16));
            out = Some(match kind {
                0 => {
                    let a = u32s(s);
                    from_f32s(a.map(|x| x as i32 as f32))
                }
                1 => {
                    let a = f32s(s);
                    from_u32s(a.map(|x| cvt_i32(x as f64, false)))
                }
                2 => {
                    let a = f32s(s);
                    from_u32s(a.map(|x| cvt_i32(x as f64, true)))
                }
                _ => {
                    e.unsupported(buf);
                    return true;
                }
            });
        }
        0xC2 => {
            let s = g!(
                e,
                e.xsrc(
                    &m,
                    next,
                    match kind {
                        2 => 4,
                        3 => 8,
                        _ => 16,
                    }
                )
            );
            out = Some(match kind {
                0 => {
                    let (a, b) = (f32s(dst), f32s(s));
                    from_u32s(core::array::from_fn(|i| if cmp_pred(a[i] as f64, b[i] as f64, imm) { u32::MAX } else { 0 }))
                }
                1 => {
                    let (a, b) = (f64s(dst), f64s(s));
                    from_u64s(core::array::from_fn(|i| if cmp_pred(a[i], b[i], imm) { u64::MAX } else { 0 }))
                }
                2 => {
                    (dst & !0xFFFF_FFFF)
                        | if cmp_pred(f32::from_bits(dst as u32) as f64, f32::from_bits(s as u32) as f64, imm) { 0xFFFF_FFFF } else { 0 }
                }
                _ => {
                    (dst & !(u64::MAX as u128))
                        | if cmp_pred(f64::from_bits(dst as u64), f64::from_bits(s as u64), imm) { u64::MAX as u128 } else { 0 }
                }
            });
        }
        0xC4 if p66 => {
            // pinsrw xmm, r32/m16, imm8
            let v = g!(e, e.get(crate::cpu::rm_loc(e, &m, next, 16, rex), 16)) as u16;
            let mut a = u16s(dst);
            a[(imm & 7) as usize] = v;
            out = Some(from_u16s(a));
        }
        0xC5 if p66 && m.md == 3 => {
            // pextrw r32, xmm, imm8
            let v = u16s(e.cpu.xmm[m.rm as usize])[(imm & 7) as usize] as u64;
            let _ = e.set(Loc::Reg(m.reg, false), 32, v);
        }
        0xC6 => {
            let s = g!(e, e.xsrc(&m, next, 16));
            out = Some(if p66 {
                let (a, b) = (u64s(dst), u64s(s));
                from_u64s([a[(imm & 1) as usize], b[((imm >> 1) & 1) as usize]])
            } else {
                let (a, b) = (u32s(dst), u32s(s));
                from_u32s([a[(imm & 3) as usize], a[((imm >> 2) & 3) as usize], b[((imm >> 4) & 3) as usize], b[((imm >> 6) & 3) as usize]])
            });
        }
        0x6E => {
            let sz = if w { 64 } else { 32 };
            let v = g!(e, e.get(crate::cpu::rm_loc(e, &m, next, sz, rex), sz));
            out = Some(v as u128);
        }
        0x6F => out = Some(g!(e, e.xsrc(&m, next, 16))),
        0x7E => {
            if rep == 0xF3 {
                out = Some(g!(e, e.xsrc(&m, next, 8)) & u64::MAX as u128);
            } else {
                let sz = if w { 64 } else { 32 };
                let l = crate::cpu::rm_loc(e, &m, next, sz, rex);
                g!(e, e.set(l, sz, dst as u64));
            }
        }
        0xD6 => {
            if m.md == 3 {
                e.cpu.xmm[m.rm as usize] = dst & u64::MAX as u128;
            } else {
                g!(e, e.xstore(&m, next, 8, dst));
            }
        }
        0xD7 => {
            let b = u8s(dst_of(e, &m));
            let v = (0..16).fold(0u64, |acc, i| acc | (((b[i] >> 7) as u64) << i));
            let _ = e.set(Loc::Reg(m.reg, false), 32, v);
        }
        0x70 => {
            let s = g!(e, e.xsrc(&m, next, 16));
            out = Some(match rep {
                0 => {
                    let a = u32s(s);
                    from_u32s(core::array::from_fn(|i| a[((imm >> (2 * i)) & 3) as usize]))
                }
                0xF2 => {
                    let a = u16s(s);
                    let mut o = a;
                    for i in 0..4 {
                        o[i] = a[((imm >> (2 * i)) & 3) as usize];
                    }
                    from_u16s(o)
                }
                _ => {
                    let a = u16s(s);
                    let mut o = a;
                    for i in 0..4 {
                        o[4 + i] = a[4 + ((imm >> (2 * i)) & 3) as usize];
                    }
                    from_u16s(o)
                }
            });
        }
        0x71..=0x73 => {
            let t = m.rm as usize;
            let v = e.cpu.xmm[t];
            let n = imm as u32;
            e.cpu.xmm[t] = shift(v, op, m.reg & 7, n);
        }
        0xD1..=0xD3 | 0xE1 | 0xE2 | 0xF1..=0xF3 => {
            let s = g!(e, e.xsrc(&m, next, 16));
            let n = if (s >> 64) != 0 || (s as u64) > 255 { 255 } else { s as u32 };
            let (grp, sub) = match op {
                0xD1 => (0x71, 2),
                0xD2 => (0x72, 2),
                0xD3 => (0x73, 2),
                0xE1 => (0x71, 4),
                0xE2 => (0x72, 4),
                0xF1 => (0x71, 6),
                0xF2 => (0x72, 6),
                _ => (0x73, 6),
            };
            out = Some(shift(dst, grp, sub, n));
        }
        0xE6 => {
            let s = g!(e, e.xsrc(&m, next, if rep == 0xF3 { 8 } else { 16 }));
            out = Some(match rep {
                0xF3 => {
                    let a = u32s(s);
                    from_f64s([a[0] as i32 as f64, a[1] as i32 as f64])
                }
                0xF2 => {
                    let a = f64s(s);
                    from_u32s([cvt_i32(a[0], false), cvt_i32(a[1], false), 0, 0])
                }
                _ => {
                    let a = f64s(s);
                    from_u32s([cvt_i32(a[0], true), cvt_i32(a[1], true), 0, 0])
                }
            });
        }
        _ => {
            // 66-prefixed integer ops on full registers
            let s = g!(e, e.xsrc(&m, next, 16));
            out = Some(match op {
                0x60 => {
                    let (a, b) = (u8s(dst), u8s(s));
                    from_u8s(core::array::from_fn(|i| if i % 2 == 0 { a[i / 2] } else { b[i / 2] }))
                }
                0x61 => {
                    let (a, b) = (u16s(dst), u16s(s));
                    from_u16s(core::array::from_fn(|i| if i % 2 == 0 { a[i / 2] } else { b[i / 2] }))
                }
                0x62 => {
                    let (a, b) = (u32s(dst), u32s(s));
                    from_u32s([a[0], b[0], a[1], b[1]])
                }
                0x68 => {
                    let (a, b) = (u8s(dst), u8s(s));
                    from_u8s(core::array::from_fn(|i| if i % 2 == 0 { a[8 + i / 2] } else { b[8 + i / 2] }))
                }
                0x69 => {
                    let (a, b) = (u16s(dst), u16s(s));
                    from_u16s(core::array::from_fn(|i| if i % 2 == 0 { a[4 + i / 2] } else { b[4 + i / 2] }))
                }
                0x6A => {
                    let (a, b) = (u32s(dst), u32s(s));
                    from_u32s([a[2], b[2], a[3], b[3]])
                }
                0x6C => {
                    let (a, b) = (u64s(dst), u64s(s));
                    from_u64s([a[0], b[0]])
                }
                0x6D => {
                    let (a, b) = (u64s(dst), u64s(s));
                    from_u64s([a[1], b[1]])
                }
                0x63 => {
                    let (a, b) = (u16s(dst), u16s(s));
                    from_u8s(core::array::from_fn(|i| sat_i8(if i < 8 { a[i] } else { b[i - 8] } as i16 as i32)))
                }
                0x67 => {
                    let (a, b) = (u16s(dst), u16s(s));
                    from_u8s(core::array::from_fn(|i| sat_u8(if i < 8 { a[i] } else { b[i - 8] } as i16 as i32)))
                }
                0x6B => {
                    let (a, b) = (u32s(dst), u32s(s));
                    from_u16s(core::array::from_fn(|i| sat_i16(if i < 4 { a[i] } else { b[i - 4] } as i32)))
                }
                0x64 => map_u8(dst, s, |a, b| if (a as i8) > (b as i8) { 0xFF } else { 0 }),
                0x65 => map_u16(dst, s, |a, b| if (a as i16) > (b as i16) { 0xFFFF } else { 0 }),
                0x66 => map_u32(dst, s, |a, b| if (a as i32) > (b as i32) { u32::MAX } else { 0 }),
                0x74 => map_u8(dst, s, |a, b| if a == b { 0xFF } else { 0 }),
                0x75 => map_u16(dst, s, |a, b| if a == b { 0xFFFF } else { 0 }),
                0x76 => map_u32(dst, s, |a, b| if a == b { u32::MAX } else { 0 }),
                0xD4 => map_u64(dst, s, |a, b| a.wrapping_add(b)),
                0xD5 => map_u16(dst, s, |a, b| a.wrapping_mul(b)),
                0xD8 => map_u8(dst, s, |a, b| a.saturating_sub(b)),
                0xD9 => map_u16(dst, s, |a, b| a.saturating_sub(b)),
                0xDA => map_u8(dst, s, |a, b| a.min(b)),
                0xDB => dst & s,
                0xDC => map_u8(dst, s, |a, b| a.saturating_add(b)),
                0xDD => map_u16(dst, s, |a, b| a.saturating_add(b)),
                0xDE => map_u8(dst, s, |a, b| a.max(b)),
                0xDF => !dst & s,
                0xE0 => map_u8(dst, s, |a, b| ((a as u16 + b as u16 + 1) >> 1) as u8),
                0xE3 => map_u16(dst, s, |a, b| ((a as u32 + b as u32 + 1) >> 1) as u16),
                0xE4 => map_u16(dst, s, |a, b| ((a as u32 * b as u32) >> 16) as u16),
                0xE5 => map_u16(dst, s, |a, b| ((a as i16 as i32 * b as i16 as i32) >> 16) as u16),
                0xE8 => map_u8(dst, s, |a, b| sat_i8(a as i8 as i32 - b as i8 as i32)),
                0xE9 => map_u16(dst, s, |a, b| sat_i16(a as i16 as i32 - b as i16 as i32)),
                0xEA => map_u16(dst, s, |a, b| (a as i16).min(b as i16) as u16),
                0xEB => dst | s,
                0xEC => map_u8(dst, s, |a, b| sat_i8(a as i8 as i32 + b as i8 as i32)),
                0xED => map_u16(dst, s, |a, b| sat_i16(a as i16 as i32 + b as i16 as i32)),
                0xEE => map_u16(dst, s, |a, b| (a as i16).max(b as i16) as u16),
                0xEF => dst ^ s,
                0xF4 => {
                    let (a, b) = (u64s(dst), u64s(s));
                    from_u64s([(a[0] as u32 as u64) * (b[0] as u32 as u64), (a[1] as u32 as u64) * (b[1] as u32 as u64)])
                }
                0xF5 => {
                    let (a, b) = (u16s(dst), u16s(s));
                    from_u32s(core::array::from_fn(|i| {
                        (a[2 * i] as i16 as i32 * b[2 * i] as i16 as i32).wrapping_add(a[2 * i + 1] as i16 as i32 * b[2 * i + 1] as i16 as i32) as u32
                    }))
                }
                0xF6 => {
                    let (a, b) = (u8s(dst), u8s(s));
                    let lo: u64 = (0..8).map(|i| (a[i] as i32 - b[i] as i32).unsigned_abs() as u64).sum();
                    let hi: u64 = (8..16).map(|i| (a[i] as i32 - b[i] as i32).unsigned_abs() as u64).sum();
                    from_u64s([lo, hi])
                }
                0xF8 => map_u8(dst, s, |a, b| a.wrapping_sub(b)),
                0xF9 => map_u16(dst, s, |a, b| a.wrapping_sub(b)),
                0xFA => map_u32(dst, s, |a, b| a.wrapping_sub(b)),
                0xFB => map_u64(dst, s, |a, b| a.wrapping_sub(b)),
                0xFC => map_u8(dst, s, |a, b| a.wrapping_add(b)),
                0xFD => map_u16(dst, s, |a, b| a.wrapping_add(b)),
                0xFE => map_u32(dst, s, |a, b| a.wrapping_add(b)),
                _ => {
                    e.unsupported(buf);
                    return true;
                }
            });
        }
    }
    if e.s.error.is_some() {
        return true;
    }
    if let Some(v) = out {
        e.cpu.xmm[r] = v;
    }
    e.cpu.rip = next;
    let _ = reg_loc;
    true
}

fn dst_of(e: &Engine, m: &ModRm) -> u128 {
    e.cpu.xmm[m.rm as usize]
}

/// Shift groups 0x71 (words), 0x72 (dwords), 0x73 (qwords / whole-register bytes).
fn shift(v: u128, grp: u8, sub: u8, n: u32) -> u128 {
    match (grp, sub) {
        (0x71, 2) => from_u16s(u16s(v).map(|x| if n > 15 { 0 } else { x >> n })),
        (0x71, 4) => from_u16s(u16s(v).map(|x| ((x as i16) >> n.min(15)) as u16)),
        (0x71, 6) => from_u16s(u16s(v).map(|x| if n > 15 { 0 } else { x << n })),
        (0x72, 2) => from_u32s(u32s(v).map(|x| if n > 31 { 0 } else { x >> n })),
        (0x72, 4) => from_u32s(u32s(v).map(|x| ((x as i32) >> n.min(31)) as u32)),
        (0x72, 6) => from_u32s(u32s(v).map(|x| if n > 31 { 0 } else { x << n })),
        (0x73, 2) => from_u64s(u64s(v).map(|x| if n > 63 { 0 } else { x >> n })),
        (0x73, 6) => from_u64s(u64s(v).map(|x| if n > 63 { 0 } else { x << n })),
        (0x73, 3) => {
            if n > 15 {
                0
            } else {
                v >> (8 * n)
            }
        }
        (0x73, 7) => {
            if n > 15 {
                0
            } else {
                v << (8 * n)
            }
        }
        _ => v,
    }
}

// ---- 0F 38 / 0F 3A: SSSE3, SSE4.1, SSE4.2 and the SHA extensions (Intel SDM definitions) ----
// MMX (no 66 prefix) forms of SSSE3 are not supported, like the rest of MMX.

/// Whether `code` (0x38XX / 0x3AXX) with this 66 prefix is one of the ops below.
pub fn op3_ok(code: u32, p66: bool) -> bool {
    match code {
        0x3800..=0x380B | 0x3810 | 0x3814 | 0x3815 | 0x3817 | 0x381C..=0x381E | 0x3820..=0x3825 | 0x3828..=0x382B | 0x3830..=0x3835
        | 0x3837..=0x3841 | 0x3A08..=0x3A0F | 0x3A14..=0x3A17 | 0x3A20..=0x3A22 | 0x3A40..=0x3A42 | 0x3A60..=0x3A63 => p66,
        0x38C8..=0x38CD | 0x3ACC => !p66,
        // AES-NI, PCLMULQDQ
        0x38DB..=0x38DF | 0x3A44 | 0x3ADF => p66,
        _ => false,
    }
}

/// Ops that only read xmm dst/src (+ xmm0) and write xmm dst: what `op3` computes.
/// The others (PTEST, PEXTR*/EXTRACTPS, PINSRB/D/Q, PCMPxSTRx) run in `op3_step`.
pub fn op3_pure(code: u32) -> bool {
    !matches!(code, 0x3817 | 0x3A14..=0x3A17 | 0x3A20 | 0x3A22 | 0x3A60..=0x3A63)
}

/// Bytes a memory source of `code` reads (PMOVSX/ZX, ROUNDSS/SD and INSERTPS read less than 16).
pub fn op3_src_bytes(code: u32) -> u32 {
    match code {
        0x3820 | 0x3823 | 0x3825 | 0x3830 | 0x3833 | 0x3835 | 0x3A0B => 8,
        0x3821 | 0x3824 | 0x3831 | 0x3834 | 0x3A0A | 0x3A21 => 4,
        0x3822 | 0x3832 => 2,
        _ => 16,
    }
}

fn sig0(x: u32) -> u32 {
    x.rotate_right(7) ^ x.rotate_right(18) ^ (x >> 3)
}
fn sig1(x: u32) -> u32 {
    x.rotate_right(17) ^ x.rotate_right(19) ^ (x >> 10)
}

/// Horizontal op on words/dwords: pairs of d, then pairs of s.
fn hpairs16(d: u128, s: u128, f: impl Fn(i16, i16) -> u16) -> u128 {
    let (a, b) = (u16s(d), u16s(s));
    from_u16s(core::array::from_fn(|i| {
        let v = if i < 4 { a } else { b };
        let k = 2 * (i & 3);
        f(v[k] as i16, v[k + 1] as i16)
    }))
}
fn hpairs32(d: u128, s: u128, f: impl Fn(u32, u32) -> u32) -> u128 {
    let (a, b) = (u32s(d), u32s(s));
    from_u32s([f(a[0], a[1]), f(a[2], a[3]), f(b[0], b[1]), f(b[2], b[3])])
}

/// ROUNDxx: imm bits 1:0 = mode (nearest even, down, up, truncate), bit 2 = MXCSR.RC
/// (always round to nearest here: MXCSR is fixed at 0x1F80). NaNs come back quiet.
fn round_f64(x: f64, imm: u8) -> f64 {
    if x.is_nan() {
        return f64::from_bits(x.to_bits() | 1 << 51);
    }
    match if imm & 4 != 0 { 0 } else { imm & 3 } {
        0 => x.round_ties_even(),
        1 => x.floor(),
        2 => x.ceil(),
        _ => x.trunc(),
    }
}
fn round_f32(x: f32, imm: u8) -> f32 {
    if x.is_nan() {
        return f32::from_bits(x.to_bits() | 1 << 22);
    }
    match if imm & 4 != 0 { 0 } else { imm & 3 } {
        0 => x.round_ties_even(),
        1 => x.floor(),
        2 => x.ceil(),
        _ => x.trunc(),
    }
}

/// PMOVSX/PMOVZX: `k` = 0..5 for BW, BD, BQ, WD, WQ, DQ; `sx` = sign extension.
fn pmovx(s: u128, k: u32, sx: bool) -> u128 {
    let (from, to) = [(8u32, 16u32), (8, 32), (8, 64), (16, 32), (16, 64), (32, 64)][k as usize];
    let mut out = 0u128;
    for i in 0..128 / to {
        let raw = (s >> (from * i)) as u64 & ((1u64 << from) - 1);
        let v = if sx { ((raw << (64 - from)) as i64 >> (64 - from)) as u64 } else { raw };
        let m = if to == 64 { u64::MAX } else { (1u64 << to) - 1 };
        out |= ((v & m) as u128) << (to * i);
    }
    out
}

/// Result of op `code` on dst `d` and source `s` (x0 = xmm0: SHA256RNDS2, PBLENDVB, BLENDVPS/PD).
pub fn op3(code: u32, d: u128, s: u128, imm: u8, x0: u128) -> u128 {
    match code {
        0x38DB..=0x38DF | 0x3A44 | 0x3ADF => crate::aes::op(code, d, s, imm),
        // PSHUFB: byte i = d[s[i] & 15], or 0 when bit 7 of s[i] is set
        0x3800 => {
            let (a, m) = (u8s(d), u8s(s));
            from_u8s(core::array::from_fn(|i| if m[i] & 0x80 != 0 { 0 } else { a[(m[i] & 15) as usize] }))
        }
        // PHADDW / PHADDD / PHADDSW / PHSUBW / PHSUBD / PHSUBSW
        0x3801 => hpairs16(d, s, |x, y| x.wrapping_add(y) as u16),
        0x3802 => hpairs32(d, s, |x, y| x.wrapping_add(y)),
        0x3803 => hpairs16(d, s, |x, y| sat_i16(x as i32 + y as i32)),
        0x3805 => hpairs16(d, s, |x, y| x.wrapping_sub(y) as u16),
        0x3806 => hpairs32(d, s, |x, y| x.wrapping_sub(y)),
        0x3807 => hpairs16(d, s, |x, y| sat_i16(x as i32 - y as i32)),
        // PMADDUBSW: unsigned bytes of d times signed bytes of s, pairs added with saturation
        0x3804 => {
            let (a, b) = (u8s(d), u8s(s));
            from_u16s(core::array::from_fn(|i| sat_i16(a[2 * i] as i32 * b[2 * i] as i8 as i32 + a[2 * i + 1] as i32 * b[2 * i + 1] as i8 as i32)))
        }
        // PSIGNB/W/D: d negated, zeroed or kept by the sign of s
        0x3808 => map_u8(d, s, |a, b| if (b as i8) < 0 { a.wrapping_neg() } else if b == 0 { 0 } else { a }),
        0x3809 => map_u16(d, s, |a, b| if (b as i16) < 0 { a.wrapping_neg() } else if b == 0 { 0 } else { a }),
        0x380A => map_u32(d, s, |a, b| if (b as i32) < 0 { a.wrapping_neg() } else if b == 0 { 0 } else { a }),
        // PMULHRSW: (a*b >> 14) + 1 >> 1
        0x380B => map_u16(d, s, |a, b| ((((a as i16 as i32 * b as i16 as i32) >> 14) + 1) >> 1) as u16),
        // PABSB/W/D
        0x381C => map_u8(s, s, |a, _| (a as i8).unsigned_abs()),
        0x381D => map_u16(s, s, |a, _| (a as i16).unsigned_abs()),
        0x381E => map_u32(s, s, |a, _| (a as i32).unsigned_abs()),
        // PBLENDVB / BLENDVPS / BLENDVPD: by the top bit of each xmm0 element
        0x3810 => {
            let (a, b, m) = (u8s(d), u8s(s), u8s(x0));
            from_u8s(core::array::from_fn(|i| if m[i] & 0x80 != 0 { b[i] } else { a[i] }))
        }
        0x3814 => {
            let (a, b, m) = (u32s(d), u32s(s), u32s(x0));
            from_u32s(core::array::from_fn(|i| if m[i] >> 31 != 0 { b[i] } else { a[i] }))
        }
        0x3815 => {
            let (a, b, m) = (u64s(d), u64s(s), u64s(x0));
            from_u64s(core::array::from_fn(|i| if m[i] >> 63 != 0 { b[i] } else { a[i] }))
        }
        0x3820..=0x3825 => pmovx(s, code - 0x3820, true),
        0x3830..=0x3835 => pmovx(s, code - 0x3830, false),
        // PMULDQ: signed dwords 0 and 2 to quadwords
        0x3828 => {
            let (a, b) = (u32s(d), u32s(s));
            from_u64s([(a[0] as i32 as i64 * b[0] as i32 as i64) as u64, (a[2] as i32 as i64 * b[2] as i32 as i64) as u64])
        }
        0x3829 => map_u64(d, s, |a, b| if a == b { u64::MAX } else { 0 }),
        // MOVNTDQA (a load)
        0x382A => s,
        // PACKUSDW
        0x382B => {
            let (a, b) = (u32s(d), u32s(s));
            from_u16s(core::array::from_fn(|i| (if i < 4 { a[i] } else { b[i - 4] } as i32).clamp(0, 65535) as u16))
        }
        // PCMPGTQ (SSE4.2)
        0x3837 => map_u64(d, s, |a, b| if (a as i64) > (b as i64) { u64::MAX } else { 0 }),
        0x3838 => map_u8(d, s, |a, b| (a as i8).min(b as i8) as u8),
        0x3839 => map_u32(d, s, |a, b| (a as i32).min(b as i32) as u32),
        0x383A => map_u16(d, s, |a, b| a.min(b)),
        0x383B => map_u32(d, s, |a, b| a.min(b)),
        0x383C => map_u8(d, s, |a, b| (a as i8).max(b as i8) as u8),
        0x383D => map_u32(d, s, |a, b| (a as i32).max(b as i32) as u32),
        0x383E => map_u16(d, s, |a, b| a.max(b)),
        0x383F => map_u32(d, s, |a, b| a.max(b)),
        0x3840 => map_u32(d, s, |a, b| a.wrapping_mul(b)),
        // PHMINPOSUW: smallest word of s and its (first) index
        0x3841 => {
            let w = u16s(s);
            let mut k = 0;
            for i in 1..8 {
                if w[i] < w[k] {
                    k = i;
                }
            }
            w[k] as u128 | (k as u128) << 16
        }
        // ROUNDPS / ROUNDPD / ROUNDSS / ROUNDSD
        0x3A08 => from_f32s(f32s(s).map(|x| round_f32(x, imm))),
        0x3A09 => from_f64s(f64s(s).map(|x| round_f64(x, imm))),
        0x3A0A => (d & !0xFFFF_FFFF) | round_f32(f32::from_bits(s as u32), imm).to_bits() as u128,
        0x3A0B => (d & !(u64::MAX as u128)) | round_f64(f64::from_bits(s as u64), imm).to_bits() as u128,
        // BLENDPS / BLENDPD / PBLENDW: element k from s when imm bit k is set
        0x3A0C => {
            let (a, b) = (u32s(d), u32s(s));
            from_u32s(core::array::from_fn(|k| if imm >> k & 1 != 0 { b[k] } else { a[k] }))
        }
        0x3A0D => {
            let (a, b) = (u64s(d), u64s(s));
            from_u64s(core::array::from_fn(|k| if imm >> k & 1 != 0 { b[k] } else { a[k] }))
        }
        0x3A0E => {
            let (a, b) = (u16s(d), u16s(s));
            from_u16s(core::array::from_fn(|k| if imm >> k & 1 != 0 { b[k] } else { a[k] }))
        }
        // PALIGNR: (d:s) >> imm bytes, low 16 bytes
        0x3A0F => {
            let n = imm as u32;
            if n >= 32 {
                0
            } else if n >= 16 {
                d >> (8 * (n - 16))
            } else if n == 0 {
                s
            } else {
                s >> (8 * n) | d << (8 * (16 - n))
            }
        }
        // INSERTPS: s element imm[7:6] into d element imm[5:4], then zero the elements of imm[3:0]
        // (a memory source is one float: op3_step clears imm[7:6])
        0x3A21 => {
            let mut a = u32s(d);
            a[(imm >> 4 & 3) as usize] = u32s(s)[(imm >> 6) as usize];
            for k in 0..4 {
                if imm >> k & 1 != 0 {
                    a[k] = 0;
                }
            }
            from_u32s(a)
        }
        // DPPS / DPPD: products of the imm[7:4] elements, summed in the SDM's order, to the imm[3:0] elements
        0x3A40 => {
            let (a, b) = (f32s(d), f32s(s));
            let p: [f32; 4] = core::array::from_fn(|i| if imm >> (4 + i) & 1 != 0 { a[i] * b[i] } else { 0.0 });
            let t = (p[0] + p[1]) + (p[2] + p[3]);
            from_f32s(core::array::from_fn(|i| if imm >> i & 1 != 0 { t } else { 0.0 }))
        }
        0x3A41 => {
            let (a, b) = (f64s(d), f64s(s));
            let p: [f64; 2] = core::array::from_fn(|i| if imm >> (4 + i) & 1 != 0 { a[i] * b[i] } else { 0.0 });
            let t = p[0] + p[1];
            from_f64s(core::array::from_fn(|i| if imm >> i & 1 != 0 { t } else { 0.0 }))
        }
        // MPSADBW: 8 sums of absolute differences of 4 bytes; d from byte 4*imm[2], s block imm[1:0]
        0x3A42 => {
            let (a, b) = (u8s(d), u8s(s));
            let (o1, o2) = (4 * (imm >> 2 & 1) as usize, 4 * (imm & 3) as usize);
            from_u16s(core::array::from_fn(|i| (0..4).map(|k| (a[o1 + i + k] as i32 - b[o2 + k] as i32).unsigned_abs() as u16).sum()))
        }
        // SHA1NEXTE: s with its top dword + rol(d.top, 30)
        0x38C8 => {
            let mut w = u32s(s);
            w[3] = w[3].wrapping_add(u32s(d)[3].rotate_left(30));
            from_u32s(w)
        }
        // SHA1MSG1
        0x38C9 => {
            let (a, b) = (u32s(d), u32s(s));
            from_u32s([a[0] ^ b[2], a[1] ^ b[3], a[2] ^ a[0], a[3] ^ a[1]])
        }
        // SHA1MSG2
        0x38CA => {
            let (a, b) = (u32s(d), u32s(s));
            let w16 = (a[3] ^ b[2]).rotate_left(1);
            let w17 = (a[2] ^ b[1]).rotate_left(1);
            let w18 = (a[1] ^ b[0]).rotate_left(1);
            let w19 = (a[0] ^ w16).rotate_left(1);
            from_u32s([w19, w18, w17, w16])
        }
        // SHA256RNDS2: two rounds; d = {C,D,G,H}, s = {A,B,E,F} (high to low), wk from xmm0
        0x38CB => {
            let (p, q, k) = (u32s(d), u32s(s), u32s(x0));
            let (mut a, mut b, mut c, mut dd) = (q[3], q[2], p[3], p[2]);
            let (mut e, mut f, mut g, mut h) = (q[1], q[0], p[1], p[0]);
            for wk in [k[0], k[1]] {
                let ch = (e & f) ^ (!e & g);
                let maj = (a & b) ^ (a & c) ^ (b & c);
                let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
                let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
                let t = ch.wrapping_add(s1).wrapping_add(wk).wrapping_add(h);
                h = g;
                g = f;
                f = e;
                e = t.wrapping_add(dd);
                dd = c;
                c = b;
                b = a;
                a = t.wrapping_add(maj).wrapping_add(s0);
            }
            from_u32s([f, e, b, a])
        }
        // SHA256MSG1
        0x38CC => {
            let (a, b) = (u32s(d), u32s(s));
            from_u32s([
                a[0].wrapping_add(sig0(a[1])),
                a[1].wrapping_add(sig0(a[2])),
                a[2].wrapping_add(sig0(a[3])),
                a[3].wrapping_add(sig0(b[0])),
            ])
        }
        // SHA256MSG2
        0x38CD => {
            let (a, b) = (u32s(d), u32s(s));
            let w16 = a[0].wrapping_add(sig1(b[2]));
            let w17 = a[1].wrapping_add(sig1(b[3]));
            let w18 = a[2].wrapping_add(sig1(w16));
            let w19 = a[3].wrapping_add(sig1(w17));
            from_u32s([w16, w17, w18, w19])
        }
        // SHA1RNDS4: four rounds; d = {A,B,C,D}, s = {W0+E,W1,W2,W3} (high to low), imm = f and K
        0x3ACC => {
            let (p, w) = (u32s(d), u32s(s));
            let (mut a, mut b, mut c, mut dd, mut e) = (p[3], p[2], p[1], p[0], 0u32);
            let k = [0x5A82_7999u32, 0x6ED9_EBA1, 0x8F1B_BCDC, 0xCA62_C1D6][(imm & 3) as usize];
            for i in 0..4 {
                let f = match imm & 3 {
                    0 => (b & c) ^ (!b & dd),
                    2 => (b & c) ^ (b & dd) ^ (c & dd),
                    _ => b ^ c ^ dd,
                };
                let t = f.wrapping_add(a.rotate_left(5)).wrapping_add(w[3 - i]).wrapping_add(e).wrapping_add(k);
                e = dd;
                dd = c;
                c = b.rotate_left(30);
                b = a;
                a = t;
            }
            from_u32s([dd, c, b, a])
        }
        _ => d,
    }
}

/// PCMPxSTRx (SSE4.2): compares `a` (xmm1) with `b` (xmm2/m128) of lengths `la`, `lb` in
/// elements; returns IntRes2 (after polarity). imm: [1:0] format, [3:2] aggregation, [5:4] polarity.
pub fn pcmpstr(a: u128, b: u128, la: usize, lb: usize, imm: u8) -> u32 {
    let n = if imm & 1 != 0 { 8 } else { 16 };
    let el = |v: u128, i: usize| -> i32 {
        match imm & 3 {
            0 => (v >> (8 * i)) as u8 as i32,
            1 => (v >> (16 * i)) as u16 as i32,
            2 => (v >> (8 * i)) as u8 as i8 as i32,
            _ => (v >> (16 * i)) as u16 as i16 as i32,
        }
    };
    let mut r1 = 0u32;
    match imm >> 2 & 3 {
        // equal any: b[j] is one of a[0..la]
        0 => {
            for j in 0..lb {
                if (0..la).any(|i| el(b, j) == el(a, i)) {
                    r1 |= 1 << j;
                }
            }
        }
        // ranges: a[2k] <= b[j] <= a[2k+1] for a pair whose two ends are valid
        1 => {
            for j in 0..lb {
                let v = el(b, j);
                if (0..la / 2).any(|k| v >= el(a, 2 * k) && v <= el(a, 2 * k + 1)) {
                    r1 |= 1 << j;
                }
            }
        }
        // equal each: both invalid = true, one invalid = false
        2 => {
            for i in 0..n {
                let t = if i < la && i < lb { el(a, i) == el(b, i) } else { i >= la && i >= lb };
                if t {
                    r1 |= 1 << i;
                }
            }
        }
        // equal ordered: a (needle) at b[j..]; an invalid a element matches anything,
        // a valid one against an invalid b element does not
        _ => {
            for j in 0..n {
                let mut t = true;
                for k in 0..n - j {
                    if k >= la {
                        break;
                    }
                    if j + k >= lb || el(a, k) != el(b, j + k) {
                        t = false;
                        break;
                    }
                }
                if t {
                    r1 |= 1 << j;
                }
            }
        }
    }
    let full = (1u32 << n) - 1;
    match imm >> 4 & 3 {
        1 => !r1 & full,
        3 => r1 ^ ((1u32 << lb) - 1),
        _ => r1,
    }
}

/// Elements before the first zero one (n when there is none): implicit length of PCMPIxxx.
fn str_len(v: u128, words: bool) -> usize {
    if words {
        u16s(v).iter().position(|&x| x == 0).unwrap_or(8)
    } else {
        u8s(v).iter().position(|&x| x == 0).unwrap_or(16)
    }
}

/// CRC32 (SSE4.2): CRC-32C (Castagnoli, reflected) of the `bytes` low bytes of `v`, from `crc`.
pub fn crc32c(mut crc: u32, v: u64, bytes: u32) -> u32 {
    for i in 0..bytes {
        crc ^= (v >> (8 * i)) as u8 as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0x82F6_3B78 } else { crc >> 1 };
        }
    }
    crc
}

/// Interpreter: 0F 38 / 0F 3A (`op2` = the 38/3A byte, already read).
pub fn op3_step(e: &mut Engine, d: &mut Dec, buf: &[u8; 16], rip: u64, rex: u8, p66: bool, rep: u8, op2: u8) {
    let code = (op2 as u32) << 8 | d.u8() as u32;
    let w = rex & 8 != 0;
    // CRC32 r32/r64, r/m8 (F0) or r/m16/32/64 (F1)
    if rep == 0xF2 && matches!(code, 0x38F0 | 0x38F1) {
        let m = modrm(d, e, rex);
        let next = rip + d.p as u64;
        let size = if code == 0x38F0 {
            8
        } else if w {
            64
        } else if p66 {
            16
        } else {
            32
        };
        let Ok(v) = e.get(crate::cpu::rm_loc(e, &m, next, size, rex), size) else { return };
        let r = m.reg as usize;
        let c = crc32c(e.cpu.regs[r] as u32, v, size / 8);
        e.cpu.regs[r] = c as u64;
        e.cpu.rip = next;
        return;
    }
    if rep != 0 || !op3_ok(code, p66) {
        e.unsupported(buf);
        return;
    }
    let m = modrm(d, e, rex);
    let imm = if op2 == 0x3A { d.u8() } else { 0 };
    let next = rip + d.p as u64;
    let r = m.reg as usize;
    let x = e.cpu.xmm[r];
    match code {
        // PEXTRB / PEXTRW / PEXTRD / PEXTRQ / EXTRACTPS r/m, xmm, imm
        0x3A14..=0x3A17 => {
            let (size, v) = match code {
                0x3A14 => (8, u8s(x)[(imm & 15) as usize] as u64),
                0x3A15 => (16, u16s(x)[(imm & 7) as usize] as u64),
                0x3A16 if w => (64, u64s(x)[(imm & 1) as usize]),
                _ => (32, u32s(x)[(imm & 3) as usize] as u64),
            };
            let res = if m.md == 3 {
                e.set(Loc::Reg(m.rm, false), if size == 64 { 64 } else { 32 }, v)
            } else {
                let a = ea(e, &m, next);
                e.set(Loc::Mem(a), size, v)
            };
            if res.is_err() {
                return;
            }
        }
        // PINSRB / PINSRD / PINSRQ xmm, r/m, imm
        0x3A20 | 0x3A22 => {
            let size = if code == 0x3A20 {
                8
            } else if w {
                64
            } else {
                32
            };
            let l = if m.md == 3 { Loc::Reg(m.rm, false) } else { Loc::Mem(ea(e, &m, next)) };
            let Ok(v) = e.get(l, size) else { return };
            e.cpu.xmm[r] = match size {
                8 => {
                    let mut a = u8s(x);
                    a[(imm & 15) as usize] = v as u8;
                    from_u8s(a)
                }
                32 => {
                    let mut a = u32s(x);
                    a[(imm & 3) as usize] = v as u32;
                    from_u32s(a)
                }
                _ => {
                    let mut a = u64s(x);
                    a[(imm & 1) as usize] = v;
                    from_u64s(a)
                }
            };
        }
        // PTEST: ZF = (d & s) == 0, CF = (s & !d) == 0, the other flags 0
        0x3817 => {
            let Ok(s) = e.xsrc(&m, next, 16) else { return };
            e.materialize();
            let c = &mut e.cpu;
            c.zf = x & s == 0;
            c.cf = s & !x == 0;
            c.of = false;
            c.sf = false;
            c.pf = false;
        }
        // PCMPESTRM / PCMPESTRI / PCMPISTRM / PCMPISTRI
        0x3A60..=0x3A63 => {
            let Ok(s) = e.xsrc(&m, next, 16) else { return };
            let words = imm & 1 != 0;
            let n: usize = if words { 8 } else { 16 };
            let (la, lb) = if code < 0x3A62 {
                let len = |v: u64| -> usize {
                    let v = if w { v as i64 } else { v as u32 as i32 as i64 };
                    v.unsigned_abs().min(n as u64) as usize
                };
                (len(e.cpu.regs[0]), len(e.cpu.regs[2]))
            } else {
                (str_len(x, words), str_len(s, words))
            };
            let r2 = pcmpstr(x, s, la, lb, imm);
            if code & 1 != 0 {
                let idx = if r2 == 0 {
                    n as u32
                } else if imm & 0x40 != 0 {
                    31 - r2.leading_zeros()
                } else {
                    r2.trailing_zeros()
                };
                e.cpu.regs[1] = idx as u64;
            } else if imm & 0x40 == 0 {
                e.cpu.xmm[0] = r2 as u128;
            } else {
                let bits = if words { 16 } else { 8 };
                let one = (1u128 << bits) - 1;
                e.cpu.xmm[0] = (0..n).filter(|&i| r2 >> i & 1 != 0).fold(0u128, |acc, i| acc | one << (bits * i));
            }
            e.materialize();
            let c = &mut e.cpu;
            c.cf = r2 != 0;
            c.zf = lb < n;
            c.sf = la < n;
            c.of = r2 & 1 != 0;
            c.pf = false;
        }
        _ => {
            let Ok(s) = e.xsrc(&m, next, op3_src_bytes(code)) else { return };
            // INSERTPS from memory: the loaded float is element 0
            let imm = if code == 0x3A21 && m.md != 3 { imm & 0x3F } else { imm };
            e.cpu.xmm[r] = op3(code, x, s, imm, e.cpu.xmm[0]);
        }
    }
    e.cpu.rip = next;
}

/// Packs an op for jit_op3: bit 31 marks it, bit 30 = source in cpu.xs (memory operand),
/// bit 29 = 0F 3A, bits 21..28 = third opcode byte, 8..15 = imm, 4..7 = dst, 0..3 = src.
pub fn op3_pack(code: u32, mem: bool, imm: u8, r: u8, x: u8) -> u32 {
    1 << 31 | (mem as u32) << 30 | ((code >> 8 == 0x3A) as u32) << 29 | (code & 0xFF) << 21 | (imm as u32) << 8 | ((r & 15) as u32) << 4 | (x & 15) as u32
}

/// JIT helper (called through the `cond` import with a packed op): runs it on the xmm registers.
pub fn jit_op3(e: &mut Engine, cc: u32) {
    let code = if cc >> 29 & 1 != 0 { 0x3A00 } else { 0x3800 } | (cc >> 21 & 0xFF);
    let (r, x) = ((cc >> 4 & 15) as usize, (cc & 15) as usize);
    let s = if cc >> 30 & 1 != 0 { e.cpu.xs } else { e.cpu.xmm[x] };
    e.cpu.xmm[r] = op3(code, e.cpu.xmm[r], s, (cc >> 8) as u8, e.cpu.xmm[0]);
}
