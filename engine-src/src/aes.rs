// AES-NI (AESENC/AESENCLAST/AESDEC/AESDECLAST/AESIMC/AESKEYGENASSIST) and PCLMULQDQ, from
// the Intel SDM / FIPS-197 definitions. The state is the xmm value as 16 bytes, column-major
// (byte 4c + r = row r of column c), like the instructions. Rounds use one 256-entry table per
// direction (S-box times the MixColumns column, rotated per row), built at compile time.

const fn xt(x: u8) -> u8 {
    (x << 1) ^ if x & 0x80 != 0 { 0x1B } else { 0 }
}
const fn gmul(mut a: u8, mut b: u8) -> u8 {
    let mut p = 0u8;
    while b != 0 {
        if b & 1 != 0 {
            p ^= a;
        }
        a = xt(a);
        b >>= 1;
    }
    p
}
const fn sbox() -> [u8; 256] {
    let mut s = [0u8; 256];
    let mut x = 0usize;
    while x < 256 {
        // inverse in GF(2^8) = x^254 (0 for 0)
        let mut inv = 1u8;
        let mut k = 0;
        while k < 254 {
            inv = gmul(inv, x as u8);
            k += 1;
        }
        if x == 0 {
            inv = 0;
        }
        let b = inv;
        s[x] = b ^ b.rotate_left(1) ^ b.rotate_left(2) ^ b.rotate_left(3) ^ b.rotate_left(4) ^ 0x63;
        x += 1;
    }
    s
}
const S: [u8; 256] = sbox();
const fn inv_sbox() -> [u8; 256] {
    let mut v = [0u8; 256];
    let mut x = 0;
    while x < 256 {
        v[S[x] as usize] = x as u8;
        x += 1;
    }
    v
}
const SI: [u8; 256] = inv_sbox();
/// Column word (row 0 in the low byte) that S[x] in row 0 adds through MixColumns: 2s, s, s, 3s.
const fn te() -> [u32; 256] {
    let mut t = [0u32; 256];
    let mut x = 0;
    while x < 256 {
        let s = S[x];
        t[x] = gmul(s, 2) as u32 | (s as u32) << 8 | (s as u32) << 16 | (gmul(s, 3) as u32) << 24;
        x += 1;
    }
    t
}
/// Same for InvS[x] through InvMixColumns: 14s, 9s, 13s, 11s.
const fn td() -> [u32; 256] {
    let mut t = [0u32; 256];
    let mut x = 0;
    while x < 256 {
        let s = SI[x];
        t[x] = gmul(s, 14) as u32 | (gmul(s, 9) as u32) << 8 | (gmul(s, 13) as u32) << 16 | (gmul(s, 11) as u32) << 24;
        x += 1;
    }
    t
}
static TE: [u32; 256] = te();
static TD: [u32; 256] = td();

/// One round: `enc` = ShiftRows (else InvShiftRows), S-box (or inverse), MixColumns (or inverse)
/// unless `last`, then XOR with the round key `k`.
#[inline(always)]
fn round(st: u128, k: u128, enc: bool, last: bool) -> u128 {
    let b = st.to_le_bytes();
    let mut out = [0u32; 4];
    for c in 0..4 {
        let mut w = 0u32;
        for r in 0..4 {
            // byte that lands in row r of column c after (Inv)ShiftRows
            let src = b[r + 4 * if enc { (c + r) & 3 } else { (c + 4 - r) & 3 }];
            w ^= if last {
                ((if enc { S[src as usize] } else { SI[src as usize] }) as u32) << (8 * r)
            } else {
                (if enc { TE[src as usize] } else { TD[src as usize] }).rotate_left(8 * r as u32)
            };
        }
        out[c] = w;
    }
    (out[0] as u128 | (out[1] as u128) << 32 | (out[2] as u128) << 64 | (out[3] as u128) << 96) ^ k
}

fn inv_mix(v: u128) -> u128 {
    let b = v.to_le_bytes();
    let mut o = [0u8; 16];
    for c in 0..4 {
        let a = [b[4 * c], b[4 * c + 1], b[4 * c + 2], b[4 * c + 3]];
        for r in 0..4 {
            o[4 * c + r] = gmul(a[r], 14) ^ gmul(a[(r + 1) & 3], 11) ^ gmul(a[(r + 2) & 3], 13) ^ gmul(a[(r + 3) & 3], 9);
        }
    }
    u128::from_le_bytes(o)
}

fn sub_word(x: u32) -> u32 {
    u32::from_le_bytes(x.to_le_bytes().map(|b| S[b as usize]))
}

fn clmul(a: u64, b: u64) -> u128 {
    let mut r = 0u128;
    for i in 0..64 {
        if b >> i & 1 != 0 {
            r ^= (a as u128) << i;
        }
    }
    r
}

/// Result of 66 0F 38 DB..DF / 66 0F 3A 44, DF on dst `d` and source `s`.
#[inline(always)]
pub fn op(code: u32, d: u128, s: u128, imm: u8) -> u128 {
    match code {
        0x38DC => round(d, s, true, false),
        0x38DD => round(d, s, true, true),
        0x38DE => round(d, s, false, false),
        0x38DF => round(d, s, false, true),
        0x38DB => inv_mix(s),
        // AESKEYGENASSIST: SubWord / RotWord(SubWord) ^ RCON of source dwords 1 and 3
        0x3ADF => {
            let (x1, x3, rc) = ((s >> 32) as u32, (s >> 96) as u32, imm as u32);
            let (a, b) = (sub_word(x1), sub_word(x3));
            a as u128 | ((a.rotate_right(8) ^ rc) as u128) << 32 | (b as u128) << 64 | ((b.rotate_right(8) ^ rc) as u128) << 96
        }
        // PCLMULQDQ: imm bit 0 picks the dst qword, bit 4 the source qword
        0x3A44 => clmul((d >> (64 * (imm & 1) as u32)) as u64, (s >> (64 * (imm >> 4 & 1) as u32)) as u64),
        _ => d,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fips197() {
        assert_eq!(S[0], 0x63);
        assert_eq!(S[0x53], 0xED);
        assert_eq!(SI[0x63], 0);
        // AES-128 key expansion with AESKEYGENASSIST, then encrypt/decrypt (FIPS-197 C.1)
        let key = u128::from_le_bytes([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
        let pt = u128::from_le_bytes([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
        let ct = u128::from_le_bytes([0x69, 0xc4, 0xe0, 0xd8, 0x6a, 0x7b, 0x04, 0x30, 0xd8, 0xcd, 0xb7, 0x80, 0x70, 0xb4, 0xc5, 0x5a]);
        let mut rk = [key; 11];
        let rcon = [1u8, 2, 4, 8, 16, 32, 64, 128, 0x1b, 0x36];
        for i in 1..11 {
            let t = op(0x3ADF, 0, rk[i - 1], rcon[i - 1]);
            let t = ((t >> 96) as u32) as u128;
            let t = t | t << 32 | t << 64 | t << 96;
            let mut k = rk[i - 1];
            k ^= k << 32;
            k ^= k << 64;
            rk[i] = k ^ t;
        }
        let mut x = pt ^ rk[0];
        for k in &rk[1..10] {
            x = op(0x38DC, x, *k, 0);
        }
        x = op(0x38DD, x, rk[10], 0);
        assert_eq!(x, ct);
        let mut y = ct ^ rk[10];
        for i in (1..10).rev() {
            y = op(0x38DE, y, op(0x38DB, 0, rk[i], 0), 0);
        }
        y = op(0x38DF, y, rk[0], 0);
        assert_eq!(y, pt);
        assert_eq!(op(0x3A44, 3, 3, 0), 5);
        assert_eq!(op(0x3A44, 1 << 64, 1u128 << 64, 0x11), 1);
    }
}
