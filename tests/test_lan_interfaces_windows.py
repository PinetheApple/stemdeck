"""Settings > Network on Windows lists only adapters another device on the LAN can open.

Windows has no SIOCGIF* ioctls and no sysfs, so its adapters are read from
iphlpapi's GetAdaptersAddresses. The records below are what that call reports
on real machines: Hyper-V's vEthernet adapters for WSL and the Default Switch,
VirtualBox and VMware host-only adapters, and the VPN clients people run.
The ctypes call itself only exists on Windows; the layout it is parsed with is
checked here against a hand-built buffer and the documented x64 offsets.
"""

from __future__ import annotations

import ctypes
import socket
from collections.abc import Callable

import pytest

from app.core import lan_interfaces, lan_interfaces_windows
from app.core.lan_interfaces_windows import _IF_OPER_STATUS_UP, _IF_TYPE_PPP, WindowsAdapter
from tests.test_lan_interfaces import _settings

IF_TYPE_ETHERNET = 6
IF_TYPE_WIFI = 71
IF_TYPE_PROP_VIRTUAL = 53
IF_OPER_DOWN = 2
POINTER_BYTES = 8


def _adapter(
    name: str,
    description: str,
    ipv4: str,
    *,
    if_type: int = IF_TYPE_ETHERNET,
    oper_status: int = _IF_OPER_STATUS_UP,
    has_ipv4_gateway: bool = False,
) -> WindowsAdapter:
    return WindowsAdapter(
        friendly_name=name,
        description=description,
        if_type=if_type,
        oper_status=oper_status,
        ipv4s=(ipv4,),
        has_ipv4_gateway=has_ipv4_gateway,
    )


WIFI = _adapter(
    "Wi-Fi",
    "Intel(R) Wi-Fi 6 AX201 160MHz",
    "192.168.1.20",
    if_type=IF_TYPE_WIFI,
    has_ipv4_gateway=True,
)
WINDOWS_HOST = [
    WIFI,
    _adapter(
        "Ethernet",
        "Realtek PCIe GbE Family Controller",
        "10.0.0.5",
        oper_status=IF_OPER_DOWN,
    ),
    _adapter("vEthernet (WSL)", "Hyper-V Virtual Ethernet Adapter", "172.28.48.1"),
    _adapter("vEthernet (Default Switch)", "Hyper-V Virtual Ethernet Adapter #2", "172.20.80.1"),
    _adapter("Ethernet 3", "VirtualBox Host-Only Ethernet Adapter", "192.168.56.1"),
    _adapter(
        "VMware Network Adapter VMnet8",
        "VMware Virtual Ethernet Adapter for VMnet8",
        "192.168.79.1",
    ),
    _adapter("Tailscale", "Tailscale Tunnel", "100.68.238.69", if_type=IF_TYPE_PROP_VIRTUAL),
    _adapter("Office", "Office", "10.200.0.7", if_type=_IF_TYPE_PPP),
]


def _on_windows(monkeypatch, read_adapters: Callable[[], list[WindowsAdapter]]) -> None:
    monkeypatch.setattr(lan_interfaces.sys, "platform", lan_interfaces._WINDOWS_PLATFORM)
    monkeypatch.setattr(lan_interfaces_windows, "read_adapters", read_adapters)


async def test_only_lan_reachable_adapters_are_listed_on_windows(monkeypatch) -> None:
    _on_windows(monkeypatch, lambda: WINDOWS_HOST)
    ips = {address for adapter in WINDOWS_HOST for address in adapter.ipv4s}
    settings = await _settings(monkeypatch, ips)
    assert settings["network_addresses"] == [
        {"url": "http://10.200.0.7:8000", "kind": "vpn"},
        {"url": "http://100.68.238.69:8000", "kind": "vpn"},
        {"url": "http://192.168.1.20:8000", "kind": "lan"},
    ]


@pytest.mark.parametrize("has_ipv4_gateway", [True, False])
async def test_a_hyper_v_external_switch_carries_the_real_lan(
    monkeypatch,
    has_ipv4_gateway: bool,
) -> None:
    external = _adapter(
        "vEthernet (External)",
        "Hyper-V Virtual Ethernet Adapter #3",
        "192.168.1.30",
        has_ipv4_gateway=has_ipv4_gateway,
    )
    _on_windows(monkeypatch, lambda: [external])
    settings = await _settings(monkeypatch, {"192.168.1.30"})
    assert settings["network_addresses"] == [{"url": "http://192.168.1.30:8000", "kind": "lan"}]


@pytest.mark.parametrize(
    "name",
    ["vEthernet (nat)", "vEthernet (WSL (Hyper-V firewall))", "vEthernet (DockerNAT)"],
)
async def test_an_internal_hyper_v_switch_is_hidden(monkeypatch, name: str) -> None:
    internal = _adapter(name, "Hyper-V Virtual Ethernet Adapter #4", "172.30.0.1")
    _on_windows(monkeypatch, lambda: [internal, WIFI])
    settings = await _settings(monkeypatch, {"172.30.0.1", "192.168.1.20"})
    assert settings["lan_addresses"] == ["http://192.168.1.20:8000"]


@pytest.mark.parametrize(
    "name,description,if_type",
    [
        ("home", "WireGuard Tunnel", IF_TYPE_PROP_VIRTUAL),
        ("OpenVPN Wintun", "Wintun Userspace Tunnel", IF_TYPE_PROP_VIRTUAL),
        ("Ethernet 4", "TAP-Windows Adapter V9", IF_TYPE_ETHERNET),
        ("OpenVPN Data Channel Offload", "OpenVPN Data Channel Offload", IF_TYPE_PROP_VIRTUAL),
        ("ZeroTier One [8056c2e21c000001]", "ZeroTier Virtual Port", IF_TYPE_ETHERNET),
        ("Ethernet 5", "Fortinet SSL VPN Virtual Ethernet Adapter", IF_TYPE_ETHERNET),
    ],
)
async def test_a_vpn_adapter_is_marked_vpn_on_windows(
    monkeypatch,
    name: str,
    description: str,
    if_type: int,
) -> None:
    vpn = _adapter(name, description, "10.8.0.2", if_type=if_type)
    _on_windows(monkeypatch, lambda: [vpn, WIFI])
    settings = await _settings(monkeypatch, {"10.8.0.2", "192.168.1.20"})
    assert settings["network_addresses"] == [
        {"url": "http://10.8.0.2:8000", "kind": "vpn"},
        {"url": "http://192.168.1.20:8000", "kind": "lan"},
    ]


async def test_a_failing_adapter_query_keeps_every_address(monkeypatch) -> None:
    def refuse() -> list[WindowsAdapter]:
        raise OSError("iphlpapi unavailable")

    _on_windows(monkeypatch, refuse)
    settings = await _settings(monkeypatch, {"172.28.48.1", "192.168.1.20"})
    assert settings["lan_addresses"] == ["http://172.28.48.1:8000", "http://192.168.1.20:8000"]


def test_without_iphlpapi_no_adapter_is_read() -> None:
    if hasattr(ctypes, "WinDLL"):
        pytest.skip("this machine has iphlpapi")
    assert lan_interfaces_windows.read_interfaces() == []


def test_the_buffer_grows_to_the_size_windows_asks_for() -> None:
    needed = lan_interfaces_windows._INITIAL_BUFFER_BYTES * 2
    sizes: list[int] = []

    def get_adapters_addresses(family, flags, reserved, buffer, size) -> int:
        sizes.append(len(buffer))
        if len(buffer) < needed:
            size.contents.value = needed
            return lan_interfaces_windows._ERROR_BUFFER_OVERFLOW
        return lan_interfaces_windows._ERROR_SUCCESS

    buffer = lan_interfaces_windows.fetch_adapter_buffer(get_adapters_addresses)
    assert sizes == [lan_interfaces_windows._INITIAL_BUFFER_BYTES, needed]
    assert len(buffer) == needed


def test_an_error_from_windows_is_raised_as_oserror() -> None:
    error_no_data = 232
    with pytest.raises(OSError):
        lan_interfaces_windows.fetch_adapter_buffer(lambda *args: error_no_data)


@pytest.mark.skipif(ctypes.sizeof(ctypes.c_void_p) != POINTER_BYTES, reason="x64 layout")
@pytest.mark.parametrize(
    "field,offset",
    [
        ("FirstUnicastAddress", 24),
        ("Description", 64),
        ("FriendlyName", 72),
        ("IfType", 100),
        ("OperStatus", 104),
        ("FirstGatewayAddress", 208),
    ],
)
def test_the_adapter_record_matches_the_x64_layout(field: str, offset: int) -> None:
    assert getattr(lan_interfaces_windows._AdapterAddresses, field).offset == offset


def test_adapters_are_parsed_from_a_hand_built_buffer() -> None:
    keep_alive: list[object] = []

    def address_list(*ips: str):
        head = None
        for ip in reversed(ips):
            sockaddr = lan_interfaces_windows._SockaddrIn(sin_family=socket.AF_INET)
            sockaddr.sin_addr[:] = socket.inet_aton(ip)
            node = lan_interfaces_windows._AddressNode(Next=head)
            node.Address.lpSockaddr = ctypes.addressof(sockaddr)
            keep_alive.extend([sockaddr, node])
            head = ctypes.pointer(node)
        return head

    second = lan_interfaces_windows._AdapterAddresses(
        FriendlyName="vEthernet (WSL)",
        Description="Hyper-V Virtual Ethernet Adapter",
        IfType=IF_TYPE_ETHERNET,
        OperStatus=_IF_OPER_STATUS_UP,
        FirstUnicastAddress=address_list("172.28.48.1"),
    )
    first = lan_interfaces_windows._AdapterAddresses(
        Next=ctypes.pointer(second),
        FriendlyName="Wi-Fi",
        Description="Intel(R) Wi-Fi 6 AX201 160MHz",
        IfType=IF_TYPE_WIFI,
        OperStatus=IF_OPER_DOWN,
        FirstUnicastAddress=address_list("192.168.1.20", "192.168.1.21"),
        FirstGatewayAddress=address_list("192.168.1.1"),
    )
    buffer = ctypes.create_string_buffer(bytes(first))
    assert lan_interfaces_windows.adapters_in(buffer) == [
        WindowsAdapter(
            friendly_name="Wi-Fi",
            description="Intel(R) Wi-Fi 6 AX201 160MHz",
            if_type=IF_TYPE_WIFI,
            oper_status=IF_OPER_DOWN,
            ipv4s=("192.168.1.20", "192.168.1.21"),
            has_ipv4_gateway=True,
        ),
        WindowsAdapter(
            friendly_name="vEthernet (WSL)",
            description="Hyper-V Virtual Ethernet Adapter",
            if_type=IF_TYPE_ETHERNET,
            oper_status=_IF_OPER_STATUS_UP,
            ipv4s=("172.28.48.1",),
            has_ipv4_gateway=False,
        ),
    ]
