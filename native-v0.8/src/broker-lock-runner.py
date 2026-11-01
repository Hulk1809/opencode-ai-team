#!/usr/bin/python3
"""Trusted launcher: kernel lock released on crash, no PID-based lock stealing.

Owner installs reviewed launcher/code under root-owned paths. No use from mutable
checkout in production. Arguments fixed by root-owned unit, not submit requests.
"""
import fcntl
import os
import sys
import stat

if len(sys.argv) < 4 or not os.path.isabs(sys.argv[1]) or not os.path.isabs(sys.argv[2]):
    raise SystemExit('usage: broker-lock-runner.py ABS_LOCK ABS_EXECUTABLE ARGS...')
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
info = os.fstat(fd)
if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
    raise SystemExit('unsafe broker lock')
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit('broker already running')
os.set_inheritable(fd, True)
os.environ['AI_TEAM_LOCK_FD'] = str(fd)
os.execv(sys.argv[2], sys.argv[2:])
