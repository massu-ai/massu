#!/usr/bin/env python3
"""Probe the two log-rotation strategies against a held O_APPEND writer.

This exists because a CLAIM LEDGER row asserts what `copytruncate` does, and a claim about
reality needs a probe rather than a citation. It is self-contained and reader-executable:
no fixtures, no repo state, nothing to install (the ledger's own audit-1 repair exists
because earlier rows cited a scratchpad directory that did not exist).

    TRUNCATE IN PLACE  the inode survives, so a writer holding an O_APPEND descriptor keeps
                       appending into the file we still read.
    MOVE AND RECREATE  the descriptor stays bound to the ORPHANED inode: the writer keeps
                       appending to a file nobody reads while the new one stays empty
                       forever -- the healthiest-looking possible death of an evidence
                       channel.

Exits 0 only if BOTH behaviours are observed. If either stops holding on some future
platform, this goes red rather than quietly agreeing with the comment it justifies.
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile


def main() -> int:
    d = tempfile.mkdtemp(prefix="copytruncate-probe-")
    ok = True

    # --- strategy 1: copy, then truncate in place (logrotate's `copytruncate`).
    p = os.path.join(d, "t.log")
    with open(p, "w") as fh:
        fh.write("pre\n")
    fd = os.open(p, os.O_WRONLY | os.O_APPEND)      # the long-lived writer
    ino0 = os.stat(p).st_ino
    shutil.copy(p, os.path.join(d, "t.copy"))
    os.truncate(p, 0)                                # exactly what `: > file` does
    os.write(fd, b"post\n")
    os.close(fd)
    same = ino0 == os.stat(p).st_ino
    live = open(p).read()
    copy = open(os.path.join(d, "t.copy")).read()
    print(f"TRUNCATE  inode same: {str(same):<5}  live={live!r:<8} copy={copy!r}")
    if not (same and live == "post\n" and copy == "pre\n"):
        print("  FAIL: truncation did not keep the writer in the live file", file=sys.stderr)
        ok = False

    # --- strategy 2: move, then recreate. The writer is orphaned.
    q = os.path.join(d, "m.log")
    with open(q, "w") as fh:
        fh.write("pre\n")
    fd = os.open(q, os.O_WRONLY | os.O_APPEND)
    ino0 = os.stat(q).st_ino
    os.rename(q, os.path.join(d, "m.moved"))
    open(q, "w").close()
    os.write(fd, b"post\n")
    os.close(fd)
    same = ino0 == os.stat(q).st_ino
    live = open(q).read()
    orphan = open(os.path.join(d, "m.moved")).read()
    print(f"MOVE      inode same: {str(same):<5}  live={live!r:<8} orphan={orphan!r}")
    if not (not same and live == "" and orphan == "pre\npost\n"):
        print("  FAIL: move did not orphan the writer as expected", file=sys.stderr)
        ok = False

    print(f"probe dir: {d}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
