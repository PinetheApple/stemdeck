//! ROCm torch exists for Linux only, so an AMD card on Windows is recorded as
//! found but unusable: Settings can then say why separation uses the processor.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Duration;

use crate::{append_to_setup_log, DetectedGpu, GPU_BACKEND_ROCM, REASON_ROCM_UNSUPPORTED};

const AMD_PNP_VENDOR: &str = "VEN_1002&";
const NVIDIA_PNP_VENDOR: &str = "VEN_10DE&";
const FIELD_SEPARATOR: char = '\t';
const PROBE_LABEL: &str = "video controller query";
/// The name recorded for an AMD card the listing gives no name for.
pub const UNNAMED_AMD_GPU: &str = "AMD GPU";

#[cfg(windows)]
const SYSTEM_ROOT_VAR: &str = "SystemRoot";
const POWERSHELL_UNDER_SYSTEM_ROOT: [&str; 4] =
    ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"];
/// Left to PATH when SystemRoot is unset.
pub const PATH_POWERSHELL: &str = "powershell.exe";
const POWERSHELL_FLAGS: [&str; 3] = ["-NoProfile", "-NonInteractive", "-Command"];
/// Each row is PNPDeviceID, a tab, then Name. UTF-8 because PowerShell 5.1
/// pipes the OEM code page; no double quotes, so Windows passes it unchanged.
pub const VIDEO_CONTROLLER_QUERY: &str = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; \
     Get-CimInstance Win32_VideoController | ForEach-Object { $_.PNPDeviceID, $_.Name -join [char]9 }";
/// PowerShell's first start on a cold machine can take many seconds.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// Each row's PNPDeviceID, upper-cased, and Name.
fn adapters(listing: &str) -> Vec<(String, &str)> {
    listing
        .lines()
        .filter_map(|row| {
            let (pnp_id, name) = row.split_once(FIELD_SEPARATOR)?;
            Some((pnp_id.to_ascii_uppercase(), name.trim()))
        })
        .collect()
}

/// The first AMD card in a video controller listing, by name. None beside an
/// NVIDIA card: nvidia-smi can fail once while a dGPU wakes, and that run must
/// stay unsettled so the next launch retries.
pub fn amd_adapter_name(listing: &str) -> Option<String> {
    let adapters = adapters(listing);
    if adapters
        .iter()
        .any(|(id, _)| id.contains(NVIDIA_PNP_VENDOR))
    {
        return None;
    }
    let (_, name) = adapters
        .iter()
        .find(|(id, _)| id.contains(AMD_PNP_VENDOR))?;
    let name = match *name {
        "" => UNNAMED_AMD_GPU,
        named => named,
    };
    Some(name.to_string())
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
#[cfg(windows)]
pub fn probe() -> Result<String, String> {
    let system_root = std::env::var_os(SYSTEM_ROOT_VAR);
    video_controllers(crate::command_output_with_timeout, system_root.as_deref())
}

#[cfg(test)]
mod tests;
