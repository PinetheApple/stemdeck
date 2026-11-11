"""Settings > Network lists only addresses another device on the LAN can open.

The address list is judged by the interface each address sits on, never by its
range: a container bridge on 172.17.0.1 and a real LAN on 172.20.5.10 share a
private range, and only the interface tells them apart.
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

import app.main as main
from app.core import lan_interfaces, tls_listener
from app.core.lan_interfaces import NetInterface


async def _listed(monkeypatch, local_ips: set[str], interfaces: list[NetInterface]) -> list[str]:
    monkeypatch.setattr(main, "_local_ips", lambda: frozenset(local_ips))
    monkeypatch.setattr(lan_interfaces, "read_interfaces", lambda: interfaces)
    monkeypatch.setattr(tls_listener, "_active_port", None)
    monkeypatch.setattr(main, "SSL_CERTFILE", None)
    monkeypatch.setattr(main, "SSL_KEYFILE", None)
    transport = httpx.ASGITransport(app=main.app, client=("127.0.0.1", 5000))
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        return (await c.get("/api/settings")).json()["lan_addresses"]


async def test_a_container_bridge_is_hidden_next_to_wifi(monkeypatch) -> None:
    listed = await _listed(
        monkeypatch,
        {"172.17.0.1", "192.168.1.20"},
        [
            NetInterface(name="docker0", ipv4="172.17.0.1", running=True),
            NetInterface(name="wlan0", ipv4="192.168.1.20", running=True),
        ],
    )
    assert listed == ["http://192.168.1.20:8000"]


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
    for name in ("docker0", "veth9", "br0", "enp4s0", "br-empty"):
        (root / name).mkdir()
    for bridge in ("docker0", "br0", "br-empty"):
        (root / bridge / "bridge").mkdir()
    (root / "enp4s0" / "device").mkdir()
    (root / "docker0" / "lower_veth9").symlink_to("../veth9")
    (root / "br0" / "lower_enp4s0").symlink_to("../enp4s0")
    return root


@pytest.mark.parametrize(
    "name,unbacked",
    [
        ("docker0", True),
        ("br-empty", True),
        ("br0", False),
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
