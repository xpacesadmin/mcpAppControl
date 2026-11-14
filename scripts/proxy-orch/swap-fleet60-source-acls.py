#!/usr/bin/env python3
"""Narrow an exact existing-route cohort for an owner-approved phone swap.

Run only on Proxy Orch as root from its VM console. This script never prints
configuration contents or provider credentials. It never changes upstreams,
listeners, firewall rules, or any route outside the supplied manifest.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path

CONFIG_DIR = Path("/etc/xpace/proxy/routes")
BACKUP_DIR = CONFIG_DIR / ".swap-backups"
PROXY_ORCH_SOURCE_IP = "192.168.52.10"
ROUTE_RE = re.compile(r"^fleet60-fleet([1-9]|1[0-9]|20)-dc([0-9]{2})$")
ALLOW_RE = re.compile(r"^(\s*allow\s+\S+\s+)(\S+)(.*)$", re.IGNORECASE)
PHASES = {"inspect", "prepare", "finalize", "rollback"}


def fail(message: str) -> None:
    raise SystemExit(f"ERROR: {message}")


def load_manifest(path: Path) -> tuple[str, list[dict]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if set(data) != {"credential_free", "operation_id", "routes"} or data["credential_free"] is not True:
        fail("manifest must contain only credential_free=true, operation_id, routes")
    operation = data["operation_id"]
    if not isinstance(operation, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{4,63}", operation):
        fail("invalid operation_id")
    routes = data["routes"]
    if not isinstance(routes, list) or len(routes) not in (2, 3, 18):
        fail("manifest requires exactly two, three, or the reviewed remaining 18 routes")
    seen_routes: set[str] = set()
    seen_old: set[str] = set()
    seen_new: set[str] = set()
    for row in routes:
        if not isinstance(row, dict) or set(row) != {"route_id", "old_source_ip", "new_source_ip"}:
            fail("route contains unexpected fields")
        route_id = row["route_id"]
        match = ROUTE_RE.fullmatch(route_id) if isinstance(route_id, str) else None
        if not match or int(match.group(1)) != int(match.group(2)):
            fail("invalid route_id")
        old = str(ipaddress.IPv4Address(row["old_source_ip"]))
        new = str(ipaddress.IPv4Address(row["new_source_ip"]))
        if not old.startswith("192.168.60.") or not new.startswith("192.168.60.") or old == new:
            fail("source IPs must be distinct VLAN60 device addresses")
        if route_id in seen_routes or old in seen_old or new in seen_new:
            fail("duplicate route or source IP")
        seen_routes.add(route_id)
        seen_old.add(old)
        seen_new.add(new)
    if seen_old != seen_new:
        fail("manifest must be a closed permutation of the same named phones")
    return operation, routes


def rewrite(content: str, old: str, new: str, phase: str) -> str:
    original = f"{old},{PROXY_ORCH_SOURCE_IP}"
    both = f"{old},{new},{PROXY_ORCH_SOURCE_IP}"
    final = f"{new},{PROXY_ORCH_SOURCE_IP}"
    expected = original if phase == "prepare" else both if phase == "finalize" else None
    target = both if phase == "prepare" else final if phase == "finalize" else original
    changed = 0
    lines = []
    for line in content.splitlines(keepends=True):
        newline = "\r\n" if line.endswith("\r\n") else "\n" if line.endswith("\n") else ""
        body = line[:-len(newline)] if newline else line
        match = ALLOW_RE.match(body)
        if not match:
            lines.append(line)
            continue
        source = match.group(2)
        if phase == "rollback" and source in (both, final):
            lines.append(match.group(1) + target + match.group(3) + newline)
            changed += 1
        elif source == expected:
            lines.append(match.group(1) + target + match.group(3) + newline)
            changed += 1
        else:
            lines.append(line)
    if changed != 1:
        fail(f"source ACL precondition failed: expected one exact allow source, found {changed}")
    return "".join(lines)


def inspect_allow_shape(content: str, old: str, route_id: str) -> None:
    count = 0
    for number, line in enumerate(content.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        tokens = shlex.split(stripped, comments=True)
        if not tokens or tokens[0].lower() != "allow":
            continue
        count += 1
        source = tokens[2] if len(tokens) > 2 else ""
        try:
            entries = source.split(",")
            for entry in entries:
                ipaddress.ip_network(entry, strict=False)
            safe_source = source
        except ValueError:
            safe_source = "[non-IP source redacted]"
        old_positions = [index for index, token in enumerate(tokens)
                         if re.search(rf"(?<![0-9.]){re.escape(old)}(?![0-9.])", token)]
        print(f"ROUTE={route_id} ALLOW_LINE={number} FIELDS={len(tokens) - 1} "
              f"SOURCE={safe_source} OLD_IP_TOKEN_POSITIONS={old_positions}")
    print(f"ROUTE={route_id} ALLOW_COUNT={count}")


def atomic_write(path: Path, content: str, original_stat: os.stat_result) -> None:
    descriptor, temp_path = tempfile.mkstemp(prefix=".swap-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chown(temp_path, original_stat.st_uid, original_stat.st_gid)
        os.chmod(temp_path, stat.S_IMODE(original_stat.st_mode))
        os.replace(temp_path, path)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--phase", required=True, choices=sorted(PHASES))
    parser.add_argument("--approve", required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        fail("run as root on Proxy Orch")
    operation, rows = load_manifest(args.manifest)
    if args.approve != f"SWAP_ACL_{operation}_{args.phase}":
        fail("approval token does not match manifest and phase")
    if args.phase == "inspect":
        for row in rows:
            path = CONFIG_DIR / f'{row["route_id"]}.cfg'
            inspect_allow_shape(path.read_text(encoding="utf-8"), row["old_source_ip"], row["route_id"])
        return
    planned = []
    for row in rows:
        path = CONFIG_DIR / f'{row["route_id"]}.cfg'
        unit = f'xpace-3proxy-{row["route_id"]}.service'
        original = path.read_text(encoding="utf-8")
        updated = rewrite(original, row["old_source_ip"], row["new_source_ip"], args.phase)
        planned.append((path, unit, original, updated, path.stat()))

    backup = BACKUP_DIR / operation / args.phase
    if backup.exists():
        fail("backup for this operation and phase already exists; refusing repeat")
    backup.mkdir(parents=True, mode=0o700)
    os.chmod(backup, 0o700)
    for path, _, _, _, _ in planned:
        target = backup / path.name
        with target.open("xb") as handle:
            os.fchmod(handle.fileno(), 0o600)
            with path.open("rb") as source:
                shutil.copyfileobj(source, handle)

    try:
        for path, _, _, updated, file_stat in planned:
            atomic_write(path, updated, file_stat)
        for _, unit, _, _, _ in planned:
            subprocess.run(["systemctl", "restart", unit], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _, unit, _, _, _ in planned:
            subprocess.run(["systemctl", "is-active", "--quiet", unit], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        for path, _, original, _, file_stat in planned:
            atomic_write(path, original, file_stat)
        for _, unit, _, _, _ in planned:
            subprocess.run(["systemctl", "restart", unit], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        fail("ACL phase failed; original configs restored and service restart attempted")
    print(f"PHASE={args.phase} ROUTES={len(rows)} ACTIVE={len(rows)} BACKUP={backup}")


if __name__ == "__main__":
    main()
