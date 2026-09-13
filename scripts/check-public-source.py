#!/usr/bin/env python3
"""Review tracked source (and optionally HEAD history), printing locations only."""

from __future__ import annotations

import argparse
from pathlib import Path, PurePosixPath
import re
import subprocess


PRIVATE_DIRS = {".agentctl", ".loopctl", ".iseeagents", ".sessiongraph", ".venv", "node_modules", "__pycache__", ".pytest_cache"}
PRIVATE_SUFFIXES = {".sqlite", ".db", ".pem", ".p12", ".pfx", ".key", ".pyc"}
HOME_PATH = re.compile(r"/(?:Users|home)/[^/\s\"'<>]+|[A-Za-z]:\\Users\\[^\\\s\"'<>]+")
PRIVATE_IP = re.compile(r"\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b")
EMAIL = re.compile(r"[\w.+-]+@([\w.-]+\.[A-Za-z]{2,})")
TEST_EMAIL_DOMAINS = {"example.com", "example.org", "example.net", "example.invalid"}
TOKEN = re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{32,})\b")


def inspect_file(name: str, content: bytes) -> list[str]:
    path = PurePosixPath(name)
    findings = []
    if (set(path.parts) & PRIVATE_DIRS or path.suffix in PRIVATE_SUFFIXES
            or path.name in {"id_rsa", "id_ed25519", ".env"}
            or (path.name.startswith(".env.") and path.name != ".env.example")):
        findings.append(f"{name}: private runtime/credential filename")
    if path.suffix == ".jsonl" and not ({"fixtures", "examples"} & set(path.parts)):
        findings.append(f"{name}: JSONL outside synthetic fixture/example directories")
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        return findings + [f"{name}: binary content needs explicit release review"]
    for number, line in enumerate(text.splitlines(), 1):
        labels = []
        if HOME_PATH.search(line):
            labels.append("absolute personal home path")
        if PRIVATE_IP.search(line):
            labels.append("private network address")
        if any(m.group(1).lower() not in TEST_EMAIL_DOMAINS
               and m.group(1).lower() not in {"noreply.github.com", "users.noreply.github.com"}
               for m in EMAIL.finditer(line)):
            labels.append("non-example email address")
        if TOKEN.search(line):
            labels.append("credential-shaped token")
        if labels:
            findings.append(f"{name}:{number}: {', '.join(labels)}")
    return findings


def git(root: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(root), *args])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--history", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    findings = []
    entries = git(root, "ls-files", "--stage", "-z").decode().split("\0")
    checked = 0
    for entry in filter(None, entries):
        metadata, name = entry.split("\t", 1)
        mode = metadata.split()[0]
        if mode not in {"100644", "100755"}:
            findings.append(f"{name}: symlink/submodule needs explicit release review")
            continue
        file = root / name
        if not file.is_file() or file.is_symlink():
            findings.append(f"{name}: missing or symlinked tracked source")
            continue
        findings.extend(inspect_file(name, file.read_bytes()))
        checked += 1
    if checked == 0:
        findings.append("No tracked source files were checked")
    historical = 0
    if args.history:
        for row in git(root, "rev-list", "--objects", "HEAD").decode().splitlines():
            oid, separator, name = row.partition(" ")
            if not separator or git(root, "cat-file", "-t", oid).strip() != b"blob":
                continue
            findings.extend(f"history {oid[:12]} {item}" for item in inspect_file(name, git(root, "cat-file", "blob", oid)))
            historical += 1
    print(f"Checked {checked} tracked files and {historical} historical blobs.")
    for finding in findings:
        print(finding)
    print("PASS: no matching private-data patterns" if not findings else f"FAIL: {len(findings)} findings")
    print("Pattern screening is not a guarantee of anonymity or absence of secrets.")
    return int(bool(findings))


if __name__ == "__main__":
    raise SystemExit(main())
