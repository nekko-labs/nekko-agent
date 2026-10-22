//! Length hiding. A record's plaintext is framed as a 4-byte big-endian
//! length and the bytes, then zero-padded to the Padmé size of the frame (at
//! least 256 bytes). Padmé (Nikitin et al., PETS 2019) leaks O(log log n)
//! bits of the length and costs at most about 12% overhead.

/// The smallest padded size: a short message and an empty one look the same.
pub const MIN_PADDED: usize = 256;

/// The Padmé size for a length.
pub fn padme(len: usize) -> usize {
    if len < 2 {
        return len;
    }
    let e = usize::BITS - 1 - len.leading_zeros(); // floor(log2 len)
    let s = u32::BITS - e.leading_zeros(); // floor(log2 e) + 1
    let last_bits = e - s;
    let mask = (1usize << last_bits) - 1;
    (len + mask) & !mask
}

/// Frame and pad a plaintext.
pub fn frame(plaintext: &[u8]) -> Vec<u8> {
    let len = u32::try_from(plaintext.len()).expect("a record is under 4 GiB");
    let size = padme((plaintext.len() + 4).max(MIN_PADDED));
    let mut out = Vec::with_capacity(size);
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(plaintext);
    out.resize(size, 0);
    out
}

/// The plaintext inside a frame. The padding is authenticated with the rest,
/// so a frame that lies about its length is only possible with the key.
pub fn unframe(framed: &[u8]) -> Result<Vec<u8>, crate::Error> {
    let head: [u8; 4] = framed.get(..4).and_then(|h| h.try_into().ok()).ok_or(crate::Error::Malformed)?;
    let len = u32::from_be_bytes(head) as usize;
    framed.get(4..4 + len).map(<[u8]>::to_vec).ok_or(crate::Error::Malformed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn padme_matches_the_paper() {
        assert_eq!(padme(256), 256);
        assert_eq!(padme(257), 272);
        assert_eq!(padme(1000), 1024);
        assert_eq!(padme(1025), 1088);
        assert_eq!(padme(1_000_000), 1_015_808);
        for n in 2..100_000 {
            let p = padme(n);
            assert!(p >= n && (p - n) * 100 <= n * 12 + 100, "{n} → {p}");
        }
    }

    #[test]
    fn frames_round_trip_and_hide_short_lengths() {
        assert_eq!(frame(b"").len(), 256);
        assert_eq!(frame(b"hi").len(), 256);
        assert_eq!(unframe(&frame(b"hi")).unwrap(), b"hi");
        let big = vec![7u8; 5000];
        assert_eq!(unframe(&frame(&big)).unwrap(), big);
        assert_eq!(unframe(&[0, 0, 1, 0, 1]), Err(crate::Error::Malformed));
    }
}
