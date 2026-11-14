#!/usr/bin/env python3
"""Add reserved Fleet61 .183 to only route C's source ACL, with rollback.

Run on Proxy Orch as root only after route C passes HTTP and HTTPS tests.
Never prints provider credentials or changes upstream, listener, or firewall.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path


ROUTE = 'fleet61-shared-santa-clara-c'
CONFIG = Path(f'/etc/xpace/proxy/routes/{ROUTE}.cfg')
UNIT = f'xpace-3proxy-{ROUTE}.service'
BACKUP = Path('/etc/xpace/proxy/routes/.cohort-backups/fleet61-c-add-183-20261031.cfg')
OLD = '192.168.61.208,192.168.61.209,192.168.61.210,192.168.61.213,192.168.61.214,192.168.52.10'
NEW = '192.168.61.183,' + OLD
APPROVAL = 'ADD_FLEET61_C_183_20261031'
ALLOW_RE = re.compile(r'^(\s*allow\s+\S+\s+)(\S+)(.*)$', re.IGNORECASE)


def fail(message: str) -> None:
    raise SystemExit(f'ERROR: {message}')


def source_acl(content: str) -> str:
    matches = []
    for line in content.splitlines():
        match = ALLOW_RE.match(line)
        if match:
            matches.append(match.group(2))
    if len(matches) != 1:
        fail('expected exactly one allow directive')
    return matches[0]


def replace_source(content: str, old: str, new: str) -> str:
    if source_acl(content) != old:
        fail('source ACL precondition failed')
    lines = []
    count = 0
    for line in content.splitlines(keepends=True):
        match = ALLOW_RE.match(line)
        if match:
            lines.append(line.replace(old, new, 1))
            count += 1
        else:
            lines.append(line)
    updated = ''.join(lines)
    if count != 1 or source_acl(updated) != new:
        fail('source ACL rewrite failed')
    return updated


def atomic_write(content: str, info: os.stat_result) -> None:
    fd, temporary = tempfile.mkstemp(prefix='.fleet61-c-', dir=CONFIG.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chown(temporary, info.st_uid, info.st_gid)
        os.chmod(temporary, stat.S_IMODE(info.st_mode))
        os.replace(temporary, CONFIG)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def restart() -> None:
    subprocess.run(['systemctl', 'restart', UNIT], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['systemctl', 'is-active', '--quiet', UNIT], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', required=True, choices=('inspect', 'apply', 'rollback'))
    parser.add_argument('--approve', default='')
    args = parser.parse_args()
    if os.geteuid() != 0:
        fail('run as root on Proxy Orch')
    if not CONFIG.is_file() or CONFIG.is_symlink():
        fail('route C config is not a regular file')
    original = CONFIG.read_text(encoding='utf-8')
    current = source_acl(original)
    if args.phase == 'inspect':
        if current not in (OLD, NEW):
            fail('route C source ACL differs from expected')
        print(f'ROUTE={ROUTE} SOURCE_COUNT={len(current.split(",")) - 1} '
              f'INCLUDES_183={"192.168.61.183" in current.split(",")} '
              f'BACKUP_EXISTS={BACKUP.exists()}')
        return 0
    if args.approve != APPROVAL:
        fail('approval token mismatch')
    info = CONFIG.stat()
    if args.phase == 'apply':
        updated = replace_source(original, OLD, NEW)
        if BACKUP.exists():
            fail('backup already exists; refusing repeat')
        BACKUP.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(BACKUP.parent, 0o700)
        with BACKUP.open('xb') as target, CONFIG.open('rb') as source:
            os.fchmod(target.fileno(), 0o600)
            shutil.copyfileobj(source, target)
        try:
            atomic_write(updated, info)
            restart()
        except (OSError, subprocess.CalledProcessError):
            atomic_write(original, info)
            try:
                restart()
            except (OSError, subprocess.CalledProcessError):
                pass
            fail('route C update failed; original config restored and restart attempted')
        print('PHASE=apply ROUTE=C SOURCE_COUNT=6 ACTIVE=1 FIREWALL_CHANGED=0')
        return 0
    if not BACKUP.is_file() or BACKUP.is_symlink():
        fail('rollback backup missing or invalid')
    saved = BACKUP.read_text(encoding='utf-8')
    if source_acl(saved) != OLD or current != NEW:
        fail('rollback precondition failed')
    atomic_write(saved, info)
    restart()
    print('PHASE=rollback ROUTE=C SOURCE_COUNT=5 ACTIVE=1 FIREWALL_CHANGED=0')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
