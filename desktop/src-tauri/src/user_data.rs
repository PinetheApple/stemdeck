//! The user-data store as Tauri state: opened on first use, reopened when the
//! jobs folder moves, and closed to writes while it cannot be reached.

use crate::store_file::OpenStore;
use serde_json::{Map, Value};
use std::{
    io,
    path::PathBuf,
    sync::{Mutex, MutexGuard, PoisonError},
    thread,
    time::{Duration, Instant},
};

/// The start of every error while the store cannot be reached; the page stops
/// on it instead of going on with stand-ins (static/js/utils.js).
pub const UNAVAILABLE: &str = "user-data-unavailable";

#[derive(Default)]
pub struct UserData {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    open: Option<OpenStore>,
    /// Set when the store could not be reached; cleared by `ready`.
    blocked: bool,
}

/// Where the store is: its path (Err when the jobs folder cannot be reached)
/// and the legacy file a first run copies in.
pub struct Place {
    pub path: Result<PathBuf, String>,
    pub legacy: Option<PathBuf>,
}

impl UserData {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Run `f` on the store at `place`, holding it for the whole call so two
    /// saves never share the `.tmp`. A store open at another path is dropped
    /// unsaved: the library moved. With `write`, refused while blocked.
    fn run<T>(
        &self,
        place: Place,
        report: impl Fn(&str),
        write: bool,
        f: impl FnOnce(&mut OpenStore) -> T,
    ) -> Result<T, String> {
        let mut state = self.state();
        if write && state.blocked {
            return Err(format!(
                "{UNAVAILABLE}: not saved: the library list could not be read earlier, \
                 so it has to be loaded again first"
            ));
        }
        let path = match place.path {
            Ok(path) => path,
            Err(e) => {
                state.blocked = true;
                return Err(format!("{UNAVAILABLE}: {e}"));
            }
        };
        if state.open.as_ref().is_some_and(|store| store.path() != path) {
            state.open = None;
        }
        if state.open.is_none() {
            match OpenStore::open(&path, place.legacy.as_deref(), &report) {
                Ok(store) => state.open = Some(store),
                Err(e) => {
                    state.blocked = true;
                    let error = format!("{UNAVAILABLE}: {e}");
                    report(&error);
                    return Err(error);
                }
            }
        }
        match state.open.as_mut() {
            Some(store) => Ok(f(store)),
            None => Err(format!("{UNAVAILABLE}: not open")),
        }
    }

    pub fn read<T>(
        &self,
        place: Place,
        report: impl Fn(&str),
        f: impl FnOnce(&OpenStore) -> T,
    ) -> Result<T, String> {
        self.run(place, report, false, |store| f(store))
    }

    pub fn write<T>(
        &self,
        place: Place,
        report: impl Fn(&str),
        f: impl FnOnce(&mut OpenStore) -> T,
    ) -> Result<T, String> {
        self.run(place, report, true, f)
    }

    pub fn get(&self, place: Place, report: impl Fn(&str), key: &str) -> Result<Option<Value>, String> {
        self.read(place, report, |store| store.get(key))
    }

    /// Every key in one save; refused whole while blocked.
    pub fn set_all(
        &self,
        place: Place,
        report: impl Fn(&str),
        entries: Map<String, Value>,
    ) -> Result<(), String> {
        self.write(place, report, |store| {
            for (key, value) in entries {
                store.set(key, value);
            }
            store
                .save()
                .map_err(|e| format!("could not save user-data.json: {e}"))
        })?
    }

    /// Open the store for a page that is loading, then lift the block on writes.
    pub fn ready(&self, place: Place, report: impl Fn(&str)) -> Result<(), String> {
        self.run(place, report, false, |_| ())?;
        self.state().blocked = false;
        Ok(())
    }

    /// Clear the store. Not refused while blocked: nothing the page holds is
    /// written, and the page loads again right after.
    pub fn reset(&self, place: Place, report: impl Fn(&str) + Copy) -> Result<(), String> {
        self.run(place, report, false, |store| store.reset(report))?
            .map_err(|e| format!("could not save user-data.json: {e}"))
    }

    /// At exit: save the open store if its last save failed.
    pub fn save_unsaved(&self) -> Option<io::Result<()>> {
        let mut state = self.state();
        let store = state.open.as_mut().filter(|store| store.is_unsaved())?;
        Some(store.save())
    }
}

/// Run `attempt` until it works, pausing between tries, for at most `budget`;
/// then its last error.
pub fn wait_until_ready(
    mut attempt: impl FnMut() -> Result<(), String>,
    budget: Duration,
    pause: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + budget;
    loop {
        match attempt() {
            Ok(()) => return Ok(()),
            Err(_) if Instant::now() + pause < deadline => thread::sleep(pause),
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store_file::{backup_path, corrupt_copies};
    use serde_json::json;
    use std::{cell::RefCell, fs, path::Path};

    fn scratch() -> tempfile::TempDir {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/store-tests");
        fs::create_dir_all(&root).expect("data/store-tests");
        tempfile::tempdir_in(root).expect("scratch folder")
    }

    fn read_json(path: &Path) -> Value {
        serde_json::from_slice(&fs::read(path).expect("read")).expect("valid JSON")
    }

    fn place(path: &Path) -> Place {
        Place {
            path: Ok(path.to_path_buf()),
            legacy: None,
        }
    }

    /// A store file that is there but unreadable (a folder in its place) is not
    /// damage: nothing moved, and writes stay refused until `ready`.
    #[test]
    fn an_unreadable_store_blocks_writes_until_ready() {
        let dir = scratch();
        let path = dir.path().join("user-data.json");
        fs::create_dir(&path).unwrap();
        fs::write(backup_path(&path), r#"{"a":"old"}"#).unwrap();

        let reported = RefCell::new(Vec::<String>::new());
        let report = |line: &str| reported.borrow_mut().push(line.to_string());
        let data = UserData::default();
        let err = data.ready(place(&path), report).expect_err("unavailable");
        assert!(err.starts_with(UNAVAILABLE), "{err}");
        assert!(reported.borrow().iter().any(|l| l.contains(UNAVAILABLE)));
        assert!(path.is_dir(), "the file in place is untouched");
        assert!(corrupt_copies(&path).unwrap().is_empty(), "nothing set aside");
        assert_eq!(read_json(&backup_path(&path)), json!({ "a": "old" }));

        fs::remove_dir(&path).unwrap();
        fs::write(&path, r#"{"a":"new"}"#).unwrap();
        let refused = data.write(place(&path), report, |s| {
            s.set("a".into(), json!("stand-in"));
            s.save()
        });
        assert!(refused.expect_err("blocked").starts_with(UNAVAILABLE));
        assert_eq!(read_json(&path), json!({ "a": "new" }), "nothing written");

        let got = data.read(place(&path), report, |s| s.get("a")).expect("read");
        assert_eq!(got, Some(json!("new")));
        assert!(data.write(place(&path), report, |_| ()).is_err());

        data.ready(place(&path), report).expect("ready");
        data.write(place(&path), report, |s| {
            s.set("a".into(), json!("newer"));
            s.save()
        })
        .expect("open")
        .expect("saved");
        assert_eq!(read_json(&path), json!({ "a": "newer" }));
    }

    #[test]
    fn an_unreachable_folder_is_unavailable_and_blocks_writes() {
        let dir = scratch();
        let path = dir.path().join("user-data.json");
        let data = UserData::default();
        let gone = Place {
            path: Err("failed to create E:\\StemDeck: the device is not ready".into()),
            legacy: None,
        };
        let err = data.read(gone, |_| {}, |s| s.get("a")).expect_err("unavailable");
        assert!(err.starts_with(UNAVAILABLE), "{err}");
        assert!(data.write(place(&path), |_| {}, |_| ()).is_err(), "blocked");
        data.ready(place(&path), |_| {}).expect("ready");
        assert!(data.write(place(&path), |_| {}, |_| ()).is_ok());
    }

    #[test]
    fn user_data_opens_again_when_the_path_changes() {
        let dir = scratch();
        let first = dir.path().join("one").join("user-data.json");
        let second = dir.path().join("two").join("user-data.json");
        fs::create_dir_all(second.parent().unwrap()).unwrap();
        fs::write(&second, r#"{"where":"two"}"#).unwrap();

        let data = UserData::default();
        data.write(place(&first), |_| {}, |s| {
            s.set("where".into(), json!("one"));
            s.save()
        })
        .expect("open")
        .expect("saved");
        let seen = data.read(place(&second), |_| {}, |s| s.get("where")).expect("open");
        assert_eq!(seen, Some(json!("two")));
        assert_eq!(read_json(&first), json!({ "where": "one" }));
    }

    #[test]
    fn the_exit_saves_what_a_failed_save_left_unsaved() {
        let dir = scratch();
        // A file where the store's folder should be: every save fails.
        let blocker = dir.path().join("jobs");
        fs::write(&blocker, "not a folder").unwrap();
        let path = blocker.join("user-data.json");

        let data = UserData::default();
        assert!(data.save_unsaved().is_none(), "nothing open");
        let saved = data
            .write(place(&path), |_| {}, |s| {
                s.set("a".into(), json!(1));
                s.save()
            })
            .expect("open");
        assert!(saved.is_err(), "the folder cannot be made");

        fs::remove_file(&blocker).unwrap();
        data.save_unsaved().expect("unsaved").expect("saved at exit");
        assert_eq!(read_json(&path), json!({ "a": 1 }));
        assert!(data.save_unsaved().is_none(), "saved once");
    }

    fn entries(value: Value) -> Map<String, Value> {
        value.as_object().expect("an object").clone()
    }

    /// store_get and store_set as the page reaches them through an unreachable
    /// jobs folder: unavailable, nothing written, writes refused until ready.
    #[test]
    fn get_and_set_all_refuse_an_unreachable_store_until_ready() {
        let dir = scratch();
        let path = dir.path().join("user-data.json");
        let data = UserData::default();
        let unreachable = Place {
            path: Err("failed to create E:\\jobs: not ready".into()),
            legacy: None,
        };

        let got = data.get(unreachable, |_| {}, "stemdeck.folders");
        assert!(got.expect_err("unavailable").starts_with(UNAVAILABLE));
        let set = data.set_all(place(&path), |_| {}, entries(json!({ "stemdeck.folders": [] })));
        assert!(set.expect_err("refused").starts_with(UNAVAILABLE));
        assert!(!path.exists(), "the stand-in was not written");

        data.ready(place(&path), |_| {}).expect("ready");
        data.set_all(place(&path), |_| {}, entries(json!({ "a": 1, "b": 2 })))
            .expect("saved");
        assert_eq!(data.get(place(&path), |_| {}, "b"), Ok(Some(json!(2))));
        assert_eq!(read_json(&path), json!({ "a": 1, "b": 2 }));
    }

    #[test]
    fn wait_until_ready_tries_again_until_it_works_or_the_wait_ends() {
        let tries = std::cell::Cell::new(0);
        let result = wait_until_ready(
            || {
                tries.set(tries.get() + 1);
                if tries.get() < 3 {
                    Err(format!("{UNAVAILABLE}: locked"))
                } else {
                    Ok(())
                }
            },
            Duration::from_secs(5),
            Duration::from_millis(1),
        );
        assert_eq!(result, Ok(()));
        assert_eq!(tries.get(), 3);

        let started = Instant::now();
        let result = wait_until_ready(
            || Err(format!("{UNAVAILABLE}: locked")),
            Duration::from_millis(60),
            Duration::from_millis(10),
        );
        assert_eq!(result, Err(format!("{UNAVAILABLE}: locked")));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
