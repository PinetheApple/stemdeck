"""Windows adapters for lan_interfaces, read through iphlpapi's GetAdaptersAddresses.

Windows has neither the SIOCGIF* ioctls nor sysfs, but GetAdaptersAddresses
reports what both would: each adapter's friendly name ("Wi-Fi", "vEthernet
(WSL)"), its driver description ("Hyper-V Virtual Ethernet Adapter"), its
interface type, whether it is up, and its IPv4 addresses and gateways.

An adapter is host-only, and its addresses left out, when it is a virtual
adapter only this machine reaches: Hyper-V's vEthernet adapters (the Default
Switch, WSL, Docker's nat), VirtualBox's Host-Only adapter and VMware's
VMnet1/VMnet8. A Hyper-V external switch is a vEthernet adapter too, but it
carries the machine's real LAN connection, and unlike the others it has a
default gateway; so a virtual adapter with an IPv4 gateway counts as LAN.
Software loopback is host-only whatever it is called.

An adapter is a VPN when its type is PPP, which is how Windows' own VPN
connections (IKEv2, SSTP, L2TP) appear, or when its name or description names
a VPN client: WireGuard, Tailscale, OpenVPN's TAP-Windows, Wintun and Data
Channel Offload drivers, ZeroTier, AnyConnect, GlobalProtect (PANGP), or any
adapter with "VPN" in it. Generic tunnel adapters (Teredo, ISATAP, IP-HTTPS)
carry no IPv4 address, so they need no rule.

The classification is a pure function over WindowsAdapter records, which keeps
it testable on any platform; only _load_get_adapters_addresses touches
ctypes.WinDLL. Any failure reads as no interfaces, which keeps every address.
"""

from __future__ import annotations

import ctypes
import logging
import re
import socket
from collections.abc import Callable
from dataclasses import dataclass

from app.core.lan_interfaces import NetInterface

_log = logging.getLogger("stemdeck.network")

IF_TYPE_PPP = 23
IF_TYPE_SOFTWARE_LOOPBACK = 24
IF_OPER_STATUS_UP = 1

_GAA_FLAG_SKIP_ANYCAST = 0x2
_GAA_FLAG_SKIP_MULTICAST = 0x4
_GAA_FLAG_SKIP_DNS_SERVER = 0x8
_GAA_FLAG_INCLUDE_GATEWAYS = 0x80
_GAA_FLAGS = (
    _GAA_FLAG_SKIP_ANYCAST
    | _GAA_FLAG_SKIP_MULTICAST
    | _GAA_FLAG_SKIP_DNS_SERVER
    | _GAA_FLAG_INCLUDE_GATEWAYS
)
_ERROR_SUCCESS = 0
_ERROR_BUFFER_OVERFLOW = 111
_INITIAL_BUFFER_BYTES = 15 * 1024  # the starting size Microsoft's documentation recommends
# An adapter can appear between the call that sizes the buffer and the one that fills it.
_MAX_BUFFER_ATTEMPTS = 3
_MAX_ADAPTER_ADDRESS_LENGTH = 8
_MAX_ZONE_INDICES = 16
_IPHLPAPI = "iphlpapi"

_HOST_ONLY_ADAPTER = re.compile(
    r"^vEthernet\b|Hyper-V Virtual Ethernet|VirtualBox Host-Only"
    r"|VMware (Virtual Ethernet Adapter|Network Adapter VMnet)",
    re.IGNORECASE,
)
_VPN_ADAPTER = re.compile(
    r"WireGuard|Tailscale|TAP-Windows|Wintun|ZeroTier|AnyConnect|PANGP|VPN",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class WindowsAdapter:
    friendly_name: str
    description: str
    if_type: int
    oper_status: int
    ipv4s: tuple[str, ...]
    has_ipv4_gateway: bool


class _SockaddrIn(ctypes.Structure):
    _fields_ = [
        ("sin_family", ctypes.c_uint16),
        ("sin_port", ctypes.c_uint16),
        ("sin_addr", ctypes.c_ubyte * 4),
        ("sin_zero", ctypes.c_ubyte * 8),
    ]


class _SocketAddress(ctypes.Structure):
    _fields_ = [("lpSockaddr", ctypes.c_void_p), ("iSockaddrLength", ctypes.c_int32)]


class _AddressNode(ctypes.Structure):
    """The head IP_ADAPTER_UNICAST_ADDRESS and IP_ADAPTER_GATEWAY_ADDRESS share."""


_AddressNode._fields_ = [
    ("Length", ctypes.c_uint32),
    ("Flags", ctypes.c_uint32),
    ("Next", ctypes.POINTER(_AddressNode)),
    ("Address", _SocketAddress),
]


class _AdapterAddresses(ctypes.Structure):
    """IP_ADAPTER_ADDRESSES up to FirstGatewayAddress; nothing past it is read."""


_AdapterAddresses._fields_ = [
    ("Length", ctypes.c_uint32),
    ("IfIndex", ctypes.c_uint32),
    ("Next", ctypes.POINTER(_AdapterAddresses)),
    ("AdapterName", ctypes.c_char_p),
    ("FirstUnicastAddress", ctypes.POINTER(_AddressNode)),
    ("FirstAnycastAddress", ctypes.c_void_p),
    ("FirstMulticastAddress", ctypes.c_void_p),
    ("FirstDnsServerAddress", ctypes.c_void_p),
    ("DnsSuffix", ctypes.c_wchar_p),
    ("Description", ctypes.c_wchar_p),
    ("FriendlyName", ctypes.c_wchar_p),
    ("PhysicalAddress", ctypes.c_ubyte * _MAX_ADAPTER_ADDRESS_LENGTH),
    ("PhysicalAddressLength", ctypes.c_uint32),
    ("Flags", ctypes.c_uint32),
    ("Mtu", ctypes.c_uint32),
    ("IfType", ctypes.c_uint32),
    ("OperStatus", ctypes.c_int32),
    ("Ipv6IfIndex", ctypes.c_uint32),
    ("ZoneIndices", ctypes.c_uint32 * _MAX_ZONE_INDICES),
    ("FirstPrefix", ctypes.c_void_p),
    ("TransmitLinkSpeed", ctypes.c_uint64),
    ("ReceiveLinkSpeed", ctypes.c_uint64),
    ("FirstWinsServerAddress", ctypes.c_void_p),
    ("FirstGatewayAddress", ctypes.POINTER(_AddressNode)),
]

GetAdaptersAddresses = Callable[..., int]


def read_interfaces() -> list[NetInterface]:
    """Every IPv4 address on this machine's adapters, or [] when Windows cannot say."""
    try:
        adapters = read_adapters()
    except OSError:
        _log.debug("adapter enumeration failed", exc_info=True)
        return []
    return [iface for adapter in adapters for iface in adapter_interfaces(adapter)]


def adapter_interfaces(adapter: WindowsAdapter) -> list[NetInterface]:
    """One NetInterface per address, judged by the adapter's type, name and gateway."""
    vpn = _is_vpn(adapter)
    host_only = not vpn and _is_host_only(adapter)
    return [
        NetInterface(
            name=adapter.friendly_name,
            ipv4=ipv4,
            running=adapter.oper_status == IF_OPER_STATUS_UP,
            host_only=host_only,
            vpn=vpn,
        )
        for ipv4 in adapter.ipv4s
    ]


def _is_vpn(adapter: WindowsAdapter) -> bool:
    return adapter.if_type == IF_TYPE_PPP or _names_match(_VPN_ADAPTER, adapter)


def _is_host_only(adapter: WindowsAdapter) -> bool:
    if adapter.if_type == IF_TYPE_SOFTWARE_LOOPBACK:
        return True
    return _names_match(_HOST_ONLY_ADAPTER, adapter) and not adapter.has_ipv4_gateway


def _names_match(pattern: re.Pattern[str], adapter: WindowsAdapter) -> bool:
    return any(pattern.search(text) for text in (adapter.friendly_name, adapter.description))


def read_adapters() -> list[WindowsAdapter]:
    """This machine's adapters as GetAdaptersAddresses reports them."""
    return adapters_in(fetch_adapter_buffer(_load_get_adapters_addresses()))


def _load_get_adapters_addresses() -> GetAdaptersAddresses:
    win_dll = getattr(ctypes, "WinDLL", None)
    if win_dll is None:
        raise OSError(f"no {_IPHLPAPI} on this platform")
    function = win_dll(_IPHLPAPI).GetAdaptersAddresses
    function.argtypes = [
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_uint32),
    ]
    function.restype = ctypes.c_uint32
    return function


def fetch_adapter_buffer(get_adapters_addresses: GetAdaptersAddresses) -> ctypes.Array:
    """The filled adapter buffer, grown to whatever size Windows asks for."""
    size = ctypes.c_uint32(_INITIAL_BUFFER_BYTES)
    for _ in range(_MAX_BUFFER_ATTEMPTS):
        buffer = ctypes.create_string_buffer(size.value)
        result = get_adapters_addresses(
            socket.AF_INET,
            _GAA_FLAGS,
            None,
            buffer,
            ctypes.pointer(size),
        )
        if result == _ERROR_SUCCESS:
            return buffer
        if result != _ERROR_BUFFER_OVERFLOW:
            break
    raise OSError(result, "GetAdaptersAddresses failed")


def adapters_in(buffer: ctypes.Array) -> list[WindowsAdapter]:
    """The linked IP_ADAPTER_ADDRESSES records a filled buffer starts with."""
    adapters = []
    node = ctypes.cast(buffer, ctypes.POINTER(_AdapterAddresses))
    while node:
        record = node.contents
        adapters.append(
            WindowsAdapter(
                friendly_name=record.FriendlyName or "",
                description=record.Description or "",
                if_type=record.IfType,
                oper_status=record.OperStatus,
                ipv4s=tuple(_ipv4s(record.FirstUnicastAddress)),
                has_ipv4_gateway=bool(_ipv4s(record.FirstGatewayAddress)),
            )
        )
        node = record.Next
    return adapters


def _ipv4s(node: ctypes._Pointer[_AddressNode]) -> list[str]:
    found = []
    while node:
        sockaddr = node.contents.Address.lpSockaddr
        if sockaddr:
            sin = ctypes.cast(sockaddr, ctypes.POINTER(_SockaddrIn)).contents
            if sin.sin_family == socket.AF_INET:
                found.append(socket.inet_ntoa(bytes(sin.sin_addr)))
        node = node.contents.Next
    return found
