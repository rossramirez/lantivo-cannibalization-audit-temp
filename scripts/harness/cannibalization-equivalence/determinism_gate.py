#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

SCRIPT_VERSION = "LANTIVO_CANNIBALIZATION_DETERMINISM_GATE_V1"

PURE_DATA_OUTPUTS = [
    "STORE_LEVEL_RUNTIME_EQUIVALENT.csv",
    "DEDUPE_CONTEXT_DELTA.csv",
    "BRAND_SUMMARY.csv",
    "DENSITY_STRATA.csv",
    "IDENTITY_AUDIT.csv",
    "COORDINATE_COLLISIONS.csv",
]

ALL_GATE_TOPLEVEL = [
    "REPORT.json",
    "SUMMARY.txt",
    "STORE_LEVEL_RUNTIME_EQUIVALENT.csv",
    "BRAND_SUMMARY.csv",
    "DENSITY_STRATA.csv",
    "MATCH_DELTA.csv",
    "FILTER_DELTA.csv",
    "DEDUPE_AUDIT.csv",
    "DEDUPE_CONTEXT_DELTA.csv",
    "IDENTITY_AUDIT.csv",
    "COORDINATE_COLLISIONS.csv",
    "EMPLOYEE_CACHE_AUDIT.csv",
    "HASHES.txt",
]

EXPECTED_RUNTIME_HEAD = "9409214fb4d003d1a34d5348e5923113f0ef695d"
EXPECTED_RUNTIME_TREE = "be68d7d2d105708eab1a8ab45702ae27d1430ae1"
EXPECTED_PREPARE_SHA = "77c36c0b39a97b99893990420f1c8564b109296d2e47a7006c510d55815d02ad"
EXPECTED_STORE_SHA = "8049764865d60ca48172dff2117b496846c947aa3a2b5d59df908c4b9d6ded39"

def die(msg: str) -> None:
    raise RuntimeError("ABORT: " + msg)

def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest().lower()

def run(args: list[str], cwd: Path | None = None, env: dict[str,str] | None = None) -> None:
    p = subprocess.run(args, cwd=str(cwd) if cwd else None, env=env, check=False)
    if p.returncode != 0:
        die(f"command failed ({p.returncode}): {' '.join(args)}")

def capture(args: list[str], cwd: Path | None = None) -> str:
    p = subprocess.run(
        args,
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    out = p.stdout.decode("utf-8", errors="replace")
    if p.returncode != 0:
        die(f"command failed ({p.returncode}): {' '.join(args)}\n{out}")
    return out.strip()

def find_bun() -> str:
    p = shutil.which("bun")
    if p:
        return p
    q = Path(os.environ.get("USERPROFILE","")) / ".bun" / "bin" / "bun.exe"
    if q.is_file():
        return str(q)
    die("Bun not found")
    raise AssertionError

def ensure_clean_dir(p: Path) -> None:
    if p.exists():
        shutil.rmtree(p)
    p.mkdir(parents=True, exist_ok=True)

def clean_gate_toplevel(out_dir: Path) -> None:
    for name in ALL_GATE_TOPLEVEL:
        p = out_dir / name
        if p.is_file():
            p.unlink()

def file_manifest(root: Path) -> dict[str,str]:
    rows: dict[str,str] = {}
    for p in sorted(x for x in root.iterdir() if x.is_file()):
        rows[p.name] = sha256_file(p)
    return rows

def manifest_digest(rows: dict[str,str]) -> str:
    body = "".join(f"{k}\0{rows[k]}\n" for k in sorted(rows)).encode("utf-8")
    return hashlib.sha256(body).hexdigest()

def hardlink_cache(src: Path, dst: Path) -> None:
    ensure_clean_dir(dst)
    files = sorted(x for x in src.iterdir() if x.is_file())
    if not files:
        die(f"frozen employee cache empty: {src}")
    for i,p in enumerate(files,1):
        os.link(p, dst / p.name)
        if i % 10000 == 0 or i == len(files):
            print(f"[CACHE LINK {i}/{len(files)}]", flush=True)

def copy_outputs(src: Path, dst: Path) -> None:
    ensure_clean_dir(dst)
    for name in PURE_DATA_OUTPUTS:
        p = src / name
        if not p.is_file():
            die(f"missing gate output {p}")
        shutil.copy2(p, dst / name)
    for name in ("REPORT.json","HASHES.txt"):
        p = src / name
        if p.is_file():
            shutil.copy2(p, dst / name)

def output_hashes(run_dir: Path) -> dict[str,str]:
    return {name: sha256_file(run_dir / name) for name in PURE_DATA_OUTPUTS}

def verify_runtime(runtime: Path) -> None:
    head = capture(["git","rev-parse","HEAD"], runtime)
    tree = capture(["git","rev-parse","HEAD^{tree}"], runtime)
    dirty = capture(["git","status","--porcelain"], runtime)
    if head != EXPECTED_RUNTIME_HEAD:
        die(f"runtime HEAD {head}")
    if tree != EXPECTED_RUNTIME_TREE:
        die(f"runtime tree {tree}")
    if dirty:
        die("runtime checkout dirty")

def write_no_network_wrapper(target: Path, gate_path: Path) -> None:
    gate_json = json.dumps(str(gate_path))
    body = (
        'import { pathToFileURL } from "node:url";\n'
        'globalThis.fetch = (async (..._args: any[]) => {\n'
        '  throw new Error("DETERMINISM_GATE_NETWORK_FORBIDDEN");\n'
        '}) as typeof fetch;\n'
        f'await import(pathToFileURL({gate_json}).href + "?determinism=1");\n'
    )
    target.write_text(body, encoding="utf-8", newline="\n")

def verify_fresh_snapshot(snapshot_dir: Path) -> None:
    rp = snapshot_dir / "SNAPSHOT_REPORT.json"
    ip = snapshot_dir / "SNAPSHOT_INDEX.json"
    if not rp.is_file() or not ip.is_file():
        die("fresh snapshot outputs missing")
    report = json.loads(rp.read_text(encoding="utf-8-sig"))
    index = json.loads(ip.read_text(encoding="utf-8-sig"))
    if report.get("verdict") != "PASS_SNAPSHOT_PREPARED":
        die(f"fresh snapshot verdict {report.get('verdict')}")
    if report.get("mode") != "local-certified":
        die(f"fresh snapshot mode {report.get('mode')}")
    if int(report.get("cells",-1)) != 20003:
        die(f"fresh snapshot cells {report.get('cells')}")
    if int(report.get("remote_write_operations",-1)) != 0:
        die("fresh snapshot reports remote writes")
    if not isinstance(index.get("cells"), list) or len(index["cells"]) != 20003:
        die("fresh snapshot index cells != 20003")

def main() -> int:
    ap = argparse.ArgumentParser(description=SCRIPT_VERSION)
    here = Path(__file__).resolve().parent
    temp = Path(os.environ.get("TEMP", "."))
    ap.add_argument("--runtime-root", type=Path,
                    default=temp / "lantivo-equivalence-publish-20260906" / "runtime-9409214")
    ap.add_argument("--data-root", type=Path, default=Path(r"E:\LANTIVO_DENUE_NACIONAL"))
    ap.add_argument("--frozen-employee-cache", type=Path, default=None)
    ap.add_argument("--out-root", type=Path, default=None)
    a = ap.parse_args()

    runtime = a.runtime_root.resolve()
    data_root = a.data_root.resolve()
    frozen_cache = (a.frozen_employee_cache or (
        data_root / "CANNIBALIZATION_EQUIVALENCE_GATE_V1_FINAL_V2" / "RESULTS" / "EMPLOYEE_CELL_CACHE"
    )).resolve()
    out_root = (a.out_root or (
        data_root / "CANNIBALIZATION_EQUIVALENCE_DETERMINISM_GATE_V1"
    )).resolve()

    print("="*100)
    print(SCRIPT_VERSION)
    print("FRESH SNAPSHOT -> RUN A -> SAME SNAPSHOT REUSED -> RUN B")
    print("GATE NETWORK DISABLED; EMPLOYEE CACHE FROZEN; 6 CSVs MUST BE BYTE/SHA IDENTICAL")
    print("="*100)

    verify_runtime(runtime)
    if not frozen_cache.is_dir():
        die(f"frozen employee cache missing: {frozen_cache}")

    assembler = here / "assemble_sources.py"
    if not assembler.is_file():
        die(f"assembler missing: {assembler}")

    source_assembled = out_root / "SOURCE_ASSEMBLED"
    fresh_snapshot = out_root / "FRESH_SNAPSHOT"
    work = out_root / "WORK"
    run_a = out_root / "RUN_A_FRESH"
    run_b = out_root / "RUN_B_REUSED"
    frozen_work_cache = work / "EMPLOYEE_CELL_CACHE"
    wrapper = out_root / "no_network_gate_wrapper.ts"

    out_root.mkdir(parents=True, exist_ok=True)
    ensure_clean_dir(source_assembled)

    print("[1/6] Assembling audited sources...", flush=True)
    run([sys.executable, str(assembler), "--out-dir", str(source_assembled)], cwd=here)
    prepare = source_assembled / "prepare_snapshot.py"
    gate = source_assembled / "gate.ts"

    # Repository root = three levels above scripts/harness/cannibalization-equivalence.
    repo_root = here.parents[2]
    store = repo_root / "CANNIBALIZATION_SPACING_STUDY_V1_3_FAST_EXACT_STORE_LEVEL.csv"
    if not store.is_file():
        die("STORE_LEVEL file not found in repository root")
    if sha256_file(prepare) != EXPECTED_PREPARE_SHA:
        die("prepare_snapshot.py SHA drift")
    if sha256_file(store) != EXPECTED_STORE_SHA:
        die("STORE_LEVEL SHA drift")

    print("[2/6] Building FRESH local-certified snapshot...", flush=True)
    ensure_clean_dir(fresh_snapshot)
    run([
        sys.executable, str(prepare),
        "--root", str(data_root),
        "--out-dir", str(fresh_snapshot),
        "--mode", "local-certified",
    ])
    verify_fresh_snapshot(fresh_snapshot)

    print("[3/6] Freezing employee cache locally (hard links, no copies/network)...", flush=True)
    work.mkdir(parents=True, exist_ok=True)
    hardlink_cache(frozen_cache, frozen_work_cache)
    cache_before = file_manifest(frozen_work_cache)
    cache_digest_before = manifest_digest(cache_before)
    print(f"FROZEN CACHE files={len(cache_before)} digest={cache_digest_before}", flush=True)

    write_no_network_wrapper(wrapper, gate)
    bun = find_bun()
    gate_args = [
        bun, str(wrapper),
        "--runtime-root", str(runtime),
        "--snapshot-index", str(fresh_snapshot / "SNAPSHOT_INDEX.json"),
        "--store-level", str(store),
        "--out-dir", str(work),
    ]

    print("[4/6] RUN A — immediate consumption of FRESH snapshot...", flush=True)
    clean_gate_toplevel(work)
    run(gate_args, cwd=runtime)
    copy_outputs(work, run_a)
    hashes_a = output_hashes(run_a)

    print("[5/6] RUN B — REUSE exact same snapshot/cache...", flush=True)
    clean_gate_toplevel(work)
    run(gate_args, cwd=runtime)
    copy_outputs(work, run_b)
    hashes_b = output_hashes(run_b)

    print("[6/6] Byte/SHA determinism comparison...", flush=True)
    cache_after = file_manifest(frozen_work_cache)
    cache_digest_after = manifest_digest(cache_after)
    if cache_after != cache_before:
        die("frozen employee cache changed during determinism gate")

    comparisons = {}
    mismatches = []
    for name in PURE_DATA_OUTPUTS:
        same = hashes_a[name] == hashes_b[name]
        comparisons[name] = {
            "run_a_sha256": hashes_a[name],
            "run_b_sha256": hashes_b[name],
            "byte_identical": same,
        }
        if not same:
            mismatches.append(name)

    report_a = json.loads((run_a / "REPORT.json").read_text(encoding="utf-8-sig"))
    report_b = json.loads((run_b / "REPORT.json").read_text(encoding="utf-8-sig"))

    final = {
        "schema": SCRIPT_VERSION,
        "fresh_vs_reused": True,
        "fresh_snapshot_report_sha256": sha256_file(fresh_snapshot / "SNAPSHOT_REPORT.json"),
        "fresh_snapshot_index_sha256": sha256_file(fresh_snapshot / "SNAPSHOT_INDEX.json"),
        "employee_cache_file_count": len(cache_before),
        "employee_cache_manifest_sha256_before": cache_digest_before,
        "employee_cache_manifest_sha256_after": cache_digest_after,
        "employee_cache_unchanged": cache_before == cache_after,
        "gate_network_disabled": True,
        "run_a_verdict": report_a.get("verdict"),
        "run_b_verdict": report_b.get("verdict"),
        "run_a_calibration_ready": report_a.get("calibration_ready_for_policy_design"),
        "run_b_calibration_ready": report_b.get("calibration_ready_for_policy_design"),
        "outputs": comparisons,
        "mismatches": mismatches,
        "determinism_pass": len(mismatches) == 0,
        "acceptance_rule": "All six pure-data CSV outputs must be byte/SHA-identical. Any mismatch blocks calibration.",
        "forbidden_product_writes": {
            "runtime": 0, "score": 0, "policy": 0, "github": 0,
            "r2": 0, "manifest": 0, "supabase": 0, "lovable": 0,
        },
    }
    out_report = out_root / "DETERMINISM_REPORT.json"
    out_report.write_text(json.dumps(final, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")

    print("="*100)
    if mismatches:
        print("DETERMINISM GATE: FAIL")
        print("MISMATCHES:", ", ".join(mismatches))
        print("CALIBRATION: BLOCKED")
        print(f"REPORT: {out_report}")
        print("="*100)
        return 2

    print("DETERMINISM GATE: PASS")
    print("RUN A == RUN B: 6/6 BYTE/SHA IDENTICAL")
    print(f"EMPLOYEE CACHE UNCHANGED: {cache_digest_before}")
    print(f"REPORT: {out_report}")
    print("Only after independent audit of this PASS may calibration_ready be accepted.")
    print("="*100)
    return 0

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print("="*100)
        print("DETERMINISM GATE ABORTED")
        print(str(e))
        print("No runtime/product/score/policy write was performed by this harness.")
        print("="*100)
        raise SystemExit(1)
