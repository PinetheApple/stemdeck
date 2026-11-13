use super::*;
use serde_json::json;
use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Instant;

/// Test stores live under the repo's git-ignored data/, never a library.
fn scratch() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/store-tests");
    fs::create_dir_all(&root).expect("data/store-tests");
    tempfile::tempdir_in(root).expect("scratch folder")
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).expect("read")).expect("valid JSON")
}

/// Opens the store, keeping what it reported.
fn open(path: &Path) -> (OpenStore, Vec<String>) {
    let reported = RefCell::new(Vec::new());
    let store = OpenStore::open(path, None, |line| {
        reported.borrow_mut().push(line.to_string())
    })
    .expect("opened");
    (store, reported.into_inner())
}

fn aside(path: &Path) -> Vec<PathBuf> {
    corrupt_copies(path)
        .expect("listed")
        .into_iter()
        .map(|(_, p)| p)
        .collect()
}

fn mentions(reported: &[String], text: &str) -> bool {
    reported.iter().any(|line| line.contains(text))
}

#[test]
fn a_save_writes_the_store_and_keeps_the_previous_one() {
    let dir = scratch();
    let path = dir.path().join("user-data.json");
    let (mut store, reported) = open(&path);
    assert!(reported.is_empty(), "a first start is not a recovery");

    store.set("a".into(), json!(1));
    store.save().expect("first save");
    assert_eq!(read_json(&path), json!({ "a": 1 }));
    assert!(
        !backup_path(&path).exists(),
        "nothing before the first save"
    );

    store.set("b".into(), json!({ "voice": "split" }));
    store.save().expect("second save");
    assert_eq!(
        read_json(&path),
        json!({ "a": 1, "b": { "voice": "split" } })
    );
    assert_eq!(read_json(&backup_path(&path)), json!({ "a": 1 }));
    assert!(!temp_path(&path).exists(), "no .tmp left after a save");

    let (mut reopened, reported) = open(&path);
    assert!(reported.is_empty());
    assert!(!reopened.take_lost());
    assert_eq!(reopened.get("b"), Some(json!({ "voice": "split" })));
}

/// The crash this guards against: the store file cut short mid-write.
#[test]
fn a_truncated_store_with_a_good_backup_recovers_from_the_backup() {
    let dir = scratch();
    let path = dir.path().join("user-data.json");
    fs::write(backup_path(&path), r#"{"songs":["one","two"]}"#).unwrap();
    fs::write(&path, r#"{"songs":["one","tw"#).unwrap();

    let (mut store, reported) = open(&path);
    assert_eq!(store.get("songs"), Some(json!(["one", "two"])));
    assert!(mentions(&reported, "is not valid JSON"), "{reported:?}");
    assert!(mentions(&reported, "user-data.json.bak"), "{reported:?}");

    let set_aside = aside(&path);
    assert_eq!(set_aside.len(), 1, "{set_aside:?}");
    assert_eq!(fs::read(&set_aside[0]).unwrap(), br#"{"songs":["one","tw"#);
    assert!(mentions(&reported, ".corrupt-"), "{reported:?}");

    // The next save never moves the broken file over the good backup.
    store.set("songs".into(), json!(["one", "two", "three"]));
    store.save().expect("save");
    assert_eq!(
        read_json(&path),
        json!({ "songs": ["one", "two", "three"] })
    );
    assert_eq!(
        read_json(&backup_path(&path)),
        json!({ "songs": ["one", "two"] })
    );
}

#[test]
fn an_invalid_store_with_a_good_backup_recovers_from_the_backup() {
    let dir = scratch();
    let path = dir.path().join("user-data.json");
    fs::write(backup_path(&path), r#"{"a":1}"#).unwrap();
    fs::write(&path, "\u{0}\u{0}garbage").unwrap();

    let (store, reported) = open(&path);
    assert_eq!(store.get("a"), Some(json!(1)));
    assert!(mentions(&reported, "is not valid JSON"), "{reported:?}");
    assert_eq!(aside(&path).len(), 1, "the invalid file is kept");
}

#[test]
fn an_empty_store_recovers_from_the_backup() {
    let dir = scratch();
    let path = dir.path().join("user-data.json");
    fs::write(backup_path(&path), r#"{"a":1}"#).unwrap();
    fs::write(&path, "").unwrap();

    let (store, reported) = open(&path);
    assert_eq!(store.get("a"), Some(json!(1)));
    assert!(mentions(&reported, "is empty"), "{reported:?}");
}

#[test]
fn a_json_value_that_is_not_an_object_is_not_a_store() {
    let dir = scratch();
    let path = dir.path().join("user-data.json");
    fs::write(&path, "[]").unwrap();
    let (_, reported) = open(&path);
    assert!(mentions(&reported, "is not valid JSON"), "{reported:?}");
}

#[test]
fn a_broken_store_and_backup_start_empty_and_say_so() {
    let dir = scratch();
    let path = dir.path().join("user-data.json");
    fs::write(&path, r#"{"a":"#).unwrap();
    fs::write(backup_path(&path), "").unwrap();

    let (mut store, reported) = open(&path);
    assert_eq!(store.entries, Entries::new());
    assert!(
        mentions(&reported, "starting with an empty library list"),
        "{reported:?}"
    );
    assert_eq!(aside(&path).len(), 2, "the broken file and backup are kept");
    assert!(store.take_lost(), "the page is told");
    assert!(!store.take_lost(), "once");

    store.set("a".into(), json!(1));
    store.save().expect("save");
    assert_eq!(read_json(&path), json!({ "a": 1 }));
}

/// No store file and only damaged copies: they are kept, never saved over.
#[test]
fn damaged_copies_are_set_aside_when_nothing_is_recovered() {
    let dir = scratch();
    let path = dir.path().join("user-data.json");
    fs::write(temp_path(&path), r#"{"a":"#).unwrap();
    fs::write(backup_path(&path), r#"{"b":"#).unwrap();

    let (mut store, reported) = open(&path);
    assert!(store.take_lost());
    assert!(
        mentions(&reported, "starting with an empty library list"),
        "{reported:?}"
    );
    assert!(!temp_path(&path).exists() && !backup_path(&path).exists());

    store.set("c".into(), json!(1));
    store.save().expect("save");
    store.save().expect("second save");
    let kept: Vec<Vec<u8>> = aside(&path).iter().map(|p| fs::read(p).unwrap()).collect();
    assert_eq!(kept, [br#"{"b":"#.to_vec(), br#"{"a":"#.to_vec()]);
}

#[test]
fn a_folder_that_refuses_to_sync_is_not_a_failed_save() {
    let refused = |kind| Err(io::Error::from(kind));
    assert!(tolerate_unsyncable(refused(io::ErrorKind::InvalidInput)).is_ok());
    assert!(tolerate_unsyncable(refused(io::ErrorKind::Unsupported)).is_ok());
    assert!(tolerate_unsyncable(Ok(())).is_ok());
    let failed = tolerate_unsyncable(refused(io::ErrorKind::PermissionDenied));
    assert_eq!(failed.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
}

#[test]
fn a_missing_store_with_no_copies_is_a_fresh_start() {
    let dir = scratch();
    let (entries, opened) = read_store(&dir.path().join("user-data.json")).unwrap();
    assert_eq!(opened, Opened::Fresh);
    assert!(entries.is_empty());
}

/// A stop between the two renames leaves the new contents complete in .tmp;
/// they go into place at once, so a second stop still leaves them.
#[test]
fn a_complete_tmp_is_put_in_place_before_the_next_save() {
    let dir = scratch();
    let path = dir.path().join("user-data.json");
    fs::write(backup_path(&path), r#"{"a":1}"#).unwrap();
    fs::write(temp_path(&path), r#"{"a":2}"#).unwrap();

    let (_store, reported) = open(&path);
    assert!(mentions(&reported, "is missing"), "{reported:?}");
    assert!(mentions(&reported, "user-data.json.tmp"), "{reported:?}");
    assert_eq!(read_json(&path), json!({ "a": 2 }), "in place at once");
    assert!(!temp_path(&path).exists());
    assert_eq!(read_json(&backup_path(&path)), json!({ "a": 1 }), "kept");

    fs::write(temp_path(&path), r#"{"a":"#).unwrap();
    let (store, reported) = open(&path);
    assert!(reported.is_empty(), "{reported:?}");
    assert_eq!(store.get("a"), Some(json!(2)));
}

#[test]
fn a_tmp_beside_a_good_store_is_ignored_and_cleared_by_the_next_save() {
    let dir = scratch();
    let path = dir.path().join("user-data.json");
    fs::write(&path, r#"{"a":1}"#).unwrap();
    fs::write(temp_path(&path), r#"{"a":"#).unwrap();

    let (mut store, reported) = open(&path);
    assert!(reported.is_empty(), "{reported:?}");
    assert_eq!(store.get("a"), Some(json!(1)));
    store.save().expect("save");
    assert!(!temp_path(&path).exists());
    assert_eq!(read_json(&backup_path(&path)), json!({ "a": 1 }));
}

#[test]
fn a_cut_short_tmp_is_passed_over_for_the_backup() {
    let dir = scratch();
    let path = dir.path().join("user-data.json");
    fs::write(backup_path(&path), r#"{"a":1}"#).unwrap();
    fs::write(temp_path(&path), r#"{"a":"#).unwrap();

    let (store, _) = open(&path);
    assert_eq!(store.get("a"), Some(json!(1)));
}

#[test]
fn only_the_two_newest_damaged_files_are_kept() {
    let dir = scratch();
    let path = dir.path().join("user-data.json");
    for n in [3, 100, 7] {
        fs::write(with_suffix(&path, &format!(".corrupt-{n}")), "x").unwrap();
    }
    fs::write(&path, "{").unwrap();
    let _ = open(&path);
    let kept: Vec<String> = aside(&path).iter().map(|p| file_name(p)).collect();
    assert_eq!(
        kept,
        ["user-data.json.corrupt-100", "user-data.json.corrupt-101"]
    );
    assert_eq!(fs::read(with_suffix(&path, ".corrupt-101")).unwrap(), b"{");
}

#[test]
fn the_legacy_file_is_copied_in_only_when_no_store_file_exists() {
    let dir = scratch();
    let legacy = dir.path().join("legacy.json");
    fs::write(&legacy, r#"{"from":"legacy"}"#).unwrap();
    let open_with_legacy =
        |path: &Path| OpenStore::open(path, Some(&legacy), |_| {}).expect("opened");

    let first = dir.path().join("first").join("user-data.json");
    fs::create_dir_all(first.parent().unwrap()).unwrap();
    assert_eq!(open_with_legacy(&first).get("from"), Some(json!("legacy")));

    for (name, contents) in [
        ("user-data.json.tmp", "{\"a\":1}"),
        ("user-data.json.tmp", "{\"a\":"),
        ("user-data.json.bak", "{\"a\":1}"),
        ("user-data.json.corrupt-1", "{"),
    ] {
        let folder = dir.path().join(format!("{name}-{}", contents.len()));
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join(name), contents).unwrap();
        let store = open_with_legacy(&folder.join("user-data.json"));
        assert_eq!(store.get("from"), None, "{name} {contents}");
    }
}

/// A store file that cannot be read still counts as there for the first-run
/// check, as does a folder that cannot be listed.
#[test]
fn a_store_file_that_cannot_be_read_still_blocks_the_legacy_copy() {
    let dir = scratch();
    let path = dir.path().join("user-data.json");
    fs::create_dir(temp_path(&path)).unwrap();
    assert!(read_entries(&temp_path(&path)).is_err(), "unreadable");
    assert!(!no_store_files(&path));

    let blocker = dir.path().join("not-a-folder");
    fs::write(&blocker, "x").unwrap();
    assert!(!no_store_files(&blocker.join("user-data.json")));
}

/// Locked is not damaged: no copy is opened in its place and nothing moves.
#[test]
fn an_unreadable_store_is_an_error_and_never_falls_back() {
    let dir = scratch();
    let path = dir.path().join("user-data.json");
    fs::create_dir(&path).unwrap();
    fs::write(backup_path(&path), r#"{"a":"old"}"#).unwrap();

    let err = OpenStore::open(&path, None, |_| {})
        .err()
        .expect("not opened");
    assert!(err.contains("could not be read"), "{err}");
    assert!(path.is_dir(), "left in place");
    assert!(aside(&path).is_empty());
    assert_eq!(read_json(&backup_path(&path)), json!({ "a": "old" }));
}

#[test]
fn a_reset_removes_every_copy_and_keeps_none_of_the_old_library() {
    let dir = scratch();
    let path = dir.path().join("user-data.json");
    let (mut store, _) = open(&path);
    store.set("songs".into(), json!(["one"]));
    store.save().unwrap();
    store.save().unwrap();
    fs::write(temp_path(&path), "{").unwrap();
    fs::write(with_suffix(&path, ".corrupt-100"), "{").unwrap();
    assert!(backup_path(&path).exists());

    let reported = RefCell::new(Vec::<String>::new());
    store
        .reset(|line| reported.borrow_mut().push(line.to_string()))
        .expect("reset");
    assert!(reported.borrow().is_empty(), "{:?}", reported.borrow());
    assert_eq!(read_json(&path), json!({}));
    assert!(!backup_path(&path).exists(), "the old library is not kept");
    assert!(!temp_path(&path).exists());
    assert!(aside(&path).is_empty());
}

#[test]
fn transient_errors_are_the_only_ones_tried_again() {
    let raw = io::Error::from_raw_os_error;
    if cfg!(windows) {
        assert!(is_transient(&raw(32)), "sharing violation");
        assert!(is_transient(&raw(33)), "lock violation");
        assert!(is_transient(&raw(5)), "access denied");
        assert!(!is_transient(&raw(2)), "file not found");
    } else {
        assert!(is_transient(&raw(16)), "EBUSY");
        assert!(!is_transient(&raw(2)), "ENOENT");
        assert!(!is_transient(&raw(30)), "EROFS");
        assert!(!is_transient(&raw(13)), "EACCES");
    }
    let calls = std::cell::Cell::new(0);
    let started = Instant::now();
    let result: io::Result<()> = retrying(|| {
        calls.set(calls.get() + 1);
        Err(io::Error::from(io::ErrorKind::NotFound))
    });
    assert!(result.is_err());
    assert_eq!(calls.get(), 1, "a missing file is not tried again");
    assert!(started.elapsed() < PAUSE);
}

/// The keys and kinds of value the page keeps; the fixture beside it holds the
/// bytes tauri-plugin-store 2.4.3 wrote for them.
fn plugin_store_entries() -> HashMap<String, Value> {
    serde_json::from_str(include_str!(
        "../../tests/fixtures/user-data-plugin-2.4.3.input.json"
    ))
    .unwrap()
}

#[test]
fn a_store_the_plugin_saved_opens_as_it_is() {
    let fixture = include_bytes!("../../tests/fixtures/user-data-plugin-2.4.3.json");
    let dir = scratch();
    let path = dir.path().join("user-data.json");
    fs::write(&path, fixture).unwrap();
    let (store, reported) = open(&path);
    assert!(reported.is_empty(), "{reported:?}");
    let expected: Entries = plugin_store_entries().into_iter().collect();
    assert_eq!(store.entries, expected);
}

/// The plugin's reader reads a save back whole, so an older build keeps the library.
#[test]
fn what_a_save_writes_the_plugin_reads() {
    let dir = scratch();
    let path = dir.path().join("user-data.json");
    let (mut store, _) = open(&path);
    for (key, value) in plugin_store_entries() {
        store.set(key, value);
    }
    store.save().unwrap();
    let read: HashMap<String, Value> =
        serde_json::from_slice(&fs::read(&path).unwrap()).expect("the plugin's reader accepts it");
    assert_eq!(read, plugin_store_entries());
}

mod crash;
