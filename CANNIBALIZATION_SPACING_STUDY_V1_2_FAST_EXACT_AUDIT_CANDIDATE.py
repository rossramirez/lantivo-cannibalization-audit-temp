#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
LANTIVO — CANNIBALIZATION SPACING STUDY V1
READ-ONLY / DESCRIPTIVE CALIBRATION ONLY

PURPOSE
-------
Measure observed same-brand spacing for:
- OXXO
- Farmacias Guadalajara
- Tiendas 3B
- Starbucks
- McDonald's

This study DOES NOT define R/C/Pmax and DOES NOT authorize any score change.
It addresses:
1) observed nearest-neighbor spacing;
2) cumulative same-brand exposure within several radii;
3) spacing stratified by a local DENUE-density proxy;
4) spacing by municipality/locality where sample is sufficient.

SAFETY
------
- SQLite opened mode=ro + PRAGMA query_only=ON.
- Official DENUE ZIPs read-only.
- NO R2.
- NO manifest.
- NO GitHub.
- NO Lovable.
- NO Supabase.
- Writes only local outputs under OUT_DIR.

CURRENT-BASE RECONCILIATION
---------------------------
The current C2 base includes the old seen_prod_denue universe plus the 9,193
MATERIALIZABLE recovered rows. This script unions both so the descriptive
sample tracks the repaired base rather than the pre-C2 source only.

IMPORTANT METHODOLOGICAL NOTE
-----------------------------
Observed spacing is DESCRIPTIVE, not causal profitability evidence.
No claim such as "X meters is safe" is produced here.
"""

from __future__ import annotations

import csv
import gzip
import hashlib
import io
import json
import math
import re
import sqlite3
import statistics
import time
import unicodedata
import zipfile
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import quote

SCRIPT_VERSION = "CANNIBALIZATION_SPACING_STUDY_V1"
ROOT = Path(r"E:\LANTIVO_DENUE_NACIONAL")
DB = ROOT / "GASOLINERAS_SCIAN_REBUILD_V1" / "prepare.sqlite"
RECOVERABLE = ROOT / "C2_BASE_MATERIALIZATION_RECOVERY_GATE_V1_2" / "C2_BASE_MATERIALIZATION_RECOVERY_GATE_V1_2_RECOVERABLE.csv.gz"
ZIP_DIR = ROOT / "01_DENUE_ZIPS_OFICIALES"
OUT_DIR = ROOT / "CANNIBALIZATION_SPACING_STUDY_V1"

EXPECTED_RAW = 6_138_075
EXPECTED_SEEN = 2_112_186
EXPECTED_RECOVERED = 9_193
EXPECTED_CURRENT_DENUE = EXPECTED_SEEN + EXPECTED_RECOVERED
EXPECTED_SNAPSHOT_SIGNATURE = "c72b1d4d9fe63afd7fe157269178d14d73e51bafa825012cdf067397ac57f82d"
EXPECTED_RECOVERABLE_SHA256 = "4956261e571d9c5bd788ccd43048e184f744223c03deea74116eeec0151ab615"

# Informational provenance only. The five rules below mirror this audited
# brandMatching.ts blob subset; the script does not call or modify the repo.
BRAND_MATCHING_BLOB_SHA = "33c649441428413909455438fdf01d24ea0a267e"

RADII_M = (250, 500, 800, 1000, 1500, 2000, 3000)
MIN_PROFILE_N = 30
MIN_CITY_N = 10
NEAR_DUP_DIAGNOSTIC_M = (10, 25, 60)

# Runtime opportunity/category universe for each target.
TARGETS = {
    "OXXO": {
        "categories": {"conveniencia"},
        "anchors": (("oxxo",),),
        "exclusions": (),
        "archetype": "conveniencia",
    },
    "Farmacias Guadalajara": {
        "categories": {"farmacia"},
        "anchors": (("farmacia", "guadalajara"),),
        "exclusions": ("similares", "ahorro", "benavides", "roma", "san pablo", "del ahorro"),
        "archetype": "farmacia",
    },
    "Tiendas 3B": {
        "categories": {"autoservicio", "conveniencia"},
        "anchors": (("tienda3b",),),
        "exclusions": (),
        "archetype": "tiendas_descuento",
    },
    "Starbucks": {
        "categories": {"fast_food"},
        "anchors": (("starbucks",),),
        "exclusions": (),
        "archetype": "cafeteria_fast_food",
    },
    "McDonald's": {
        "categories": {"fast_food"},
        "anchors": (("mcdonald",),),
        "exclusions": (),
        "archetype": "fast_food",
    },
}


BRANDS_BY_CATEGORY = {}
for _brand, _cfg in TARGETS.items():
    for _cat in _cfg["categories"]:
        BRANDS_BY_CATEGORY.setdefault(_cat, []).append(_brand)

COMMON_NON_OUTLET = [
    ("oficina", re.compile(r"\boficina(s)?\b")),
    ("administrativo", re.compile(r"\badministrativ[oa]s?\b")),
    ("corporativo", re.compile(r"\bcorporativo\b")),
    ("centro_distribucion", re.compile(r"\bcentro\s+de\s+distribucion\b")),
    ("cedis", re.compile(r"\bcedis\b")),
]
FARMACIA_NON_OUTLET = [
    ("laboratorio_no_retail", re.compile(r"\blaboratorio(s)?\b")),
    ("distribuidor", re.compile(r"\bdistribuidor(a|es|as)?\b")),
    ("mayoreo", re.compile(r"\b(mayoreo|mayorista)\b")),
    ("almacen_medicamentos", re.compile(r"\balmacen(es)?\s+(de\s+)?(medicamento|farmaceutic)")),
]
FOOD_NON_OUTLET = [
    ("banquetes", re.compile(r"\bbanquete(s)?\b")),
    ("catering", re.compile(r"\bcatering\b")),
    ("comedor_industrial", re.compile(r"\bcomedor(es)?\s+industrial(es)?\b")),
    ("servicio_comedor", re.compile(r"\bservicio(s)?\s+de\s+comedor(es)?\b")),
    ("salon_eventos", re.compile(r"\bsalon\s+de\s+(fiestas|eventos)\b")),
]

def log(msg=""):
    print(msg, flush=True)

def die(msg):
    raise SystemExit(f"ABORT: {msg}")

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest().lower()

def sqlite_ro_uri(path: Path) -> str:
    return "file:" + quote(str(path.resolve()).replace("\\", "/"), safe="/:") + "?mode=ro"

def table_cols(con, table):
    return {r[1] for r in con.execute(f"PRAGMA table_info({table})")}

def normalize_brand_text(s) -> str:
    s = "" if s is None else str(s)
    s = s.lower()
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = re.sub(r"waldo['\u2019]?s\b", " waldosbrand ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    words = []
    for w in s.split():
        if w == "arcos":
            words.append(w)
        elif len(w) > 3 and w.endswith("s"):
            words.append(w[:-1])
        else:
            words.append(w)
    s = " ".join(words)
    s = re.sub(r"\bmc\s+donald(?:\s+s)?\b", "mcdonald", s)
    s = re.sub(r"\bmcdonald\s+s\b", "mcdonald", s)
    s = re.sub(r"\bh e b\b", "heb", s)
    s = re.sub(r"\bgo mart\b", "gomart", s)
    s = re.sub(r"\bwal mart\b", "walmart", s)
    s = re.sub(r"\bsuperama\b", "walmart", s)
    s = re.sub(r"\btienda 3b\b", "tienda3b", s)
    s = re.sub(r"\btre b\b", "tienda3b", s)
    s = re.sub(r"\bmi super bara\b", "tienda bara", s)
    s = re.sub(r"\bwaldosbrand\b", "waldos", s)
    return re.sub(r"\s+", " ", s).strip()

def contains(haystack: str, needle: str) -> bool:
    return f" {needle} " in f" {haystack} "

def match_target(brand: str, name: str, category: str):
    cfg = TARGETS[brand]
    if category not in cfg["categories"]:
        return False
    h = normalize_brand_text(name)
    if not h:
        return False
    for exclusion in cfg["exclusions"]:
        if contains(h, normalize_brand_text(exclusion)):
            return False
    ok = any(all(contains(h, normalize_brand_text(a)) for a in sig) for sig in cfg["anchors"])
    return ok

def outlet_exclusion_reason(brand: str, name: str) -> str:
    n = normalize_brand_text(name)
    for rid, rx in COMMON_NON_OUTLET:
        if rx.search(n):
            return rid
    if brand == "Farmacias Guadalajara":
        # Preserve explicit retail evidence around laboratorio exactly as the runtime philosophy.
        retail_evidence = re.search(r"\b(farmacia|botica|similares|simi|benavides|yza)\b", n)
        for rid, rx in FARMACIA_NON_OUTLET:
            if rid == "laboratorio_no_retail":
                if rx.search(n) and not retail_evidence:
                    return rid
            elif rx.search(n):
                return rid
    if brand in {"Starbucks", "McDonald's"}:
        for rid, rx in FOOD_NON_OUTLET:
            if rx.search(n):
                return rid
    return ""

def qtile(values, p):
    if not values:
        return None
    s = sorted(values)
    if len(s) == 1:
        return float(s[0])
    pos = (len(s) - 1) * p
    lo = int(math.floor(pos)); hi = int(math.ceil(pos))
    if lo == hi:
        return float(s[lo])
    frac = pos - lo
    return float(s[lo] * (1-frac) + s[hi] * frac)

def fmt(v, digits=1):
    return "" if v is None else f"{v:.{digits}f}"

def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371008.8
    p1 = math.radians(lat1); p2 = math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2-lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2*r*math.asin(min(1.0, math.sqrt(a)))

# Brand-neighbor grid: small enough to cover 3 km with a bounded neighborhood.
BRAND_GRID_DEG = 0.02
# Density proxy: count all current materialized DENUE points in surrounding 3x3 cells.
DENSITY_GRID_DEG = 0.01

def grid_key(lat, lng, size):
    return (math.floor(lat / size), math.floor(lng / size))

def load_recoverable_categories():
    if not RECOVERABLE.exists():
        die(f"falta RECOVERABLE C2: {RECOVERABLE}")
    actual = sha256_file(RECOVERABLE)
    if actual != EXPECTED_RECOVERABLE_SHA256:
        die(f"RECOVERABLE SHA drift: {actual}")
    out = {}
    with gzip.open(RECOVERABLE, "rt", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        cols = set(reader.fieldnames or [])
        id_col = "id" if "id" in cols else None
        cat_col = next((c for c in ("target_category","category_after","category") if c in cols), None)
        if not id_col or not cat_col:
            die(f"RECOVERABLE schema inesperado: {sorted(cols)}")
        for row in reader:
            rid = str(row.get(id_col) or "").strip()
            cat = str(row.get(cat_col) or "").strip()
            if rid and cat:
                out[rid] = cat
    if len(out) != EXPECTED_RECOVERED:
        die(f"RECOVERABLE count drift: {len(out):,} != {EXPECTED_RECOVERED:,}")
    return out

def load_current_universe():
    if not DB.exists():
        die(f"no existe DB: {DB}")

    log("[0/5] Abriendo SQLite read-only y validando schema/provenance...")
    con = sqlite3.connect(sqlite_ro_uri(DB), uri=True, timeout=60)
    con.execute("PRAGMA query_only=ON")
    con.execute("PRAGMA busy_timeout=30000")
    con.execute("PRAGMA temp_store=MEMORY")
    den_cols = table_cols(con, "denue")
    seen_cols = table_cols(con, "seen_prod_denue")
    need_den = {"id","scian","name_norm","lat","lng"}
    need_seen = {"id","category_after"}
    if not need_den.issubset(den_cols) or not need_seen.issubset(seen_cols):
        die(f"schema drift denue={sorted(den_cols)} seen={sorted(seen_cols)}")

    sig_row = con.execute("SELECT value FROM meta WHERE key='snapshot_signature'").fetchone()
    sig = sig_row[0] if sig_row else None
    if sig and sig != EXPECTED_SNAPSHOT_SIGNATURE:
        die(f"snapshot_signature drift {sig}")

    recovered_categories = load_recoverable_categories()

    target_points = {b: [] for b in TARGETS}
    excluded = Counter()
    density_grid = Counter()
    t0 = time.time()
    seen_scanned = 0

    log(f"[1/5] Escaneando universo materializado pre-C2: esperado {EXPECTED_SEEN:,}...")
    sql = """
    SELECT d.id, d.name_norm, d.lat, d.lng, s.category_after
    FROM seen_prod_denue AS s
    JOIN denue AS d ON d.id=s.id
    """
    for i, (rid, name, lat, lng, cat) in enumerate(con.execute(sql), start=1):
        seen_scanned = i
        if lat is None or lng is None:
            continue
        lat = float(lat); lng = float(lng)
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            continue
        density_grid[grid_key(lat, lng, DENSITY_GRID_DEG)] += 1
        cat = "" if cat is None else str(cat)
        for brand in BRANDS_BY_CATEGORY.get(cat, ()):
            if match_target(brand, name or "", cat):
                reason = outlet_exclusion_reason(brand, name or "")
                if reason:
                    excluded[(brand, reason)] += 1
                else:
                    target_points[brand].append({
                        "id": str(rid), "name": str(name or ""), "lat": lat, "lng": lng,
                        "category": cat, "source_universe": "seen_prod_denue",
                    })
        if i % 250_000 == 0:
            log(f"  seen {i:,}/{EXPECTED_SEEN:,} · {time.time()-t0:.1f}s")

    if seen_scanned != EXPECTED_SEEN:
        die(f"SEEN scan drift {seen_scanned:,} != {EXPECTED_SEEN:,}")

    log(f"[2/5] Sumando los {EXPECTED_RECOVERED:,} MATERIALIZABLE C2...")
    rec_ids = list(recovered_categories)
    found_recovered = 0
    CHUNK = 500
    for k in range(0, len(rec_ids), CHUNK):
        chunk = rec_ids[k:k+CHUNK]
        q = ",".join("?" for _ in chunk)
        for rid, name, lat, lng in con.execute(
            f"SELECT id,name_norm,lat,lng FROM denue WHERE id IN ({q})", chunk
        ):
            found_recovered += 1
            cat = recovered_categories[str(rid)]
            if lat is None or lng is None:
                die(f"recovered sin coords: {rid}")
            lat = float(lat); lng = float(lng)
            density_grid[grid_key(lat, lng, DENSITY_GRID_DEG)] += 1
            for brand in BRANDS_BY_CATEGORY.get(cat, ()):
                if match_target(brand, name or "", cat):
                    reason = outlet_exclusion_reason(brand, name or "")
                    if reason:
                        excluded[(brand, reason)] += 1
                    else:
                        target_points[brand].append({
                            "id": str(rid), "name": str(name or ""), "lat": lat, "lng": lng,
                            "category": cat, "source_universe": "c2_recovered",
                        })
    if found_recovered != EXPECTED_RECOVERED:
        die(f"recovered lookup drift: {found_recovered:,} != {EXPECTED_RECOVERED:,}")

    con.close()
    return target_points, density_grid, excluded, {
        "raw": EXPECTED_RAW, "seen": seen_scanned, "recovered": found_recovered,
        "current_denue": seen_scanned + found_recovered, "snapshot_signature": sig,
    }

def density_proxy(point, density_grid):
    # 3x3 cells around the point; descriptive proxy only, NOT population density.
    ky, kx = grid_key(point["lat"], point["lng"], DENSITY_GRID_DEG)
    return sum(density_grid.get((ky+dy, kx+dx), 0) for dy in (-1,0,1) for dx in (-1,0,1))

def compute_neighbors(points):
    """
    Exact nearest-neighbor + cumulative same-brand exposure.

    Exact NN:
    - balanced 3D KD-tree on unit-sphere coordinates;
    - Euclidean chord distance is strictly monotonic with great-circle arc
      distance, so the KD-tree nearest point is the exact geographic nearest.

    Multi-radius exposure:
    - existing 0.02° brand grid limits work to cells that can contain a sister
      inside 3 km;
    - each candidate pair is evaluated ONCE (not once from each endpoint);
    - a cheap chord prefilter skips obviously distant pairs, then the exact
      legacy haversine_m + d<=radius semantics classify qualifying pairs;
    - one bucket update per qualifying pair + prefix sums yields all seven
      cumulative counts.

    There is no full-network pairwise scan and no O(N^2) fallback.
    """
    n = len(points)
    if n == 0:
        return []

    earth_r = 6371008.8

    # Unit-sphere Cartesian coordinates.
    xyz = []
    for p in points:
        phi = math.radians(p["lat"])
        lam = math.radians(p["lng"])
        cp = math.cos(phi)
        xyz.append((cp * math.cos(lam), cp * math.sin(lam), math.sin(phi)))

    # Compact balanced KD-tree: node=(point_index, axis, left, right).
    def build_kdtree(indices):
        if not indices:
            return None
        mins = [min(xyz[i][a] for i in indices) for a in range(3)]
        maxs = [max(xyz[i][a] for i in indices) for a in range(3)]
        axis = max(range(3), key=lambda a: maxs[a] - mins[a])
        indices.sort(key=lambda i: (xyz[i][axis], i))
        mid = len(indices) // 2
        return (
            indices[mid],
            axis,
            build_kdtree(indices[:mid]),
            build_kdtree(indices[mid + 1:]),
        )

    kd_root = build_kdtree(list(range(n)))

    def exact_nearest_index(i):
        if n <= 1:
            return None
        q = xyz[i]
        best_idx = None
        best_d2 = math.inf

        def search(node):
            nonlocal best_idx, best_d2
            if node is None:
                return
            j, axis, left, right = node
            x = xyz[j]
            diff = q[axis] - x[axis]
            first, second = (left, right) if diff <= 0 else (right, left)

            search(first)

            if j != i:
                dx = q[0] - x[0]
                dy = q[1] - x[1]
                dz = q[2] - x[2]
                d2 = dx * dx + dy * dy + dz * dz
                if d2 < best_d2 or (d2 == best_d2 and (best_idx is None or j < best_idx)):
                    best_d2 = d2
                    best_idx = j

            # Split-plane distance is a valid lower bound in 3D Euclidean space.
            if diff * diff <= best_d2:
                search(second)

        search(kd_root)
        return best_idx

    # Grid for exposure only. Cell membership is unique, so a lexicographic
    # cell-pair order lets every candidate pair be processed exactly once.
    grid = defaultdict(list)
    for idx, p in enumerate(points):
        grid[grid_key(p["lat"], p["lng"], BRAND_GRID_DEG)].append(idx)

    # Great-circle arc and unit-sphere chord are monotonic:
    # chord = 2*sin(arc/(2R)). Compare squared chords in the hot loop.
    radius_chord2 = [
        (2.0 * math.sin(r / (2.0 * earth_r))) ** 2
        for r in RADII_M
    ]
    max_chord2 = radius_chord2[-1]

    bucket_hits = [[0] * len(RADII_M) for _ in range(n)]
    keys = sorted(grid)

    max_r = max(RADII_M)
    # Conservative cheap prefilter. Exact classification below still uses the
    # same haversine_m + d<=radius semantics as V1.1.
    prefilter_chord2 = (2.0 * math.sin((max_r + 50.0) / (2.0 * earth_r))) ** 2

    def classify_pair(i, j):
        a = xyz[i]
        b = xyz[j]
        dx = a[0] - b[0]
        dy = a[1] - b[1]
        dz = a[2] - b[2]
        d2 = dx * dx + dy * dy + dz * dz
        if d2 > prefilter_chord2:
            return

        pi = points[i]
        pj = points[j]
        d = haversine_m(pi["lat"], pi["lng"], pj["lat"], pj["lng"])
        if d > max_r:
            return

        lo, hi = 0, len(RADII_M)
        while lo < hi:
            mid = (lo + hi) // 2
            if d <= RADII_M[mid]:
                hi = mid
            else:
                lo = mid + 1
        if lo < len(RADII_M):
            bucket_hits[i][lo] += 1
            bucket_hits[j][lo] += 1

    for key in keys:
        members = grid[key]

        # Same cell: upper triangle only.
        for a_pos in range(len(members)):
            i = members[a_pos]
            for b_pos in range(a_pos + 1, len(members)):
                classify_pair(i, members[b_pos])

        # Neighbor cells: only lexicographically later keys, so no pair repeats.
        ky, kx = key
        for dy in range(-3, 4):
            for dx in range(-3, 4):
                other_key = (ky + dy, kx + dx)
                if other_key <= key:
                    continue
                other = grid.get(other_key)
                if not other:
                    continue
                for i in members:
                    for j in other:
                        classify_pair(i, j)

    rows = []
    for i, p in enumerate(points):
        nearest_idx = exact_nearest_index(i)
        nearest = (
            haversine_m(
                p["lat"], p["lng"],
                points[nearest_idx]["lat"], points[nearest_idx]["lng"],
            )
            if nearest_idx is not None else None
        )

        counts = []
        running = 0
        for hits in bucket_hits[i]:
            running += hits
            counts.append(running)

        row = {
            **p,
            "nearest_m": nearest,
        }
        for ri, r in enumerate(RADII_M):
            row[f"n_within_{r}m"] = counts[ri]
        rows.append(row)

    return rows

def exact_duplicate_diagnostics(points):
    c = Counter((round(p["lat"], 7), round(p["lng"], 7)) for p in points)
    duplicate_locations = sum(1 for n in c.values() if n > 1)
    duplicate_rows = sum(n for n in c.values() if n > 1)
    return duplicate_locations, duplicate_rows

def enrich_city_metadata(all_brand_rows):
    target_numeric = {}
    for brand, rows in all_brand_rows.items():
        for r in rows:
            rid = r["id"]
            numeric = rid[6:] if rid.startswith("DENUE_") else rid
            target_numeric[numeric] = (brand, rid)

    if not ZIP_DIR.exists():
        die(f"no existe ZIP_DIR: {ZIP_DIR}")
    zips = sorted(ZIP_DIR.glob("denue_*_csv.zip"))
    if len(zips) != 33:
        die(f"esperaba 33 ZIP DENUE, encontré {len(zips)}")

    meta = {}
    scanned = 0
    t0 = time.time()
    log(f"[4/5] Enriqueciendo ciudad/municipio desde 33 ZIP oficiales (1 pasada; targets={len(target_numeric):,})...")
    for zi, zp in enumerate(zips, start=1):
        with zipfile.ZipFile(zp) as z:
            csv_names = [n for n in z.namelist() if n.lower().endswith(".csv")]
            if not csv_names:
                die(f"{zp.name}: sin CSV")
            # Prefer the main state CSV, usually only one.
            csv_name = sorted(csv_names, key=lambda s: (len(s), s))[0]
            with z.open(csv_name) as raw, io.TextIOWrapper(raw, encoding="latin-1", newline="") as f:
                rd = csv.reader(f)
                header = next(rd)
                low = {str(c).strip().lower(): i for i, c in enumerate(header)}
                def idx(*names):
                    for n in names:
                        if n in low: return low[n]
                    return None
                i_id = idx("id","clee")
                i_ent = idx("nom_ent","entidad","estado")
                i_mun = idx("nom_mun","municipio")
                i_loc = idx("localidad","nom_loc")
                if i_id is None:
                    die(f"{zp.name}: no encuentro id en header")
                for row in rd:
                    scanned += 1
                    if i_id >= len(row): continue
                    rid = row[i_id].strip()
                    hit = target_numeric.get(rid)
                    if hit:
                        meta[hit[1]] = {
                            "state": row[i_ent].strip() if i_ent is not None and i_ent < len(row) else "",
                            "municipality": row[i_mun].strip() if i_mun is not None and i_mun < len(row) else "",
                            "locality": row[i_loc].strip() if i_loc is not None and i_loc < len(row) else "",
                        }
                    if scanned % 500_000 == 0:
                        log(f"  ZIP scan {scanned:,}/{EXPECTED_RAW:,} · found={len(meta):,}/{len(target_numeric):,} · {time.time()-t0:.1f}s")
        log(f"  [{zi:02d}/33] {zp.name} · found acumulado={len(meta):,}")
    if scanned != EXPECTED_RAW:
        die(f"ZIP official row count drift: {scanned:,} != {EXPECTED_RAW:,}")
    missing = sorted(set(r["id"] for rows in all_brand_rows.values() for r in rows) - set(meta))
    return meta, missing, scanned

def write_csv(path, rows, fields):
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in fields})

def aggregate_stats(rows):
    nn = [r["nearest_m"] for r in rows if r["nearest_m"] is not None]
    out = {
        "n": len(rows),
        "n_with_nn": len(nn),
        "nn_p10_m": qtile(nn, .10),
        "nn_p25_m": qtile(nn, .25),
        "nn_p50_m": qtile(nn, .50),
        "nn_p75_m": qtile(nn, .75),
        "nn_p90_m": qtile(nn, .90),
        "nn_mean_m": statistics.fmean(nn) if nn else None,
    }
    for r in RADII_M:
        vals = [x[f"n_within_{r}m"] for x in rows]
        out[f"mean_sisters_within_{r}m"] = statistics.fmean(vals) if vals else None
        out[f"pct_with_any_sister_within_{r}m"] = 100*sum(v > 0 for v in vals)/len(vals) if vals else None
    for d in NEAR_DUP_DIAGNOSTIC_M:
        out[f"pct_nn_le_{d}m"] = 100*sum(v <= d for v in nn)/len(nn) if nn else None
    return out

def main():
    t0 = time.time()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    log("="*100)
    log("LANTIVO — CANNIBALIZATION SPACING STUDY V1")
    log("DESCRIPTIVE ONLY · NO SCORE POLICY · ZERO PRODUCTION WRITES")
    log("="*100)

    target_points, density_grid, excluded, source = load_current_universe()
    if source["current_denue"] != EXPECTED_CURRENT_DENUE:
        die(f"current DENUE union drift {source['current_denue']:,}")

    all_rows = {}
    log("[3/5] Calculando NN + exposición acumulada + proxy local de densidad...")
    for brand, points in target_points.items():
        # Deterministic order.
        points.sort(key=lambda p: (p["lat"], p["lng"], p["id"]))
        dup_locs, dup_rows = exact_duplicate_diagnostics(points)
        rows = compute_neighbors(points)
        for r in rows:
            r["density_proxy_3x3_001deg"] = density_proxy(r, density_grid)
        all_rows[brand] = rows
        log(f"  {brand}: N={len(rows):,} · exact-coordinate duplicate rows={dup_rows:,} across {dup_locs:,} locations")

    # Common density strata across ALL target rows (not within-brand quartiles).
    proxy_vals = [r["density_proxy_3x3_001deg"] for rows in all_rows.values() for r in rows]
    d25, d50, d75 = qtile(proxy_vals, .25), qtile(proxy_vals, .50), qtile(proxy_vals, .75)
    def stratum(v):
        if v <= d25: return "Q1_baja"
        if v <= d50: return "Q2_media_baja"
        if v <= d75: return "Q3_media_alta"
        return "Q4_alta"
    for rows in all_rows.values():
        for r in rows:
            r["density_stratum"] = stratum(r["density_proxy_3x3_001deg"])

    city_meta, missing_city, official_rows_scanned = enrich_city_metadata(all_rows)
    for rows in all_rows.values():
        for r in rows:
            m = city_meta.get(r["id"], {})
            r.update(m)

    log("[5/5] Escribiendo outputs auditables...")

    store_fields = [
        "brand","archetype","id","name","category","source_universe","lat","lng",
        "state","municipality","locality","density_proxy_3x3_001deg","density_stratum",
        "nearest_m",
    ] + [f"n_within_{r}m" for r in RADII_M]
    store_rows = []
    for brand, rows in all_rows.items():
        for r in rows:
            store_rows.append({
                "brand": brand, "archetype": TARGETS[brand]["archetype"], **r
            })
    store_rows.sort(key=lambda r: (r["brand"], r["nearest_m"] if r["nearest_m"] is not None else 1e99, r["id"]))
    store_csv = OUT_DIR / f"{SCRIPT_VERSION}_STORE_LEVEL.csv"
    write_csv(store_csv, store_rows, store_fields)

    brand_summary = []
    for brand, rows in all_rows.items():
        s = aggregate_stats(rows)
        dup_locs, dup_rows = exact_duplicate_diagnostics(target_points[brand])
        brand_summary.append({
            "brand": brand,
            "archetype": TARGETS[brand]["archetype"],
            **s,
            "exact_coordinate_duplicate_locations": dup_locs,
            "exact_coordinate_duplicate_rows": dup_rows,
            "profile_sample_n_ge_30": "YES" if len(rows) >= MIN_PROFILE_N else "NO",
            "method_label": "observed_spacing_descriptive_not_profitability_threshold",
        })
    bs_fields = list(brand_summary[0].keys())
    brand_csv = OUT_DIR / f"{SCRIPT_VERSION}_BRAND_SUMMARY.csv"
    write_csv(brand_csv, brand_summary, bs_fields)

    density_rows = []
    for brand, rows in all_rows.items():
        for st in ("Q1_baja","Q2_media_baja","Q3_media_alta","Q4_alta"):
            rr = [r for r in rows if r["density_stratum"] == st]
            if not rr: continue
            s = aggregate_stats(rr)
            density_rows.append({
                "brand": brand, "archetype": TARGETS[brand]["archetype"],
                "density_stratum": st,
                "density_proxy_median": qtile([x["density_proxy_3x3_001deg"] for x in rr], .50),
                **s,
                "profile_sample_n_ge_30": "YES" if len(rr) >= MIN_PROFILE_N else "NO",
            })
    density_csv = OUT_DIR / f"{SCRIPT_VERSION}_DENSITY_STRATA.csv"
    write_csv(density_csv, density_rows, list(density_rows[0].keys()) if density_rows else ["brand"])

    city_rows = []
    for brand, rows in all_rows.items():
        grouped = defaultdict(list)
        for r in rows:
            key = (r.get("state",""), r.get("municipality",""), r.get("locality",""))
            grouped[key].append(r)
        for (state, mun, loc), rr in grouped.items():
            if len(rr) < MIN_CITY_N:
                continue
            s = aggregate_stats(rr)
            city_rows.append({
                "brand": brand, "archetype": TARGETS[brand]["archetype"],
                "state": state, "municipality": mun, "locality": loc,
                **s,
                "profile_sample_n_ge_30": "YES" if len(rr) >= MIN_PROFILE_N else "NO",
            })
    city_rows.sort(key=lambda r: (r["brand"], -r["n"], r["state"], r["municipality"], r["locality"]))
    city_csv = OUT_DIR / f"{SCRIPT_VERSION}_CITY_STATS.csv"
    write_csv(city_csv, city_rows, list(city_rows[0].keys()) if city_rows else ["brand"])

    excluded_rows = [
        {"brand": b, "reason": reason, "count": n}
        for (b, reason), n in sorted(excluded.items())
    ]
    excluded_csv = OUT_DIR / f"{SCRIPT_VERSION}_EXCLUDED_MATCHES_SUMMARY.csv"
    write_csv(excluded_csv, excluded_rows, ["brand","reason","count"])

    report = {
        "schema": SCRIPT_VERSION,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "verdict": "DESCRIPTIVE_STUDY_COMPLETE_NOT_POLICY_AUTHORIZATION",
        "production_writes": {
            "r2": 0, "manifest": 0, "github": 0, "lovable": 0, "supabase": 0, "denue_source": 0
        },
        "source": {
            **source,
            "prepare_sqlite": str(DB),
            "recoverable": str(RECOVERABLE),
            "recoverable_sha256": EXPECTED_RECOVERABLE_SHA256,
            "official_denue_zip_rows_scanned": official_rows_scanned,
            "brand_matching_blob_sha_provenance": BRAND_MATCHING_BLOB_SHA,
        },
        "methodology": {
            "warning": "Observed spacing is descriptive and MUST NOT be interpreted as causal profitability tolerance.",
            "targets": TARGETS,
            "nearest_neighbor": "exact haversine among matched same-brand DENUE outlet candidates",
            "multi_sister_exposure_radii_m": list(RADII_M),
            "density_proxy": {
                "definition": "count of current materialized DENUE rows in surrounding 3x3 cells of 0.01 degree grid",
                "use": "stratification proxy only; NOT population density and NOT a score input",
                "pooled_quartile_thresholds": {"p25": d25, "p50": d50, "p75": d75},
            },
            "city_stats_min_n": MIN_CITY_N,
            "profile_min_n": MIN_PROFILE_N,
            "duplicate_warning": "Exact/near-coincident record diagnostics are reported. Identity-collapse should be reviewed before policy calibration if material.",
            "tiendas_3b_warning": "DENUE-based descriptive network only; runtime may also use an OSM fallback for discount retail, so 3B is a lower-bound network view.",
        },
        "brand_summary": brand_summary,
        "density_strata": density_rows,
        "city_stats_count": len(city_rows),
        "missing_city_metadata_ids": missing_city[:100],
        "missing_city_metadata_count": len(missing_city),
        "excluded_match_counts": excluded_rows,
        "policy_authorization": False,
        "score_change_authorized": False,
    }
    report_path = OUT_DIR / f"{SCRIPT_VERSION}_REPORT.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = []
    add = lines.append
    add("="*100)
    add("LANTIVO — CANNIBALIZATION SPACING STUDY V1")
    add("DESCRIPTIVE ONLY — NOT A SCORE POLICY")
    add("="*100)
    add(f"RAW DENUE: {source['raw']:,}")
    add(f"PRE-C2 SEEN: {source['seen']:,}")
    add(f"C2 RECOVERED UNION: +{source['recovered']:,}")
    add(f"CURRENT DENUE UNION FOR STUDY: {source['current_denue']:,}")
    add("")
    add("METHOD WARNING:")
    add("Observed same-brand spacing describes the network that exists. It does NOT prove profitable spacing.")
    add("Nearest-neighbor is supplemented with cumulative sister counts inside multiple radii.")
    add("Density strata use a DENUE local-density proxy, not population density.")
    add("")
    add("BRAND SUMMARY")
    add("-"*100)
    for r in brand_summary:
        add(
            f"{r['brand']:<24} N={r['n']:>6,} | NN P10/P25/P50/P75="
            f"{fmt(r['nn_p10_m'],0)}/{fmt(r['nn_p25_m'],0)}/{fmt(r['nn_p50_m'],0)}/{fmt(r['nn_p75_m'],0)} m "
            f"| any<=500m {fmt(r['pct_with_any_sister_within_500m'])}% "
            f"| any<=1000m {fmt(r['pct_with_any_sister_within_1000m'])}% "
            f"| any<=2000m {fmt(r['pct_with_any_sister_within_2000m'])}%"
        )
        add(
            f"{'':24} near-dup diagnostics NN<=10/25/60m="
            f"{fmt(r['pct_nn_le_10m'])}%/{fmt(r['pct_nn_le_25m'])}%/{fmt(r['pct_nn_le_60m'])}% "
            f"| exact-coordinate duplicate rows={r['exact_coordinate_duplicate_rows']:,}"
        )
    add("")
    add("DENSITY PROXY POOLED QUARTILES")
    add(f"P25={fmt(d25,0)} | P50={fmt(d50,0)} | P75={fmt(d75,0)} current-DENUE rows in 3x3×0.01° neighborhood")
    add("")
    add("PROFILE ELIGIBILITY")
    add(f"Brand/density or city strata need N >= {MIN_PROFILE_N} before they can inform a brand-specific prior.")
    add(f"City table reports groups N >= {MIN_CITY_N}; N 10–29 is descriptive only.")
    add("")
    add("HARD LIMITS")
    add("- No R/C/Pmax selected.")
    add("- No score change.")
    add("- No 800m replacement.")
    add("- Gasoline not studied.")
    add("- 3B is DENUE-only in this study; OSM fallback is not merged.")
    add("- Identity-collapse risk must be reviewed using near-duplicate diagnostics.")
    add("")
    add("NEXT AUDIT:")
    add("Claude + Gris review BRAND_SUMMARY + DENSITY_STRATA + CITY_STATS before proposing any policy.")
    add("")
    add(f"REPORT: {report_path}")
    add(f"STORE LEVEL: {store_csv}")
    add(f"BRAND SUMMARY: {brand_csv}")
    add(f"DENSITY STRATA: {density_csv}")
    add(f"CITY STATS: {city_csv}")
    summary_path = OUT_DIR / f"{SCRIPT_VERSION}_SUMMARY.txt"
    summary_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    outputs = [report_path, summary_path, store_csv, brand_csv, density_csv, city_csv, excluded_csv]
    hashes_path = OUT_DIR / f"{SCRIPT_VERSION}_HASHES.txt"
    with hashes_path.open("w", encoding="utf-8") as f:
        for p in outputs:
            f.write(f"{sha256_file(p)}  {p.name}\n")

    log("")
    log("\n".join(lines))
    log(f"HASHES: {hashes_path}")
    log("")
    log(f"PASS — {SCRIPT_VERSION} — {time.time()-t0:.1f}s")
    log("ZERO PRODUCTION WRITES. NO POLICY AUTHORIZATION.")

if __name__ == "__main__":
    main()
