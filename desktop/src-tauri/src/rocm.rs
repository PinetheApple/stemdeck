//! Finding an AMD GPU the ROCm build of torch can drive, on Linux, through the
//! amdgpu driver's KFD topology read relative to a root path.

use std::fs;
use std::path::Path;
#[cfg(target_os = "linux")]
use std::process::Command;

use crate::{append_to_setup_log, DetectedGpu, ROCM_TAG, ROCM_VERSION};

pub const BACKEND: &str = crate::GPU_BACKEND_ROCM;
/// A card no ROCm build StemDeck installs has kernels for.
pub const REASON_UNSUPPORTED: &str = crate::REASON_ROCM_UNSUPPORTED;
/// The card is supported but this user cannot open /dev/kfd or its render
/// node. Not settled: fixing the groups gets the GPU on the next launch.
pub const REASON_NO_KFD_ACCESS: &str = "rocm-no-kfd-access";

/// What `torch.cuda.get_arch_list()` reports on torch 2.8.0+rocm6.4. A card
/// outside it would download several GB only to fail verification.
const GFX_TARGETS: &[&str] = &[
    "gfx900", "gfx906", "gfx908", "gfx90a", "gfx942", "gfx1030", "gfx1100", "gfx1101", "gfx1102",
    "gfx1200", "gfx1201",
];

/// Where the amdgpu driver lists its KFD topology, relative to the root.
pub const KFD_NODES: &str = "sys/class/kfd/kfd/topology/nodes";
const KFD_DEVICE: &str = "dev/kfd";
const KFD_PROPERTIES: &str = "properties";
const KFD_GFX_TARGET_VERSION: &str = "gfx_target_version";
const KFD_SIMD_COUNT: &str = "simd_count";
const KFD_DEVICE_ID: &str = "device_id";
const KFD_RENDER_MINOR: &str = "drm_render_minor";
const RENDER_NODES: &str = "dev/dri";
const DRM_CLASS: &str = "sys/class/drm";
const RENDER_NODE_PREFIX: &str = "renderD";
const DRM_DEVICE: &str = "device";
const DRM_PRODUCT_NAME: &str = "product_name";
const PCI_IDS: [&str; 2] = ["usr/share/hwdata/pci.ids", "usr/share/misc/pci.ids"];
const AMD_PCI_VENDOR: &str = "1002 ";

const ROCR_VISIBLE_DEVICES: &str = "ROCR_VISIBLE_DEVICES";
pub const VISIBLE_DEVICE_VARS: [&str; 3] = [
    ROCR_VISIBLE_DEVICES,
    "HIP_VISIBLE_DEVICES",
    "CUDA_VISIBLE_DEVICES",
];
const GROUP_FIX: &str = "sudo usermod -aG render,video $USER";

/// One GPU node of the KFD topology.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KfdGpu {
    pub ordinal: usize,
    pub gfx: String,
    pub simd_count: u32,
    pub device_id: u32,
    pub render_minor: u32,
}

impl KfdGpu {
    fn has_rocm_kernels(&self) -> bool {
        GFX_TARGETS.contains(&self.gfx.as_str())
    }
}

/// The gfx target for a KFD `gfx_target_version`: major * 10000 + minor * 100
/// + stepping, with minor and stepping hex digits in the name (90010 is gfx90a).
pub fn gfx_target_name(version: u32) -> String {
    format!(
        "gfx{}{:x}{:x}",
        version / 10000,
        (version / 100) % 100,
        version % 100
    )
}

fn kfd_field(properties: &str, key: &str) -> Option<u32> {
    properties.lines().find_map(|line| {
        let (k, v) = line.split_once(' ')?;
        (k == key).then(|| v.trim().parse().ok()).flatten()
    })
}

/// One node's `properties` file, as a GPU. None for a CPU node, whose
/// gfx_target_version is 0. `ordinal` is filled in by the caller.
pub fn parse_kfd_node(properties: &str) -> Option<KfdGpu> {
    let gfx = kfd_field(properties, KFD_GFX_TARGET_VERSION).filter(|v| *v != 0)?;
    let field = |key| kfd_field(properties, key).unwrap_or(0);
    Some(KfdGpu {
        ordinal: 0,
        gfx: gfx_target_name(gfx),
        simd_count: field(KFD_SIMD_COUNT),
        device_id: field(KFD_DEVICE_ID),
        render_minor: field(KFD_RENDER_MINOR),
    })
}

/// Every GPU node under `root`, in node order. read_dir order is arbitrary,
/// so node directories are sorted as numbers: node 10 comes after node 9.
pub fn kfd_gpus(root: &Path) -> Vec<KfdGpu> {
    let Ok(entries) = fs::read_dir(root.join(KFD_NODES)) else {
        return Vec::new();
    };
    let mut nodes: Vec<(u32, String)> = entries
        .flatten()
        .filter_map(|entry| {
            let node = entry.file_name().to_str()?.parse().ok()?;
            let properties = fs::read_to_string(entry.path().join(KFD_PROPERTIES)).ok()?;
            Some((node, properties))
        })
        .collect();
    nodes.sort_by_key(|(node, _)| *node);
    nodes
        .iter()
        .filter_map(|(_, properties)| parse_kfd_node(properties))
        .enumerate()
        .map(|(ordinal, gpu)| KfdGpu { ordinal, ..gpu })
        .collect()
}

/// Supported before unsupported, then most SIMDs: a Ryzen's integrated GPU is
/// often listed first and has no kernels, which left the discrete card unused.
pub fn choose(gpus: &[KfdGpu]) -> Option<&KfdGpu> {
    gpus.iter().max_by_key(|gpu| {
        (
            gpu.has_rocm_kernels(),
            gpu.simd_count,
            std::cmp::Reverse(gpu.ordinal),
        )
    })
}

pub fn visible_devices(root: &Path) -> Option<String> {
    choose(&kfd_gpus(root))
        .filter(|gpu| gpu.has_rocm_kernels())
        .map(|gpu| gpu.ordinal.to_string())
}

// Adding ours on top of a user's own choice would renumber the devices under it.
pub fn visible_devices_to_set(root: &Path, user_set: impl Fn(&str) -> bool) -> Option<String> {
    if VISIBLE_DEVICE_VARS.into_iter().any(user_set) {
        None
    } else {
        visible_devices(root)
    }
}

#[cfg(target_os = "linux")]
pub fn show_chosen_gpu(command: &mut Command) {
    let user_set = |name: &str| std::env::var_os(name).is_some();
    if let Some(devices) = visible_devices_to_set(Path::new("/"), user_set) {
        command.env(ROCR_VISIBLE_DEVICES, devices);
    }
}

pub fn pci_ids_amd_name(pci_ids: &str, device_id: u32) -> Option<String> {
    let wanted = format!("{device_id:04x}");
    let mut in_amd = false;
    for line in pci_ids.lines() {
        // Comments sit inside vendor sections and must not end one.
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if !line.starts_with('\t') {
            in_amd = line.starts_with(AMD_PCI_VENDOR);
            continue;
        }
        if !in_amd || line.starts_with("\t\t") {
            continue;
        }
        if let Some(name) = line.trim_start_matches('\t').strip_prefix(wanted.as_str()) {
            return Some(bracketed_product(name.trim()).to_string());
        }
    }
    None
}

fn bracketed_product(name: &str) -> &str {
    match (name.find('['), name.rfind(']')) {
        (Some(open), Some(close)) if open < close => &name[open + 1..close],
        _ => name,
    }
}

fn gpu_name(root: &Path, gpu: &KfdGpu) -> String {
    let device = root
        .join(DRM_CLASS)
        .join(format!("{RENDER_NODE_PREFIX}{}", gpu.render_minor))
        .join(DRM_DEVICE);
    fs::read_to_string(device.join(DRM_PRODUCT_NAME))
        .ok()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .or_else(|| {
            PCI_IDS.iter().find_map(|ids| {
                pci_ids_amd_name(&fs::read_to_string(root.join(ids)).ok()?, gpu.device_id)
            })
        })
        .map_or_else(
            || format!("AMD GPU ({})", gpu.gfx),
            |product| format!("AMD {product} ({})", gpu.gfx),
        )
}

fn can_open_rw(path: &Path) -> bool {
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .is_ok()
}

/// The runtime reaches the GPU through /dev/kfd and the card's render node,
/// which most distributions give to the render group.
fn has_device_access(root: &Path, gpu: &KfdGpu) -> bool {
    let render_node = format!("{RENDER_NODE_PREFIX}{}", gpu.render_minor);
    can_open_rw(&root.join(KFD_DEVICE)) && can_open_rw(&root.join(RENDER_NODES).join(render_node))
}

/// Why the chosen GPU cannot be used, said once in setup.log; None when it can.
fn unusable_reason(root: &Path, gpu: &KfdGpu, data_dir: &Path) -> Option<&'static str> {
    if !gpu.has_rocm_kernels() {
        let msg = format!(
            "no ROCm build StemDeck installs has kernels for {}; staying on CPU",
            gpu.gfx
        );
        append_to_setup_log(data_dir, &msg);
        return Some(REASON_UNSUPPORTED);
    }
    if !has_device_access(root, gpu) {
        let msg = format!(
            "cannot open /{KFD_DEVICE} or the GPU's render node; add your user to the render \
             and video groups ({GROUP_FIX}) and log in again"
        );
        append_to_setup_log(data_dir, &msg);
        return Some(REASON_NO_KFD_ACCESS);
    }
    None
}

fn log_nodes(gpus: &[KfdGpu], data_dir: &Path) {
    for gpu in gpus {
        let msg = format!(
            "KFD GPU {}: {}, {} SIMDs, PCI device {:04x}, {RENDER_NODE_PREFIX}{}",
            gpu.ordinal, gpu.gfx, gpu.simd_count, gpu.device_id, gpu.render_minor
        );
        append_to_setup_log(data_dir, &msg);
    }
}

/// The AMD GPU under `root` setup should use, with the ROCm candidate when the
/// build has kernels for it, and why it cannot be used when it cannot.
pub fn detect(root: &Path, data_dir: &Path) -> Option<DetectedGpu> {
    let gpus = kfd_gpus(root);
    log_nodes(&gpus, data_dir);
    let gpu = choose(&gpus)?;
    let name = gpu_name(root, gpu);
    let msg = format!(
        "AMD GPU chosen: {name}, KFD GPU {ordinal}; torch processes get \
         {ROCR_VISIBLE_DEVICES}={ordinal} unless one of {user_vars} is set",
        ordinal = gpu.ordinal,
        user_vars = VISIBLE_DEVICE_VARS.join(", ")
    );
    append_to_setup_log(data_dir, &msg);
    let candidates = if gpu.has_rocm_kernels() {
        vec![ROCM_TAG]
    } else {
        Vec::new()
    };
    Some(DetectedGpu {
        name,
        backend: BACKEND,
        version: ROCM_VERSION.to_string(),
        candidates,
        unusable: unusable_reason(root, gpu, data_dir),
    })
}

#[cfg(test)]
mod tests;
