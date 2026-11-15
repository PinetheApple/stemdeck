//! Finding an AMD graphics card on Windows. ROCm torch exists for Linux only,
//! so a card found here is recorded as one StemDeck can't use: Settings then
//! says why separation runs on the processor instead of saying nothing (#196).
//!
//! The probe asks PowerShell for every `Win32_VideoController`. nvidia-smi,
//! which finds the NVIDIA cards, sees no other vendor, and wmic is no longer
//! installed on current Windows 11. Each row is the PNPDeviceID and the Name,
//! tab-separated; a card is AMD when its PNPDeviceID names PCI vendor 1002.
//!
//! Only the call in `ensure_torch_device` is Windows-only. Everything here
//! builds and is tested on Linux too, with the process run injected.
#![cfg_attr(not(windows), allow(dead_code))]

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Duration;

use crate::{append_to_setup_log, DetectedGpu, GPU_BACKEND_ROCM, REASON_ROCM_UNSUPPORTED};

const AMD_PNP_VENDOR: &str = "VEN_1002&";
const FIELD_SEPARATOR: char = '\t';
const PROBE_LABEL: &str = "video controller query";
/// The name recorded for an AMD card the listing gives no name for.
pub const UNNAMED_AMD_GPU: &str = "AMD GPU";

const SYSTEM_ROOT_VAR: &str = "SystemRoot";
const POWERSHELL_UNDER_SYSTEM_ROOT: [&str; 4] =
    ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"];
/// Left to PATH when SystemRoot is unset.
pub const PATH_POWERSHELL: &str = "powershell.exe";
const POWERSHELL_FLAGS: [&str; 3] = ["-NoProfile", "-NonInteractive", "-Command"];
/// No double quotes inside, so Windows' argument quoting passes it unchanged.
pub const VIDEO_CONTROLLER_QUERY: &str =
    "Get-CimInstance Win32_VideoController | ForEach-Object { $_.PNPDeviceID, $_.Name -join [char]9 }";
/// PowerShell's first start on a cold machine can take many seconds.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// The first AMD card in a video controller listing, by name.
pub fn amd_adapter_name(listing: &str) -> Option<String> {
    listing.lines().find_map(|row| {
        let (pnp_id, name) = row.split_once(FIELD_SEPARATOR)?;
        if !pnp_id.to_ascii_uppercase().contains(AMD_PNP_VENDOR) {
            return None;
        }
        let name = match name.trim() {
            "" => UNNAMED_AMD_GPU,
            named => named,
        };
        Some(name.to_string())
    })
}

/// The AMD card `probe` lists, as a GPU no build StemDeck installs can use. A
/// probe that fails is logged and finds none.
pub fn detect(
    data_dir: &Path,
    probe: impl FnOnce() -> Result<String, String>,
) -> Option<DetectedGpu> {
    let listing = match probe() {
        Ok(listing) => listing,
        Err(e) => {
            append_to_setup_log(data_dir, &format!("{PROBE_LABEL} failed: {e}"));
            return None;
        }
    };
    let name = amd_adapter_name(&listing)?;
    let msg = format!("AMD GPU found: {name}; ROCm torch exists for Linux only, staying on CPU");
    append_to_setup_log(data_dir, &msg);
    Some(DetectedGpu {
        name,
        backend: GPU_BACKEND_ROCM,
        version: String::new(),
        candidates: Vec::new(),
        unusable: Some(REASON_ROCM_UNSUPPORTED),
    })
}

/// Tauri child processes inherit a stripped PATH, so PowerShell is named
/// by its place under SystemRoot whenever that is known.
pub fn powershell_exe(system_root: Option<&OsStr>) -> PathBuf {
    system_root.map_or_else(
        || PathBuf::from(PATH_POWERSHELL),
        |root| {
            POWERSHELL_UNDER_SYSTEM_ROOT
                .iter()
                .fold(PathBuf::from(root), |path, part| path.join(part))
        },
    )
}

pub fn probe_command(system_root: Option<&OsStr>) -> Command {
    let mut command = Command::new(powershell_exe(system_root));
    command
        .args(POWERSHELL_FLAGS)
        .arg(VIDEO_CONTROLLER_QUERY)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::hide_console_window(&mut command);
    command
}

/// Every video controller Windows lists, one row each, through `run`.
pub fn video_controllers(
    run: impl FnOnce(Command, Duration, &str) -> Result<Output, String>,
    system_root: Option<&OsStr>,
) -> Result<String, String> {
    let out = run(probe_command(system_root), PROBE_TIMEOUT, PROBE_LABEL)?;
    if !out.status.success() {
        return Err(format!("exited with {}", out.status));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The probe setup runs: the real query, bounded by PROBE_TIMEOUT.
pub fn probe() -> Result<String, String> {
    let system_root = std::env::var_os(SYSTEM_ROOT_VAR);
    video_controllers(crate::command_output_with_timeout, system_root.as_deref())
}

#[cfg(test)]
mod tests;
