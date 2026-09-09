//! Which adapter owns each output, and which adapters can actually duplicate it?
//!
//! WHY THIS EXISTS. A clip arm failed with
//! `DuplicateOutput failed: ... (0x887A0004)` — `DXGI_ERROR_UNSUPPORTED`. From
//! `IDXGIOutput1::DuplicateOutput` that HRESULT has one common meaning: the
//! D3D11 device was created on a DIFFERENT adapter from the one owning the
//! output. `windows_impl.rs` walks adapters AND their outputs to find monitor N
//! (correctly — monitor N is not adapter N), then duplicates it with a device
//! from `D3D11CreateDevice(None, D3D_DRIVER_TYPE_HARDWARE, ..)`: whatever
//! adapter Windows calls default FOR THIS PROCESS.
//!
//! That last part is the trap. The default is not a property of the machine, it
//! is a property of the process — a per-app graphics preference, a hybrid-GPU
//! heuristic or a driver update can change it with no code change at all. So
//! "it works when I run it" proves nothing; the useful question is which
//! adapters can duplicate a given output AT ALL.
//!
//! Run:  cargo run -p puca-capture --example dxgi-topology
#![cfg(windows)]

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_UNKNOWN, D3D_DRIVER_TYPE_WARP,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter, IDXGIFactory1, IDXGIOutput, IDXGIOutput1,
};

/// A device on a specific adapter, or on the default when `adapter` is None.
///
/// NOTE the driver type: passing an explicit adapter REQUIRES
/// `D3D_DRIVER_TYPE_UNKNOWN`. `HARDWARE` with a non-null adapter is
/// E_INVALIDARG — the mistake that usually follows this diagnosis.
fn device_on(adapter: Option<&IDXGIAdapter>) -> Option<ID3D11Device> {
    let mut device: Option<ID3D11Device> = None;
    unsafe {
        D3D11CreateDevice(
            adapter,
            if adapter.is_some() { D3D_DRIVER_TYPE_UNKNOWN } else { D3D_DRIVER_TYPE_HARDWARE },
            None,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )
        .ok()?;
    }
    device
}

/// A device by DRIVER TYPE with no adapter — exactly what
/// `windows_impl.rs::create_device` does, including its WARP fallback.
fn device_by_driver(driver: D3D_DRIVER_TYPE) -> Option<ID3D11Device> {
    let mut device: Option<ID3D11Device> = None;
    unsafe {
        D3D11CreateDevice(
            None,
            driver,
            None,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )
        .ok()?;
    }
    device
}

fn adapter_name(a: &windows::Win32::Graphics::Dxgi::IDXGIAdapter1) -> String {
    unsafe { a.GetDesc1() }
        .ok()
        .map(|d| String::from_utf16_lossy(&d.Description).trim_end_matches('\0').trim().to_string())
        .unwrap_or_else(|| "<unnamed>".into())
}

fn try_dup(output: &IDXGIOutput, device: &Option<ID3D11Device>) -> String {
    let out1 = match output.cast::<IDXGIOutput1>() {
        Ok(o) => o,
        Err(e) => return format!("no IDXGIOutput1: {e}"),
    };
    match device {
        None => "no device".to_string(),
        Some(d) => match unsafe { out1.DuplicateOutput(d) } {
            Ok(_) => "OK".to_string(),
            Err(e) => format!("{:#010X}", e.code().0 as u32),
        },
    }
}

fn main() -> windows::core::Result<()> {
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1()?;

        // Name every adapter up front, so the matrix below reads.
        let mut adapters = Vec::new();
        let mut i = 0u32;
        while let Ok(a) = factory.EnumAdapters1(i) {
            adapters.push((i, adapter_name(&a), a));
            i += 1;
        }
        println!("{} adapter(s):", adapters.len());
        for (idx, name, _) in &adapters {
            println!("  {idx}: {name}");
        }

        let default_device = device_on(None);
        // THE QUESTION THIS PROBE WAS EXTENDED TO ANSWER. create_device() tries
        // HARDWARE and falls back to WARP. A WARP device is a software
        // rasterizer with no display attached — if duplication on it fails, the
        // fallback silently converts "no hardware device right now" into "no
        // monitor can be captured", which is exactly what a member sees.
        let warp_device = device_by_driver(D3D_DRIVER_TYPE_WARP);
        println!(
            "WARP device: {}",
            if warp_device.is_some() { "created" } else { "could not be created" }
        );
        println!(
            "\ndevice on the DEFAULT adapter for THIS process: {}\n",
            if default_device.is_some() { "created" } else { "FAILED" }
        );

        let mut seen = 0usize;
        let mut cross_failures = 0usize;
        for (aidx, aname, adapter) in &adapters {
            let mut oidx = 0u32;
            while let Ok(output) = adapter.EnumOutputs(oidx) {
                let rect = output
                    .GetDesc()
                    .ok()
                    .map(|d| {
                        let r = d.DesktopCoordinates;
                        format!("{}x{} at {},{}", r.right - r.left, r.bottom - r.top, r.left, r.top)
                    })
                    .unwrap_or_else(|| "<no desc>".into());
                println!("capture index {seen} — owned by adapter {aidx} ({aname}) — {rect}");
                println!("    with the process default adapter: {}", try_dup(&output, &default_device));
                println!("    with a WARP (software) device:     {}", try_dup(&output, &warp_device));

                // THE MATRIX: every adapter against this output.
                for (oa_idx, oa_name, other) in &adapters {
                    let dev = other.cast::<IDXGIAdapter>().ok().and_then(|c| device_on(Some(&c)));
                    if dev.is_none() {
                        continue; // a virtual/software adapter that cannot make a device
                    }
                    let r = try_dup(&output, &dev);
                    let owns = if oa_idx == aidx { " (owner)" } else { "" };
                    if oa_idx != aidx && r != "OK" {
                        cross_failures += 1;
                    }
                    println!("      via adapter {oa_idx} ({oa_name}){owns}: {r}");
                }
                seen += 1;
                oidx += 1;
            }
        }

        println!("\n{seen} capturable output(s).");
        println!(
            "{cross_failures} adapter/output combination(s) failed where the adapter did NOT own \
             the output — which is what binding the device to the owning adapter prevents."
        );
    }
    Ok(())
}
