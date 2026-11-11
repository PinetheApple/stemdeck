"""Settings > Network lists only addresses another device on the LAN can open.

The address list is judged by the interface each address sits on, never by its
range: a container bridge on 172.17.0.1 and a real LAN on 172.20.5.10 share a
private range, and only the interface tells them apart.
"""

from __future__ import annotations

import errno
import socket
import struct
from pathlib import Path

import httpx
import pytest

import app.main as main
from app.core import lan_interfaces, tls_listener
from app.core.lan_interfaces import NetInterface

UP_AND_RUNNING = 0x1043  # UP | BROADCAST | RUNNING | MULTICAST
UP_NOT_RUNNING = 0x1003
RUNNING_NOT_UP = 0x1042
# Bytes beside each field, so reading one offset off returns something else.
PORT_NOISE = b"\x1f\x90"
FLAGS_NOISE = b"\x5a\x5a"
TAIL_NOISE = b"\xaa"
SOCKADDR_FAMILY = {"linux": b"\x02\x00", "darwin": b"\x10\x02"}
FAKE_HOST = {
    "lo2": (None, UP_AND_RUNNING),
    "wlan0": ("192.168.1.20", UP_AND_RUNNING),
    "ctr0": ("172.17.0.1", UP_AND_RUNNING),
    "eth1": ("10.0.0.5", UP_NOT_RUNNING),
    "eth2": ("10.0.0.6", RUNNING_NOT_UP),
}


async def _listed(monkeypatch, local_ips: set[str], interfaces: list[NetInterface]) -> list[str]:
    monkeypatch.setattr(lan_interfaces, "read_interfaces", lambda: interfaces)
    return await _settings_addresses(monkeypatch, local_ips)


async def _settings_addresses(monkeypatch, local_ips: set[str]) -> list[str]:
    monkeypatch.setattr(main, "_local_ips", lambda: frozenset(local_ips))
    monkeypatch.setattr(tls_listener, "_active_port", None)
    monkeypatch.setattr(main, "SSL_CERTFILE", None)
    monkeypatch.setattr(main, "SSL_KEYFILE", None)
    transport = httpx.ASGITransport(app=main.app, client=("127.0.0.1", 5000))
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        return (await c.get("/api/settings")).json()["lan_addresses"]


def _fake_host(monkeypatch, tmp_path: Path, platform: str) -> None:
    """Answer the interface ioctls from FAKE_HOST, laid out as the kernel would."""
    fcntl = pytest.importorskip("fcntl")
    requests = lan_interfaces._IOCTL_REQUESTS[platform]

    def fake_ioctl(fd: int, request: int, arg: bytes) -> bytes:
        name = arg[:16].rstrip(b"\0").decode()
        ipv4, flags = FAKE_HOST[name]
        if request == requests.get_addr and ipv4 is not None:
            payload = SOCKADDR_FAMILY[platform] + PORT_NOISE + socket.inet_aton(ipv4)
        elif request == requests.get_flags:
            payload = struct.pack("H", flags) + FLAGS_NOISE
        else:
            raise OSError(errno.EADDRNOTAVAIL, "no address")
        return (arg[:16] + payload).ljust(len(arg), TAIL_NOISE)

    monkeypatch.setattr(lan_interfaces.sys, "platform", platform)
    monkeypatch.setattr(fcntl, "ioctl", fake_ioctl)
    monkeypatch.setattr(
        lan_interfaces.socket,
        "if_nameindex",
        lambda: list(enumerate(FAKE_HOST, start=1)),
    )
    monkeypatch.setattr(lan_interfaces, "SYSFS_NET", _fake_sysfs(tmp_path))


async def test_a_container_bridge_is_hidden_next_to_wifi(monkeypatch, tmp_path: Path) -> None:
    _fake_host(monkeypatch, tmp_path, "linux")
    listed = await _settings_addresses(monkeypatch, {"172.17.0.1", "192.168.1.20"})
    assert listed == ["http://192.168.1.20:8000"]


@pytest.mark.parametrize("platform", ["linux", "darwin"])
def test_each_interface_address_is_read_from_the_ifreq(
    monkeypatch,
    tmp_path: Path,
    platform: str,
) -> None:
    _fake_host(monkeypatch, tmp_path, platform)
    read = {iface.name: iface.ipv4 for iface in lan_interfaces.read_interfaces()}
    assert read == {
        "wlan0": "192.168.1.20",
        "ctr0": "172.17.0.1",
        "eth1": "10.0.0.5",
        "eth2": "10.0.0.6",
    }


def test_running_needs_both_the_up_and_running_flags(monkeypatch, tmp_path: Path) -> None:
    _fake_host(monkeypatch, tmp_path, "linux")
    read = {iface.name: iface.running for iface in lan_interfaces.read_interfaces()}
    assert read == {"wlan0": True, "ctr0": True, "eth1": False, "eth2": False}


def test_a_bridge_without_hardware_is_read_as_unbacked(monkeypatch, tmp_path: Path) -> None:
    _fake_host(monkeypatch, tmp_path, "linux")
    read = {iface.name: iface.unbacked_bridge for iface in lan_interfaces.read_interfaces()}
    assert read == {"wlan0": False, "ctr0": True, "eth1": False, "eth2": False}


async def test_a_physical_lan_in_the_172_16_range_still_shows(monkeypatch) -> None:
    listed = await _listed(
        monkeypatch,
        {"172.20.5.10"},
        [NetInterface(name="eth0", ipv4="172.20.5.10", running=True)],
    )
    assert listed == ["http://172.20.5.10:8000"]


@pytest.mark.parametrize("name", ["br-d6d656299007", "veth1a2b3c", "virbr0"])
async def test_container_and_vm_interfaces_are_hidden(monkeypatch, name: str) -> None:
    listed = await _listed(
        monkeypatch,
        {"10.10.0.1"},
        [NetInterface(name=name, ipv4="10.10.0.1", running=True)],
    )
    assert listed == []


async def test_a_bridge_with_no_hardware_behind_it_is_hidden(monkeypatch) -> None:
    listed = await _listed(
        monkeypatch,
        {"10.88.0.1"},
        [NetInterface(name="lan-sim", ipv4="10.88.0.1", running=True, unbacked_bridge=True)],
    )
    assert listed == []


async def test_an_interface_that_is_down_is_hidden(monkeypatch) -> None:
    listed = await _listed(
        monkeypatch,
        {"192.168.1.20"},
        [NetInterface(name="eth0", ipv4="192.168.1.20", running=False)],
    )
    assert listed == []


async def test_a_vpn_interface_stays_listed(monkeypatch) -> None:
    listed = await _listed(
        monkeypatch,
        {"100.68.238.69"},
        [NetInterface(name="tailscale0", ipv4="100.68.238.69", running=True)],
    )
    assert listed == ["http://100.68.238.69:8000"]


async def test_without_an_interface_table_every_address_is_kept(monkeypatch) -> None:
    listed = await _listed(monkeypatch, {"192.168.1.20", "172.17.0.1"}, [])
    assert listed == ["http://172.17.0.1:8000", "http://192.168.1.20:8000"]


def test_a_platform_without_ioctl_reads_no_interfaces(monkeypatch) -> None:
    monkeypatch.setattr(lan_interfaces, "_IOCTL_REQUESTS", {})
    assert lan_interfaces.read_interfaces() == []


def test_a_failing_interface_query_reads_no_interfaces(monkeypatch) -> None:
    def refuse() -> list[tuple[int, str]]:
        raise OSError("no interface table")

    monkeypatch.setattr(lan_interfaces.socket, "if_nameindex", refuse)
    assert lan_interfaces.read_interfaces() == []


def _fake_sysfs(root: Path) -> Path:
    """Bridges with and without hardware, one reaching its NIC through a bond and a VLAN."""
    for nic in ("wlan0", "eth1", "eth2", "enp4s0", "enp1s0"):
        (root / nic / "device").mkdir(parents=True)
    for bridge in ("ctr0", "br0", "br-empty", "lanbr"):
        (root / bridge / "bridge").mkdir(parents=True)
    for name in ("veth9", "bond0", "vlan10"):
        (root / name).mkdir()
    for upper, lower in (
        ("ctr0", "veth9"),
        ("br0", "enp4s0"),
        ("lanbr", "bond0"),
        ("bond0", "vlan10"),
        ("vlan10", "enp1s0"),
    ):
        (root / upper / f"lower_{lower}").symlink_to(f"../{lower}")
    return root


@pytest.mark.parametrize(
    "name,unbacked",
    [
        ("ctr0", True),
        ("br-empty", True),
        ("br0", False),
        ("lanbr", False),
        ("enp4s0", False),
        ("veth9", False),
    ],
)
def test_a_bridge_counts_as_lan_only_with_hardware_behind_it(
    tmp_path: Path,
    name: str,
    unbacked: bool,
) -> None:
    sysfs = _fake_sysfs(tmp_path)
    assert lan_interfaces.is_unbacked_bridge(name, sysfs) is unbacked


def test_a_missing_sysfs_reads_as_not_a_bridge(tmp_path: Path) -> None:
    assert lan_interfaces.is_unbacked_bridge("en0", tmp_path / "absent") is False
