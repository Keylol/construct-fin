#!/usr/bin/env python3
"""Creates gzip SQL dump + sha256 for local PostgreSQL."""

from __future__ import annotations

import gzip
import hashlib
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path


def _env(name: str, default: str) -> str:
    return str(os.getenv(name, default)).strip()


def _sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    project_dir = Path(__file__).resolve().parents[1]
    pg_bin_dir = Path(_env("PG_BIN_DIR", str(project_dir / ".setup" / "tools" / "postgres" / "pgsql" / "bin")))
    backup_dir = Path(_env("BACKUP_DIR", str(project_dir / "backups" / "postgres")))
    pg_host = _env("PG_HOST", "/tmp")
    pg_port = _env("PG_PORT", "5432")
    pg_user = _env("PG_USER", "construct")
    pg_db = _env("PG_DB", "construct_miniapp")

    pg_dump = pg_bin_dir / "pg_dump"
    if not pg_dump.exists():
        print(f"pg_dump not found: {pg_dump}", file=sys.stderr)
        return 1

    backup_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    tmp_file = backup_dir / f".{pg_db}_{timestamp}.sql.gz.tmp"
    backup_file = backup_dir / f"{pg_db}_{timestamp}.sql.gz"
    checksum_file = Path(f"{backup_file}.sha256")

    env = os.environ.copy()
    cmd = [
        str(pg_dump),
        "-h",
        pg_host,
        "-p",
        pg_port,
        "-U",
        pg_user,
        "-d",
        pg_db,
        "--no-owner",
        "--no-privileges",
    ]

    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    assert process.stdout is not None
    assert process.stderr is not None

    with gzip.open(tmp_file, "wb") as gz:
        for chunk in iter(lambda: process.stdout.read(1024 * 1024), b""):
            gz.write(chunk)

    stderr_text = process.stderr.read().decode("utf-8", errors="replace")
    exit_code = process.wait()
    if exit_code != 0:
        try:
            tmp_file.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass
        print(stderr_text or f"pg_dump exited with code {exit_code}", file=sys.stderr)
        return exit_code

    tmp_file.replace(backup_file)
    digest = _sha256_of(backup_file)
    checksum_file.write_text(f"{digest}  {backup_file.name}\n", encoding="utf-8")

    print("Backup created:")
    print(f"  {backup_file}")
    print(f"  {checksum_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
