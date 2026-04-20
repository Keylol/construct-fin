#!/usr/bin/env python3
"""Keeps a Cloudflare quick tunnel alive and updates the live Mini App URL."""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv


PROJECT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_DIR / "data"
ENV_PATH = PROJECT_DIR / ".env"
URL_FILE = DATA_DIR / "miniapp_tunnel_url.txt"
URL_RE = re.compile(r"https://[a-z0-9.-]+\.[a-z]{2,}(?:/[^\s]*)?", re.IGNORECASE)
LOCALHOST_RUN_URL_RE = re.compile(r"https://([a-z0-9-]+\.)?lhr\.life", re.IGNORECASE)
CLOUDFLARE_URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com", re.IGNORECASE)

load_dotenv(ENV_PATH)


def write_runtime_url(url: str) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    URL_FILE.write_text(url.strip() + "\n", encoding="utf-8")


def update_env_url(url: str) -> None:
    lines = ENV_PATH.read_text(encoding="utf-8").splitlines()
    updated: list[str] = []
    replaced = False
    for line in lines:
        if line.startswith("MINIAPP_URL="):
            updated.append(f"MINIAPP_URL={url}")
            replaced = True
        else:
            updated.append(line)
    if not replaced:
        updated.append(f"MINIAPP_URL={url}")
    ENV_PATH.write_text("\n".join(updated) + "\n", encoding="utf-8")


def wait_until_public(url: str, timeout_seconds: int = 25) -> None:
    deadline = time.time() + timeout_seconds
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            with httpx.Client(timeout=8.0, trust_env=True, follow_redirects=True) as client:
                response = client.get(url)
            if response.status_code == 200:
                return
            last_error = RuntimeError(f"Unexpected status {response.status_code}")
        except Exception as exc:  # pragma: no cover - network dependent
            last_error = exc
        time.sleep(1.5)
    if last_error:
        print(f"[miniapp_tunnel] public URL still warming up: {last_error}", flush=True)


def update_telegram_menu_button(url: str) -> None:
    token = str(os.getenv("TELEGRAM_BOT_TOKEN", "")).strip()
    if not token:
        print("[miniapp_tunnel] TELEGRAM_BOT_TOKEN is empty, skip menu button update", flush=True)
        return

    base = f"https://api.telegram.org/bot{token}"
    payload = {
        "menu_button": json.dumps(
            {"type": "web_app", "text": "Mini App", "web_app": {"url": url}},
            ensure_ascii=False,
        )
    }
    with httpx.Client(timeout=15.0, trust_env=True) as client:
        response = client.post(base + "/setChatMenuButton", data=payload)
        response.raise_for_status()
        print(f"[miniapp_tunnel] setChatMenuButton -> {response.text}", flush=True)


def main() -> int:
    provider = str(os.getenv("MINIAPP_TUNNEL_PROVIDER", "cloudflared")).strip().lower()
    target_url = str(os.getenv("MINIAPP_TUNNEL_TARGET", "http://127.0.0.1:8081")).strip() or "http://127.0.0.1:8081"
    if provider == "cloudflared":
        cloudflared_bin = PROJECT_DIR / ".setup" / "tools" / "bin" / "cloudflared"
        if not cloudflared_bin.exists():
            print(f"[miniapp_tunnel] cloudflared not found at {cloudflared_bin}", flush=True)
            return 1
        command = [str(cloudflared_bin), "tunnel", "--url", target_url]
    else:
        remote_target = target_url.replace("http://", "").replace("https://", "")
        command = [
            "/usr/bin/ssh",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "ServerAliveInterval=30",
            "-R",
            f"80:{remote_target}",
            "nokey@localhost.run",
        ]

    print(f"[miniapp_tunnel] starting: {' '.join(shlex.quote(part) for part in command)}", flush=True)
    process = subprocess.Popen(
        command,
        cwd=PROJECT_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    seen_url = ""
    try:
        assert process.stdout is not None
        for raw_line in process.stdout:
            line = raw_line.rstrip("\n")
            print(line, flush=True)
            if provider == "localhost_run":
                if "tunneled with tls termination" not in line:
                    continue
                match = LOCALHOST_RUN_URL_RE.search(line)
            elif provider == "cloudflared":
                match = CLOUDFLARE_URL_RE.search(line)
            else:
                match = URL_RE.search(line)
            if match:
                detected_url = match.group(0)
                if detected_url == seen_url:
                    continue
                seen_url = detected_url
                print(f"[miniapp_tunnel] detected url: {seen_url}", flush=True)
                write_runtime_url(seen_url)
                update_env_url(seen_url)
                wait_until_public(seen_url)
                try:
                    update_telegram_menu_button(seen_url)
                except Exception as exc:  # pragma: no cover - network dependent
                    print(f"[miniapp_tunnel] menu button update failed: {exc}", flush=True)
        return process.wait()
    finally:
        if process.poll() is None:
            process.terminate()


if __name__ == "__main__":
    sys.exit(main())
