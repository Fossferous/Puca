//! Randomness, injected.
//!
//! The engine never makes its own randomness. Every shuffle takes a
//! [`GameRng`] — anything that yields uniform `u64`s — so:
//!
//! * production deals from the OS CSPRNG ([`os_rng`]: `getrandom`, i.e.
//!   `BCryptGenRandom` on Windows and `getrandom(2)` on Linux);
//! * tests deal from [`seeded`], and every hand in the suite replays from its
//!   seed;
//! * a later "provably fair" phase (docs/GAMES.md, *Not in v1*) can drive the
//!   SAME shuffle from a committed HKDF stream instead of the OS.
//!
//! There is one shuffle and it is ours: Fisher-Yates over [`below`], which
//! draws by rejection rather than `x % n`. `rand`'s own `SliceRandom` would be
//! just as correct, but then the code the uniformity test exercises would not
//! be the code a different random source would drive.

/// A source of uniform 64-bit values.
pub trait GameRng {
    fn next_u64(&mut self) -> u64;
}

impl<R: rand::RngCore + ?Sized> GameRng for R {
    fn next_u64(&mut self) -> u64 {
        rand::RngCore::next_u64(self)
    }
}

/// A uniform value in `0..n`. Panics if `n == 0`.
///
/// `x % n` over a uniform `u64` is biased whenever `n` does not divide 2^64:
/// the top `2^64 mod n` values fold onto the low residues a second time. Those
/// values are rejected and redrawn instead, so every residue has exactly
/// `floor(2^64 / n)` preimages. For a 52-card deck a redraw is needed about
/// once in 10^17 draws; it costs nothing and removes the argument.
pub fn below<R: GameRng + ?Sized>(rng: &mut R, n: u64) -> u64 {
    assert!(n > 0, "below(0)");
    // `zone` is the largest multiple of n that fits; values >= zone are the
    // biased tail. (For n = 1 the zone is u64::MAX itself; the one rejected
    // value changes nothing.)
    let zone = (u64::MAX / n) * n;
    loop {
        let x = rng.next_u64();
        if x < zone {
            return x % n;
        }
    }
}

/// Fisher-Yates: every permutation of `items` equally likely, given a uniform
/// source.
pub fn shuffle<T, R: GameRng + ?Sized>(items: &mut [T], rng: &mut R) {
    for i in (1..items.len()).rev() {
        // j in 0..=i — the "+ 1" is the whole difference between a uniform
        // shuffle and Sattolo's cycle generator (see tests/shuffle.rs).
        let j = below(rng, i as u64 + 1) as usize;
        items.swap(i, j);
    }
}

/// The production dealer: the operating system's CSPRNG.
pub fn os_rng() -> rand::rngs::OsRng {
    rand::rngs::OsRng
}

/// A reproducible generator for tests and simulations. NEVER deal a real
/// table from this: anyone who learns the seed knows every card.
pub fn seeded(seed: u64) -> rand::rngs::StdRng {
    use rand::SeedableRng;
    rand::rngs::StdRng::seed_from_u64(seed)
}
