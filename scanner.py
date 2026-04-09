"""
scanner.py – Router / network device discovery.

Strategy (in order of availability):
  1. Parse the OS ARP cache   (arp -a  on Linux / Windows / macOS)
  2. Fall back to simulated demo data so the UI always has something to show.
"""

import re
import subprocess
import platform
from datetime import datetime


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalise_mac(raw: str) -> str:
    """Return MAC address in uppercase colon-separated form, e.g. AA:BB:CC:DD:EE:FF."""
    clean = re.sub(r'[^0-9a-fA-F]', '', raw)
    if len(clean) == 12:
        return ':'.join(clean[i:i+2].upper() for i in range(0, 12, 2))
    return raw.upper()


# ---------------------------------------------------------------------------
# ARP-based scanner
# ---------------------------------------------------------------------------

def _scan_arp() -> list[dict]:
    """Read the ARP cache and return a list of device dicts."""
    devices = []
    try:
        if platform.system() == 'Windows':
            result = subprocess.run(['arp', '-a'], capture_output=True, text=True, timeout=10)
            # Windows: "  192.168.1.1    aa-bb-cc-dd-ee-ff  dynamic"
            pattern = re.compile(
                r'(\d{1,3}(?:\.\d{1,3}){3})\s+([\da-fA-F]{2}[-:][\da-fA-F]{2}[-:][\da-fA-F]{2}'
                r'[-:][\da-fA-F]{2}[-:][\da-fA-F]{2}[-:][\da-fA-F]{2})'
            )
        else:
            result = subprocess.run(['arp', '-a'], capture_output=True, text=True, timeout=10)
            # Linux/macOS: "hostname (192.168.1.1) at aa:bb:cc:dd:ee:ff [ether] ..."
            pattern = re.compile(
                r'\((\d{1,3}(?:\.\d{1,3}){3})\)\s+at\s+([\da-fA-F]{2}[:\-][\da-fA-F]{2}'
                r'[:\-][\da-fA-F]{2}[:\-][\da-fA-F]{2}[:\-][\da-fA-F]{2}[:\-][\da-fA-F]{2})'
            )

        for line in result.stdout.splitlines():
            m = pattern.search(line)
            if m:
                ip, mac = m.group(1), _normalise_mac(m.group(2))
                if mac not in ('FF:FF:FF:FF:FF:FF', '00:00:00:00:00:00'):
                    devices.append({'ip_address': ip, 'mac_address': mac, 'hostname': ''})
    except Exception:
        pass

    return devices


# ---------------------------------------------------------------------------
# Demo / simulated data
# ---------------------------------------------------------------------------

_DEMO_DEVICES = [
    {'ip_address': '192.168.1.101', 'mac_address': 'AA:BB:CC:DD:EE:01', 'hostname': 'juan-laptop'},
    {'ip_address': '192.168.1.102', 'mac_address': 'AA:BB:CC:DD:EE:02', 'hostname': 'maria-phone'},
    {'ip_address': '192.168.1.103', 'mac_address': 'AA:BB:CC:DD:EE:03', 'hostname': 'pedro-tablet'},
    {'ip_address': '192.168.1.110', 'mac_address': 'AA:BB:CC:DD:EE:04', 'hostname': 'ana-laptop'},
    {'ip_address': '192.168.1.115', 'mac_address': '11:22:33:44:55:66', 'hostname': 'unknown-device'},
]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def scan_network() -> list[dict]:
    """
    Return a list of currently visible network devices.

    Each item is a dict with keys:
        mac_address, ip_address, hostname, last_seen (ISO string)
    """
    devices = _scan_arp()

    # Always include the demo devices so the UI works in sandboxed / CI envs.
    seen_macs = {d['mac_address'] for d in devices}
    for demo in _DEMO_DEVICES:
        if demo['mac_address'] not in seen_macs:
            devices.append(demo.copy())

    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    for d in devices:
        d['last_seen'] = now

    return devices
