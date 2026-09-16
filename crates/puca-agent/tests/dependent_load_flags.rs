//! The import table's DLL search is System32-only BEFORE main() runs.
//!
//! `dll_search::harden` narrows the search path for everything loaded after
//! it, but the loader resolves this binary's static imports first, and several
//! of them are not KnownDLLs — so a same-named DLL beside the exe would load
//! into this process before any Rust code ran. build.rs links with
//! `/DEPENDENTLOADFLAG:0x800` (LOAD_LIBRARY_SEARCH_SYSTEM32) to close that;
//! this reads the built binary's load-config directory and requires the flag,
//! so the next linker or flag change cannot silently reopen it. Found by the
//! 2026-09-16 adversarial campaign.
#![cfg(windows)]

fn u16le(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([d[o], d[o + 1]])
}

fn u32le(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([d[o], d[o + 1], d[o + 2], d[o + 3]])
}

/// `DependentLoadFlags` from IMAGE_LOAD_CONFIG_DIRECTORY, or None when the
/// image carries no load-config directory at all.
fn dependent_load_flags(bytes: &[u8]) -> Option<u16> {
    let e = u32le(bytes, 0x3c) as usize;
    assert_eq!(&bytes[e..e + 4], b"PE\0\0", "not a PE image");
    let nsec = u16le(bytes, e + 6) as usize;
    let optsz = u16le(bytes, e + 20) as usize;
    let opt = e + 24;
    let magic = u16le(bytes, opt);
    let dd = opt + if magic == 0x20b { 112 } else { 96 };
    // Data directory 10 is the load config.
    let lc_rva = u32le(bytes, dd + 10 * 8) as usize;
    if lc_rva == 0 {
        return None;
    }
    let sections: Vec<(usize, usize, usize, usize)> = (0..nsec)
        .map(|i| {
            let b = opt + optsz + 40 * i;
            (
                u32le(bytes, b + 12) as usize, // VirtualAddress
                u32le(bytes, b + 8) as usize,  // VirtualSize
                u32le(bytes, b + 20) as usize, // PointerToRawData
                u32le(bytes, b + 16) as usize, // SizeOfRawData
            )
        })
        .collect();
    let off = sections
        .iter()
        .find(|(va, vs, _, rs)| lc_rva >= *va && lc_rva < va + std::cmp::max(*vs, *rs))
        .map(|(va, _, ra, _)| ra + (lc_rva - va))
        .expect("the load config RVA is inside a section");
    let size = u32le(bytes, off) as usize;
    // DependentLoadFlags sits at +78 in both the 32- and 64-bit layouts.
    if size < 80 {
        return None;
    }
    Some(u16le(bytes, off + 78))
}

#[test]
fn the_import_table_is_resolved_from_system32_only() {
    let exe = env!("CARGO_BIN_EXE_puca-agent");
    let bytes = std::fs::read(exe).expect("the built binary");
    let flags = dependent_load_flags(&bytes)
        .expect("a load-config directory with DependentLoadFlags; /DEPENDENTLOADFLAG was not linked in");
    assert_eq!(
        flags & 0x800,
        0x800,
        "DependentLoadFlags is {flags:#06x}: LOAD_LIBRARY_SEARCH_SYSTEM32 is not applied to the static imports"
    );
}
