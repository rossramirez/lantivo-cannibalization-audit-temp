# Lantivo — Cannibalization Equivalence Gate V1

**Scope:** READ-ONLY audit harness for the `IDENTITY/DEDUP + FILTER EQUIVALENCE GATES` that must close before any cannibalization score policy (`R/C/Pmax`) is designed.

This directory is intentionally outside the production runtime path. Publishing it on an audit branch does **not** activate any product behavior.

## Frozen runtime authority

The harness fails closed unless the checkout used as oracle is exactly:

- commit: `9409214fb4d003d1a34d5348e5923113f0ef695d`
- root tree: `be68d7d2d105708eab1a8ab45702ae27d1430ae1`

It also verifies Git blob SHAs for every imported semantic authority, including:

- `dedupeDenuePois.ts`
- `denueCanonicalAuthority.ts`
- `directCompetitionFilter.ts`
- `brandMatching.ts`
- `identityEntityMap.ts`
- `cellResolver.ts`
- `haversineDistance.ts`
- `empleadosCellsService.ts`
- `loadRadar.ts`

A HEAD/blob drift is an **ABORT**, never an implicit upgrade.

## Why STORE_LEVEL + prepare.sqlite are insufficient

The certified V1.3 `STORE_LEVEL` is still the study baseline (`30,073` rows; SHA256 `8049764865d60ca48172dff2117b496846c947aa3a2b5d59df908c4b9d6ded39`), but it cannot by itself reproduce runtime because:

1. runtime `matchBrand()` evaluates both `poi.name` and `poi.brand`;
2. `dedupeDenuePois` Rule B consumes `address` + `updated_at`;
3. runtime enriches `empleados_estimados` **before** dedupe, and that field can affect survivor tie-breaks;
4. runtime applies `applyDenueCanonicalAuthority` **between dedupe and canonical competition cleaning**.

The gate therefore uses the active Radar data plane plus the live pinned TS functions, rather than inventing missing fields or porting semantics to Python.

## Exact relevant runtime order

For the commercial base universe exercised here:

```text
resolveCellsForPoint (5x5 for <=2km)
→ distance_m + radius filter
→ empleados lookup
→ dedupeDenuePois (Rule A 7.5m + Rule B 50m)
→ applyDenueCanonicalAuthority
→ cleanCanonicalCompetitionPois
→ getBrandSearchPois
→ matchBrand(name + brand)
→ identity overlay ONLY where certified
```

The manifest guard requires `brand_overrides_url == null` and the pinned curated release `2026-07-21-vialnac-nacional-v1`. Its pinned producer only emits `carretera`, `vialidad_primaria`, and `puente`, so it cannot enter any of the five commercial brand-search category universes. If that layer/version changes, the gate aborts and requires a new audit instead of silently assuming base-only equivalence.

## Claude corrections incorporated

### 1. Dedupe is runtime-windowed, not assumed nationally equivalent

The primary nationalization is a **study construction**:

- for every Radar home cell containing a possible target match;
- use the exact runtime `resolveCellsForPoint` 5x5 window;
- use a 2,000m radius around the cell center;
- run the exact runtime pipeline;
- emit only survivors whose home cell is the tile being emitted.

A second diagnostic dedupes the complete *relevant exact-name buckets* globally. The harness reports every symmetric delta between the tiled runtime-window construction and the global diagnostic.

Any such context delta makes:

```text
calibration_ready_for_policy_design = false
```

No replacement clustering algorithm is introduced.

### 2. Entity↔entity spacing is explicitly study-derived

Runtime Day-2 defines property→entity distance, not entity→entity spacing. This gate therefore labels the new spacing metric explicitly:

```text
STUDY_DERIVED_MIN_PAIRWISE_MEMBER_HAVERSINE
```

For entities A and B:

```text
d(A,B) = min(haversine(a,b)) for every a∈A, b∈B
```

It is Day-2-compatible and conservative, but **not represented as a runtime behavior**.

## Identity scope

Certified Day-2 sidecar:

- version: `2026-08-30-day2-v1`
- policy: `STRICT_DEGREE_ONE_NO_TRANSITIVITY`
- 15,882 IDs → 7,941 entities
- SHA256: `279c4d9df04113e4020cc4d312170a7a4a1cc06bfd5afc7a3969a191adfd9bc4`

Runtime overlay is ON only for:

- `farmacia`
- `autoservicios`
- `tiendas_conveniencia`
- `fast_food`
- `restaurantes`

`tiendas_descuento` / **Tiendas 3B remains overlay OFF**. The harness may report a 3B sidecar result only as `SHADOW_ONLY_NOT_RUNTIME`; it never governs the runtime-equivalent distribution.

## Snapshot strategy — avoids an unnecessary 20,003-cell re-download

`prepare_snapshot.py` defaults to `local-certified` mode:

- re-hashes the exact 20,003 historical source cells against the frozen `prepare.sqlite.processed` checkpoint;
- re-hashes the 41 C2 candidate replacements against the frozen C2 inventory;
- reconstructs the active immutable `2026-09-05-base-c2-v1` keyset locally as 19,962 source-identical cells + 41 candidates;
- GET-verifies current manifest, C2 `_SUCCESS`, and the identity sidecar.

It writes an index of paths; it does **not** duplicate ~1 GB of cell files.

Fallback `public-snapshot` mode exists and is GET-only/checkpointed if the certified local source assets are unavailable.

## Employee lookup

The runtime manifest's `denue_empleados_cells_url` is read GET-only and cached locally only for cells actually touched by brand-candidate windows. HTTP 404 is recorded as a stable empty lookup, matching runtime semantics. Any other unrecoverable fetch error aborts rather than silently converting a transient failure into false missing metadata.

The employee cache itself is local evidence; `EMPLOYEE_CACHE_AUDIT.csv` hashes every cached 200/404 result used by the run.

## Gates / outputs

The evaluator produces, at minimum:

- `REPORT.json`
- `SUMMARY.txt`
- `STORE_LEVEL_RUNTIME_EQUIVALENT.csv`
- `BRAND_SUMMARY.csv`
- `DENSITY_STRATA.csv`
- `MATCH_DELTA.csv`
- `FILTER_DELTA.csv`
- `DEDUPE_AUDIT.csv`
- `DEDUPE_CONTEXT_DELTA.csv`
- `IDENTITY_AUDIT.csv`
- `COORDINATE_COLLISIONS.csv`
- `EMPLOYEE_CACHE_AUDIT.csv`
- `HASHES.txt`

The coordinate-collision output is **measurement only**. Distinct units are never merged because coordinates coincide or are close.

Density remains descriptive. For an identity group with >1 surviving member, the gate reports member min/max and uses the median member density proxy as an explicitly study-derived grouping value. This is not a runtime scoring rule.

## Forbidden actions

This gate does not contain any R2 SDK, Supabase client, GitHub writer, Lovable action, manifest mutation, score mutation, or product-code write path.

During execution:

```text
R2 write = 0
manifest write = 0
Supabase write = 0
GitHub write = 0
Lovable write = 0
calculateScore.ts = untouched
cannibalizationPolicy.ts = not created
card = untouched
```

## Execution

Do **not** execute until the source commit/blobs have received the read-only second signature.

The two large executable sources are published as deterministic line-boundary chunks under `source_parts/`. `assemble_sources.py` concatenates them byte-for-byte and fails unless the assembled SHA256 is exactly the frozen source SHA (`prepare_snapshot.py = 5773db99…`, `gate.ts = 8700e441…`). This avoids any lossy/manual large-file publication path while keeping every published blob independently auditable.

After audit, use `run.ps1` from this directory. It first reassembles and authenticates those exact sources. It requires explicit paths to:

- a local checkout pinned at `9409214...`;
- the certified V1.3 `STORE_LEVEL.csv`.

The runner first prepares the authenticated snapshot, then runs the Bun/TS oracle, hashes outputs, and creates a local audit ZIP. It does not publish results or mutate production.
