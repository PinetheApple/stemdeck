use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Output};
use std::time::Duration;

use tempfile::TempDir;

use super::{
    amd_adapter_name, detect, powershell_exe, probe_command, video_controllers, PATH_POWERSHELL,
    PROBE_TIMEOUT, UNNAMED_AMD_GPU, VIDEO_CONTROLLER_QUERY,
};
use crate::{detect_gpu, GpuSetup, GPU_BACKEND_ROCM, REASON_ROCM_UNSUPPORTED};

/// Win32_VideoController rows as the probe prints them: PNPDeviceID, a tab,
/// then Name, with PowerShell's CRLF line ends.
const INTEL_UHD: &str =
    "PCI\\VEN_8086&DEV_9A49&SUBSYS_0A1F1028&REV_01\\3&11583659&0&10\tIntel(R) UHD Graphics\r\n";
const BASIC_DISPLAY: &str = "ROOT\\BASICDISPLAY\\0000\tMicrosoft Basic Display Adapter\r\n";
const RX_7800: &str =
    "PCI\\VEN_1002&DEV_747E&SUBSYS_E3291DA2&REV_C8\\6&2B9C1F34&0&00000019\tAMD Radeon RX 7800 XT\r\n";
const RX_7800_NAME: &str = "AMD Radeon RX 7800 XT";
const RADEON_IGPU_LOWERCASE: &str =
    "pci\\ven_1002&dev_1681&subsys_0b291028&rev_c7\\4&3a1b2c3d&0&0041\tAMD Radeon(TM) Graphics\r\n";
const RADEON_IGPU_NAME: &str = "AMD Radeon(TM) Graphics";
const RTX_4060: &str =
    "PCI\\VEN_10DE&DEV_28E0&SUBSYS_0C661028&REV_A1\\4&2F0E1D3C&0&0008\tNVIDIA GeForce RTX 4060 Laptop GPU\r\n";
const UNNAMED_AMD: &str = "PCI\\VEN_1002&DEV_15BF&SUBSYS_0B8C1028&REV_C1\\4&1E2D3A5B&0&0041\t\r\n";
const PROBE_FAILURE: &str = "failed to start powershell: not found";
const PROBE_TIMED_OUT: &str = "video controller query timed out after 30s";
const CPU_DEVICE: &str = "cpu";
const FAKE_SYSTEM_ROOT: &str = "D:\\Win";
const EXIT_OK: i32 = 0;
const EXIT_FAILED: i32 = 1;

fn make_tmp() -> TempDir {
    tempfile::tempdir().expect("failed to create temp dir")
}

fn setup_log(data_dir: &Path) -> String {
    fs::read_to_string(data_dir.join("logs").join("setup.log")).unwrap_or_default()
}

#[cfg(unix)]
fn exit_status(code: i32) -> ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    ExitStatus::from_raw(code << 8)
}

#[cfg(windows)]
fn exit_status(code: i32) -> ExitStatus {
    use std::os::windows::process::ExitStatusExt;
    ExitStatus::from_raw(code as u32)
}

fn output(code: i32, stdout: &str) -> Output {
    Output {
        status: exit_status(code),
        stdout: stdout.as_bytes().to_vec(),
        stderr: Vec::new(),
    }
}

#[test]
fn an_amd_card_is_named_from_the_video_controller_listing() {
    let listing = format!("{INTEL_UHD}{RX_7800}");
    assert_eq!(amd_adapter_name(&listing).as_deref(), Some(RX_7800_NAME));
}

#[test]
fn a_listing_without_an_amd_card_names_none() {
    let listing = format!("{INTEL_UHD}{BASIC_DISPLAY}");
    assert_eq!(amd_adapter_name(&listing), None);
    assert_eq!(amd_adapter_name(""), None);
}

#[test]
fn a_lowercase_device_id_is_still_amd() {
    assert_eq!(
        amd_adapter_name(RADEON_IGPU_LOWERCASE).as_deref(),
        Some(RADEON_IGPU_NAME)
    );
}

#[test]
fn of_two_amd_cards_the_first_listed_is_named() {
    let listing = format!("{RX_7800}{RADEON_IGPU_LOWERCASE}");
    assert_eq!(amd_adapter_name(&listing).as_deref(), Some(RX_7800_NAME));
}

/// nvidia-smi can fail once while a laptop's dGPU wakes; recording the Radeon
/// iGPU then would settle the machine on CPU instead of retrying next launch.
#[test]
fn an_amd_card_beside_an_nvidia_one_is_left_to_the_nvidia_path() {
    let data = make_tmp();
    let listing = format!("{RADEON_IGPU_LOWERCASE}{RTX_4060}");
    assert_eq!(amd_adapter_name(&listing), None);
    assert!(detect_gpu(None, || detect(data.path(), || Ok(listing))).is_none());
}

#[test]
fn an_amd_card_without_a_name_is_still_found() {
    assert_eq!(
        amd_adapter_name(UNNAMED_AMD).as_deref(),
        Some(UNNAMED_AMD_GPU)
    );
}

#[test]
fn powershell_is_found_under_system_root_or_left_to_path() {
    let under_root = powershell_exe(Some(OsStr::new(FAKE_SYSTEM_ROOT)));
    let expected: PathBuf = [
        FAKE_SYSTEM_ROOT,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    ]
    .iter()
    .collect();
    assert_eq!(under_root, expected);
    assert_eq!(powershell_exe(None), PathBuf::from(PATH_POWERSHELL));
}

/// Windows quotes an argument with spaces in double quotes; with none inside
/// the query, PowerShell receives it unchanged.
#[test]
fn the_probe_command_runs_the_query_without_a_profile_or_prompts() {
    let command = probe_command(None);
    assert_eq!(command.get_program(), OsStr::new(PATH_POWERSHELL));
    let args: Vec<&OsStr> = command.get_args().collect();
    let expected: Vec<&OsStr> = ["-NoProfile", "-NonInteractive", "-Command"]
        .into_iter()
        .chain([VIDEO_CONTROLLER_QUERY])
        .map(OsStr::new)
        .collect();
    assert_eq!(args, expected);
    assert!(!VIDEO_CONTROLLER_QUERY.contains('"'));
}

#[test]
fn the_probe_hands_its_listing_over_and_is_bounded_by_the_timeout() {
    let run = |command: std::process::Command, timeout: Duration, _: &str| {
        assert_eq!(command.get_program(), OsStr::new(PATH_POWERSHELL));
        assert_eq!(timeout, PROBE_TIMEOUT);
        Ok(output(EXIT_OK, RX_7800))
    };
    assert_eq!(video_controllers(run, None).as_deref(), Ok(RX_7800));
}

#[test]
fn a_probe_that_times_out_or_fails_is_logged_and_finds_no_amd_card() {
    let data = make_tmp();
    let timed_out = |_, _, _: &str| Err(PROBE_TIMED_OUT.to_string());
    assert!(detect(data.path(), || video_controllers(timed_out, None)).is_none());
    let failed = |_, _, _: &str| Ok(output(EXIT_FAILED, RX_7800));
    assert!(detect(data.path(), || video_controllers(failed, None)).is_none());
    assert!(detect(data.path(), || Err(PROBE_FAILURE.to_string())).is_none());
    let log = setup_log(data.path());
    assert!(log.contains(PROBE_TIMED_OUT));
    assert!(log.contains(PROBE_FAILURE));
    assert!(!log.contains(RX_7800_NAME));
}

/// The card is recorded as a GPU StemDeck can't use, which is what the
/// Settings line reads, instead of as no GPU.
#[test]
fn a_windows_amd_card_is_recorded_as_a_gpu_stemdeck_cannot_use() {
    let data = make_tmp();
    let probe = || Ok(format!("{BASIC_DISPLAY}{RX_7800}"));
    let gpu = detect_gpu(None, || detect(data.path(), probe)).expect("found");
    assert_eq!(gpu.name, RX_7800_NAME);
    assert_eq!(gpu.backend, GPU_BACKEND_ROCM);
    assert!(gpu.candidates.is_empty());
    let reason = gpu.unusable.expect("recorded as unusable");
    let setup = GpuSetup::from_detection(Some(&gpu), false, reason);
    assert_eq!(setup.reason, REASON_ROCM_UNSUPPORTED);
    assert!(setup.gpu_detected);
    assert_eq!(setup.backend.as_deref(), Some(GPU_BACKEND_ROCM));
    assert_eq!(setup.torch_device, CPU_DEVICE);
    assert!(setup_log(data.path()).contains(RX_7800_NAME));
}
