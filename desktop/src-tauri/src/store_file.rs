//! `user-data.json` on disk: saved through a synced `.tmp` and a rename, with the
//! previous file kept as `.bak`, so a crash at any point leaves one complete copy.

use serde_json::{Map, Value};
use std::{
    fs, io,
    io::Write,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

/// The store's contents: one JSON value per key.
pub type Entries = Map<String, Value>;

/// How many set-aside damaged files are kept.
const CORRUPT_KEPT: usize = 2;

/// Tries per file step and the pause between them: 200 ms per step at most.
const ATTEMPTS: u32 = 5;
const PAUSE: Duration = Duration::from_millis(50);

const TEMP_SUFFIX: &str = ".tmp";
const BACKUP_SUFFIX: &str = ".bak";
const CORRUPT_SUFFIX: &str = ".corrupt-";

/// Windows: ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION.
const WINDOWS_TRANSIENT: [i32; 3] = [5, 32, 33];

pub fn temp_path(path: &Path) -> PathBuf {
    with_suffix(path, TEMP_SUFFIX)
}

pub fn backup_path(path: &Path) -> PathBuf {
    with_suffix(path, BACKUP_SUFFIX)
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The damaged files set aside beside `path`, `<name>.corrupt-<n>`, oldest first.
pub fn corrupt_copies(path: &Path) -> io::Result<Vec<(u64, PathBuf)>> {
    let prefix = format!("{}{CORRUPT_SUFFIX}", file_name(path));
    let Some(dir) = path.parent() else {
        return Ok(Vec::new());
    };
    let listing = match fs::read_dir(dir) {
        Ok(listing) => listing,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut found = Vec::new();
    for entry in listing {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(n) = name.strip_prefix(&prefix).and_then(|n| n.parse().ok()) {
            found.push((n, entry.path()));
        }
    }
    found.sort();
    Ok(found)
}

/// True only when no store file of any kind is at `path`; anything that cannot
/// be checked counts as there. Only then may the legacy file be copied in.
pub fn no_store_files(path: &Path) -> bool {
    let absent =
        |p: &Path| matches!(fs::symlink_metadata(p), Err(e) if e.kind() == io::ErrorKind::NotFound);
    absent(path)
        && absent(&temp_path(path))
        && absent(&backup_path(path))
        && corrupt_copies(path).is_ok_and(|found| found.is_empty())
}

/// Where the entries came from when the store was opened.
#[derive(Debug, PartialEq)]
pub enum Opened {
    Main,
    /// No store file and no copy: a first start, or one after a reset.
    Fresh,
    /// The file was missing, empty or invalid, and a copy was good.
    Recovered {
        from: PathBuf,
        problem: String,
    },
    /// The file was missing, empty or invalid, and so was every copy.
    Lost {
        problem: String,
    },
}

impl Opened {
    /// The line for the log, or None when there is nothing to say.
    pub fn warning(&self, path: &Path) -> Option<String> {
        match self {
            Opened::Main | Opened::Fresh => None,
            Opened::Recovered { from, problem } => Some(format!(
                "{} {problem}; restored the library list from {}",
                path.display(),
                from.display()
            )),
            Opened::Lost { problem } => Some(format!(
                "{} {problem}, and no copy of it could be read; \
                 starting with an empty library list",
                path.display()
            )),
        }
    }
}

enum Unreadable {
    Missing,
    Empty,
    Invalid(String),
    /// There, but not readable now: never a reason to fall back to a copy.
    Io(io::Error),
}

impl Unreadable {
    fn describe(&self) -> String {
        match self {
            Unreadable::Missing => "is missing".to_string(),
            Unreadable::Empty => "is empty".to_string(),
            Unreadable::Invalid(e) => format!("is not valid JSON ({e})"),
            Unreadable::Io(e) => format!("could not be read ({e})"),
        }
    }
}

fn read_entries(path: &Path) -> Result<Entries, Unreadable> {
    let bytes = retrying(|| fs::read(path)).map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            Unreadable::Missing
        } else {
            Unreadable::Io(e)
        }
    })?;
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Err(Unreadable::Empty);
    }
    serde_json::from_slice(&bytes).map_err(|e| Unreadable::Invalid(e.to_string()))
}

/// Read the store, falling back to `.tmp` then `.bak` only when the file is
/// damaged. Err when a file that is needed is there but cannot be read now.
pub fn read_store(path: &Path) -> Result<(Entries, Opened), String> {
    let problem = match read_entries(path) {
        Ok(entries) => return Ok((entries, Opened::Main)),
        Err(Unreadable::Io(e)) => {
            return Err(format!("{} could not be read ({e})", path.display()));
        }
        Err(problem) => problem,
    };
    let mut damaged_copy = false;
    // A complete .tmp is newer than the .bak; one cut short is not valid JSON.
    for copy in [temp_path(path), backup_path(path)] {
        match read_entries(&copy) {
            Ok(entries) => {
                let problem = problem.describe();
                return Ok((
                    entries,
                    Opened::Recovered {
                        from: copy,
                        problem,
                    },
                ));
            }
            Err(Unreadable::Missing) => {}
            Err(Unreadable::Io(e)) => {
                return Err(format!(
                    "{} {}, and {} could not be read ({e})",
                    path.display(),
                    problem.describe(),
                    copy.display()
                ));
            }
            Err(_) => damaged_copy = true,
        }
    }
    if matches!(problem, Unreadable::Missing) && !damaged_copy {
        return Ok((Entries::new(), Opened::Fresh));
    }
    let problem = problem.describe();
    Ok((Entries::new(), Opened::Lost { problem }))
}

/// Errors that clear by themselves: a scanner or sync client holding the file
/// on Windows, EBUSY elsewhere.
fn is_transient(e: &io::Error) -> bool {
    if cfg!(windows) {
        e.raw_os_error()
            .is_some_and(|code| WINDOWS_TRANSIENT.contains(&code))
    } else {
        e.kind() == io::ErrorKind::ResourceBusy
    }
}

fn retrying<T>(mut op: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    let mut attempt = 1;
    loop {
        match op() {
            Err(e) if is_transient(&e) && attempt < ATTEMPTS => {
                attempt += 1;
                thread::sleep(PAUSE);
            }
            result => return result,
        }
    }
}

fn write_synced(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = retrying(|| fs::File::create(path))?;
    file.write_all(bytes)?;
    // On the disk before the rename, or a power loss could leave the new name
    // pointing at contents that never got there.
    file.sync_all()
}

fn sync_folder(dir: &Path) -> io::Result<()> {
    // Renames reach the disk with the folder on Linux and macOS; NTFS journals them.
    if cfg!(unix) {
        fs::File::open(dir)?.sync_all()?;
    }
    Ok(())
}

/// Write `bytes` to `path` through a synced `.tmp` and a rename, keeping the
/// current file as `.bak` when `keep_previous`. A failed rename puts it back.
/// Err too when the folder could not be synced: the new file may not survive a power loss.
pub fn write_replacing(path: &Path, bytes: &[u8], keep_previous: bool) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::other(format!("{} has no folder", path.display())))?;
    fs::create_dir_all(dir)?;
    let temp = temp_path(path);
    if let Err(e) = write_synced(&temp, bytes) {
        let _ = fs::remove_file(&temp);
        return Err(e);
    }
    let backup = backup_path(path);
    let kept = keep_previous
        && match retrying(|| fs::rename(path, &backup)) {
            Ok(()) => true,
            Err(e) if e.kind() == io::ErrorKind::NotFound => false,
            Err(e) => {
                let _ = fs::remove_file(&temp);
                return Err(e);
            }
        };
    if let Err(e) = retrying(|| fs::rename(&temp, path)) {
        if kept {
            let _ = retrying(|| fs::rename(&backup, path));
        }
        return Err(e);
    }
    sync_folder(dir)
}

/// Move a damaged store file aside as `<name>.corrupt-<n>`, one above the
/// highest there, keeping only the newest `CORRUPT_KEPT`. Returns the new name.
fn set_aside(path: &Path) -> io::Result<PathBuf> {
    let existing = corrupt_copies(path)?;
    let next = existing.last().map_or(1, |(n, _)| n + 1);
    let aside = with_suffix(path, &format!("{CORRUPT_SUFFIX}{next}"));
    retrying(|| fs::rename(path, &aside))?;
    let surplus = (existing.len() + 1).saturating_sub(CORRUPT_KEPT);
    for (_, old) in existing.iter().take(surplus) {
        let _ = fs::remove_file(old);
    }
    Ok(aside)
}

/// The store as it is open in this process.
pub struct OpenStore {
    path: PathBuf,
    entries: Entries,
    /// Whether the file at `path` is one this process read or wrote, so a save
    /// may keep it as the backup.
    main_good: bool,
    /// Set after a failed save; the exit tries that save once more.
    unsaved: bool,
    /// The open found the file and every copy damaged and started empty;
    /// cleared once the page has been told.
    lost: bool,
}

impl OpenStore {
    /// Open the store at `path`, telling `report` about any recovery. Err when
    /// it cannot be opened now; nothing on the disk has changed then.
    pub fn open(
        path: &Path,
        legacy: Option<&Path>,
        report: impl Fn(&str),
    ) -> Result<OpenStore, String> {
        copy_in_legacy(path, legacy, &report)?;
        let (entries, opened) = read_store(path)?;
        if opened != Opened::Main && path.exists() {
            let aside = set_aside(path).map_err(|e| {
                format!(
                    "{} is damaged and could not be set aside ({e})",
                    path.display()
                )
            })?;
            report(&format!(
                "{} could not be opened; kept it as {}",
                path.display(),
                aside.display()
            ));
        }
        let main_good = opened == Opened::Main || promote_temp(path, &opened)?;
        if let Some(warning) = opened.warning(path) {
            report(&warning);
        }
        Ok(OpenStore {
            path: path.to_path_buf(),
            entries,
            main_good,
            unsaved: false,
            lost: matches!(opened, Opened::Lost { .. }),
        })
    }

    pub fn get(&self, key: &str) -> Option<Value> {
        self.entries.get(key).cloned()
    }

    pub fn set(&mut self, key: String, value: Value) {
        self.entries.insert(key, value);
        self.unsaved = true;
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn is_unsaved(&self) -> bool {
        self.unsaved
    }

    /// Whether the open started empty because nothing could be recovered,
    /// answered true once.
    pub fn take_lost(&mut self) -> bool {
        std::mem::take(&mut self.lost)
    }

    pub fn save(&mut self) -> io::Result<()> {
        // Pretty-printed as tauri-plugin-store 2.4.3 saved it (key order aside), so the
        // file keeps the layout users and older builds have seen.
        let bytes = serde_json::to_vec_pretty(&self.entries).map_err(io::Error::other)?;
        write_replacing(&self.path, &bytes, self.main_good)?;
        self.main_good = true;
        self.unsaved = false;
        Ok(())
    }

    /// Clear the store: the copies go first and nothing is kept as `.bak`, so
    /// no later recovery can bring the old library back.
    pub fn reset(&mut self, report: impl Fn(&str)) -> io::Result<()> {
        let mut copies = vec![backup_path(&self.path), temp_path(&self.path)];
        match corrupt_copies(&self.path) {
            Ok(found) => copies.extend(found.into_iter().map(|(_, p)| p)),
            Err(e) => report(&format!("reset: could not list the set-aside files ({e})")),
        }
        for copy in copies {
            match retrying(|| fs::remove_file(&copy)) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => report(&format!(
                    "reset: could not remove {} ({e}); it still holds the library from before the reset",
                    copy.display()
                )),
                _ => {}
            }
        }
        self.entries.clear();
        self.unsaved = true;
        self.main_good = false;
        self.save()
    }
}

/// On a first run only, copy in the store a build that kept it elsewhere left.
fn copy_in_legacy(
    path: &Path,
    legacy: Option<&Path>,
    report: &impl Fn(&str),
) -> Result<(), String> {
    let Some(legacy) = legacy else {
        return Ok(());
    };
    if legacy == path || !legacy.is_file() || !no_store_files(path) {
        return Ok(());
    }
    fs::copy(legacy, path)
        .map_err(|e| format!("{} could not be copied in ({e})", legacy.display()))?;
    report(&format!(
        "copied the library list from {} (first run)",
        legacy.display()
    ));
    Ok(())
}

/// A store recovered from a complete `.tmp` goes into place at once, so the
/// next save's `.tmp` can never truncate its only copy. True when it did.
fn promote_temp(path: &Path, opened: &Opened) -> Result<bool, String> {
    let Opened::Recovered { from, .. } = opened else {
        return Ok(false);
    };
    if *from != temp_path(path) {
        return Ok(false);
    }
    let placed = retrying(|| fs::rename(from, path)).and_then(|()| match path.parent() {
        Some(dir) => sync_folder(dir),
        None => Ok(()),
    });
    placed.map_err(|e| format!("{} could not be put in place ({e})", from.display()))?;
    Ok(true)
}

#[cfg(test)]
mod tests;
