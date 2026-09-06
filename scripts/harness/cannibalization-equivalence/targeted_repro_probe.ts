import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

type Poi = {
  id: string;
  source: string;
  name?: string | null;
  brand?: string | null;
  category?: string | null;
  lat: number;
  lng: number;
  address?: string | null;
  scian?: string | null;
  maps_url?: string | null;
  updated_at?: string | null;
  empleados_estimados?: number | null;
  distance_m?: number;
  [k: string]: any;
};

type SnapshotCell = {
  cell_id: string;
  path: string;
  sha256: string;
  bytes: number;
  poi_count: number;
  provenance: string;
};

type SnapshotIndex = {
  schema: string;
  active_base_version: string;
  authorities: { identity: { sha256: string } };
  cells: SnapshotCell[];
};

type Runtime = {
  dedupeDenuePois: (p: Poi[], a?: number, b?: number) => Poi[];
  applyDenueCanonicalAuthority: (p: Poi[]) => Poi[];
  cleanCanonicalCompetitionPois: (p: Poi[]) => Poi[];
  getBrandSearchPois: (p: Poi[], opportunity: string, brand: string) => Poi[];
  matchBrand: (brand: string, p: Poi) => boolean;
  resolveCellsForPoint: (lat: number, lng: number, radiusM: number) => {id:string}[];
  resolveHomeCell: (lat: number, lng: number) => {id:string};
  haversineDistance: (a:number,b:number,c:number,d:number) => number;
  applyEmpleadosLookup: (p: Poi[], m: Map<string,number>) => Poi[];
};

const PINNED_HEAD = "9409214fb4d003d1a34d5348e5923113f0ef695d";
const PINNED_TREE = "be68d7d2d105708eab1a8ab45702ae27d1430ae1";
const EXPECTED_IDENTITY_SHA = "279c4d9df04113e4020cc4d312170a7a4a1cc06bfd5afc7a3969a191adfd9bc4";
const EXPECTED_TARGET_N = 523;
const RUNTIME_RADIUS_M = 2000;

const EXPECTED_BRANDS: Record<string, number> = {
  "OXXO": 439,
  "Farmacias Guadalajara": 68,
  "Starbucks": 8,
  "McDonald's": 5,
  "Tiendas 3B": 3,
};

const TARGET_META: Record<string, { opportunity: string; brand: string }> = {
  "OXXO": { opportunity: "tiendas_conveniencia", brand: "OXXO" },
  "Farmacias Guadalajara": { opportunity: "farmacia", brand: "Farmacias Guadalajara" },
  "Starbucks": { opportunity: "fast_food", brand: "Starbucks" },
  "McDonald's": { opportunity: "fast_food", brand: "McDonald's" },
  "Tiendas 3B": { opportunity: "tiendas_descuento", brand: "Tiendas 3B" },
};

const EXPECTED_BLOBS: Record<string,string> = {
  "src/lib/dedupeDenuePois.ts": "41c289b9bd4eaf759011820029e012d1aaaffadd",
  "src/lib/directCompetitionFilter.ts": "b500eb7fa58bafe615a72cf8ed47643bfb1ab0eb",
  "src/lib/brandMatching.ts": "33c649441428413909455438fdf01d24ea0a267e",
  "src/lib/identityEntityMap.ts": "4fb36c54e613c2863fbbe649294bb44d47055b60",
  "src/lib/cellResolver.ts": "da4df6f658d51ff8d73eefbd489d1cd26fa3e25c",
  "src/lib/haversineDistance.ts": "69a77d57dee9c8d6e1fe8d1a89914d5f7a5ae223",
  "src/lib/denueCanonicalAuthority.ts": "ca619724f8880b17e2af89af93489fa5f8c3a388",
  "src/lib/empleadosCellsService.ts": "f890587a2d9eb94e747dd34821b39bab6bb78464",
  "src/lib/radarMergeLayers.ts": "1dce3bb39c753741c61e82d4f6b3c91c5eb952b4",
  "src/lib/loadRadar.ts": "c2d13f60cd65bd5740fa94a8007de5b83672dcf0",
  "scripts/build_vialnac_r2.py": "a6e331b5c902d4355adeb918ffb4ee44738eec11",
  "scripts/extract_vial_tile.py": "c3911d88b1c363711f6c9646dfb92365b1a81319",
};

function die(msg: string): never { throw new Error(`ABORT: ${msg}`); }
function ensureDir(p: string) { mkdirSync(p, { recursive: true }); }
function atomicWrite(p: string, body: string) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.partial`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, p);
}
function shaBytes(b: Buffer|string): string {
  return createHash("sha256").update(b).digest("hex");
}
function shaFile(p: string): string {
  return shaBytes(readFileSync(p));
}
function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
function parseArgs(argv: string[]) {
  const out: Record<string,string> = {};
  for (let i=0; i<argv.length; i+=2) {
    const k=argv[i], v=argv[i+1];
    if (!k?.startsWith("--") || v===undefined) die(`bad args near ${k ?? "<end>"}`);
    out[k.slice(2)] = v;
  }
  for (const k of ["runtime-root","snapshot-index","employee-cache-dir","targets-csv","out-dir"]) {
    if (!out[k]) die(`missing --${k}`);
  }
  return {
    runtimeRoot: out["runtime-root"],
    snapshotIndex: out["snapshot-index"],
    employeeCacheDir: out["employee-cache-dir"],
    targetsCsv: out["targets-csv"],
    outDir: out["out-dir"],
  };
}
function parseCsv(text: string): Record<string,string>[] {
  const rows: string[][]=[]; let row:string[]=[], field="", quoted=false;
  for (let i=0;i<text.length;i++) {
    const ch=text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i+1] === '"') { field+='"'; i++; } else quoted=false;
      } else field+=ch;
    } else if (ch === '"') quoted=true;
    else if (ch === ",") { row.push(field); field=""; }
    else if (ch === "\n") { row.push(field.replace(/\r$/,"")); rows.push(row); row=[]; field=""; }
    else field+=ch;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/,"")); rows.push(row); }
  if (!rows.length) return [];
  const h=rows[0].map((x,i)=>i===0?x.replace(/^\uFEFF/,""):x);
  return rows.slice(1).filter(r=>r.some(x=>x!=="")).map(r=>Object.fromEntries(h.map((x,i)=>[x,r[i]??""])));
}
function csvEscape(v:any): string {
  if (v===null || v===undefined) return "";
  const s=typeof v==="string"?v:typeof v==="object"?JSON.stringify(v):String(v);
  return /[",\r\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;
}
function writeCsv(p:string, rows:Record<string,any>[], fields:string[]) {
  atomicWrite(p,[fields.join(","),...rows.map(r=>fields.map(f=>csvEscape(r[f])).join(","))].join("\r\n")+"\r\n");
}
function cellSort(a:string,b:string):number {
  const pa=/^MX_(-?\d+)_(-?\d+)$/.exec(a), pb=/^MX_(-?\d+)_(-?\d+)$/.exec(b);
  if (!pa||!pb) die(`invalid cell id ${!pa?a:b}`);
  return Number(pa[1])-Number(pb[1]) || Number(pa[2])-Number(pb[2]);
}
function cellCenter(cid:string):[number,number] {
  const m=/^MX_(-?\d+)_(-?\d+)$/.exec(cid); if(!m) die(`invalid cell ${cid}`);
  return [(Number(m[1])+0.5)*0.02,(Number(m[2])+0.5)*0.02];
}
function guardRuntime(root:string) {
  const head=git(root,["rev-parse","HEAD"]), tree=git(root,["rev-parse","HEAD^{tree}"]);
  if(head!==PINNED_HEAD) die(`runtime HEAD ${head}`);
  if(tree!==PINNED_TREE) die(`runtime TREE ${tree}`);
  if(git(root,["status","--porcelain"])) die("runtime dirty");
  for(const [rel,expected] of Object.entries(EXPECTED_BLOBS)) {
    const actual=git(root,["hash-object",rel]);
    if(actual!==expected) die(`runtime blob drift ${rel}: ${actual}`);
  }
  return {head,tree};
}
async function importTs(root:string, rel:string, nonce:string):Promise<any> {
  return import(pathToFileURL(path.join(root,rel)).href+`?targeted_probe=${encodeURIComponent(nonce)}`);
}
async function loadRuntime(root:string, nonce:string):Promise<Runtime> {
  const [dedupe,filters,brands,cells,hav,authority,employees]=await Promise.all([
    importTs(root,"src/lib/dedupeDenuePois.ts",nonce),
    importTs(root,"src/lib/directCompetitionFilter.ts",nonce),
    importTs(root,"src/lib/brandMatching.ts",nonce),
    importTs(root,"src/lib/cellResolver.ts",nonce),
    importTs(root,"src/lib/haversineDistance.ts",nonce),
    importTs(root,"src/lib/denueCanonicalAuthority.ts",nonce),
    importTs(root,"src/lib/empleadosCellsService.ts",nonce),
  ]);
  return {
    dedupeDenuePois:dedupe.dedupeDenuePois,
    applyDenueCanonicalAuthority:authority.applyDenueCanonicalAuthority,
    cleanCanonicalCompetitionPois:filters.cleanCanonicalCompetitionPois,
    getBrandSearchPois:filters.getBrandSearchPois,
    matchBrand:brands.matchBrand,
    resolveCellsForPoint:cells.resolveCellsForPoint,
    resolveHomeCell:cells.resolveHomeCell,
    haversineDistance:hav.haversineDistance,
    applyEmpleadosLookup:employees.applyEmpleadosLookup,
  };
}
function poiListFromCellText(text:string,cid:string):Poi[] {
  const obj=JSON.parse(text);
  const list=Array.isArray(obj)?obj:obj.pois;
  if(!Array.isArray(list) || obj.cell_id!==cid || Number(obj.poi_count)!==list.length) die(`cell schema drift ${cid}`);
  return list as Poi[];
}
class CellStore {
  byId=new Map<string,SnapshotCell>(); cache=new Map<string,Poi[]>(); maxCache=768;
  currentSha=new Map<string,string>();
  constructor(cells:SnapshotCell[]) { for(const c of cells) this.byId.set(c.cell_id,c); }
  meta(cid:string):SnapshotCell|undefined { return this.byId.get(cid); }
  get(cid:string):Poi[] {
    const h=this.cache.get(cid); if(h){this.cache.delete(cid);this.cache.set(cid,h);return h;}
    const m=this.byId.get(cid); if(!m) return [];
    const buf=readFileSync(m.path), text=buf.toString("utf8");
    const list=poiListFromCellText(text,cid);
    this.currentSha.set(cid,shaBytes(buf));
    this.cache.set(cid,list);
    while(this.cache.size>this.maxCache)this.cache.delete(this.cache.keys().next().value!);
    return list;
  }
  shaStatus(cid:string):{expected:string;actual:string;match:boolean;path:string} {
    const m=this.byId.get(cid); if(!m) die(`missing cell ${cid}`);
    let actual=this.currentSha.get(cid);
    if(!actual){actual=shaFile(m.path);this.currentSha.set(cid,actual);}
    return {expected:m.sha256,actual,match:actual===m.sha256,path:m.path};
  }
}
class FrozenEmployees {
  mem=new Map<string,Map<string,number>>();
  constructor(public dir:string) {}
  cell(cid:string):Map<string,number> {
    const h=this.mem.get(cid); if(h) return h;
    const fp=path.join(this.dir,`${cid}.json`), miss=path.join(this.dir,`${cid}.missing`);
    let obj:any={};
    if(existsSync(fp)) obj=JSON.parse(readFileSync(fp,"utf8"));
    else if(existsSync(miss)) obj={};
    else die(`frozen employee cache missing cell ${cid}`);
    const m=new Map<string,number>();
    if(obj && typeof obj==="object" && !Array.isArray(obj)) for(const [id,v] of Object.entries(obj)) {
      const n=Number(v); if(Number.isFinite(n))m.set(id,n);
    }
    this.mem.set(cid,m); return m;
  }
  merged(cids:string[]):Map<string,number> {
    const out=new Map<string,number>();
    for(const cid of cids) for(const [id,n] of this.cell(cid)) out.set(id,n);
    return out;
  }
}
function poiFingerprint(p:Poi):string {
  return JSON.stringify([
    p.id,p.source,p.name??null,p.brand??null,p.category??null,
    p.lat,p.lng,p.address??null,p.scian??null,p.maps_url??null,
    p.updated_at??null,p.empleados_estimados??null,p.distance_m??null,
  ]);
}
function seqHash(pois:Poi[]):string {
  const h=createHash("sha256");
  for(const p of pois){h.update(poiFingerprint(p));h.update("\n");}
  return h.digest("hex");
}
function idsHash(pois:Poi[]):string {
  return shaBytes(pois.map(p=>p.id).join("\n")+"\n");
}
function orderInput(pois:Poi[],mode:"ORIGINAL"|"ID_SORT"|"REVERSE"):Poi[] {
  if(mode==="ORIGINAL") return pois.slice();
  if(mode==="REVERSE") return pois.slice().reverse();
  return pois.slice().sort((a,b)=>a.id.localeCompare(b.id)||a.source.localeCompare(b.source)||a.lat-b.lat||a.lng-b.lng);
}
function brandMatches(rt:Runtime, cleaned:Poi[], brand:string):Poi[] {
  const meta=TARGET_META[brand]; if(!meta) die(`unknown brand ${brand}`);
  return rt.getBrandSearchPois(cleaned,meta.opportunity,meta.brand).filter(p=>rt.matchBrand(meta.brand,p));
}

type TargetInfo={brand:string;member_id:string;new_unit_id:string;new_entity_id:string};
type Located={target:TargetInfo;storage_cell:string;coord_home:string;poi:Poi;storage_sha_match:boolean;storage_expected_sha:string;storage_actual_sha:string};

function validateTargets(rows:Record<string,string>[]):TargetInfo[] {
  const need=["brand","member_id","new_unit_id","new_entity_id"];
  for(const k of need) if(!rows[0] || !(k in rows[0])) die(`targets CSV missing ${k}`);
  if(rows.length!==EXPECTED_TARGET_N) die(`targets rows ${rows.length} != ${EXPECTED_TARGET_N}`);
  const ids=new Set<string>(); const counts:Record<string,number>={};
  const out:TargetInfo[]=[];
  for(const r of rows){
    const brand=r.brand, id=r.member_id;
    if(!EXPECTED_BRANDS[brand]) die(`unexpected brand ${brand}`);
    if(!id || ids.has(id)) die(`blank/duplicate member_id ${id}`); ids.add(id);
    counts[brand]=(counts[brand]??0)+1;
    out.push({brand,member_id:id,new_unit_id:r.new_unit_id,new_entity_id:r.new_entity_id});
  }
  for(const [b,n] of Object.entries(EXPECTED_BRANDS)) if((counts[b]??0)!==n) die(`brand count ${b}=${counts[b]??0} != ${n}`);
  return out;
}

function locateTargets(index:SnapshotIndex, store:CellStore, targets:TargetInfo[]):Located[] {
  const targetById=new Map(targets.map(t=>[t.member_id,t]));
  const found=new Map<string,Located[]>();
  const idRegex=/"id"\s*:\s*"([^"]+)"/g;
  const t0=Date.now();
  for(let i=0;i<index.cells.length;i++){
    const meta=index.cells[i];
    const buf=readFileSync(meta.path), text=buf.toString("utf8");
    let hit=false; idRegex.lastIndex=0; let m:RegExpExecArray|null;
    while((m=idRegex.exec(text))!==null){if(targetById.has(m[1])){hit=true;break;}}
    if(hit){
      const actual=shaBytes(buf);
      const list=poiListFromCellText(text,meta.cell_id);
      for(const p of list){
        const target=targetById.get(p.id); if(!target)continue;
        const loc:Located={
          target,storage_cell:meta.cell_id,coord_home:"",poi:p,
          storage_sha_match:actual===meta.sha256,storage_expected_sha:meta.sha256,storage_actual_sha:actual,
        };
        const arr=found.get(p.id)??[];arr.push(loc);found.set(p.id,arr);
      }
    }
    if((i+1)%2000===0||i+1===index.cells.length)console.log(`[LOCATE ${i+1}/${index.cells.length}] found=${found.size}/${targets.length} elapsed=${((Date.now()-t0)/1000).toFixed(1)}s`);
  }
  const missing=targets.filter(t=>!found.has(t.member_id)).map(t=>t.member_id);
  if(missing.length) die(`targets missing from current snapshot paths: ${missing.slice(0,20).join("|")} total=${missing.length}`);
  const dup=[...found].filter(([,v])=>v.length!==1);
  if(dup.length) die(`target IDs occur in multiple storage cells: ${dup.slice(0,10).map(([id,v])=>`${id}:${v.length}`).join(",")} total=${dup.length}`);
  const out=[...found.values()].map(v=>v[0]);
  return out;
}

async function runWindow(
  rt:Runtime, store:CellStore, employees:FrozenEmployees, home:string,
  targetRows:Located[], mode:"ORIGINAL"|"ID_SORT"|"REVERSE", label:string
):Promise<{summary:Record<string,any>;targetRows:Record<string,any>[];windowCells:string[]}> {
  const [clat,clng]=cellCenter(home);
  const refs=rt.resolveCellsForPoint(clat,clng,RUNTIME_RADIUS_M).map(x=>x.id);
  const merged:Poi[]=[];
  for(const cid of refs)for(const p of store.get(cid)){
    const d=rt.haversineDistance(clat,clng,p.lat,p.lng);
    if(d<=RUNTIME_RADIUS_M)merged.push({...p,distance_m:d});
  }
  const ordered=orderInput(merged,mode);
  const emp=employees.merged(refs);
  const enriched=rt.applyEmpleadosLookup(ordered,emp);
  const a=rt.dedupeDenuePois(enriched,7.5,-1);
  const ab=rt.dedupeDenuePois(enriched,7.5);
  const cleanAB=rt.cleanCanonicalCompetitionPois(rt.applyDenueCanonicalAuthority(ab));

  const brands=[...new Set(targetRows.map(x=>x.target.brand))].sort();
  const emittedByBrand=new Map<string,Set<string>>();
  for(const brand of brands){
    const matches=brandMatches(rt,cleanAB,brand).filter(p=>rt.resolveHomeCell(p.lat,p.lng).id===home);
    emittedByBrand.set(brand,new Set(matches.map(p=>p.id)));
  }
  const rawIds=new Set(ordered.map(p=>p.id)), enrIds=new Set(enriched.map(p=>p.id)), aIds=new Set(a.map(p=>p.id)), abIds=new Set(ab.map(p=>p.id));
  const tr=targetRows.map(x=>({
    label,mode,home_cell:home,brand:x.target.brand,member_id:x.target.member_id,
    storage_cell:x.storage_cell,
    raw_present:rawIds.has(x.target.member_id)?"YES":"NO",
    enriched_present:enrIds.has(x.target.member_id)?"YES":"NO",
    rule_a_survivor:aIds.has(x.target.member_id)?"YES":"NO",
    rule_ab_survivor:abIds.has(x.target.member_id)?"YES":"NO",
    emitted_for_brand_home:emittedByBrand.get(x.target.brand)?.has(x.target.member_id)?"YES":"NO",
  }));
  const summary={
    label,mode,home_cell:home,target_n:targetRows.length,
    refs_n:refs.length,raw_n:ordered.length,enriched_n:enriched.length,a_n:a.length,ab_n:ab.length,clean_ab_n:cleanAB.length,
    raw_ids_sha256:idsHash(ordered),raw_seq_sha256:seqHash(ordered),
    enriched_ids_sha256:idsHash(enriched),enriched_seq_sha256:seqHash(enriched),
    rule_a_ids_sha256:idsHash(a),rule_a_seq_sha256:seqHash(a),
    rule_ab_ids_sha256:idsHash(ab),rule_ab_seq_sha256:seqHash(ab),
    clean_ab_ids_sha256:idsHash(cleanAB),clean_ab_seq_sha256:seqHash(cleanAB),
    target_emitted_n:tr.filter(r=>r.emitted_for_brand_home==="YES").length,
  };
  return {summary,targetRows:tr,windowCells:refs};
}

async function main(){
  const args=parseArgs(process.argv.slice(2));ensureDir(args.outDir);
  console.log("=".repeat(100));
  console.log("LANTIVO TARGETED REPRODUCIBILITY PROBE — 523 NEW-ONLY MEMBERS");
  console.log("READ-ONLY INPUTS · FROZEN EMPLOYEE CACHE ONLY · LOCAL EVIDENCE WRITES ONLY");
  console.log("=".repeat(100));
  const guards=guardRuntime(args.runtimeRoot);
  const index=JSON.parse(readFileSync(args.snapshotIndex,"utf8")) as SnapshotIndex;
  if(index.schema!=="LANTIVO_CANNIBALIZATION_EQUIVALENCE_SNAPSHOT_V1"||index.cells.length!==20003)die("snapshot index schema/count drift");
  if(index.authorities.identity.sha256!==EXPECTED_IDENTITY_SHA)die("identity SHA drift");
  if(!existsSync(args.employeeCacheDir))die("employee cache dir missing");
  const targetRows=parseCsv(readFileSync(args.targetsCsv,"utf8"));
  const targets=validateTargets(targetRows);
  console.log(`[PASS] runtime ${guards.head} tree ${guards.tree}`);
  console.log(`[PASS] targets ${targets.length}; brand signature exact`);

  const rtLocate=await loadRuntime(args.runtimeRoot,"LOCATE");
  const store=new CellStore(index.cells);
  const located=locateTargets(index,store,targets);
  for(const x of located)x.coord_home=rtLocate.resolveHomeCell(x.poi.lat,x.poi.lng).id;

  const locRows=located.sort((a,b)=>a.target.brand.localeCompare(b.target.brand)||a.target.member_id.localeCompare(b.target.member_id)).map(x=>({
    brand:x.target.brand,member_id:x.target.member_id,new_unit_id:x.target.new_unit_id,new_entity_id:x.target.new_entity_id,
    storage_cell:x.storage_cell,coord_home:x.coord_home,storage_equals_coord_home:x.storage_cell===x.coord_home?"YES":"NO",
    lat:x.poi.lat,lng:x.poi.lng,storage_sha_match_snapshot:x.storage_sha_match?"YES":"NO",
    storage_expected_sha256:x.storage_expected_sha,storage_actual_sha256:x.storage_actual_sha,
  }));
  writeCsv(path.join(args.outDir,"TARGET_LOCATOR.csv"),locRows,[
    "brand","member_id","new_unit_id","new_entity_id","storage_cell","coord_home","storage_equals_coord_home","lat","lng",
    "storage_sha_match_snapshot","storage_expected_sha256","storage_actual_sha256"
  ]);

  const byHome=new Map<string,Located[]>();
  for(const x of located){const arr=byHome.get(x.coord_home)??[];arr.push(x);byHome.set(x.coord_home,arr);}
  const homes=[...byHome.keys()].sort(cellSort);
  console.log(`[TARGET HOMES] ${homes.length} unique homes for 523 targets`);

  // Verify every physical cell used by the targeted windows against the SHA frozen in SNAPSHOT_INDEX.
  const windowCellSet=new Set<string>();
  for(const home of homes){const [clat,clng]=cellCenter(home);for(const r of rtLocate.resolveCellsForPoint(clat,clng,RUNTIME_RADIUS_M))windowCellSet.add(r.id);}
  const driftRows:Record<string,any>[]=[];
  for(const cid of [...windowCellSet].sort(cellSort)){
    const meta=store.meta(cid); if(!meta)continue;
    const st=store.shaStatus(cid);
    if(!st.match)driftRows.push({cell_id:cid,path:st.path,expected_sha256:st.expected,actual_sha256:st.actual});
  }
  writeCsv(path.join(args.outDir,"TARGET_WINDOW_CELL_DRIFT.csv"),driftRows,["cell_id","path","expected_sha256","actual_sha256"]);
  console.log(`[SNAPSHOT PATH DRIFT] targeted-window cells=${windowCellSet.size} mismatches=${driftRows.length}`);

  const employeesA=new FrozenEmployees(args.employeeCacheDir), employeesB=new FrozenEmployees(args.employeeCacheDir);
  const rtA=await loadRuntime(args.runtimeRoot,"RUN_A"), rtB=await loadRuntime(args.runtimeRoot,"RUN_B");

  const summaries:Record<string,any>[]=[], targetAudit:Record<string,any>[]=[];
  const modes:[Runtime,FrozenEmployees,"ORIGINAL"|"ID_SORT"|"REVERSE",string][]=[
    [rtA,employeesA,"ORIGINAL","A_ORIGINAL"],
    [rtB,employeesB,"ORIGINAL","B_ORIGINAL"],
    [rtA,employeesA,"ID_SORT","A_ID_SORT"],
    [rtA,employeesA,"REVERSE","A_REVERSE"],
  ];
  for(const [rt,emp,mode,label] of modes){
    const t0=Date.now();
    for(let i=0;i<homes.length;i++){
      const home=homes[i], r=await runWindow(rt,store,emp,home,byHome.get(home)!,mode,label);
      summaries.push(r.summary);targetAudit.push(...r.targetRows);
      if((i+1)%50===0||i+1===homes.length)console.log(`[${label} ${i+1}/${homes.length}] ${((Date.now()-t0)/1000).toFixed(1)}s`);
    }
  }

  writeCsv(path.join(args.outDir,"WINDOW_HASHES.csv"),summaries,[
    "label","mode","home_cell","target_n","refs_n","raw_n","enriched_n","a_n","ab_n","clean_ab_n",
    "raw_ids_sha256","raw_seq_sha256","enriched_ids_sha256","enriched_seq_sha256",
    "rule_a_ids_sha256","rule_a_seq_sha256","rule_ab_ids_sha256","rule_ab_seq_sha256",
    "clean_ab_ids_sha256","clean_ab_seq_sha256","target_emitted_n"
  ]);
  writeCsv(path.join(args.outDir,"TARGET_SURVIVORS.csv"),targetAudit,[
    "label","mode","home_cell","brand","member_id","storage_cell","raw_present","enriched_present","rule_a_survivor","rule_ab_survivor","emitted_for_brand_home"
  ]);

  const sBy=new Map(summaries.map(r=>[`${r.label}|${r.home_cell}`,r]));
  const repeatDiff:Record<string,any>[]=[], orderSensitive:Record<string,any>[]=[];
  const hashFields=["raw_ids_sha256","raw_seq_sha256","enriched_ids_sha256","enriched_seq_sha256","rule_a_ids_sha256","rule_a_seq_sha256","rule_ab_ids_sha256","rule_ab_seq_sha256","clean_ab_ids_sha256","clean_ab_seq_sha256","target_emitted_n"];
  for(const home of homes){
    const a=sBy.get(`A_ORIGINAL|${home}`)!,b=sBy.get(`B_ORIGINAL|${home}`)!;
    const differing=hashFields.filter(f=>String(a[f])!==String(b[f]));
    if(differing.length)repeatDiff.push({home_cell:home,differing_fields:differing.join("|"),a_target_emitted:a.target_emitted_n,b_target_emitted:b.target_emitted_n});
    for(const label of ["A_ID_SORT","A_REVERSE"]){
      const x=sBy.get(`${label}|${home}`)!;
      const dif=hashFields.filter(f=>String(a[f])!==String(x[f]));
      if(dif.length)orderSensitive.push({home_cell:home,comparison:`A_ORIGINAL_VS_${label}`,differing_fields:dif.join("|"),original_target_emitted:a.target_emitted_n,variant_target_emitted:x.target_emitted_n});
    }
  }
  writeCsv(path.join(args.outDir,"REPEAT_DIFF.csv"),repeatDiff,["home_cell","differing_fields","a_target_emitted","b_target_emitted"]);
  writeCsv(path.join(args.outDir,"ORDER_SENSITIVITY.csv"),orderSensitive,["home_cell","comparison","differing_fields","original_target_emitted","variant_target_emitted"]);

  const targetByLabel=new Map<string,Map<string,string>>();
  for(const r of targetAudit){
    const m=targetByLabel.get(r.label)??new Map<string,string>();
    m.set(r.member_id,[r.rule_ab_survivor,r.emitted_for_brand_home].join("|"));targetByLabel.set(r.label,m);
  }
  const originalA=targetByLabel.get("A_ORIGINAL")!, originalB=targetByLabel.get("B_ORIGINAL")!;
  const repeatTargetDiff=[...originalA].filter(([id,v])=>originalB.get(id)!==v).map(([id,v])=>({member_id:id,a_state:v,b_state:originalB.get(id)??""}));
  writeCsv(path.join(args.outDir,"REPEAT_TARGET_DIFF.csv"),repeatTargetDiff,["member_id","a_state","b_state"]);

  const report={
    schema:"LANTIVO_TARGETED_REPRO_PROBE_V1",
    runtime_head:guards.head,runtime_tree:guards.tree,
    targets:targets.length,target_homes:homes.length,target_window_cells:windowCellSet.size,
    targeted_window_snapshot_path_sha_mismatches:driftRows.length,
    target_storage_cell_sha_mismatches:locRows.filter(r=>r.storage_sha_match_snapshot==="NO").length,
    target_storage_vs_coord_home_mismatches:locRows.filter(r=>r.storage_equals_coord_home==="NO").length,
    repeated_original_window_hash_differences:repeatDiff.length,
    repeated_original_target_state_differences:repeatTargetDiff.length,
    order_sensitive_window_comparisons:orderSensitive.length,
    employee_cache_mode:"FROZEN_LOCAL_ONLY_NO_NETWORK",
    remote_access:"NONE",
    product_writes:0,
    interpretation_guard:"DIAGNOSTIC_ONLY_NO_RUNTIME_OR_POLICY_CHANGE",
  };
  atomicWrite(path.join(args.outDir,"REPORT.json"),JSON.stringify(report,null,2)+"\n");
  const outputs=["TARGET_LOCATOR.csv","TARGET_WINDOW_CELL_DRIFT.csv","WINDOW_HASHES.csv","TARGET_SURVIVORS.csv","REPEAT_DIFF.csv","ORDER_SENSITIVITY.csv","REPEAT_TARGET_DIFF.csv","REPORT.json"];
  atomicWrite(path.join(args.outDir,"HASHES.txt"),outputs.sort().map(n=>`${shaFile(path.join(args.outDir,n))}  ${n}`).join("\n")+"\n");
  console.log("=".repeat(100));
  console.log("TARGETED PROBE COMPLETE");
  console.log(JSON.stringify(report,null,2));
  console.log("=".repeat(100));
}
main().catch(e=>{console.error(e?.stack??String(e));process.exit(1);});
