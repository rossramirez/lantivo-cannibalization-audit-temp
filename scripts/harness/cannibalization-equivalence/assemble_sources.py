#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, os
from pathlib import Path

EXPECTED = {
    "prepare_snapshot.py": "77c36c0b39a97b99893990420f1c8564b109296d2e47a7006c510d55815d02ad",
    "gate.ts": "8700e4411de74db142c4c4895fb73756b25b4a4637b7c304913490183f93f170",
}

def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest().lower()

def assemble(parts_dir: Path, name: str, out_dir: Path) -> Path:
    parts = sorted(parts_dir.glob(name + ".part*"))
    if not parts:
        raise SystemExit(f"ABORT: no parts for {name}")
    expected_nums = [f"{i:02d}" for i in range(1, len(parts)+1)]
    actual_nums = [p.name.rsplit("part",1)[1] for p in parts]
    if actual_nums != expected_nums:
        raise SystemExit(f"ABORT: non-contiguous parts for {name}: {actual_nums}")
    body = b"".join(p.read_bytes() for p in parts)
    actual = sha256(body)
    if actual != EXPECTED[name]:
        raise SystemExit(f"ABORT: assembled SHA drift {name}: {actual} != {EXPECTED[name]}")
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / name
    tmp = target.with_name(target.name + ".partial")
    tmp.write_bytes(body)
    os.replace(tmp, target)
    return target

def main() -> int:
    ap=argparse.ArgumentParser()
    ap.add_argument("--parts-dir", type=Path, default=Path(__file__).resolve().parent / "source_parts")
    ap.add_argument("--out-dir", type=Path, required=True)
    a=ap.parse_args()
    for name in EXPECTED:
        p=assemble(a.parts_dir,name,a.out_dir)
        print(f"PASS {name} {EXPECTED[name]} {p}")
    return 0
if __name__ == "__main__": raise SystemExit(main())
