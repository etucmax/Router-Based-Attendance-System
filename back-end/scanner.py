# ARP cache scan (`arp -a`); optional hotspot subnet filter (RBAS_HOTSPOT_ONLY / RBAS_HOTSPOT_SUBNET).

import ipaddress
import os
import platform
import re
import subprocess
from datetime import datetime


# Normalize MAC string to AA:BB:CC:DD:EE:FF uppercase.
def _normalise_mac(raw: str) -> str:
    clean = re.sub(r"[^0-9a-fA-F]", "", raw)
    if len(clean) == 12:
        return ":".join(clean[i : i + 2].upper() for i in range(0, 12, 2))
    return raw.upper()


# Filter ARP lines: unicast IP + unicast MAC (drop multicast, all-zero, etc.).
def _is_likely_unicast_client(ip: str, mac: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip.strip())
        if addr.version == 4:
            if (
                addr.is_multicast
                or addr.is_reserved
                or addr.is_unspecified
                or addr.is_link_local
            ):
                return False
        else:
            if addr.is_multicast or addr.is_unspecified or addr.is_link_local:
                return False
    except ValueError:
        return False

    mac = mac.replace("-", ":").upper()
    mp = mac.split(":")
    if len(mp) != 6:
        return False
    try:
        ob = [int(x, 16) for x in mp]
    except ValueError:
        return False
    if ob[0] & 0x01:
        return False
    if mac.startswith("01:00:5E"):
        return False
    return True


_LEGACY_DEMO_MACS = frozenset(
    {
        "AA:BB:CC:DD:EE:01",
        "AA:BB:CC:DD:EE:02",
        "AA:BB:CC:DD:EE:03",
        "AA:BB:CC:DD:EE:04",
        "AA:BB:CC:DD:EE:05",
        "11:22:33:44:55:66",
    }
)


# Parse `arp -a` stdout (Windows vs Unix pattern); dedupe by MAC.
def _scan_arp() -> list[dict]:
    devices = []
    try:
        if platform.system() == "Windows":
            result = subprocess.run(["arp", "-a"], capture_output=True, text=True, timeout=10)
            pattern = re.compile(
                r"(\d{1,3}(?:\.\d{1,3}){3})\s+([\da-fA-F]{2}[-:][\da-fA-F]{2}[-:][\da-fA-F]{2}"
                r"[-:][\da-fA-F]{2}[-:][\da-fA-F]{2}[-:][\da-fA-F]{2})"
            )
        else:
            result = subprocess.run(["arp", "-a"], capture_output=True, text=True, timeout=10)
            pattern = re.compile(
                r"\((\d{1,3}(?:\.\d{1,3}){3})\)\s+at\s+([\da-fA-F]{2}[:\-][\da-fA-F]{2}"
                r"[:\-][\da-fA-F]{2}[:\-][\da-fA-F]{2}[:\-][\da-fA-F]{2}[:\-][\da-fA-F]{2})"
            )

        for line in result.stdout.splitlines():
            m = pattern.search(line)
            if not m:
                continue
            ip, mac = m.group(1), _normalise_mac(m.group(2))
            if mac in ("FF:FF:FF:FF:FF:FF", "00:00:00:00:00:00"):
                continue
            if not _is_likely_unicast_client(ip, mac):
                continue
            if mac in _LEGACY_DEMO_MACS:
                continue
            devices.append({"ip_address": ip, "mac_address": mac, "hostname": ""})
    except Exception:
        pass

    by_mac = {}
    for d in devices:
        m = d["mac_address"]
        if m not in by_mac:
            by_mac[m] = d
    return list(by_mac.values())


# PowerShell: find mobile hotspot adapter IPv4 + prefix for subnet filter.
def _windows_hotspot_cidr() -> str | None:
    if platform.system() != "Windows":
        return None
    ps = r"""
$ErrorActionPreference = 'SilentlyContinue'
$na = Get-NetAdapter | Where-Object {
  $_.Status -eq 'Up' -and (
    $_.InterfaceDescription -match 'Wi-Fi Direct Virtual' -or
    $_.Name -match '^Local Area Connection\*'
  )
} | Select-Object -First 1
if ($na) {
  $ip = Get-NetIPAddress -InterfaceIndex $na.ifIndex -AddressFamily IPv4 |
        Select-Object -First 1
  if ($null -ne $ip) {
    Write-Output ($ip.IPAddress + '/' + $ip.PrefixLength)
    exit 0
  }
}
$ip2 = Get-NetIPAddress -AddressFamily IPv4 |
       Where-Object { $_.IPAddress -like '192.168.137.*' } |
       Select-Object -First 1
if ($null -ne $ip2) {
  Write-Output ($ip2.IPAddress + '/' + $ip2.PrefixLength)
}
"""
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True,
            text=True,
            timeout=8,
        )
        line = (r.stdout or "").strip().splitlines()
        if not line:
            return None
        first = line[0].strip()
        if "/" not in first:
            return None
        host, _, pl = first.partition("/")
        ipaddress.ip_address(host)
        int(pl)
        return first
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


# Env RBAS_HOTSPOT_ONLY default on (1): restrict to hotspot LAN when possible.
def _hotspot_only_enabled() -> bool:
    v = os.environ.get("RBAS_HOTSPOT_ONLY", "1").strip().lower()
    return v not in ("0", "false", "no", "off")


# Optional RBAS_HOTSPOT_SUBNET override (e.g. 192.168.137.0/24).
def _manual_hotspot_cidr() -> str | None:
    raw = os.environ.get("RBAS_HOTSPOT_SUBNET", "").strip()
    if not raw:
        return None
    try:
        ipaddress.ip_network(raw, strict=False)
        return raw
    except ValueError:
        return None


# Keep devices whose IP is in host_with_prefix network but not gateway/broadcast.
def _filter_hotspot_clients(
    devices: list[dict], host_with_prefix: str
) -> tuple[list[dict], str | None]:
    try:
        host_ip_str, _, pl_str = host_with_prefix.partition("/")
        prefix_len = int(pl_str)
        host_ip = ipaddress.ip_address(host_ip_str.strip())
        net = ipaddress.ip_network(f"{host_ip_str}/{prefix_len}", strict=False)
    except (ValueError, OSError):
        return devices, None

    out = []
    for d in devices:
        try:
            a = ipaddress.ip_address(d["ip_address"].strip())
        except ValueError:
            continue
        if a not in net:
            continue
        if a == host_ip or a == net.network_address or a == net.broadcast_address:
            continue
        out.append(d)
    note = f"{net} (excluding hotspot host {host_ip})"
    return out, note


# True if this IP/MAC pair should be dropped from final output.
def _reject_noise(ip: str, mac: str) -> bool:
    try:
        a = ipaddress.ip_address(ip.strip())
        if a.version == 4 and (a.is_multicast or a.is_reserved or a.is_unspecified or a.is_link_local):
            return True
        if a.version != 4 and (a.is_multicast or a.is_unspecified):
            return True
    except ValueError:
        return True
    m = mac.replace("-", ":").upper()
    if m in _LEGACY_DEMO_MACS or m.startswith("01:00:5E") or m.startswith("33:33"):
        return True
    return False


# Last pass: valid IPv4 + MAC, dedupe MACs, normalize fields.
def _scrub_final(devices: list[dict]) -> list[dict]:
    out = []
    seen = set()
    for raw in devices:
        ip = str(raw.get("ip_address", "")).strip()
        mac = _normalise_mac(str(raw.get("mac_address", "")))
        hx = re.sub(r"[^0-9a-fA-F]", "", mac)
        if len(hx) != 12:
            continue
        mac = ":".join(hx[i : i + 2].upper() for i in range(0, 12, 2))
        try:
            a = ipaddress.ip_address(ip)
            if a.version != 4:
                continue
        except ValueError:
            continue
        if _reject_noise(ip, mac):
            continue
        if mac in seen:
            continue
        seen.add(mac)
        out.append({"ip_address": ip, "mac_address": mac, "hostname": ""})
    return out


# Public entry: ARP list → optional hotspot filter → scrub; returns (devices, note for UI).
def scan_network() -> tuple[list[dict], str | None]:
    devices = []
    for d in _scan_arp():
        if _reject_noise(d["ip_address"], d["mac_address"]):
            continue
        devices.append(d)

    filter_note: str | None = None
    if _hotspot_only_enabled():
        manual = _manual_hotspot_cidr()
        if manual:
            try:
                net = ipaddress.ip_network(manual, strict=False)
                exclude = {net.network_address, net.broadcast_address}
                first_host = next(net.hosts(), None)
                if first_host is not None:
                    exclude.add(first_host)
                trimmed = []
                for d in devices:
                    try:
                        a = ipaddress.ip_address(d["ip_address"].strip())
                    except ValueError:
                        continue
                    if a in net and a not in exclude:
                        trimmed.append(d)
                devices = trimmed
                filter_note = f"Only {net} clients (RBAS_HOTSPOT_SUBNET; excluding gateway guess)"
            except ValueError:
                pass
        elif platform.system() == "Windows":
            cidr = _windows_hotspot_cidr()
            if cidr:
                devices, filter_note = _filter_hotspot_clients(devices, cidr)
            else:
                devices = []
                filter_note = (
                    "Hotspot LAN not detected - no clients listed. "
                    "Enable Settings > Mobile hotspot, or set RBAS_HOTSPOT_SUBNET (e.g. 192.168.137.0/24), "
                    "or RBAS_HOTSPOT_ONLY=0 to scan all interfaces."
                )

    devices = _scrub_final(devices)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for d in devices:
        d["last_seen"] = now
    return devices, filter_note
