//! The virtual screen's Windows half: install, remove, switch on, switch off.
//!
//! The decisions are in `virtual_screen.rs` and tested there. This file only
//! carries them out, and it is NOT exercised by any test: every function here
//! installs a driver, creates or deletes a device, or changes what displays the
//! machine has. Running one from `cargo test` would rearrange the developer's
//! screens, which is the line `display_topology.rs` draws for the same reason.
//! Verifying it needs a real laptop, with the owner's permission, by the steps
//! in `docs/REMOTE_CONTROL.md` ("A laptop with its lid closed").
//!
//! WHO CALLS WHAT, because the two halves run in very different places:
//!  * `install` / `remove` run in the ELEVATED HELPER (`sovereign-service.exe
//!    virtual-screen-install`, raised by the app with a UAC prompt) in the
//!    signed-in user's own session. That placement is what lets Windows show
//!    its "install this device software?" prompt. A service in session 0 has
//!    no desktop to show it on, and Windows refuses an untrusted publisher
//!    outright when it cannot ask. `remove` also runs from `deprovision` and
//!    from the uninstaller's hook, where it needs no prompt.
//!  * `hold` / `release` / `tick` / `recover_at_start` run INSIDE THE SERVICE
//!    as LocalSystem, where switching an installed device on and off needs no
//!    prompt at all.

#![cfg(windows)]

use crate::virtual_screen::{
    describe_install_error, install_precheck, is_driver_hardware_id, matches_pinned,
    settings_xml, startup_action, Installed, LeaseBook, Report, Transition, Unavailable,
    DEFAULT_HEIGHT, DEFAULT_REFRESH_HZ, DEFAULT_WIDTH, DRIVER_FILES, DRIVER_REG_KEY,
    DRIVER_REG_OWNER_VALUE, DRIVER_REG_PATH_VALUE, HARDWARE_ID, ORIGINAL_INF_NAME,
};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    CM_Get_DevNode_Status, CM_Locate_DevNodeW, DiUninstallDevice, SetupDiCallClassInstaller,
    SetupDiCreateDeviceInfoList, SetupDiCreateDeviceInfoW, SetupDiDestroyDeviceInfoList,
    SetupDiEnumDeviceInfo, SetupDiGetClassDevsW, SetupDiGetDeviceInstanceIdW,
    SetupDiGetDeviceRegistryPropertyW, SetupDiOpenDevRegKey, SetupDiOpenDeviceInfoW,
    SetupDiSetClassInstallParamsW, SetupDiSetDeviceRegistryPropertyW,
    SetupGetInfDriverStoreLocationW, SetupUninstallOEMInfW, UpdateDriverForPlugAndPlayDevicesW,
    CM_DEVNODE_STATUS_FLAGS, CM_LOCATE_DEVNODE_NORMAL, CM_PROB, CM_PROB_DISABLED, CR_SUCCESS,
    DICD_GENERATE_ID, DICS_DISABLE, DICS_ENABLE, DICS_FLAG_GLOBAL, DIF_PROPERTYCHANGE,
    DIF_REGISTERDEVICE, DIF_REMOVE, DIGCF_ALLCLASSES, DIREG_DRV, GUID_DEVCLASS_DISPLAY, HDEVINFO,
    SPDRP_HARDWAREID, SP_CLASSINSTALL_HEADER, SP_DEVINFO_DATA, SP_PROPCHANGE_PARAMS,
    UPDATEDRIVERFORPLUGANDPLAYDEVICES_FLAGS,
};
use windows::Win32::Foundation::{BOOL, HWND};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteKeyW, RegOpenKeyExW, RegQueryInfoKeyW,
    RegQueryValueExW, RegSetValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE,
    REG_DWORD, REG_OPTION_NON_VOLATILE, REG_SZ, REG_VALUE_TYPE,
};

/// The release files, embedded. See `virtual_screen::DRIVER_FILES` for why the
/// installing binary carries them rather than reading them from the app.
const EMBEDDED: [(&str, &[u8]); 3] = [
    ("MttVDD.dll", include_bytes!("../vdd/MttVDD.dll")),
    ("MttVDD.inf", include_bytes!("../vdd/MttVDD.inf")),
    ("mttvdd.cat", include_bytes!("../vdd/mttvdd.cat")),
];

/// The driver's settings folder. The driver runs in a UMDF host as
/// LocalService, so it is granted READ (and the UMDF driver SID, S-1-5-84-…,
/// which that host also carries). Users may read, as everywhere in the install
/// directory. Nobody but SYSTEM and administrators may write, so a command sent
/// to the driver's open control pipe cannot rewrite its settings for the next
/// session (`vdd/NOTICE.md`).
const SETTINGS_SDDL: &str = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)\
                             (A;OICI;0x1200a9;;;LS)(A;OICI;0x1200a9;;;S-1-5-84-0-0-0-0-0)";

fn log(msg: &str) {
    crate::log::line(&format!("[virtual-screen] {msg}"));
}

fn install_dir() -> Result<PathBuf, String> {
    crate::path_guard::install_dir()
}

/// Where the driver package is written before Windows copies it into its
/// driver store.
fn package_dir() -> Result<PathBuf, String> {
    Ok(install_dir()?.join("virtual-screen-driver"))
}

/// Where the driver reads `vdd_settings.xml` (its `VDDPATH`).
fn settings_dir() -> Result<PathBuf, String> {
    Ok(install_dir()?.join("virtual-screen"))
}

fn record_path() -> Result<PathBuf, String> {
    Ok(install_dir()?.join(Installed::FILE))
}

/// What this service installed, or `None`. A record with the wrong version or
/// a parse error reads as "not installed": the hold then answers NotInstalled,
/// and the switch in the app offers to install, which repairs it.
pub fn read_installed() -> Option<Installed> {
    let raw = std::fs::read(record_path().ok()?).ok()?;
    let rec: Installed = serde_json::from_slice(&raw).ok()?;
    (rec.version == Installed::VERSION).then_some(rec)
}

fn write_installed(rec: &Installed) -> Result<(), String> {
    let path = record_path()?;
    let body = serde_json::to_vec_pretty(rec).map_err(|e| format!("cannot encode the record: {e}"))?;
    std::fs::write(&path, body).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

// ------------------------------------------------------------ SetupAPI helpers

/// Destroys the device-information set on every path out.
struct DevInfo(HDEVINFO);
impl Drop for DevInfo {
    fn drop(&mut self) {
        unsafe {
            let _ = SetupDiDestroyDeviceInfoList(self.0);
        }
    }
}

fn new_devinfo_data() -> SP_DEVINFO_DATA {
    SP_DEVINFO_DATA { cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32, ..Default::default() }
}

fn wide_z(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Split a REG_MULTI_SZ byte buffer into its strings.
fn multi_sz(bytes: &[u8]) -> Vec<String> {
    let wide: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    wide.split(|c| *c == 0).filter(|s| !s.is_empty()).map(String::from_utf16_lossy).collect()
}

fn hardware_ids(set: HDEVINFO, data: &SP_DEVINFO_DATA) -> Vec<String> {
    let mut buf = vec![0u8; 2048];
    let mut needed = 0u32;
    unsafe {
        if SetupDiGetDeviceRegistryPropertyW(
            set,
            data,
            SPDRP_HARDWAREID,
            None,
            Some(&mut buf),
            Some(&mut needed),
        )
        .is_err()
        {
            return Vec::new();
        }
    }
    buf.truncate((needed as usize).min(buf.len()));
    multi_sz(&buf)
}

fn instance_id_of(set: HDEVINFO, data: &SP_DEVINFO_DATA) -> Option<String> {
    let mut buf = vec![0u16; 512];
    let mut needed = 0u32;
    unsafe { SetupDiGetDeviceInstanceIdW(set, data, Some(&mut buf), Some(&mut needed)).ok()? };
    let len = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..len]))
}

/// Every device on the machine — present or not — that carries this driver's
/// hardware ID. Phantoms count: a device someone uninstalled but left in the
/// registry still belongs to them.
fn devices_with_driver_id() -> Vec<String> {
    let mut found = Vec::new();
    unsafe {
        let Ok(set) = SetupDiGetClassDevsW(None, PCWSTR::null(), HWND::default(), DIGCF_ALLCLASSES)
        else {
            return found;
        };
        let set = DevInfo(set);
        let mut i = 0u32;
        loop {
            let mut data = new_devinfo_data();
            if SetupDiEnumDeviceInfo(set.0, i, &mut data).is_err() {
                break;
            }
            i += 1;
            if is_driver_hardware_id(&hardware_ids(set.0, &data)) {
                if let Some(id) = instance_id_of(set.0, &data) {
                    found.push(id);
                }
            }
        }
    }
    found
}

/// Open one device by instance ID, but only if it really carries this driver's
/// hardware ID. A recorded instance ID that now names something else (a reset
/// PC renumbered its root devices) is not ours to switch or delete.
fn open_ours(instance_id: &str) -> Option<(DevInfo, SP_DEVINFO_DATA)> {
    unsafe {
        let set = SetupDiCreateDeviceInfoList(Some(&GUID_DEVCLASS_DISPLAY), HWND::default()).ok()?;
        let set = DevInfo(set);
        let mut data = new_devinfo_data();
        SetupDiOpenDeviceInfoW(set.0, &HSTRING::from(instance_id), HWND::default(), 0, Some(&mut data))
            .ok()?;
        is_driver_hardware_id(&hardware_ids(set.0, &data)).then_some((set, data))
    }
}

/// Switch the device on or off. `DICS_FLAG_GLOBAL` makes the state persistent
/// across reboots, which is what lets "disabled" be the resting state and what
/// `recover_at_start` relies on reading back.
fn change_state(instance_id: &str, enable: bool) -> Result<(), String> {
    let Some((set, mut data)) = open_ours(instance_id) else {
        return Err(format!("the virtual screen device {instance_id} is not present"));
    };
    let params = SP_PROPCHANGE_PARAMS {
        ClassInstallHeader: SP_CLASSINSTALL_HEADER {
            cbSize: std::mem::size_of::<SP_CLASSINSTALL_HEADER>() as u32,
            InstallFunction: DIF_PROPERTYCHANGE,
        },
        StateChange: if enable { DICS_ENABLE } else { DICS_DISABLE },
        Scope: DICS_FLAG_GLOBAL,
        HwProfile: 0,
    };
    unsafe {
        SetupDiSetClassInstallParamsW(
            set.0,
            Some(&mut data),
            Some(&params.ClassInstallHeader),
            std::mem::size_of::<SP_PROPCHANGE_PARAMS>() as u32,
        )
        .map_err(|e| format!("could not prepare the state change: {e}"))?;
        SetupDiCallClassInstaller(DIF_PROPERTYCHANGE, set.0, Some(&data)).map_err(|e| {
            format!("Windows refused to switch the virtual screen {}: {e}", if enable { "on" } else { "off" })
        })?;
    }
    Ok(())
}

/// Is the device switched on? `None` when its node cannot be found or read.
fn is_enabled(instance_id: &str) -> Option<bool> {
    unsafe {
        let mut devinst = 0u32;
        if CM_Locate_DevNodeW(&mut devinst, &HSTRING::from(instance_id), CM_LOCATE_DEVNODE_NORMAL)
            != CR_SUCCESS
        {
            return None;
        }
        let mut status = CM_DEVNODE_STATUS_FLAGS::default();
        let mut problem = CM_PROB::default();
        if CM_Get_DevNode_Status(&mut status, &mut problem, devinst, 0) != CR_SUCCESS {
            return None;
        }
        Some(problem != CM_PROB_DISABLED)
    }
}

// ------------------------------------------------------------ the registry key

struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = RegCloseKey(self.0);
            }
        }
    }
}

/// (the key exists, it carries our ownership mark)
fn registry_state() -> (bool, bool) {
    unsafe {
        let mut key = HKEY::default();
        if RegOpenKeyExW(HKEY_LOCAL_MACHINE, &HSTRING::from(DRIVER_REG_KEY), 0, KEY_READ, &mut key)
            .is_err()
        {
            return (false, false);
        }
        let key = Key(key);
        let mut kind = REG_VALUE_TYPE::default();
        let mut data = 0u32;
        let mut len = std::mem::size_of::<u32>() as u32;
        let rc = RegQueryValueExW(
            key.0,
            &HSTRING::from(DRIVER_REG_OWNER_VALUE),
            None,
            Some(&mut kind),
            Some(&mut data as *mut u32 as *mut u8),
            Some(&mut len),
        );
        (true, rc.is_ok() && kind == REG_DWORD && data == 1)
    }
}

fn write_registry(settings: &Path) -> Result<(), String> {
    unsafe {
        let mut key = HKEY::default();
        let rc = RegCreateKeyExW(
            HKEY_LOCAL_MACHINE,
            &HSTRING::from(DRIVER_REG_KEY),
            0,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut key,
            None,
        );
        if rc.is_err() {
            return Err(format!("cannot create the driver's settings key: {rc:?}"));
        }
        let key = Key(key);
        // The mark FIRST: a key with our VDDPATH but no mark would read as
        // somebody else's on the next install and block it.
        let rc = RegSetValueExW(
            key.0,
            &HSTRING::from(DRIVER_REG_OWNER_VALUE),
            0,
            REG_DWORD,
            Some(&1u32.to_ne_bytes()),
        );
        if rc.is_err() {
            return Err(format!("cannot mark the driver's settings key: {rc:?}"));
        }
        let path: Vec<u8> = wide_z(&settings.to_string_lossy())
            .iter()
            .flat_map(|c| c.to_le_bytes())
            .collect();
        let rc = RegSetValueExW(key.0, &HSTRING::from(DRIVER_REG_PATH_VALUE), 0, REG_SZ, Some(&path));
        if rc.is_err() {
            return Err(format!("cannot point the driver at its settings: {rc:?}"));
        }
    }
    Ok(())
}

/// Delete the driver's settings key, but only when it carries our mark.
fn remove_registry() -> Option<String> {
    let (exists, ours) = registry_state();
    if !exists {
        return None;
    }
    if !ours {
        return Some("left the driver's settings key alone (it is not Púca's)".into());
    }
    unsafe {
        let rc = RegDeleteKeyW(HKEY_LOCAL_MACHINE, &HSTRING::from(DRIVER_REG_KEY));
        if rc.is_err() {
            return Some(format!("could not delete the driver's settings key ({rc:?})"));
        }
        // The vendor key above it, only when that left it with no subkeys and
        // no values: anything still in it belongs to another of that vendor's
        // products. RegDeleteKeyW would delete values along with the key, so
        // this is counted, not left to the call to refuse.
        let vendor = HSTRING::from(r"SOFTWARE\MikeTheTech");
        let mut key = HKEY::default();
        if RegOpenKeyExW(HKEY_LOCAL_MACHINE, &vendor, 0, KEY_READ, &mut key).is_ok() {
            let key = Key(key);
            let (mut subkeys, mut values) = (u32::MAX, u32::MAX);
            let rc = RegQueryInfoKeyW(
                key.0,
                windows::core::PWSTR::null(),
                None,
                None,
                Some(&mut subkeys),
                None,
                None,
                Some(&mut values),
                None,
                None,
                None,
                None,
            );
            drop(key);
            if rc.is_ok() && subkeys == 0 && values == 0 {
                let _ = RegDeleteKeyW(HKEY_LOCAL_MACHINE, &vendor);
            }
        }
    }
    None
}

// ------------------------------------------------------------ install / remove

/// Is this PC's NATIVE processor x64? The question is the machine's, not this
/// process's: an x64 build runs emulated on an ARM64 PC, and the driver it
/// would install must match the kernel, not the emulator.
pub fn native_x64() -> bool {
    use windows::Win32::System::SystemInformation::{
        GetNativeSystemInfo, PROCESSOR_ARCHITECTURE_AMD64, SYSTEM_INFO,
    };
    let mut info = SYSTEM_INFO::default();
    unsafe { GetNativeSystemInfo(&mut info) };
    unsafe { info.Anonymous.Anonymous.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_AMD64 }
}

fn require_x64() -> Result<(), String> {
    if !native_x64() {
        return Err(crate::virtual_screen::NOT_X64.into());
    }
    Ok(())
}

/// Write the embedded package into the admin-only package folder and prove the
/// bytes on disk are the pinned ones.
fn write_package(dir: &Path) -> Result<PathBuf, String> {
    crate::provision::secure_directory(dir)?;
    for (name, bytes) in EMBEDDED {
        let path = dir.join(name);
        std::fs::write(&path, bytes).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        let on_disk = std::fs::read(&path).map_err(|e| format!("cannot re-read {}: {e}", path.display()))?;
        if !matches_pinned(name, &on_disk) {
            return Err(format!(
                "{} does not match the driver Púca was built with; nothing was installed",
                path.display()
            ));
        }
    }
    debug_assert_eq!(EMBEDDED.len(), DRIVER_FILES.len());
    Ok(dir.join("MttVDD.inf"))
}

fn write_settings(dir: &Path) -> Result<(), String> {
    crate::provision::apply_sddl(dir, SETTINGS_SDDL)?;
    let path = dir.join("vdd_settings.xml");
    std::fs::write(&path, settings_xml(DEFAULT_WIDTH, DEFAULT_HEIGHT, DEFAULT_REFRESH_HZ))
        .map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// Create the root device node `devcon install` would: class Display, an ID
/// Windows generates (`ROOT\DISPLAY\000N`), hardware ID `Root\MttVDD`.
fn create_device_node() -> Result<String, String> {
    unsafe {
        let set = SetupDiCreateDeviceInfoList(Some(&GUID_DEVCLASS_DISPLAY), HWND::default())
            .map_err(|e| format!("cannot create a device list: {e}"))?;
        let set = DevInfo(set);
        let mut data = new_devinfo_data();
        SetupDiCreateDeviceInfoW(
            set.0,
            &HSTRING::from("Display"),
            &GUID_DEVCLASS_DISPLAY,
            PCWSTR::null(),
            HWND::default(),
            DICD_GENERATE_ID,
            Some(&mut data),
        )
        .map_err(|e| format!("cannot create the virtual screen device: {e}"))?;
        // REG_MULTI_SZ: the ID, its terminator, and the list terminator.
        let mut ids = wide_z(HARDWARE_ID);
        ids.push(0);
        let bytes: Vec<u8> = ids.iter().flat_map(|c| c.to_le_bytes()).collect();
        SetupDiSetDeviceRegistryPropertyW(set.0, &mut data, SPDRP_HARDWAREID, Some(&bytes))
            .map_err(|e| format!("cannot set the device's hardware ID: {e}"))?;
        SetupDiCallClassInstaller(DIF_REGISTERDEVICE, set.0, Some(&data))
            .map_err(|e| format!("cannot register the virtual screen device: {e}"))?;
        instance_id_of(set.0, &data).ok_or_else(|| "the new device has no instance ID".to_string())
    }
}

/// Delete a device node this module created.
fn remove_device_node(instance_id: &str) -> Result<(), String> {
    let Some((set, data)) = open_ours(instance_id) else { return Ok(()) };
    unsafe {
        let mut reboot = BOOL(0);
        if DiUninstallDevice(HWND::default(), set.0, &data, 0, Some(&mut reboot)).is_err() {
            // Older path, same effect.
            SetupDiCallClassInstaller(DIF_REMOVE, set.0, Some(&data))
                .map_err(|e| format!("cannot remove the virtual screen device: {e}"))?;
        }
    }
    Ok(())
}

/// The driver store's published name for the package this device uses
/// (`oemNN.inf`), read from the device's driver key.
fn published_inf(instance_id: &str) -> Option<String> {
    let (set, data) = open_ours(instance_id)?;
    unsafe {
        let key = SetupDiOpenDevRegKey(set.0, &data, DICS_FLAG_GLOBAL.0, 0, DIREG_DRV, KEY_READ.0).ok()?;
        let key = Key(key);
        let mut buf = vec![0u16; 260];
        let mut len = (buf.len() * 2) as u32;
        let mut kind = REG_VALUE_TYPE::default();
        RegQueryValueExW(
            key.0,
            &HSTRING::from("InfPath"),
            None,
            Some(&mut kind),
            Some(buf.as_mut_ptr() as *mut u8),
            Some(&mut len),
        )
        .ok()
        .ok()?;
        let n = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
        let name = String::from_utf16_lossy(&buf[..n]);
        (kind == REG_SZ && !name.is_empty()).then_some(name)
    }
}

/// Does the published name still resolve, in the driver store, to THIS
/// driver's INF? Published names are reused once a package is removed, so a
/// recorded `oem42.inf` may belong to someone else's driver by now.
fn published_inf_is_ours(oem_inf: &str) -> bool {
    let mut buf = vec![0u16; 1024];
    unsafe {
        if SetupGetInfDriverStoreLocationW(&HSTRING::from(oem_inf), None, PCWSTR::null(), &mut buf, None)
            .is_err()
        {
            return false;
        }
    }
    let n = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    let path = String::from_utf16_lossy(&buf[..n]);
    Path::new(&path)
        .file_name()
        .and_then(|f| f.to_str())
        .is_some_and(|f| f.eq_ignore_ascii_case(ORIGINAL_INF_NAME))
}

/// Install the driver and its device, leaving it switched OFF. Run elevated,
/// in the signed-in user's session (see the module header).
pub fn install() -> Result<String, String> {
    require_x64()?;
    let dir = install_dir()?;
    if !dir.join(crate::INSTALLED_SERVICE_EXE).exists() {
        return Err(crate::virtual_screen::NEEDS_REMOTE_ACCESS.into());
    }

    let ours = read_installed();
    if let Some(rec) = &ours {
        if open_ours(&rec.instance_id).is_some() {
            // Re-running the install is a repair, not a second install. Make
            // sure it rests off, and refresh the settings it reads.
            write_settings(&settings_dir()?)?;
            let _ = change_state(&rec.instance_id, false);
            return Ok("the virtual screen was already installed".into());
        }
    }

    let (key_exists, key_ours) = registry_state();
    install_precheck(ours.as_ref(), &devices_with_driver_id(), key_exists, key_ours)
        .map_err(str::to_string)?;

    let inf = write_package(&package_dir()?)?;
    let settings = settings_dir()?;
    write_settings(&settings)?;
    write_registry(&settings)?;

    let rollback = |instance: Option<&str>| {
        if let Some(i) = instance {
            let _ = remove_device_node(i);
        }
        let _ = remove_registry();
        let _ = std::fs::remove_dir_all(package_dir().unwrap_or_default());
        let _ = std::fs::remove_dir_all(settings_dir().unwrap_or_default());
    };

    let instance = match create_device_node() {
        Ok(i) => i,
        Err(e) => {
            rollback(None);
            return Err(e);
        }
    };
    log(&format!("created device {instance}; installing the driver (Windows asks the user here)"));

    // THE CONSENT. Windows shows its own device-software prompt naming the
    // publisher here, and blocks until the person answers it.
    let mut reboot = BOOL(0);
    let installed = unsafe {
        UpdateDriverForPlugAndPlayDevicesW(
            HWND::default(),
            &HSTRING::from(HARDWARE_ID),
            &HSTRING::from(inf.as_os_str()),
            UPDATEDRIVERFORPLUGANDPLAYDEVICES_FLAGS(0),
            Some(&mut reboot),
        )
    };
    if let Err(e) = installed {
        let code = e.code().0 as u32;
        // A Win32 error arrives as HRESULT_FROM_WIN32 (0x8007xxxx); SetupAPI's
        // own errors as 0xE000xxxx. Hand describe_install_error the raw code.
        let raw = if code & 0xFFFF_0000 == 0x8007_0000 { code & 0xFFFF } else { code };
        log(&format!("driver install failed: 0x{code:08X}"));
        rollback(Some(&instance));
        return Err(describe_install_error(raw));
    }

    // THE RESTING STATE. Installing starts the device, so a virtual monitor
    // appears for a moment; it goes off again here and stays off until a
    // remote session needs it.
    let off = change_state(&instance, false);
    let oem_inf = published_inf(&instance);
    write_installed(&Installed { version: Installed::VERSION, instance_id: instance.clone(), oem_inf })?;
    log(&format!("installed on {instance}"));
    match off {
        Ok(()) => Ok("installed the virtual screen; it stays off until a remote session needs it".into()),
        Err(e) => Ok(format!(
            "installed the virtual screen, but could not switch it off yet ({e}); Púca's service \
             switches it off the next time it starts"
        )),
    }
}

/// Remove the device, its driver package, its settings key and its files. Safe
/// to run when nothing is installed. Touches only what this module recorded,
/// or what carries its mark.
pub fn remove() -> Result<String, String> {
    let mut notes: Vec<String> = Vec::new();
    if let Some(rec) = read_installed() {
        if let Err(e) = remove_device_node(&rec.instance_id) {
            return Err(format!("{e}. Nothing else was removed."));
        }
        match rec.oem_inf.as_deref() {
            Some(oem) if published_inf_is_ours(oem) => unsafe {
                if !SetupUninstallOEMInfW(&HSTRING::from(oem), 0, None).as_bool() {
                    notes.push(format!("the driver package {oem} is still in the driver store"));
                }
            },
            Some(oem) => notes.push(format!(
                "left {oem} in the driver store: it no longer names this driver"
            )),
            None => notes.push("the driver package's store name was never recorded, so it was left".into()),
        }
    }
    if let Some(n) = remove_registry() {
        notes.push(n);
    }
    for d in [package_dir()?, settings_dir()?] {
        if d.exists() {
            if let Err(e) = std::fs::remove_dir_all(&d) {
                notes.push(format!("could not delete {} ({e})", d.display()));
            }
        }
    }
    let rec = record_path()?;
    if rec.exists() {
        std::fs::remove_file(&rec).map_err(|e| format!("could not delete {}: {e}", rec.display()))?;
    }
    if let Some(i) = devices_with_driver_id().first() {
        notes.push(format!("another copy of this driver remains on device {i}; it is not Púca's"));
    }
    log("removed");
    Ok(if notes.is_empty() {
        "removed the virtual screen".into()
    } else {
        format!("removed the virtual screen ({})", notes.join("; "))
    })
}

// ------------------------------------------------------------ the runtime half

fn book() -> &'static Mutex<LeaseBook> {
    static BOOK: OnceLock<Mutex<LeaseBook>> = OnceLock::new();
    BOOK.get_or_init(|| Mutex::new(LeaseBook::new()))
}

fn report(rec: Option<&Installed>, on: bool, unavailable: Option<Unavailable>) -> Report {
    Report {
        installed: rec.is_some(),
        on,
        instance_id: rec.map(|r| r.instance_id.clone()),
        unavailable,
    }
}

/// The current state, for the app's switch and the agent's question.
pub fn state() -> Report {
    let rec = read_installed();
    let on = rec.as_ref().and_then(|r| is_enabled(&r.instance_id)).unwrap_or(false);
    report(rec.as_ref(), on, None)
}

/// `pid` wants the virtual screen on. Switches it on if nobody held it yet.
pub fn hold(pid: u32) -> Report {
    let Some(rec) = read_installed() else {
        return report(None, false, Some(Unavailable::NotInstalled));
    };
    if open_ours(&rec.instance_id).is_none() {
        return report(Some(&rec), false, Some(Unavailable::DeviceMissing));
    }
    let mut book = book().lock().unwrap_or_else(|e| e.into_inner());
    if book.hold(pid, Instant::now()) == Transition::Enable {
        // Rewritten every time, so the one mode Púca asks for is the one the
        // driver loads with, whatever the file was left saying.
        if let Ok(dir) = settings_dir() {
            if let Err(e) = write_settings(&dir) {
                log(&format!("could not refresh the settings: {e}"));
            }
        }
        match change_state(&rec.instance_id, true) {
            Ok(()) => {
                book.set_on(true);
                log(&format!("switched on for process {pid}"));
            }
            Err(e) => {
                log(&format!("could not switch on: {e}"));
                book.withdraw(pid);
                book.set_on(false);
                return report(Some(&rec), false, Some(Unavailable::EnableFailed));
            }
        }
    }
    report(Some(&rec), book.is_on(), None)
}

/// `pid` is done with it.
pub fn release(pid: u32) -> Report {
    let rec = read_installed();
    let mut book = book().lock().unwrap_or_else(|e| e.into_inner());
    let t = book.release(pid, Instant::now());
    apply(&mut book, rec.as_ref(), t, "released");
    report(rec.as_ref(), book.is_on(), None)
}

/// The periodic tick: switch off once every hold has lapsed.
pub fn tick() {
    let mut book = book().lock().unwrap_or_else(|e| e.into_inner());
    let t = book.expire(Instant::now());
    if t == Transition::Disable {
        let rec = read_installed();
        apply(&mut book, rec.as_ref(), t, "every hold lapsed");
    }
}

fn apply(book: &mut LeaseBook, rec: Option<&Installed>, t: Transition, why: &str) {
    if t != Transition::Disable {
        return;
    }
    let Some(rec) = rec else {
        // Removed while on: nothing left to switch.
        book.set_on(false);
        return;
    };
    match change_state(&rec.instance_id, false) {
        Ok(()) => {
            book.set_on(false);
            log(&format!("switched off ({why})"));
        }
        // `on` stays true, so the next tick tries again. Logged once per
        // failure run so a stuck device cannot fill the service log every 2 s.
        Err(e) => {
            static LAST: Mutex<Option<String>> = Mutex::new(None);
            let mut last = LAST.lock().unwrap_or_else(|p| p.into_inner());
            if last.as_deref() != Some(e.as_str()) {
                log(&format!("could not switch off ({why}): {e}; retrying"));
                *last = Some(e);
            }
        }
    }
}

/// At service start: nothing holds the screen, so a screen that is on was left
/// on by a crash, a power cut or a reboot mid-session. Switch it off.
pub fn recover_at_start() {
    let Some(rec) = read_installed() else { return };
    let enabled = is_enabled(&rec.instance_id);
    if startup_action(true, enabled) == Transition::Disable {
        match change_state(&rec.instance_id, false) {
            Ok(()) if enabled == Some(true) => {
                log("found the virtual screen left on by an earlier run; switched it off")
            }
            Ok(()) => {}
            Err(e) => log(&format!("could not make sure the virtual screen is off at start: {e}")),
        }
    }
}
