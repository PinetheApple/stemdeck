use std::fs;
use std::path::Path;

use tempfile::TempDir;

use super::{
    choose, detect, gfx_target_name, kfd_gpus, parse_kfd_node, pci_ids_amd_name, visible_devices,
    visible_devices_to_set, KfdGpu, BACKEND, KFD_NODES, REASON_NO_KFD_ACCESS, REASON_UNSUPPORTED,
    VISIBLE_DEVICE_VARS,
};
use crate::ROCM_TAG;

const RX_9070: u32 = 0x7550;
const RX_7900: u32 = 0x744c;
const RX_6600: u32 = 0x73ff;
const RYZEN_IGPU: u32 = 0x164e;
const RENDER_MINOR: u32 = 128;
const SECOND_RENDER_MINOR: u32 = 129;
const MISSING_RENDER_MINOR: u32 = 130;

/// A CPU node, as KFD writes one.
const KFD_CPU: &str =
    "cpu_cores_count 16\nsimd_count 0\ngfx_target_version 0\nvendor_id 0\ndevice_id 0\n";

/// A GPU node, trimmed to the fields detection reads.
fn kfd_gpu(gfx: u32, simds: u32, device: u32, minor: u32) -> String {
    format!(
        "cpu_cores_count 0\nsimd_count {simds}\ngfx_target_version {gfx}\n\
         vendor_id 4098\ndevice_id {device}\ndrm_render_minor {minor}\n"
    )
}

fn make_tmp() -> TempDir {
    tempfile::tempdir().expect("failed to create temp dir")
}

/// A fake filesystem root: KFD nodes 0..n, and /dev/kfd with render nodes 128
/// and 129 when `kfd` is set.
fn fake_amd_root(nodes: &[&str], kfd: bool) -> TempDir {
    let root = make_tmp();
    for (n, properties) in nodes.iter().enumerate() {
        write_node(root.path(), n, properties);
    }
    if kfd {
        fs::create_dir_all(root.path().join("dev/dri")).unwrap();
        for node in ["dev/kfd", "dev/dri/renderD128", "dev/dri/renderD129"] {
            fs::write(root.path().join(node), "").unwrap();
        }
    }
    root
}

fn write_node(root: &Path, node: usize, properties: &str) {
    let dir = root.join(KFD_NODES).join(node.to_string());
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("properties"), properties).unwrap();
}

fn setup_log(data: &TempDir) -> String {
    fs::read_to_string(data.path().join("logs").join("setup.log")).unwrap()
}

#[test]
fn kfd_gfx_target_versions_name_their_targets() {
    // Minor and stepping are hex digits in the name, decimal pairs in the
    // number: the MI200's 90010 is gfx90a, not gfx9010.
    assert_eq!(gfx_target_name(120001), "gfx1201");
    assert_eq!(gfx_target_name(110000), "gfx1100");
    assert_eq!(gfx_target_name(100300), "gfx1030");
    assert_eq!(gfx_target_name(100306), "gfx1036");
    assert_eq!(gfx_target_name(90010), "gfx90a");
}

#[test]
fn a_kfd_gpu_node_is_read_and_a_cpu_node_skipped() {
    assert_eq!(parse_kfd_node(KFD_CPU), None);
    let gpu = parse_kfd_node(&kfd_gpu(120001, 128, RX_9070, RENDER_MINOR)).unwrap();
    assert_eq!(gpu.gfx, "gfx1201");
    assert_eq!(gpu.simd_count, 128);
    assert_eq!(gpu.device_id, RX_9070);
    assert_eq!(gpu.render_minor, RENDER_MINOR);
}

#[test]
fn kfd_nodes_are_taken_in_number_order() {
    // read_dir order is arbitrary, and "10" sorts before "2" as text.
    let root = make_tmp();
    write_node(root.path(), 2, &kfd_gpu(110000, 64, 0, RENDER_MINOR));
    write_node(root.path(), 10, &kfd_gpu(120001, 64, 0, RENDER_MINOR));
    write_node(root.path(), 0, KFD_CPU);
    let gfx: Vec<String> = kfd_gpus(root.path()).into_iter().map(|g| g.gfx).collect();
    assert_eq!(gfx, ["gfx1100", "gfx1201"]);
}

#[test]
fn pci_ids_give_the_product_name_of_amd_devices_only() {
    // The comment sits mid-section, as real pci.ids has them: it must not end
    // the AMD section.
    let ids = "1002  Advanced Micro Devices, Inc. [AMD/ATI]\n\
               # Used in the Steam Deck OLED\n\
               \t7550  Navi 48 [Radeon RX 9070/9070 XT/9070 GRE]\n\
               \t\t1002 7550  Subsystem that must not match\n\
               \t73bf  Navi 21\n\
               10de  NVIDIA Corporation\n\
               \t7551  Not an AMD device\n";
    assert_eq!(
        pci_ids_amd_name(ids, RX_9070).as_deref(),
        Some("Radeon RX 9070/9070 XT/9070 GRE")
    );
    // No brackets: the whole entry is the name.
    assert_eq!(pci_ids_amd_name(ids, 0x73bf).as_deref(), Some("Navi 21"));
    assert_eq!(pci_ids_amd_name(ids, 0x7551), None);
}

#[test]
fn one_supported_amd_gpu_is_offered_rocm() {
    let root = fake_amd_root(
        &[KFD_CPU, &kfd_gpu(120001, 128, RX_9070, RENDER_MINOR)],
        true,
    );
    let drm = root.path().join("sys/class/drm/renderD128/device");
    fs::create_dir_all(&drm).unwrap();
    fs::write(drm.join("product_name"), "Radeon RX 9070 XT\n").unwrap();
    let data = make_tmp();

    let gpu = detect(root.path(), data.path()).expect("found");
    assert_eq!(gpu.name, "AMD Radeon RX 9070 XT (gfx1201)");
    assert_eq!(gpu.backend, BACKEND);
    assert_eq!(gpu.version, "6.4");
    assert_eq!(gpu.candidates, vec![ROCM_TAG]);
    assert_eq!(gpu.unusable, None);
    assert_eq!(visible_devices(root.path()).as_deref(), Some("0"));
}

/// A Ryzen's integrated GPU, which no build has kernels for, listed ahead of
/// the discrete card: taking the first node would settle on CPU.
#[test]
fn the_discrete_card_wins_over_an_integrated_gpu_listed_first() {
    let root = fake_amd_root(
        &[
            KFD_CPU,
            &kfd_gpu(100306, 4, RYZEN_IGPU, SECOND_RENDER_MINOR),
            &kfd_gpu(110000, 192, RX_7900, RENDER_MINOR),
        ],
        true,
    );
    let data = make_tmp();

    let gpu = detect(root.path(), data.path()).expect("found");
    assert_eq!(gpu.name, "AMD GPU (gfx1100)");
    assert_eq!(gpu.unusable, None);
    // The runtime is shown only the discrete card, GPU 1 of 0 and 1.
    assert_eq!(visible_devices(root.path()).as_deref(), Some("1"));
    let log = setup_log(&data);
    assert!(log.contains("KFD GPU 0: gfx1036"), "{log}");
    assert!(log.contains("KFD GPU 1: gfx1100"), "{log}");
}

/// The card ROCm supports wins even when an unsupported one is larger.
#[test]
fn a_supported_gpu_beats_a_larger_unsupported_one() {
    let root = fake_amd_root(
        &[
            &kfd_gpu(100301, 80, 0x73df, SECOND_RENDER_MINOR),
            KFD_CPU,
            &kfd_gpu(110002, 64, 0x7480, RENDER_MINOR),
        ],
        true,
    );
    let data = make_tmp();
    let gpu = detect(root.path(), data.path()).expect("found");
    assert_eq!(gpu.name, "AMD GPU (gfx1102)");
    // The CPU node between them is not counted: GPU 1 of 0 and 1.
    assert_eq!(visible_devices(root.path()).as_deref(), Some("1"));
}

#[test]
fn of_two_supported_gpus_the_larger_is_chosen_then_the_first() {
    let gpu = |ordinal: usize, simd_count: u32| KfdGpu {
        ordinal,
        gfx: "gfx1100".to_string(),
        simd_count,
        device_id: 0,
        render_minor: RENDER_MINOR,
    };
    assert_eq!(
        choose(&[gpu(0, 96), gpu(1, 192)]).map(|g| g.ordinal),
        Some(1)
    );
    assert_eq!(
        choose(&[gpu(0, 192), gpu(1, 192)]).map(|g| g.ordinal),
        Some(0)
    );
    assert_eq!(choose(&[]), None);
}

#[test]
fn an_amd_gpu_without_rocm_kernels_is_not_offered_the_download() {
    // An RX 6600 (gfx1032): no kernels in the official build, so it would
    // download several GB only to fail verification.
    let root = fake_amd_root(
        &[KFD_CPU, &kfd_gpu(100302, 56, RX_6600, RENDER_MINOR)],
        true,
    );
    let data = make_tmp();

    let gpu = detect(root.path(), data.path()).expect("found");
    assert!(gpu.candidates.is_empty());
    assert_eq!(gpu.unusable, Some(REASON_UNSUPPORTED));
    assert_eq!(visible_devices(root.path()), None);
    let log = setup_log(&data);
    assert!(
        log.contains("no ROCm build StemDeck installs has kernels for gfx1032"),
        "{log}"
    );
}

#[test]
fn no_access_to_dev_kfd_is_named_with_its_fix() {
    let root = fake_amd_root(
        &[KFD_CPU, &kfd_gpu(110000, 192, RX_7900, RENDER_MINOR)],
        false,
    );
    let data = make_tmp();

    let gpu = detect(root.path(), data.path()).expect("found");
    assert_eq!(gpu.unusable, Some(REASON_NO_KFD_ACCESS));
    // Still a supported card: the download is offered once access is fixed.
    assert_eq!(gpu.candidates, vec![ROCM_TAG]);
    let log = setup_log(&data);
    assert!(log.contains("cannot open /dev/kfd"), "{log}");
    assert!(log.contains("sudo usermod -aG render,video $USER"), "{log}");
}

#[test]
fn no_access_to_the_render_node_is_no_access() {
    let root = fake_amd_root(
        &[
            KFD_CPU,
            &kfd_gpu(110000, 192, RX_7900, MISSING_RENDER_MINOR),
        ],
        true,
    );
    let data = make_tmp();
    let gpu = detect(root.path(), data.path()).expect("found");
    assert_eq!(gpu.unusable, Some(REASON_NO_KFD_ACCESS));
}

#[test]
fn no_kfd_topology_is_no_amd_gpu() {
    let data = make_tmp();
    assert!(detect(make_tmp().path(), data.path()).is_none());
    // A CPU node only: an amdgpu driver with no GPU bound to it.
    let root = fake_amd_root(&[KFD_CPU], true);
    assert!(detect(root.path(), data.path()).is_none());
    assert_eq!(visible_devices(root.path()), None);
}

/// The owner's machine: a Hawk Point iGPU (gfx1103, PCI 1002:1900) as KFD
/// node 1 behind the CPU node, beside an NVIDIA RTX 5050.
const HAWK_POINT_IGPU: u32 = 0x1900;
const HAWK_POINT_GFX: u32 = 110003;
const HAWK_POINT_SIMDS: u32 = 24;

fn hawk_point_root() -> TempDir {
    fake_amd_root(
        &[
            KFD_CPU,
            &kfd_gpu(
                HAWK_POINT_GFX,
                HAWK_POINT_SIMDS,
                HAWK_POINT_IGPU,
                RENDER_MINOR,
            ),
        ],
        true,
    )
}

#[test]
fn a_hawk_point_igpu_alone_is_unsupported_and_not_offered_rocm() {
    let root = hawk_point_root();
    let data = make_tmp();
    let gpu = detect(root.path(), data.path()).expect("found");
    assert_eq!(gpu.name, "AMD GPU (gfx1103)");
    assert!(gpu.candidates.is_empty());
    assert_eq!(gpu.unusable, Some(REASON_UNSUPPORTED));
}

/// With the NVIDIA card present the iGPU is never looked at, and the backend
/// is given no ROCR_VISIBLE_DEVICES, so the CUDA path sees what it always did.
#[test]
fn the_owners_nvidia_card_wins_and_the_hawk_point_igpu_is_left_alone() {
    let root = hawk_point_root();
    let data = make_tmp();
    let nvidia = Some((
        "NVIDIA GeForce RTX 5050".to_string(),
        "13.0".to_string(),
        Some("12.0".to_string()),
    ));
    let amd_lookups = std::cell::Cell::new(0);
    let gpu = crate::detect_gpu(nvidia, || {
        amd_lookups.set(amd_lookups.get() + 1);
        detect(root.path(), data.path())
    })
    .expect("found");
    assert_eq!(amd_lookups.get(), 0);
    assert_eq!(gpu.backend, crate::GPU_BACKEND_CUDA);
    assert_eq!(gpu.candidates, vec!["cu128"]);
    assert_eq!(visible_devices_to_set(root.path(), |_| false), None);
}

#[test]
fn a_gpu_choice_the_user_made_in_the_environment_wins() {
    let root = fake_amd_root(
        &[KFD_CPU, &kfd_gpu(110000, 192, RX_7900, RENDER_MINOR)],
        true,
    );
    assert_eq!(
        visible_devices_to_set(root.path(), |_| false).as_deref(),
        Some("0")
    );
    for var in VISIBLE_DEVICE_VARS {
        assert_eq!(
            visible_devices_to_set(root.path(), |name| name == var),
            None,
            "{var}"
        );
    }
}
