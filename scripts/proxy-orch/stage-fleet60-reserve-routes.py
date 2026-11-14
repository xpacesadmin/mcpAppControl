#!/usr/bin/env python3
"""Safely plan, stage, or roll back two credential-free Fleet 60 reserve routes.

The route manifest never contains provider credentials. During staging, this tool
clones existing, credential-bearing route files locally on Proxy Orch and never
prints their contents. Staging writes a paired set of configs and units, reloads
systemd, and deliberately does not start or enable either service.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import stat
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


APPLY_APPROVAL = "APPLY_FLEET60_RESERVE_ROUTES_20260828"
ROLLBACK_APPROVAL = "ROLLBACK_FLEET60_RESERVE_ROUTES_20260828"
ROUTE_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}$")
SECRET_KEY_PARTS = (
    "password",
    "passwd",
    "username",
    "credential",
    "secret",
    "token",
    "authorization",
    "apikey",
    "accesskey",
    "privatekey",
    "sshkey",
    "enrollmentkey",
)

ROOT_KEYS = {
    "schema_version",
    "kind",
    "credential_free",
    "generated_at",
    "purpose",
    "routes",
}
ROUTE_KEYS = {
    "route_id",
    "provider",
    "classification",
    "assignment_state",
    "assigned_device_id",
    "assigned_fleet_vlan",
    "adb_serial",
    "reserved_device_ip",
    "clone_from",
    "internal_endpoint",
    "provider_endpoint",
    "location",
    "health_state",
    "expected_public_ip",
    "observed_public_ip",
    "last_verification_time",
    "rollout_state",
}
CLONE_KEYS = {"route_id", "reserved_device_ip"}
ENDPOINT_KEYS = {"hostname_or_ip", "port", "protocol"}
LOCATION_KEYS = {"country", "region", "city"}

# This strict map makes path selection task-scoped and prevents a modified
# manifest from turning this utility into an arbitrary root-owned file writer.
EXPECTED_ROUTES: dict[str, dict[str, Any]] = {
    "fleet60-ip189-spare01": {
        "assigned_device_id": "FLEET_12",
        "reserved_device_ip": "192.168.60.189",
        "adb_serial": "192.168.60.189:5555",
        "clone_route_id": "fleet60-fleet6-dc06",
        "clone_device_ip": "192.168.60.189",
        "listener_port": 8221,
        "provider_port": 10021,
        "expected_public_ip": "172.120.79.131",
    },
    "fleet60-ip197-spare02": {
        "assigned_device_id": "FLEET_19",
        "reserved_device_ip": "192.168.60.197",
        "adb_serial": "192.168.60.197:5555",
        "clone_route_id": "fleet60-fleet13-dc13",
        "clone_device_ip": "192.168.60.197",
        "listener_port": 8222,
        "provider_port": 10022,
        "expected_public_ip": "142.252.141.119",
    },
}


class RouteStageError(RuntimeError):
    """A sanitized, operator-actionable staging error."""


@dataclass(frozen=True)
class Artifact:
    target: Path
    content: bytes
    mode: int
    uid: int
    gid: int
    route_id: str
    kind: str


def fail(message: str) -> None:
    raise RouteStageError(message)


def normalized_key(key: object) -> str:
    return re.sub(r"[^a-z0-9]", "", str(key).lower())


def reject_secret_keys(value: object, path: str = "manifest") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = normalized_key(key)
            if normalized != "credentialfree" and any(
                part in normalized for part in SECRET_KEY_PARTS
            ):
                fail(f"secret-bearing key prohibited at {path}")
            reject_secret_keys(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            reject_secret_keys(child, f"{path}[{index}]")


def require_exact_keys(value: object, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(f"{label} must be an object")
    actual = set(value)
    if actual != expected:
        fail(f"{label} has missing or unsupported fields")
    return value


def validate_route(route: object) -> dict[str, Any]:
    item = require_exact_keys(route, ROUTE_KEYS, "route")
    route_id = item.get("route_id")
    if not isinstance(route_id, str) or not ROUTE_ID_PATTERN.fullmatch(route_id):
        fail("route has an invalid route_id")
    expected = EXPECTED_ROUTES.get(route_id)
    if expected is None:
        fail("manifest contains a route outside this task scope")

    clone = require_exact_keys(item.get("clone_from"), CLONE_KEYS, f"route {route_id} clone_from")
    internal = require_exact_keys(
        item.get("internal_endpoint"), ENDPOINT_KEYS, f"route {route_id} internal_endpoint"
    )
    provider = require_exact_keys(
        item.get("provider_endpoint"), ENDPOINT_KEYS, f"route {route_id} provider_endpoint"
    )
    location = require_exact_keys(item.get("location"), LOCATION_KEYS, f"route {route_id} location")

    checks = {
        "provider": "Decodo",
        "classification": "dedicated_static",
        "assignment_state": "planned_replacement",
        "assigned_device_id": expected["assigned_device_id"],
        "assigned_fleet_vlan": 60,
        "adb_serial": expected["adb_serial"],
        "reserved_device_ip": expected["reserved_device_ip"],
        "health_state": "not_verified",
        "expected_public_ip": expected["expected_public_ip"],
        "observed_public_ip": None,
        "last_verification_time": None,
        "rollout_state": "staged_only",
    }
    for key, expected_value in checks.items():
        if item.get(key) != expected_value:
            fail(f"route {route_id} has an unexpected {key}")

    if clone != {
        "route_id": expected["clone_route_id"],
        "reserved_device_ip": expected["clone_device_ip"],
    }:
        fail(f"route {route_id} has an unexpected clone source")
    if internal != {
        "hostname_or_ip": "192.168.52.10",
        "port": expected["listener_port"],
        "protocol": "http",
    }:
        fail(f"route {route_id} has an unexpected internal endpoint")
    if provider != {
        "hostname_or_ip": "dc.decodo.com",
        "port": expected["provider_port"],
        "protocol": "http_connect",
    }:
        fail(f"route {route_id} has an unexpected provider endpoint")
    if location.get("country") != "United States":
        fail(f"route {route_id} has an unexpected country")
    if location.get("region") is not None or location.get("city") is not None:
        fail(f"route {route_id} geography must remain unverified until observed")
    return item


def load_routes(manifest_path: Path) -> list[dict[str, Any]]:
    try:
        with manifest_path.open("r", encoding="utf-8") as handle:
            manifest = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise RouteStageError("unable to read the route manifest") from exc

    reject_secret_keys(manifest)
    root = require_exact_keys(manifest, ROOT_KEYS, "manifest")
    if root.get("schema_version") != 1 or root.get("kind") != "xpace.proxy_route_reserve.v1":
        fail("unsupported manifest schema")
    if root.get("credential_free") is not True:
        fail("manifest must declare credential_free=true")
    if not isinstance(root.get("generated_at"), str) or not isinstance(root.get("purpose"), str):
        fail("manifest metadata is incomplete")
    raw_routes = root.get("routes")
    if not isinstance(raw_routes, list) or len(raw_routes) != len(EXPECTED_ROUTES):
        fail("manifest must contain exactly the two paired reserve routes")

    routes = [validate_route(route) for route in raw_routes]
    if {route["route_id"] for route in routes} != set(EXPECTED_ROUTES):
        fail("manifest reserve route pair is incomplete")
    routes.sort(key=lambda route: int(route["internal_endpoint"]["port"]))
    return routes


def rewrite_config(template: str, route: dict[str, Any]) -> str:
    clone_ip = route["clone_from"]["reserved_device_ip"]
    target_ip = route["reserved_device_ip"]
    output: list[str] = []
    allow_count = 0
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
            raise RouteStageError("template config cannot be parsed safely") from exc
        if not tokens:
            output.append(raw_line)
            continue

        directive = tokens[0].lower()
        if directive == "allow":
            allow_count += 1
            if raw_line.count(clone_ip) != 1:
                fail("template must have one exclusive source ACL for its assigned device")
            output.append(raw_line.replace(clone_ip, target_ip, 1))
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
            rewritten = [tokens[0]]
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

    if allow_count != 1:
        fail(f"template must contain exactly one exclusive allow directive; found {allow_count}")
    if parent_count != 1:
        fail(f"template must contain exactly one parent directive; found {parent_count}")
    if listener_count != 1:
        fail(f"template must contain exactly one proxy listener; found {listener_count}")
    if deny_count < 1:
        fail("template must retain a deny rule")

    rewritten_config = "".join(output)
    if clone_ip != target_ip and clone_ip in rewritten_config:
        fail("template source ACL substitution was incomplete")
    return rewritten_config


def rewrite_unit(template: str, clone_route_id: str, target_route_id: str) -> str:
    if template.count(clone_route_id) < 1:
        fail("template unit does not reference its declared clone route")
    rewritten = template.replace(clone_route_id, target_route_id)
    if clone_route_id in rewritten or target_route_id not in rewritten:
        fail("template unit substitution was incomplete")
    return rewritten


def read_regular_template(path: Path, label: str) -> tuple[str, os.stat_result]:
    try:
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
            fail(f"{label} must be a regular, non-symlink file")
        return path.read_text(encoding="utf-8"), metadata
    except RouteStageError:
        raise
    except OSError as exc:
        raise RouteStageError(f"unable to read {label}") from exc


def build_artifacts(
    routes: Iterable[dict[str, Any]], config_dir: Path, unit_dir: Path
) -> list[Artifact]:
    if not config_dir.is_dir() or not unit_dir.is_dir():
        fail("config and unit directories must already exist")
    artifacts: list[Artifact] = []
    seen_targets: set[Path] = set()

    for route in routes:
        route_id = route["route_id"]
        clone_route_id = route["clone_from"]["route_id"]
        config_template_path = config_dir / f"{clone_route_id}.cfg"
        unit_template_path = unit_dir / f"xpace-3proxy-{clone_route_id}.service"
        config_template, config_stat = read_regular_template(
            config_template_path, f"config template for {route_id}"
        )
        unit_template, unit_stat = read_regular_template(
            unit_template_path, f"unit template for {route_id}"
        )

        candidates = [
            Artifact(
                target=config_dir / f"{route_id}.cfg",
                content=rewrite_config(config_template, route).encode("utf-8"),
                mode=stat.S_IMODE(config_stat.st_mode),
                uid=config_stat.st_uid,
                gid=config_stat.st_gid,
                route_id=route_id,
                kind="config",
            ),
            Artifact(
                target=unit_dir / f"xpace-3proxy-{route_id}.service",
                content=rewrite_unit(unit_template, clone_route_id, route_id).encode("utf-8"),
                mode=stat.S_IMODE(unit_stat.st_mode),
                uid=unit_stat.st_uid,
                gid=unit_stat.st_gid,
                route_id=route_id,
                kind="unit",
            ),
        ]
        for artifact in candidates:
            if artifact.target in seen_targets:
                fail("duplicate target path in reserve route pair")
            seen_targets.add(artifact.target)
            artifacts.append(artifact)
    return artifacts


def fsync_directory(directory: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    descriptor = os.open(directory, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def publish_exclusive(artifact: Artifact) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{artifact.target.name}.", suffix=".stage", dir=artifact.target.parent
    )
    temporary = Path(temporary_name)
    published = False
    try:
        os.fchown(descriptor, artifact.uid, artifact.gid)
        os.fchmod(descriptor, artifact.mode)
        with os.fdopen(descriptor, "wb") as handle:
            descriptor = -1
            handle.write(artifact.content)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temporary, artifact.target)
            published = True
        except FileExistsError as exc:
            raise RouteStageError(
                f"refusing to overwrite existing {artifact.kind} for {artifact.route_id}"
            ) from exc
        temporary.unlink()
        fsync_directory(artifact.target.parent)
    except Exception:
        if published:
            try:
                artifact.target.unlink()
                fsync_directory(artifact.target.parent)
            except OSError:
                pass
        raise
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def run_daemon_reload(*, check: bool) -> bool:
    result = subprocess.run(
        ["systemctl", "daemon-reload"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if check and result.returncode != 0:
        fail("systemd daemon-reload failed")
    return result.returncode == 0


def require_root() -> None:
    get_effective_uid = getattr(os, "geteuid", None)
    if get_effective_uid is None or get_effective_uid() != 0:
        fail("stage and rollback operations must run as root on Proxy Orch")


def restore_artifacts(artifacts: Iterable[Artifact]) -> list[str]:
    failures: list[str] = []
    for artifact in artifacts:
        if artifact.target.exists() or artifact.target.is_symlink():
            failures.append(artifact.target.name)
            continue
        try:
            publish_exclusive(artifact)
        except (OSError, RouteStageError):
            failures.append(artifact.target.name)
    return failures


def stage(routes: list[dict[str, Any]], args: argparse.Namespace) -> None:
    require_root()
    if args.approve != APPLY_APPROVAL:
        fail(f"--apply requires --approve {APPLY_APPROVAL}")

    artifacts = build_artifacts(routes, args.config_dir, args.unit_dir)
    for artifact in artifacts:
        if artifact.target.exists() or artifact.target.is_symlink():
            fail(f"refusing to overwrite existing {artifact.kind} for {artifact.route_id}")

    created: list[Artifact] = []
    try:
        for artifact in artifacts:
            publish_exclusive(artifact)
            created.append(artifact)
        run_daemon_reload(check=True)
    except Exception as exc:
        cleanup_failures: list[str] = []
        for artifact in reversed(created):
            try:
                artifact.target.unlink()
                fsync_directory(artifact.target.parent)
            except FileNotFoundError:
                pass
            except OSError:
                cleanup_failures.append(artifact.target.name)
        run_daemon_reload(check=False)
        if cleanup_failures:
            raise RouteStageError(
                "staging failed; manual recovery is required for: " + ", ".join(cleanup_failures)
            ) from exc
        raise RouteStageError("staging failed; all newly created target files were removed") from exc

    print(f"STAGED={len(routes)} routes")
    print("STARTED=0")
    print("ENABLED=0")
    print("DAEMON_RELOADED=1")


def service_is_active_or_enabled(route_id: str) -> bool:
    unit = f"xpace-3proxy-{route_id}.service"
    for operation in ("is-active", "is-enabled"):
        result = subprocess.run(
            ["systemctl", operation, "--quiet", unit],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if result.returncode == 0:
            return True
    return False


def rollback(routes: list[dict[str, Any]], args: argparse.Namespace) -> None:
    require_root()
    if args.approve != ROLLBACK_APPROVAL:
        fail(f"--rollback requires --approve {ROLLBACK_APPROVAL}")

    artifacts = build_artifacts(routes, args.config_dir, args.unit_dir)
    for route in routes:
        if service_is_active_or_enabled(route["route_id"]):
            fail(f"refusing rollback while route service is active or enabled: {route['route_id']}")

    backups: list[Artifact] = []
    for artifact in artifacts:
        try:
            metadata = artifact.target.lstat()
        except FileNotFoundError as exc:
            raise RouteStageError(
                "paired rollback requires every staged config and unit to be present"
            ) from exc
        if not stat.S_ISREG(metadata.st_mode) or artifact.target.is_symlink():
            fail(f"refusing rollback of non-regular target for {artifact.route_id}")
        try:
            actual_content = artifact.target.read_bytes()
        except OSError as exc:
            raise RouteStageError(f"unable to verify rollback target for {artifact.route_id}") from exc
        if actual_content != artifact.content:
            fail(f"refusing rollback because staged target changed for {artifact.route_id}")
        backups.append(
            Artifact(
                target=artifact.target,
                content=actual_content,
                mode=stat.S_IMODE(metadata.st_mode),
                uid=metadata.st_uid,
                gid=metadata.st_gid,
                route_id=artifact.route_id,
                kind=artifact.kind,
            )
        )

    removed: list[Artifact] = []
    try:
        # Units first keeps systemd's on-disk view paired during the transaction.
        for artifact in sorted(backups, key=lambda item: item.kind != "unit"):
            artifact.target.unlink()
            removed.append(artifact)
            fsync_directory(artifact.target.parent)
        run_daemon_reload(check=True)
    except Exception as exc:
        restore_failures = restore_artifacts(removed)
        run_daemon_reload(check=False)
        if restore_failures:
            raise RouteStageError(
                "rollback failed; manual recovery is required for: " + ", ".join(restore_failures)
            ) from exc
        raise RouteStageError("rollback failed; the paired target files were restored") from exc

    print(f"ROLLED_BACK={len(routes)} routes")
    print("STOPPED=0")
    print("DISABLED=0")
    print("DAEMON_RELOADED=1")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Plan or transactionally stage the two Fleet 60 reserve routes."
    )
    parser.add_argument("--manifest", type=Path, required=True)
    operation = parser.add_mutually_exclusive_group()
    operation.add_argument("--apply", action="store_true", help="stage both routes; starts no service")
    operation.add_argument(
        "--rollback", action="store_true", help="remove only the unchanged paired target files"
    )
    parser.add_argument("--approve", default="")
    parser.add_argument("--config-dir", type=Path, default=Path("/etc/xpace/proxy/routes"))
    parser.add_argument("--unit-dir", type=Path, default=Path("/etc/systemd/system"))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        routes = load_routes(args.manifest.resolve(strict=True))
        for route in routes:
            print(
                f'PLAN route={route["route_id"]} device={route["assigned_device_id"]} '
                f'adb={route["adb_serial"]} listener={route["internal_endpoint"]["port"]} '
                f'upstream_port={route["provider_endpoint"]["port"]} '
                f'expected_ip={route["expected_public_ip"]}'
            )
        if args.apply:
            stage(routes, args)
        elif args.rollback:
            rollback(routes, args)
        else:
            print("MODE=plan (no files, services, listeners, or firewall rules changed)")
        return 0
    except (OSError, RouteStageError) as exc:
        print(f"ERROR: {exc}", file=os.sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
