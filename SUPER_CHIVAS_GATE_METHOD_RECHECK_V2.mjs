#!/usr/bin/env node
// Audit-temp only. Writes only /tmp. Re-runs the independent GET-only gate with
// name-proxy precision aligned to national-local-brand-corpus distinctive_core.
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const src = fs.readFileSync("SUPER_CHIVAS_IDENTITY_ONLY_GATE.mjs", "utf8");
const start = src.indexOf("function nationalIdentityMetrics(basePois,candPois){");
const marker = "// ---------------------------------------------------------------------------\n// Live Mexicali runtime-like loader";
const end = src.indexOf(marker, start);
if (start < 0 || end < 0) throw new Error("nationalIdentityMetrics block not found");

const replacement = `function nationalIdentityMetrics(basePois,candPois){
 const perOpp=[];let hcDen=0,hcFp=0,nameDen=0,nameColl=0;const nameExamples=[],hcExamples=[];
 const baseCommercial=basePois.filter(p=>COMMERCIAL_CATEGORIES.has(p.category)),candCommercial=candPois.filter(p=>COMMERCIAL_CATEGORIES.has(p.category));
 check(sameJson(sortedIds(baseCommercial),sortedIds(candCommercial)),"national commercial IDs changed");
 check(basePois.filter(p=>p.category==="generador_flujo").length===candPois.filter(p=>p.category==="generador_flujo").length,"national flow count changed");
 for(const opp of OPPORTUNITIES){
  const b=getBrandSearchPois(basePois,opp),cb=getBrandSearchPois(candPois,opp);
  check(sameJson(ids(b),ids(cb)),opp+": getBrandSearchPois changed baseline->candidate");
  check(sameJson(ids(getValidCompetitionPois(basePois,opp)),ids(getValidCompetitionPois(candPois,opp))),opp+": direct competition IDs changed");
  const bs=getSemanticSearchPois(basePois,opp),cs=getSemanticSearchPois(candPois,opp);
  check(sameJson(bs?ids(bs):null,cs?ids(cs):null),opp+": semantic IDs changed");
  const can=getCanibalizationIdentityPois(candPois,opp);const bset=new Set(b.map(p=>p.id)),extras=can.filter(p=>!bset.has(p.id));
  perOpp.push({opportunity:opp,base:b.length,candidate:can.length,extras:extras.length});
  const targets=b.slice(0,250);
  for(const a of targets){
   const ab=highConfidenceBrand(a),al=identityLabel(a),an=al?normalizeLocalBrandText(al):null;
   const core=al?localDistinctiveTokens(al):[];
   const variant=core.length?core.join(" "):null;
   for(const e of extras){
    const eb=highConfidenceBrand(e);
    if(ab&&eb&&ab!==eb){hcDen++;if(matchBrand(a.brand,e)){hcFp++;if(hcExamples.length<20)hcExamples.push("["+opp+"] "+a.brand+" => "+e.brand+" | "+e.name)}}
    if(!variant) continue;
    const el=identityLabel(e),en=el?normalizeLocalBrandText(el):null;
    if(an&&en&&an!==en){nameDen++;if(matchBrand(variant,e)){nameColl++;if(nameExamples.length<30)nameExamples.push("["+opp+"] core=\\\""+variant+"\\\" from=\\\""+al+"\\\" => "+el+" id="+e.id)}}
   }
  }
 }
 return {perOpp,hcDen,hcFp,nameDen,nameColl,nameExamples,hcExamples,totalBase:basePois.length,totalCandidate:candPois.length,commercial:baseCommercial.length,flow:basePois.filter(p=>p.category==="generador_flujo").length};
}

`;
const out = src.slice(0,start) + replacement + src.slice(end);
const path = "/tmp/SUPER_CHIVAS_IDENTITY_ONLY_GATE_METHOD_RECHECK_V2.mjs";
fs.writeFileSync(path, out);
const r = spawnSync(process.execPath, [path], { stdio: "inherit" });
process.exit(r.status ?? 2);
