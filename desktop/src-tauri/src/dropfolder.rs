//! What a native drop holds, with any dropped folder opened up into the files
//! inside it.
//!
//! In a browser the page walks a dropped folder itself, through
//! `webkitGetAsEntry`, and reviews every file under it with the folder it sits
//! in (`walkEntries` in `static/js/batchImportModel.js`). On Linux the drop
//! never reaches the page (see `dropin`), so the same walk happens here and
//! follows the same rules: hidden names are skipped at every level, and each
//! file carries the folder path below the drop, `/`-separated, starting with
//! the dropped folder's own name.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Names starting with this are skipped inside a folder, as the page skips them.
const HIDDEN_PREFIX: char = '.';

/// Joins folder names in a file's `dir`, as the page's `PATH_SEP` does.
const PATH_SEP: &str = "/";

/// One file the drop holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub path: PathBuf,
    /// The folders between the drop and the file; empty for a loose file.
    pub dir: String,
    /// 0 for anything that is not a regular file by the time it is looked at.
    pub size: u64,
}

/// Every file a drop holds, and whether any of it was a folder.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Expanded {
    pub folder: bool,
    pub files: Vec<Found>,
}

/// Opens up a drop. A drop with no folder in it is passed through as it is,
/// so a loose file the page will refuse still reaches it to be named. A
/// folder that cannot be read fails the whole drop, as it does in the page.
pub fn expand(paths: &[PathBuf]) -> io::Result<Expanded> {
    if !paths.iter().any(|p| p.is_dir()) {
        let files = paths
            .iter()
            .map(|p| found(p.clone(), String::new()))
            .collect();
        return Ok(Expanded {
            folder: false,
            files,
        });
    }
    let mut files = Vec::new();
    for path in paths {
        visit(path, "", &mut files)?;
    }
    Ok(Expanded {
        folder: true,
        files,
    })
}

fn visit(path: &Path, dir: &str, out: &mut Vec<Found>) -> io::Result<()> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if name.starts_with(HIDDEN_PREFIX) {
        return Ok(());
    }
    // Not following a linked folder keeps a link back up the tree from
    // walking forever.
    let kind = fs::symlink_metadata(path)?.file_type();
    if kind.is_dir() {
        let below = join(dir, &name);
        for entry in fs::read_dir(path)? {
            visit(&entry?.path(), &below, out)?;
        }
    } else if path.is_file() {
        out.push(found(path.to_path_buf(), dir.to_string()));
    }
    Ok(())
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}{PATH_SEP}{name}")
    }
}

fn found(path: PathBuf, dir: String) -> Found {
    let size = fs::metadata(&path)
        .ok()
        .filter(|m| m.is_file())
        .map_or(0, |m| m.len());
    Found { path, dir, size }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    /// (dir, file name, size) per file, sorted, for comparing walks.
    fn listing(expanded: &Expanded) -> Vec<(String, String, u64)> {
        let mut rows: Vec<_> = expanded
            .files
            .iter()
            .map(|f| {
                let name = f.path.file_name().unwrap().to_string_lossy().into_owned();
                (f.dir.clone(), name, f.size)
            })
            .collect();
        rows.sort();
        rows
    }

    fn row(dir: &str, name: &str, size: u64) -> (String, String, u64) {
        (dir.to_string(), name.to_string(), size)
    }

    #[test]
    fn a_folder_is_opened_into_its_files_and_subfolders() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("Rehearsal");
        write(&root.join("a.wav"), b"RIFF");
        write(&root.join("notes.txt"), b"hi");
        write(&root.join("Live").join("b.flac"), b"fLaC!");
        write(&root.join("Live").join("Older").join("c.m4a"), b"m4a");

        let expanded = expand(&[root]).unwrap();

        assert!(expanded.folder);
        assert_eq!(
            listing(&expanded),
            vec![
                row("Rehearsal", "a.wav", 4),
                row("Rehearsal", "notes.txt", 2),
                row("Rehearsal/Live", "b.flac", 5),
                row("Rehearsal/Live/Older", "c.m4a", 3),
            ]
        );
    }

    #[test]
    fn hidden_files_and_folders_inside_a_folder_are_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("Set");
        write(&root.join("a.wav"), b"a");
        write(&root.join(".DS_Store"), b"x");
        write(&root.join(".git").join("b.wav"), b"b");

        assert_eq!(
            listing(&expand(&[root]).unwrap()),
            vec![row("Set", "a.wav", 1)]
        );
    }

    #[test]
    fn loose_files_dropped_beside_a_folder_have_no_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("Set");
        let loose = tmp.path().join("loose.mp3");
        write(&root.join("a.wav"), b"a");
        write(&loose, b"ID3");

        assert_eq!(
            listing(&expand(&[root, loose]).unwrap()),
            vec![row("", "loose.mp3", 3), row("Set", "a.wav", 1)]
        );
    }

    #[test]
    fn a_drop_of_files_only_is_passed_through_as_it_is() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a.wav");
        write(&a, b"RIFF");
        let gone = tmp.path().join("gone.wav");

        let expanded = expand(&[a.clone(), gone.clone()]).unwrap();

        assert!(!expanded.folder);
        let sizes: Vec<_> = expanded.files.iter().map(|f| (&f.path, f.size)).collect();
        assert_eq!(sizes, vec![(&a, 4), (&gone, 0)]);
    }

    #[test]
    fn an_empty_folder_is_a_folder_with_nothing_in_it() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("Empty");
        fs::create_dir(&root).unwrap();

        assert_eq!(
            expand(&[root]).unwrap(),
            Expanded {
                folder: true,
                files: vec![],
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_link_back_up_the_tree_is_not_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("Set");
        write(&root.join("a.wav"), b"a");
        std::os::unix::fs::symlink(&root, root.join("loop")).unwrap();

        assert_eq!(
            listing(&expand(&[root]).unwrap()),
            vec![row("Set", "a.wav", 1)]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_that_cannot_be_read_fails_the_drop() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("Set");
        let locked = root.join("Locked");
        write(&locked.join("a.wav"), b"a");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

        let result = expand(&[root]);

        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(result.is_err());
    }
}
