#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LANTIVO — DENUE 2026-05 MINIMAL REFRESH
Downloads ONLY states 02/09/14/19/25 from the official INEGI current-release tree.

Safety / scope:
- writes only E:\\LANTIVO_DENUE_NACIONAL\\01_DENUE_ZIPS_OFICIALES;
- never touches R2, manifest, Supabase, Lovable, GitHub or the Lantivo app;
- stages and validates all five ZIPs before replacing any destination file;
- state 25 is intentionally refreshed, not merely reused;
- emits a SHA256 provenance manifest consumed by the V1.3 spacing study.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(r"E:\LANTIVO_DENUE_NACIONAL")
ZIP_DIR = ROOT / "01_DENUE_ZIPS_OFICIALES"
STATES = ("02", "09", "14", "19", "25")
OFFICIAL_BASE_URL = "https://www.inegi.org.mx/contenidos/masiva/denue/"
MANIFEST = ZIP_DIR / "DENUE_2026_05_REFRESH_02_09_14_19_25.json"
SCHEMA = "LANTIVO_DENUE_2026_05_REFRESH_MANIFEST_V1"
MAX_WORKERS = 5
RETRIES = 4
TIMEOUT_S = 120
CHUNK_BYTES = 4 * 1024 * 1024
USER_AGENT = "Lantivo-DENUE-audit/1.0 (+read-only-source-download)"


def die(msg: str) -> None:
    print(f"ABORT: {msg}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(CHUNK_BYTES), b""):
            h.update(chunk)
    return h.hexdigest().lower()


def select_main_csv(z: zipfile.ZipFile) -> str:
    names = [n for n in z.namelist() if n.lower().endswith(".csv") and not n.endswith("/")]
    if not names:
        raise RuntimeError("ZIP sin CSV")
    # Exact same deterministic selection used by the V1.3 study.
    return sorted(names, key=lambda s: (len(s), s))[0]


def validate_and_count(path: Path) -> tuple[str, int, list[str]]:
    try:
        with zipfile.ZipFile(path) as z:
            bad = z.testzip()
            if bad is not None:
                raise RuntimeError(f"CRC inválido en {bad}")
            csv_entries = sorted(n for n in z.namelist() if n.lower().endswith(".csv") and not n.endswith("/"))
            main_csv = select_main_csv(z)
            with z.open(main_csv) as raw, io.TextIOWrapper(raw, encoding="latin-1", newline="") as f:
                rd = csv.reader(f)
                try:
                    next(rd)
                except StopIteration:
                    raise RuntimeError("CSV principal vacío")
                rows = sum(1 for _ in rd)
    except zipfile.BadZipFile as exc:
        raise RuntimeError(f"ZIP inválido: {exc}") from exc
    if rows <= 0:
        raise RuntimeError("CSV principal sin filas de datos")
    return main_csv, rows, csv_entries


def stage_one(state: str) -> dict:
    filename = f"denue_{state}_csv.zip"
    url = OFFICIAL_BASE_URL + filename
    staged = ZIP_DIR / f".{filename}.v13-stage-{os.getpid()}"
    if staged.exists():
        staged.unlink()

    last_exc: Exception | None = None
    headers = {}
    for attempt in range(1, RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            h = hashlib.sha256()
            total = 0
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp, staged.open("wb") as out:
                headers = {k.lower(): v for k, v in resp.headers.items()}
                status = getattr(resp, "status", 200)
                if status != 200:
                    raise RuntimeError(f"HTTP {status}")
                while True:
                    chunk = resp.read(CHUNK_BYTES)
                    if not chunk:
                        break
                    out.write(chunk)
                    h.update(chunk)
                    total += len(chunk)
                out.flush()
                os.fsync(out.fileno())
            if total <= 0:
                raise RuntimeError("descarga 0 bytes")
            main_csv, rows, csv_entries = validate_and_count(staged)
            actual_sha = sha256_file(staged)
            if actual_sha != h.hexdigest().lower():
                raise RuntimeError("SHA interno de descarga no coincide con archivo staged")
            return {
                "state": state,
                "filename": filename,
                "url": url,
                "staged_path": str(staged),
                "sha256": actual_sha,
                "bytes": total,
                "main_csv": main_csv,
                "rows": rows,
                "csv_entries": csv_entries,
                "http_last_modified": headers.get("last-modified"),
                "http_etag": headers.get("etag"),
                "http_content_length": headers.get("content-length"),
            }
        except Exception as exc:
            last_exc = exc
            try:
                if staged.exists():
                    staged.unlink()
            except OSError:
                pass
            if attempt < RETRIES:
                wait_s = min(12, 2 ** attempt)
                print(f"[{state}] intento {attempt}/{RETRIES} falló: {exc}; retry {wait_s}s", flush=True)
                time.sleep(wait_s)
    raise RuntimeError(f"[{state}] agotó {RETRIES} intentos: {last_exc}")


def main() -> int:
    if not ZIP_DIR.exists():
        die(f"no existe ZIP_DIR: {ZIP_DIR}")

    print("=" * 92)
    print("LANTIVO — DENUE 2026-05 MINIMAL REFRESH — 02/09/14/19/25")
    print("ORIGEN: INEGI OFICIAL · STAGE ALL → VALIDATE ALL → ATOMIC REPLACE")
    print("=" * 92, flush=True)

    staged_entries: list[dict] = []
    try:
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futures = {pool.submit(stage_one, state): state for state in STATES}
            for fut in as_completed(futures):
                state = futures[fut]
                entry = fut.result()
                staged_entries.append(entry)
                print(
                    f"[{state}] STAGED OK · {entry['bytes']:,} bytes · rows={entry['rows']:,} · "
                    f"sha256={entry['sha256']}",
                    flush=True,
                )
    except Exception as exc:
        for e in staged_entries:
            try:
                Path(e["staged_path"]).unlink(missing_ok=True)
            except OSError:
                pass
        die(f"ningún destino se reemplaza; falló el stage/validate: {exc}")

    if {e["state"] for e in staged_entries} != set(STATES) or len(staged_entries) != len(STATES):
        die("stage incompleto; no se reemplaza ningún destino")

    # Commit local only after ALL five downloads validated successfully.
    staged_entries.sort(key=lambda e: e["state"])
    for e in staged_entries:
        staged = Path(e.pop("staged_path"))
        dest = ZIP_DIR / e["filename"]
        os.replace(staged, dest)
        # Immediate post-replace attestation.
        if dest.stat().st_size != e["bytes"] or sha256_file(dest) != e["sha256"]:
            die(f"post-replace drift en {dest}")
        print(f"[{e['state']}] COMMITTED -> {dest.name}", flush=True)

    doc = {
        "schema": SCHEMA,
        "release": "2026-05",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "official_base_url": OFFICIAL_BASE_URL,
        "states": list(STATES),
        "download_policy": "ONLY_02_09_14_19_25_ALL_STAGED_BEFORE_REPLACE",
        "state_25_policy": "FORCED_REFRESH_TO_CURRENT_OFFICIAL_BYTES",
        "entries": staged_entries,
    }
    tmp_manifest = MANIFEST.with_name(f".{MANIFEST.name}.tmp-{os.getpid()}")
    tmp_manifest.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp_manifest, MANIFEST)

    print("-" * 92)
    print(f"MANIFEST: {MANIFEST}")
    print(f"MANIFEST SHA256: {sha256_file(MANIFEST)}")
    print(f"REFRESHED: {', '.join(STATES)}")
    print("PASS — 5 ZIP oficiales refreshed; ningún otro ZIP fue descargado ni reemplazado.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        die("interrumpido por usuario; revisa archivos .v13-stage-* antes de reintentar")
