#!/usr/bin/env python3
"""Stage credential-bearing 3proxy route files by cloning the proven Fleet 1 route.

The script never prints configuration content or provider credentials. Plan mode is
the default. Apply mode stages Fleet 2-20 configs and units but does not start them.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

SECRET_KEYS = {"password", "token", "username", "credentials", "secret", "authorization"}
TEMPLATE_ROUTE_ID = "fleet60-fleet1-dc01"
TEMPLATE_DEVICE_IP = "192.168.60.199"
TEMPLATE_LISTENER = 8201
TEMPLATE_PROVIDER_PORT = 10001


def fail(message: str) -> None:
    raise SystemExit(f"ERROR: {message}")


def reject_secret_keys(value: object, path: str = "manifest") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key.lower() in SECRET_KEYS:
                fail(f"secret-bearing key prohibited at {path}.{key}")
            reject_secret_keys(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            reject_secret_keys(child, f"{path}[{index}]")


def load_routes(manifest_path: Path) -> list[dict]:
    with manifest_path.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    reject_secret_keys(manifest)
    if manifest.get("credential_free") is not True:
        fail("manifest must declare credential_free=true")
    routes = manifest.get("routes")
    if not isinstance(routes, list) or len(routes) != 20:
        fail("manifest must contain exactly 20 active routes")

    seen: dict[str, set[object]] = {
        "route_id": set(), "adb_serial": set(), "listener": set(),
        "provider_port": set(), "public_ip": set(),
    }
    for route in routes:
        number = int(route["fleet_number"])
        expected_route_id = f"fleet60-fleet{number}-dc{number:02d}"
        if route["route_id"] != expected_route_id:
            fail(f"unexpected route ID for Fleet {number}")
        if int(route["assigned_fleet_vlan"]) != 60:
            fail(f"Fleet {number} is outside VLAN 60")
        if route["classification"] != "dedicated_static":
            fail(f"Fleet {number} is not dedicated_static")
        if route["adb_serial"] != f'{route["reserved_device_ip"]}:5555':
            fail(f"Fleet {number} ADB/reserved IP mismatch")
        if int(route["internal_endpoint"]["port"]) != 8200 + number:
            fail(f"Fleet {number} listener is not deterministic")
        if int(route["provider_endpoint"]["port"]) != 10000 + number:
            fail(f"Fleet {number} provider port is not deterministic")
        values = {
            "route_id": route["route_id"],
            "adb_serial": route["adb_serial"],
            "listener": int(route["internal_endpoint"]["port"]),
            "provider_port": int(route["provider_endpoint"]["port"]),
            "public_ip": route["expected_public_ip"],
        }
        for label, value in values.items():
            if value in seen[label]:
                fail(f"duplicate {label}: {value}")
            seen[label].add(value)
    routes.sort(key=lambda route: int(route["fleet_number"]))
    fleet1 = routes[0]
    if (
        fleet1["reserved_device_ip"] != TEMPLATE_DEVICE_IP
        or int(fleet1["internal_endpoint"]["port"]) != TEMPLATE_LISTENER
        or int(fleet1["provider_endpoint"]["port"]) != TEMPLATE_PROVIDER_PORT
        or fleet1["expected_public_ip"] != "13.143.18.160"
    ):
        fail("Fleet 1 canary mapping changed unexpectedly")
    return routes


def rewrite_config(template: str, route: dict) -> str:
    output: list[str] = []
    allow_replacements = 0
    parent_count = 0
    listener_count = 0
    deny_count = 0

    for raw_line in template.splitlines(keepends=True):
        newline = "\n" if raw_line.endswith("\n") else ""
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            output.append(raw_line)
            continue
        try:
            tokens = shlex.split(stripped, comments=True, posix=True)
        except ValueError as exc:
            fail(f"template parse error: {exc}")
        if not tokens:
            output.append(raw_line)
            continue
        directive = tokens[0].lower()
        if directive == "allow":
            replaced = raw_line.replace(TEMPLATE_DEVICE_IP, route["reserved_device_ip"])
            if replaced != raw_line:
                allow_replacements += 1
            output.append(replaced)
            continue
        if directive == "parent":
            if len(tokens) < 5:
                fail("template parent directive is incomplete")
            tokens[3] = str(route["provider_endpoint"]["hostname_or_ip"])
            tokens[4] = str(route["provider_endpoint"]["port"])
            output.append(shlex.join(tokens) + newline)
            parent_count += 1
            continue
        if directive == "proxy":
            rewritten: list[str] = [tokens[0]]
            found_port = False
            found_interface = False
            for token in tokens[1:]:
                if token.startswith("-p"):
                    rewritten.append(f'-p{route["internal_endpoint"]["port"]}')
                    found_port = True
                elif token.startswith("-i"):
                    rewritten.append(f'-i{route["internal_endpoint"]["hostname_or_ip"]}')
                    found_interface = True
                else:
                    rewritten.append(token)
            if not found_port:
                rewritten.append(f'-p{route["internal_endpoint"]["port"]}')
            if not found_interface:
                rewritten.append(f'-i{route["internal_endpoint"]["hostname_or_ip"]}')
            output.append(shlex.join(rewritten) + newline)
            listener_count += 1
            continue
        if directive == "deny":
            deny_count += 1
        output.append(raw_line)

    if allow_replacements < 1:
        fail("template has no Fleet 1 source ACL to replace")
    if parent_count != 1:
        fail(f"template must contain exactly one parent directive; found {parent_count}")
    if listener_count != 1:
        fail(f"template must contain exactly one proxy listener; found {listener_count}")
    if deny_count < 1:
        fail("template must retain a deny rule")
    return "".join(output)


def rewrite_unit(template: str, route_id: str) -> str:
    if TEMPLATE_ROUTE_ID not in template:
        fail("template unit does not reference the Fleet 1 route ID")
    rewritten = template.replace(TEMPLATE_ROUTE_ID, route_id)
    if TEMPLATE_ROUTE_ID in rewritten:
        fail("template unit substitution was incomplete")
    return rewritten


def write_like_template(path: Path, content: str, template_stat: os.stat_result) -> None:
    path.write_text(content, encoding="utf-8")
    os.chmod(path, stat.S_IMODE(template_stat.st_mode))
    os.chown(path, template_stat.st_uid, template_stat.st_gid)


def stage(routes: list[dict], args: argparse.Namespace) -> None:
    if os.geteuid() != 0:
        fail("--apply must run as root")
    if args.approve != "APPLY_FLEET60_COHORT_19":
        fail("--apply requires --approve APPLY_FLEET60_COHORT_19")

    template_config = args.template_config.resolve(strict=True)
    template_unit = args.template_unit.resolve(strict=True)
    config_text = template_config.read_text(encoding="utf-8")
    unit_text = template_unit.read_text(encoding="utf-8")
    config_stat = template_config.stat()
    unit_stat = template_unit.stat()
    targets: list[tuple[Path, str, os.stat_result]] = []

    for route in routes[1:]:
        route_id = route["route_id"]
        config_target = args.config_dir / f"{route_id}.cfg"
        unit_target = args.unit_dir / f"xpace-3proxy-{route_id}.service"
        if config_target.exists() or unit_target.exists():
            fail(f"refusing to overwrite existing route artifacts for {route_id}")
        targets.append((config_target, rewrite_config(config_text, route), config_stat))
        targets.append((unit_target, rewrite_unit(unit_text, route_id), unit_stat))

    args.config_dir.mkdir(parents=True, exist_ok=True)
    args.unit_dir.mkdir(parents=True, exist_ok=True)
    created: list[Path] = []
    try:
        with tempfile.TemporaryDirectory(prefix="xpace-fleet60-cohort-") as temp_dir:
            temp_root = Path(temp_dir)
            staged: list[tuple[Path, Path, os.stat_result]] = []
            for index, (target, content, template_stat) in enumerate(targets):
                temporary = temp_root / f"artifact-{index}"
                write_like_template(temporary, content, template_stat)
                staged.append((temporary, target, template_stat))
            for temporary, target, template_stat in staged:
                shutil.copy2(temporary, target)
                os.chown(target, template_stat.st_uid, template_stat.st_gid)
                os.chmod(target, stat.S_IMODE(template_stat.st_mode))
                created.append(target)
        subprocess.run(["systemctl", "daemon-reload"], check=True)
    except Exception:
        for path in reversed(created):
            try:
                path.unlink()
            except FileNotFoundError:
                pass
        subprocess.run(["systemctl", "daemon-reload"], check=False)
        raise

    print(f"STAGED={len(routes) - 1} routes")
    print("STARTED=0")
    print("Next: start and validate exactly one named service at a time.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--apply", action="store_true", help="stage Fleet 2-20 configs and units; does not start them")
    parser.add_argument("--approve", default="")
    parser.add_argument("--template-config", type=Path, default=Path("/etc/xpace/proxy/routes/fleet60-fleet1-dc01.cfg"))
    parser.add_argument("--template-unit", type=Path, default=Path("/etc/systemd/system/xpace-3proxy-fleet60-fleet1-dc01.service"))
    parser.add_argument("--config-dir", type=Path, default=Path("/etc/xpace/proxy/routes"))
    parser.add_argument("--unit-dir", type=Path, default=Path("/etc/systemd/system"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    routes = load_routes(args.manifest.resolve(strict=True))
    for route in routes:
        print(
            f'PLAN fleet={route["fleet_number"]:02d} device={route["reserved_device_ip"]} '
            f'listener={route["internal_endpoint"]["port"]} upstream_port={route["provider_endpoint"]["port"]} '
            f'expected_ip={route["expected_public_ip"]} state={route["rollout_state"]}'
        )
    if args.apply:
        stage(routes, args)
    else:
        print("MODE=plan (no files, services, listeners, or firewall rules changed)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
