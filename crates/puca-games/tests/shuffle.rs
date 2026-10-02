//! The shuffle is the one piece of the dealer a player cannot audit, so it is
//! tested two ways: statistically (every card is equally likely to land in
//! every position) and exactly (the rejection sampler throws away the values
//! that would make `x % n` biased). Both checks run the PRODUCTION functions,
//! `rng::shuffle` and `rng::below`, driven by a seeded generator.

use puca_games::rng::{below, seeded, shuffle};

/// A generator that replays a fixed script, for exact tests of `below`.
struct Script(Vec<u64>, usize);

impl rand::RngCore for Script {
    fn next_u32(&mut self) -> u32 {
        rand::RngCore::next_u64(self) as u32
    }
    fn next_u64(&mut self) -> u64 {
        let v = self.0[self.1];
        self.1 += 1;
        v
    }
    fn fill_bytes(&mut self, dest: &mut [u8]) {
        rand::RngCore::try_fill_bytes(self, dest).unwrap()
    }
    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rand::Error> {
        for chunk in dest.chunks_mut(8) {
            let v = rand::RngCore::next_u64(self).to_le_bytes();
            chunk.copy_from_slice(&v[..chunk.len()]);
        }
        Ok(())
    }
}

#[test]
fn below_rejects_the_top_of_the_range_instead_of_folding_it_with_modulo() {
    // u64::MAX % 10 == 5, so `x % 10` maps the last six values of the range
    // onto 0..=5 a second time — 0..=5 would come up slightly more often than
    // 6..=9. Those six values must be thrown away and the next draw used.
    let mut s = Script(vec![u64::MAX, u64::MAX - 5, 7], 0);
    assert_eq!(below(&mut s, 10), 7);
    assert_eq!(s.1, 3, "both values in the biased zone were rejected");
    // The largest ACCEPTED value is the last one before the zone.
    let zone_start = (u64::MAX / 10) * 10;
    let mut s = Script(vec![zone_start - 1], 0);
    assert_eq!(below(&mut s, 10), 9);
    // n = 1 has no choice to make.
    let mut s = Script(vec![12345], 0);
    assert_eq!(below(&mut s, 1), 0);
}

fn positions_chi_square(shuffles: usize, shuffle_fn: impl Fn(&mut [usize], &mut rand::rngs::StdRng)) -> f64 {
    const N: usize = 52;
    let mut rng = seeded(0xC4_1D5);
    let mut counts = vec![[0u32; N]; N];
    for _ in 0..shuffles {
        let mut deck: Vec<usize> = (0..N).collect();
        shuffle_fn(&mut deck, &mut rng);
        for (pos, &card) in deck.iter().enumerate() {
            counts[card][pos] += 1;
        }
    }
    let expected = shuffles as f64 / N as f64;
    counts
        .iter()
        .flat_map(|row| row.iter())
        .map(|&o| (o as f64 - expected).powi(2) / expected)
        .sum()
}

/// Statistic over the 52x52 card-by-position table. Each shuffle is a
/// permutation, so rows and columns are constrained and the statistic is
/// chi-square with (52-1)^2 = 2,601 degrees of freedom: mean 2,601, standard
/// deviation sqrt(2 * 2,601) = 72. The bound is the mean plus five standard
/// deviations; the seed is fixed, so the test is deterministic either way.
const DF: f64 = 2_601.0;
const BOUND: f64 = DF + 5.0 * 72.12;

#[test]
fn every_card_is_equally_likely_in_every_position() {
    let stat = positions_chi_square(52 * 400, shuffle);
    assert!(stat < BOUND, "chi-square {stat:.1} >= {BOUND:.1}: the shuffle is not uniform");
    // A uniform shuffle is not suspiciously TOO even either.
    assert!(stat > DF - 5.0 * 72.12, "chi-square {stat:.1} is implausibly low");
}

#[test]
fn the_uniformity_test_catches_the_classic_off_by_one_shuffle() {
    // POSITIVE CONTROL. Sattolo's algorithm — Fisher-Yates with `below(i)`
    // where `below(i + 1)` belongs — only ever produces single cycles, so no
    // card can stay where it started. The test above must reject it.
    let sattolo = |d: &mut [usize], r: &mut rand::rngs::StdRng| {
        for i in (1..d.len()).rev() {
            let j = below(r, i as u64) as usize;
            d.swap(i, j);
        }
    };
    let stat = positions_chi_square(52 * 400, sattolo);
    assert!(stat > BOUND, "chi-square {stat:.1} did not reject a biased shuffle");
}

#[test]
fn a_shuffle_is_a_permutation_and_depends_on_the_seed() {
    let mut a: Vec<u8> = (0..52).collect();
    let mut b: Vec<u8> = (0..52).collect();
    shuffle(&mut a, &mut seeded(1));
    shuffle(&mut b, &mut seeded(2));
    let mut sorted = a.clone();
    sorted.sort_unstable();
    assert_eq!(sorted, (0..52).collect::<Vec<u8>>());
    assert_ne!(a, b);
    let mut again: Vec<u8> = (0..52).collect();
    shuffle(&mut again, &mut seeded(1));
    assert_eq!(a, again, "same seed, same deck");
}
