#!/usr/bin/env python3
"""Stage three Box 2 shared static-proxy routes on Proxy Orch; never start them.

Run on VM 520 as root. Provider credentials stay inside the existing root-owned
3proxy template and the staged root-owned configs; this tool never prints them.
The unreserved .183 device is intentionally excluded from its ACL.
"""

from __future__ import annotations

import argparse
import os
import re
import shlex
import socket
import stat
import subprocess
from pathlib import Path


CONFIG_DIR = Path('/etc/xpace/proxy/routes')
UNIT_DIR = Path('/etc/systemd/system')
CLONE_ID = 'fleet60-fleet1-dc01'
BIND_IP = '192.168.52.10'
APPROVAL = 'STAGE_FLEET61_THREE_EXITS_20261030'
ROUTES = (
    ('fleet61-shared-santa-clara-a', 8301, 10021,
     ('192.168.61.194', '192.168.61.195', '192.168.61.196',
      '192.168.61.197', '192.168.61.198', '192.168.61.199', '192.168.61.200')),
    ('fleet61-shared-santa-clara-b', 8302, 10022,
     ('192.168.61.201', '192.168.61.202', '192.168.61.203',
      '192.168.61.204', '192.168.61.205', '192.168.61.206', '192.168.61.207')),
    ('fleet61-shared-santa-clara-c', 8303, 10025,
     ('192.168.61.208', '192.168.61.209', '192.168.61.210',
      '192.168.61.213', '192.168.61.214')),
)


def require_regular(path: Path) -> tuple[str, os.stat_result]:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.is_symlink():
        raise RuntimeError('template is not a regular file')
    return path.read_text(encoding='utf-8'), info


def rewrite_config(template: str, source_ips: tuple[str, ...], port: int,
                   upstream_port: int) -> str:
    counts = {'allow': 0, 'parent': 0, 'proxy': 0, 'deny': 0}
    rewritten = []
    template_source = None
    for raw in template.splitlines(keepends=True):
        stripped = raw.strip()
        if not stripped or stripped.startswith('#'):
            rewritten.append(raw)
            continue
        tokens = shlex.split(stripped, comments=True, posix=True)
        if not tokens:
            rewritten.append(raw)
            continue
        kind = tokens[0].lower()
        if kind in counts:
            counts[kind] += 1
        ending = '\n' if raw.endswith('\n') else ''
        if kind == 'allow':
            matches = re.findall(r'(?<![0-9.])192\.168\.60\.\d{1,3}(?![0-9.])', raw)
            if len(matches) != 1:
                raise RuntimeError('template requires exactly one Box 1 device source ACL')
            template_source = matches[0]
            rewritten.append(raw.replace(template_source, ','.join(source_ips), 1))
        elif kind == 'parent':
            if len(tokens) < 5:
                raise RuntimeError('template parent directive is incomplete')
            tokens[3], tokens[4] = 'dc.decodo.com', str(upstream_port)
            rewritten.append(shlex.join(tokens) + ending)
        elif kind == 'proxy':
            options = []
            found_port = found_bind = False
            for token in tokens[1:]:
                if token.startswith('-p'):
                    options.append(f'-p{port}')
                    found_port = True
                elif token.startswith('-i'):
                    options.append(f'-i{BIND_IP}')
                    found_bind = True
                else:
                    options.append(token)
            if not found_port:
                options.append(f'-p{port}')
            if not found_bind:
                options.append(f'-i{BIND_IP}')
            rewritten.append(shlex.join([tokens[0], *options]) + ending)
        else:
            rewritten.append(raw)
    if any(counts[key] != 1 for key in ('allow', 'parent', 'proxy')) or counts['deny'] < 1:
        raise RuntimeError('template directive counts differ from expected')
    result = ''.join(rewritten)
    if template_source is not None and template_source in result:
        raise RuntimeError('template source substitution incomplete')
    return result


def check_port_available(port: int) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((BIND_IP, port))


def publish(path: Path, data: bytes, template_info: os.stat_result) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(path, flags, stat.S_IMODE(template_info.st_mode))
    try:
        os.fchown(fd, template_info.st_uid, template_info.st_gid)
        os.fchmod(fd, stat.S_IMODE(template_info.st_mode))
        with os.fdopen(fd, 'wb', closefd=False) as output:
            output.write(data)
            output.flush()
            os.fsync(fd)
    except Exception:
        os.close(fd)
        path.unlink(missing_ok=True)
        raise
    else:
        os.close(fd)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', action='store_true', help='write configs and units; start nothing')
    parser.add_argument('--approve', default='')
    args = parser.parse_args()
    if args.stage and args.approve != APPROVAL:
        parser.error(f'--stage requires --approve {APPROVAL}')
    if args.stage and os.geteuid() != 0:
        parser.error('--stage requires root')

    print('CHECK=config-template', flush=True)
    template, config_info = require_regular(CONFIG_DIR / f'{CLONE_ID}.cfg')
    print('CHECK=unit-template', flush=True)
    unit, unit_info = require_regular(UNIT_DIR / f'xpace-3proxy-{CLONE_ID}.service')
    if unit.count(CLONE_ID) < 1:
        raise RuntimeError('template unit does not reference expected source route')
    pending = []
    for route_id, port, upstream_port, sources in ROUTES:
        print(f'CHECK={route_id}', flush=True)
        check_port_available(port)
        config_path = CONFIG_DIR / f'{route_id}.cfg'
        unit_path = UNIT_DIR / f'xpace-3proxy-{route_id}.service'
        if config_path.exists() or unit_path.exists() or config_path.is_symlink() or unit_path.is_symlink():
            raise RuntimeError(f'target already exists: {route_id}')
        config = rewrite_config(template, sources, port, upstream_port)
        target_unit = unit.replace(CLONE_ID, route_id)
        pending.extend(((config_path, config.encode(), config_info),
                        (unit_path, target_unit.encode(), unit_info)))
        print(f'PLANNED route={route_id} listener={BIND_IP}:{port} upstream_port={upstream_port} source_count={len(sources)}')
    if not args.stage:
        print('MODE=plan; no files, services, or firewall rules changed')
        return 0

    created = []
    try:
        for path, data, info in pending:
            publish(path, data, info)
            created.append(path)
        subprocess.run(['systemctl', 'daemon-reload'], check=True, capture_output=True)
    except Exception:
        for path in reversed(created):
            path.unlink(missing_ok=True)
        subprocess.run(['systemctl', 'daemon-reload'], check=False, capture_output=True)
        raise
    print('STAGED=3; STARTED=0; FIREWALL_CHANGED=0; DEVICE_PROXY_CHANGED=0')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        # Only fixed messages raised by this module are safe to print.
        safe = {
            'template is not a regular file',
            'template requires exactly one Box 1 device source ACL',
            'template parent directive is incomplete',
            'template directive counts differ from expected',
            'template source substitution incomplete',
            'template unit does not reference expected source route',
        }
        message = str(exc)
        if message not in safe and not message.startswith('target already exists: fleet61-shared-santa-clara-'):
            message = 'unexpected runtime error'
        raise SystemExit(f'ERROR: {message}; staging not completed') from None
    except (OSError, subprocess.CalledProcessError) as exc:
        # Never echo config content, command output, or provider credentials.
        raise SystemExit(f'ERROR: {type(exc).__name__}; staging not completed') from None
