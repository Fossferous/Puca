//! Can a screen still be duplicated when the process prefers the LOW-POWER GPU?
//!
//! WHY THIS EXISTS. Windows lets a user pin an app to a GPU (Settings ->
//! Display -> Graphics, stored in
//! `HKCU\Software\Microsoft\DirectX\UserGpuPreferences`). The reporter has
//! Puca.exe pinned to "power saving" DELIBERATELY and is keeping it: with a
//! game using 100% of the discrete card, moving the app off it is what stopped
//! their stream looking choppy to viewers. So clips have to work in that
//! configuration — "unpin it" is not an answer.
//!
//! With the app pinned, every monitor refused duplication and the error named
//! `AMD Radeon(TM) Graphics`. The open question is whether the DISCRETE adapter
//! still exposes those monitors inside such a process — because if it does,
//! walking every adapter and taking the first that can duplicate (what
//! `open_duplication` now does) fixes it, and if it does not, that fix cannot
//! work and something else is needed.
//!
//! `IDXGIFactory6::EnumAdapterByGpuPreference` is the same preference the OS
//! pin drives, so this reproduces the pinned VIEW without changing any setting
//! on the machine.
//!
//! Run:  cargo run -p puca-capture --example gpu-preference

#[cfg(windows)]
use windows::core::Interface;
#[cfg(windows)]
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
#[cfg(windows)]
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
};
#[cfg(windows)]
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter, IDXGIAdapter1, IDXGIFactory1, IDXGIFactory6, IDXGIOutput1,
    DXGI_GPU_PREFERENCE, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE, DXGI_GPU_PREFERENCE_MINIMUM_POWER,
    DXGI_GPU_PREFERENCE_UNSPECIFIED,
};

#[cfg(windows)]
fn name_of(a: &IDXGIAdapter1) -> String {
    unsafe { a.GetDesc1() }
        .ok()
        .map(|d| String::from_utf16_lossy(&d.Description).trim_end_matches('\0').trim().to_string())
        .unwrap_or_else(|| "<unnamed>".into())
}

/// Walk the adapters in the order this GPU preference implies, and for every
/// output each one exposes, say whether it can be duplicated from that adapter.
#[cfg(windows)]
unsafe fn report(factory: &IDXGIFactory6, pref: DXGI_GPU_PREFERENCE, label: &str) {
    println!("\n=== preference: {label} ===");
    let mut i = 0u32;
    let mut any_output = false;
    let mut any_ok = false;
    loop {
        let adapter: IDXGIAdapter1 = match factory.EnumAdapterByGpuPreference(i, pref) {
            Ok(a) => a,
            Err(_) => break,
        };
        i += 1;
        let name = name_of(&adapter);

        let mut outs = 0u32;
        let mut line = String::new();
        while let Ok(output) = adapter.EnumOutputs(outs) {
            outs += 1;
            any_output = true;
            let size = output
                .GetDesc()
                .ok()
                .map(|d| {
                    let r = d.DesktopCoordinates;
                    format!("{}x{}", r.right - r.left, r.bottom - r.top)
                })
                .unwrap_or_else(|| "?".into());

            // A device on THIS adapter, then try to duplicate THIS output.
            let mut device: Option<ID3D11Device> = None;
            let made = adapter.cast::<IDXGIAdapter>().ok().map(|a| {
                D3D11CreateDevice(
                    &a,
                    D3D_DRIVER_TYPE_UNKNOWN,
                    None,
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    None,
                )
            });
            let verdict = match (made, output.cast::<IDXGIOutput1>(), &device) {
                (Some(Ok(())), Ok(o1), Some(d)) => match o1.DuplicateOutput(d) {
                    Ok(_) => {
                        any_ok = true;
                        "OK".to_string()
                    }
                    Err(e) => format!("{:#010X}", e.code().0 as u32),
                },
                _ => "no device".to_string(),
            };
            line.push_str(&format!("      output {size}: {verdict}\n"));
        }
        println!("  adapter {}: {name}  ({outs} output(s))", i - 1);
        print!("{line}");
    }
    if !any_output {
        println!("  (no adapter exposed ANY output under this preference)");
    }
    println!(
        "  => a screen {} be duplicated with this preference",
        if any_ok { "CAN" } else { "CANNOT" }
    );
}

#[cfg(windows)]
fn main() -> windows::core::Result<()> {
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1()?;
        let f6: IDXGIFactory6 = factory.cast()?;
        report(&f6, DXGI_GPU_PREFERENCE_MINIMUM_POWER, "MINIMUM_POWER (what 'power saving' pins to)");
        report(&f6, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE, "HIGH_PERFORMANCE");
        report(&f6, DXGI_GPU_PREFERENCE_UNSPECIFIED, "UNSPECIFIED (no pin)");
    }
    println!(
        "\nIf MINIMUM_POWER lists the monitors on the low-power adapter AND another\n\
         adapter also lists them with OK, then walking every adapter fixes the\n\
         pinned case. If only the low-power adapter lists them, it cannot."
    );
    Ok(())
}

// OFF WINDOWS THIS MUST STILL COMPILE. `cargo test` builds every example,
// and a file-wide `#![cfg(windows)]` removes `main` along with everything
// else — which is E0601 on Linux, not a skipped probe. Same shape as
// cursor_probe.rs beside it.
#[cfg(not(windows))]
fn main() {
    eprintln!("gpu-preference asks DXGI what each GPU preference exposes; run it on Windows.");
}
