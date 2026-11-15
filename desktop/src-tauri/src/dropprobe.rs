//! How long a dropped file plays, for the import review.
//!
//! The review flags a song over the length limit before anything is queued.
//! For a file the page holds, it reads the length itself; a file dropped on
//! the Linux app stays on this side until it is sent (see `dropin`), so this
//! asks ffprobe instead. It is the same ffprobe, asked the same question, that
//! the backend uses to refuse a long upload, so the review and the server agree.
//! ffprobe reads a file's headers and seeks for what it needs; it never reads
//! the whole file.
//!
//! Every way of not knowing is `None`: the review then treats the file as one
//! it could not measure, and the server still refuses it at upload if it is
//! too long.

use std::ffi::OsString;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

/// How long one probe may take before the file counts as unmeasured.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// ffprobe's own name for a local file, so a dropped name that happens to look
/// like one of its protocols (`concat:`, `http:`) is still read as a file.
const FILE_PROTOCOL: &str = "file:";

/// The file's length in seconds, as `ffprobe` at `ffprobe` reports it.
pub fn duration(ffprobe: &Path, file: &Path, timeout: Duration) -> Option<f64> {
    let mut command = Command::new(ffprobe);
    command
        .args([
            "-v",
            "quiet",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(as_file_url(file))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::hide_console_window(&mut command);
    match crate::command_output_with_timeout(command, timeout, "ffprobe duration") {
        Ok(output) if output.status.success() => seconds(&String::from_utf8_lossy(&output.stdout)),
        Ok(output) => {
            eprintln!(
                "[dropprobe] ffprobe could not measure a dropped file: {}",
                output.status
            );
            None
        }
        Err(e) => {
            eprintln!("[dropprobe] could not measure a dropped file: {e}");
            None
        }
    }
}

fn as_file_url(file: &Path) -> OsString {
    let mut url = OsString::from(FILE_PROTOCOL);
    url.push(file);
    url
}

/// ffprobe's answer as seconds; "N/A" and anything else unusable is `None`.
fn seconds(stdout: &str) -> Option<f64> {
    stdout
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|s| s.is_finite() && *s >= 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffprobes_answer_is_read_as_seconds() {
        assert_eq!(seconds("11560.042\n"), Some(11560.042));
        assert_eq!(seconds("N/A\n"), None);
        assert_eq!(seconds(""), None);
        assert_eq!(seconds("nan"), None);
        assert_eq!(seconds("-1"), None);
    }

    #[test]
    fn a_dropped_name_is_always_read_as_a_file() {
        assert_eq!(
            as_file_url(Path::new("/music/concat:a.wav")),
            OsString::from("file:/music/concat:a.wav")
        );
    }

    /// A stand-in ffprobe: CI's cargo runners have no FFmpeg.
    #[cfg(unix)]
    fn stand_in(dir: &Path, script: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("ffprobe");
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn a_file_ffprobe_can_measure_has_its_length() {
        let dir = tempfile::tempdir().unwrap();
        // Echoes the file argument's length back, so a probe of the wrong
        // file, or without the file: prefix, reads differently.
        let ffprobe = stand_in(dir.path(), r#"for a; do last=$a; done; echo "${#last}.5""#);
        let file = dir.path().join("a.wav");

        let expected = as_file_url(&file).len() as f64 + 0.5;
        assert_eq!(duration(&ffprobe, &file, PROBE_TIMEOUT), Some(expected));
    }

    #[cfg(unix)]
    #[test]
    fn a_file_ffprobe_refuses_has_no_length() {
        let dir = tempfile::tempdir().unwrap();
        let ffprobe = stand_in(dir.path(), "echo 12.0; exit 1");
        assert_eq!(
            duration(&ffprobe, &dir.path().join("a.wav"), PROBE_TIMEOUT),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_probe_that_hangs_gives_up() {
        let dir = tempfile::tempdir().unwrap();
        let ffprobe = stand_in(dir.path(), "exec sleep 30");
        let started = std::time::Instant::now();

        let length = duration(
            &ffprobe,
            &dir.path().join("a.wav"),
            Duration::from_millis(200),
        );

        assert_eq!(length, None);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn no_ffprobe_means_no_length() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("ffprobe");
        assert_eq!(
            duration(&missing, &dir.path().join("a.wav"), PROBE_TIMEOUT),
            None
        );
    }
}
