"""Which of this machine's addresses another device on the LAN can open.

Settings > Network turns every address into a QR code for a phone, so an
address the phone cannot reach is worse than none: it looks right and fails.
The classic offender is a container bridge (docker0 on 172.17.0.1), which
shares a private range with plenty of real LANs -- 172.16.0.0/12 is a common
office and router range -- so the address alone cannot tell them apart. The
interface it sits on can.

An address is left out when its interface is not up and running, when it is a
Linux bridge with no hardware anywhere behind it (docker0, br-*, virbr0 and
cni0 all look like this in sysfs), or when its name belongs to a container or
VM host network. The name list is the fallback for macOS, which has no sysfs.
VPN interfaces (tailscale0, wg0, utun*) stay listed: a phone on the same VPN
reaches them.

Everything here is best-effort and standard-library only. Interfaces are read
with the SIOCGIF* ioctls, which Linux and macOS both have; on Windows, or when
a query fails, no interface is read and every address is kept as before.
"""

from __future__ import annotations

import logging
import re
import socket
import struct
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

_log = logging.getLogger("stemdeck.network")

SYSFS_NET = Path("/sys/class/net")
# A bridge over a bond over a VLAN is three hops down to the NIC.
MAX_LOWER_DEPTH = 4

# (SIOCGIFADDR, SIOCGIFFLAGS) per platform; absent means no ioctl to ask.
_IOCTL_REQUESTS: dict[str, tuple[int, int]] = {
    "linux": (0x8915, 0x8913),
    "darwin": (0xC0206921, 0xC0206911),
}
# Linux's struct ifreq is 40 bytes and macOS's 32; the larger buffer serves both.
_IFREQ_FORMAT = "40s"
_IFNAME_MAX = 15
_IFR_FLAGS_OFFSET = 16
_IFR_IPV4_SLICE = slice(20, 24)
_IFF_UP = 0x1
_IFF_RUNNING = 0x40

_HOST_ONLY_NAME = re.compile(
    r"^(docker|br-|veth|virbr|cni|flannel|cali|podman|vboxnet|vmnet|bridge1\d\d)"
)


@dataclass(frozen=True)
class NetInterface:
    name: str
    ipv4: str
    running: bool
    unbacked_bridge: bool = False


def unreachable_ipv4s(interfaces: Iterable[NetInterface]) -> frozenset[str]:
    """The addresses that sit on an interface no other device can reach."""
    return frozenset(iface.ipv4 for iface in interfaces if _is_unreachable(iface))


def _is_unreachable(iface: NetInterface) -> bool:
    return (
        not iface.running or iface.unbacked_bridge or _HOST_ONLY_NAME.match(iface.name) is not None
    )


def read_interfaces() -> list[NetInterface]:
    """Every interface with an IPv4 address, or [] where the platform cannot say."""
    requests = _IOCTL_REQUESTS.get(sys.platform)
    if requests is None:
        return []
    try:
        names = [name for _, name in socket.if_nameindex()]
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            found = [_read_interface(sock, name, requests) for name in names]
    except OSError:
        _log.debug("interface enumeration failed", exc_info=True)
        return []
    return [iface for iface in found if iface is not None]


def _read_interface(
    sock: socket.socket,
    name: str,
    requests: tuple[int, int],
) -> NetInterface | None:
    addr_request, flags_request = requests
    try:
        addr = _ioctl(sock, addr_request, name)
        flags = _ioctl(sock, flags_request, name)
    except OSError:
        return None  # no IPv4 address, or the interface vanished mid-read
    (flag_bits,) = struct.unpack_from("H", flags, _IFR_FLAGS_OFFSET)
    running_bits = _IFF_UP | _IFF_RUNNING
    return NetInterface(
        name=name,
        ipv4=socket.inet_ntoa(addr[_IFR_IPV4_SLICE]),
        running=flag_bits & running_bits == running_bits,
        unbacked_bridge=is_unbacked_bridge(name, SYSFS_NET),
    )


def _ioctl(sock: socket.socket, request: int, name: str) -> bytes:
    import fcntl

    ifreq = struct.pack(_IFREQ_FORMAT, name.encode()[:_IFNAME_MAX])
    return fcntl.ioctl(sock.fileno(), request, ifreq)


def is_unbacked_bridge(name: str, sysfs_root: Path) -> bool:
    """A Linux bridge with no physical device behind it, however deeply nested."""
    iface = sysfs_root / name
    return (iface / "bridge").is_dir() and not _has_hardware(iface, MAX_LOWER_DEPTH)


def _has_hardware(iface: Path, depth: int) -> bool:
    if (iface / "device").exists():
        return True
    if depth == 0:
        return False
    return any(_has_hardware(lower, depth - 1) for lower in iface.glob("lower_*"))
