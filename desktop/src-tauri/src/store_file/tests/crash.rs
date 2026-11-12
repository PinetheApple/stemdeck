//! A child process killed partway through saving a 9 MB store.

use super::super::*;
use super::scratch;
use serde_json::json;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

const CRASH_DIR: &str = "STEMDECK_STORE_CRASH_DIR";
const HELPER: &str = "store_file::tests::crash::crash_helper_saves_until_killed";
const SONGS: usize = 300;
const LANES: usize = 98;
const KILLS: u64 = 24;
const KILL_STEP_MS: u64 = 3;

/// About the size of a 300-song library with every song's mixes.
fn nine_megabytes() -> Entries {
    let mut store = Entries::new();
    for song in 0..SONGS {
        let lanes: Vec<Value> = (0..LANES)
            .map(|lane| {
                json!({
                    "stem": format!("stem-{lane}"),
                    "gain": 0.75, "pan": -0.25, "mute": false, "solo": false,
                    "eq": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
                    "label": "a lane label of an ordinary length",
                })
            })
            .collect();
        store.insert(format!("stemdeck:mix:{song:032x}"), json!({ "lanes": lanes }));
    }
    store
}

/// Not a test: the child `kill_mid_save` starts. Saves two versions in turn
/// forever, serialized up front so nearly every kill lands inside a write.
#[test]
#[ignore]
fn crash_helper_saves_until_killed() {
    let Ok(dir) = std::env::var(CRASH_DIR) else {
        return;
    };
    let dir = Path::new(&dir);
    let path = dir.join("user-data.json");
    let versions: Vec<Vec<u8>> = (0..2)
        .map(|n| fs::read(dir.join(format!("version-{n}"))).expect("version"))
        .collect();
    for n in 0usize.. {
        write_replacing(&path, &versions[n % 2], true).expect("save");
        if n == 0 {
            println!("saved");
        }
    }
}

fn crash_versions() -> [Vec<u8>; 2] {
    let mut entries = nine_megabytes();
    [0, 1].map(|n| {
        entries.insert("n".into(), json!(n));
        serde_json::to_vec_pretty(&entries).unwrap()
    })
}

fn kill_mid_save(versions: &[Vec<u8>; 2], delay: Duration) -> (Entries, Opened) {
    let dir = scratch();
    for (n, bytes) in versions.iter().enumerate() {
        fs::write(dir.path().join(format!("version-{n}")), bytes).unwrap();
    }
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([HELPER, "--exact", "--ignored", "--nocapture"])
        .env(CRASH_DIR, dir.path())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("helper started");
    let stdout = child.stdout.take().unwrap();
    let saved = BufReader::new(stdout)
        .lines()
        .map_while(Result::ok)
        .any(|line| line == "saved");
    assert!(saved, "the helper never saved");
    thread::sleep(delay);
    child.kill().expect("killed");
    child.wait().expect("reaped");
    read_store(&dir.path().join("user-data.json")).expect("readable")
}

/// A kill leaves the OS cache intact, so this covers a crash, not a power loss;
/// the sync before the rename covers that.
#[test]
fn a_process_killed_mid_save_always_leaves_a_store_to_open() {
    let versions = crash_versions();
    for step in 0..KILLS {
        let delay = Duration::from_millis(step * KILL_STEP_MS);
        let (entries, opened) = kill_mid_save(&versions, delay);
        assert!(
            !matches!(opened, Opened::Lost { .. } | Opened::Fresh),
            "kill {step}: {opened:?}"
        );
        assert!(entries.contains_key("n"), "kill {step}: no entries");
    }
}
