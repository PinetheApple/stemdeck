"""Which of this machine's addresses another device on the LAN can open.

Settings > Network turns every address into a QR code for a phone, so an
address the phone cannot reach is worse than none: it looks right and fails.
A container bridge on 172.17.0.1 and a real LAN on 172.20.5.10 share a private
range, so the address alone cannot tell them apart; the interface it sits on can.

An address is left out when its interface is not up and running, when it is a
Linux bridge with no hardware anywhere behind it (docker0, br-*, virbr0 and
cni0 all look like this in sysfs), or when its name belongs to a container or
VM host network. The name list is the fallback for macOS, which has no sysfs.
VPN interfaces (tailscale0, wg0, utun3, tun0, any WireGuard device) stay listed, since a phone on the
same VPN reaches them, but are marked as VPN so the phone's owner knows which
address needs the VPN on. Tailscale's 100.64.0.0/10 range counts as VPN even
where no interface could be read.

Everything here is best-effort and standard-library only. Interfaces are read
with the SIOCGIF* ioctls, which Linux and macOS both have; on Windows, or when
a query fails, no interface is read and every address is kept as before.
"""

from __future__ import annotations

import ipaddress
import logging
import re
import socket
import struct
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import NamedTuple, TypedDict

_log = logging.getLogger("stemdeck.network")

SYSFS_NET = Path("/sys/class/net")
# lower_* hops followed below a bridge: bridge -> bond -> VLAN -> NIC is three.
MAX_LOWER_DEPTH = 3


class IoctlRequests(NamedTuple):
    get_addr: int  # SIOCGIFADDR
    get_flags: int  # SIOCGIFFLAGS


# Absent platform means no ioctl to ask.
_IOCTL_REQUESTS: dict[str, IoctlRequests] = {
    "linux": IoctlRequests(get_addr=0x8915, get_flags=0x8913),
    "darwin": IoctlRequests(get_addr=0xC0206921, get_flags=0xC0206911),
}
# Linux's struct ifreq is 40 bytes and macOS's 32; the larger buffer serves both.
_IFREQ_FORMAT = "40s"
_IFNAME_MAX = 15
_IFR_FLAGS_OFFSET = 16
_IFR_FLAGS_FORMAT = "H"  # ifr_flags, a native-endian short
_IFR_IPV4_SLICE = slice(20, 24)
_IFF_UP = 0x1
_IFF_RUNNING = 0x40
_IFF_UP_AND_RUNNING = _IFF_UP | _IFF_RUNNING

_HOST_ONLY_NAME = re.compile(
    r"^(docker|br-|veth|virbr|cni|flannel|cali|podman|vboxnet|vmnet|bridge1\d\d)"
)

_VPN_NAME = re.compile(r"^(tailscale\d*|wg[\w.-]*|utun\d+|tun\d+)$")
_WIREGUARD_UEVENT_LINE = "DEVTYPE=wireguard"
_CGNAT_NETWORK = ipaddress.IPv4Network("100.64.0.0/10")

KIND_LAN = "lan"
KIND_VPN = "vpn"
KIND_PUBLIC = "public"


class NetworkAddress(TypedDict):
    url: str
    kind: str


@dataclass(frozen=True)
class NetInterface:
    name: str
    ipv4: str
    running: bool
    unbacked_bridge: bool = False
    wireguard: bool = False


def unreachable_ipv4s(interfaces: Iterable[NetInterface]) -> frozenset[str]:
    """The addresses that sit on an interface no other device can reach."""
    return frozenset(iface.ipv4 for iface in interfaces if _is_unreachable(iface))


def vpn_ipv4s(interfaces: Iterable[NetInterface]) -> frozenset[str]:
    """The addresses that sit on a VPN interface, judged by its name or sysfs type."""
    return frozenset(
        iface.ipv4 for iface in interfaces if iface.wireguard or _VPN_NAME.match(iface.name)
    )


def address_kind(ipv4: str, vpn_addresses: frozenset[str]) -> str:
    """KIND_VPN for an address on a VPN interface or in the CGNAT range, else KIND_LAN."""
    if ipv4 in vpn_addresses or ipaddress.IPv4Address(ipv4) in _CGNAT_NETWORK:
        return KIND_VPN
    return KIND_LAN


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
    requests: IoctlRequests,
) -> NetInterface | None:
    try:
        addr = _ioctl(sock, requests.get_addr, name)
        flags = _ioctl(sock, requests.get_flags, name)
    except OSError:
        return None  # no IPv4 address, or the interface vanished mid-read
    (flag_bits,) = struct.unpack_from(_IFR_FLAGS_FORMAT, flags, _IFR_FLAGS_OFFSET)
    return NetInterface(
        name=name,
        ipv4=socket.inet_ntoa(addr[_IFR_IPV4_SLICE]),
        running=flag_bits & _IFF_UP_AND_RUNNING == _IFF_UP_AND_RUNNING,
        unbacked_bridge=is_unbacked_bridge(name, SYSFS_NET),
        wireguard=is_wireguard(name, SYSFS_NET),
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


def is_wireguard(name: str, sysfs_root: Path) -> bool:
    """A WireGuard interface by its kernel type, whatever wg-quick named it."""
    try:
        uevent = (sysfs_root / name / "uevent").read_text()
    except OSError:
        return False
    return _WIREGUARD_UEVENT_LINE in uevent.splitlines()
