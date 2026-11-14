#!/usr/bin/env python3
"""One-shot, credential-safe HTTP check of the three existing Fleet61 parents.

Run as root on Proxy Orch. Reads existing route configs but never writes files,
changes services, or prints credentials. No command-line secret arguments.
"""

from __future__ import annotations

import base64
import ipaddress
import shlex
import socket
from pathlib import Path


ROUTES = (
    ('fleet61-shared-santa-clara-a', 10021),
    ('fleet61-shared-santa-clara-b', 10022),
    ('fleet61-shared-santa-clara-c', 10025),
)
CONFIG_DIR = Path('/etc/xpace/proxy/routes')


class ProbeError(Exception):
    """A fixed, credential-free diagnostic code."""


def parent_fields(route_id: str, expected_port: int) -> tuple[str, int, str, str]:
    path = CONFIG_DIR / f'{route_id}.cfg'
    parents = []
    for line in path.read_text(encoding='utf-8').splitlines():
        tokens = shlex.split(line, comments=True)
        if tokens and tokens[0].lower() == 'parent':
            parents.append(tokens)
    if len(parents) != 1:
        raise ProbeError(f'PARENT_COUNT_{len(parents)}')
    if len(parents[0]) < 7:
        raise ProbeError(f'PARENT_FIELD_COUNT_{len(parents[0])}')
    _, _weight, _mode, host, port_text, username, password = parents[0][:7]
    try:
        port = int(port_text)
    except ValueError:
        raise ProbeError('PARENT_PORT_INVALID') from None
    if port != expected_port:
        raise ProbeError('PARENT_PORT_MISMATCH')
    return host, port, username, password


def probe(host: str, port: int, username: str, password: str) -> tuple[int, str]:
    token = base64.b64encode(f'{username}:{password}'.encode()).decode('ascii')
    request = (
        'GET http://api.ipify.org/ HTTP/1.1\r\n'
        'Host: api.ipify.org\r\n'
        f'Proxy-Authorization: Basic {token}\r\n'
        'Connection: close\r\n\r\n'
    ).encode('ascii')
    with socket.create_connection((host, port), timeout=8) as sock:
        sock.settimeout(8)
        sock.sendall(request)
        payload = bytearray()
        while len(payload) < 32768:
            chunk = sock.recv(min(4096, 32768 - len(payload)))
            if not chunk:
                break
            payload.extend(chunk)
    header, _, body = bytes(payload).partition(b'\r\n\r\n')
    first_line = header.split(b'\r\n', 1)[0].decode('ascii', 'replace')
    parts = first_line.split(' ', 2)
    if len(parts) < 2 or not parts[0].startswith('HTTP/') or not parts[1].isdigit():
        raise ProbeError('UPSTREAM_RESPONSE_UNRECOGNIZED')
    status = int(parts[1])
    exit_ip = '-'
    if status == 200:
        try:
            exit_ip = str(ipaddress.IPv4Address(body.strip().decode('ascii')))
        except (UnicodeError, ValueError):
            exit_ip = 'unparsed'
    return status, exit_ip


def main() -> int:
    for route_id, port in ROUTES:
        try:
            host, checked_port, username, password = parent_fields(route_id, port)
            status, exit_ip = probe(host, checked_port, username, password)
            print(f'ROUTE={route_id} UPSTREAM_PORT={port} HTTP={status} EXIT={exit_ip}', flush=True)
        except ProbeError as exc:
            print(f'ROUTE={route_id} UPSTREAM_PORT={port} ERROR={exc}', flush=True)
        except (OSError, ValueError, UnicodeError) as exc:
            print(f'ROUTE={route_id} UPSTREAM_PORT={port} ERROR={type(exc).__name__}', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
