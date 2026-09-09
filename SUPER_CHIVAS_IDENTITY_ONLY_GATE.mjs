#!/usr/bin/env node
/*
LANTIVO — SUPER CHIVAS IDENTITY-ONLY NATIONAL GATE
Independent audit runner. READ-ONLY remote access (HTTP GET only).
This file lives only in lantivo-cannibalization-audit-temp, never in lantivo-vf.

Frozen source logic: rossramirez/lantivo-vf @
  d4e08469b36d86bf11af7cf0d17595c9766e2c31

Gate under test (prospective only): preserve identity_category on C1a flow POIs and
add them ONLY to the canibalization identity universe. No production write.
*/

const MANIFEST_URL = "https://datos.lantivo.app/radar/mx/manifest.json";
const FROZEN_HEAD = "d4e08469b36d86bf11af7cf0d17595c9766e2c31";
const FLOW_GENERATOR_SCIANS = new Set(["461121", "461122", "461213"]);
const DROP_SCIANS = new Set(["519290"]);
const VIAL_CATEGORIES = new Set(["carretera", "vialidad_primaria", "puente"]);
const COMMERCIAL_CATEGORIES = new Set([
  "farmacia", "gasolinera", "otros_combustibles", "fast_food", "restaurantes",
  "conveniencia", "autoservicio", "plaza_comercial", "banco", "mercado",
]);
const REGIONS = [
  { region: "Guadalajara, JAL", lat: 20.6831, lng: -103.3961 },
  { region: "CDMX", lat: 19.4326, lng: -99.1332 },
  { region: "Monterrey, NL", lat: 25.6866, lng: -100.3161 },
  { region: "Mexicali, BC", lat: 32.6534, lng: -115.4004 },
  { region: "Mérida, YUC", lat: 20.9674, lng: -89.5926 },
  { region: "Puebla, PUE", lat: 19.0414, lng: -98.2063 },
];
const OPPORTUNITIES = [
  "fast_food", "restaurantes", "cafeterias", "autoservicios",
  "tiendas_conveniencia", "tiendas_descuento", "farmacia", "gasolinera",
];

let failures = 0;
function fail(msg) { failures += 1; console.error(`FAIL: ${msg}`); }
function check(cond, msg) { if (!cond) fail(msg); }
function stable(obj) { return JSON.stringify(obj, Object.keys(obj).sort()); }
function stripIdentity(p) { const q = { ...p }; delete q.identity_category; return q; }
function ids(list) { return list.map((p) => p.id); }
function sortedIds(list) { return list.map((p) => p.id).sort(); }
function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function pct(n, d) { return d === 0 ? "n/a" : `${((n / d) * 100).toFixed(6)}%`; }

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function getJson(url, { attempts = 3, required = false } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { method: "GET", headers: { "user-agent": "lantivo-independent-audit/1" } });
      if (res.status === 404) return null;
      if (res.ok) return await res.json();
      last = new Error(`HTTP ${res.status} ${url}`);
    } catch (e) { last = e; }
    await sleep(250 * (i + 1));
  }
  if (required) throw last ?? new Error(`GET failed ${url}`);
  return null;
}
function rootUrl(base) { return base?.endsWith("/") ? base : `${base}/`; }
function withVersion(url, version) { return version ? `${url}?v=${encodeURIComponent(version)}` : url; }
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  async function worker() {
    while (true) {
      const i = next++; if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}
async function fetchCells(baseUrl, cellIds, version) {
  if (!baseUrl) return { pois: [], loaded: false, cellsFound: 0, cellsRequested: cellIds.length };
  const root = rootUrl(baseUrl);
  const chunks = await mapLimit(cellIds, 20, async (cellId) => {
    const json = await getJson(withVersion(`${root}${cellId}.json`, version));
    if (json == null) return { found: false, pois: [] };
    const list = Array.isArray(json) ? json : (json.pois ?? []);
    return { found: true, pois: Array.isArray(list) ? list : [] };
  });
  return {
    pois: chunks.flatMap((c) => c.pois),
    loaded: chunks.some((c) => c.found),
    cellsFound: chunks.filter((c) => c.found).length,
    cellsRequested: cellIds.length,
  };
}

// ---------------------------------------------------------------------------
// Cell / geometry helpers (parity with frozen runtime)
// ---------------------------------------------------------------------------
const CELL_STEP_DEG = 0.02;
function resolveCellsForPoint(lat, lng, radiusM) {
  const latIndex = Math.floor(lat / CELL_STEP_DEG);
  const lngIndex = Math.floor(lng / CELL_STEP_DEG);
  let spanCells;
  if (radiusM <= 2000) spanCells = 2;
  else spanCells = Math.max(1, Math.ceil((radiusM / 111000) / CELL_STEP_DEG));
  const cells = [];
  for (let dLat = -spanCells; dLat <= spanCells; dLat++) {
    for (let dLng = -spanCells; dLng <= spanCells; dLng++) {
      cells.push(`MX_${latIndex + dLat}_${lngIndex + dLng}`);
    }
  }
  return cells;
}
const EARTH_R = 6371000;
function haversineDistance(lat1, lng1, lat2, lng2) {
  const r = (d) => d * Math.PI / 180;
  const dLat = r(lat2 - lat1), dLng = r(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}
function radarMergeLayers(base, brand, curated) {
  const m = new Map();
  for (const p of base) m.set(p.id, p);
  for (const p of brand) m.set(p.id, p);
  for (const p of curated) m.set(p.id, p);
  return Array.from(m.values());
}

// ---------------------------------------------------------------------------
// DENUE dedupe — frozen contract
// ---------------------------------------------------------------------------
function normalizeExactName(raw) {
  if (!raw) return "";
  return raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
const GENERIC_NAMES = new Set([
  "", "sin nombre", "sin nombre comercial", "no disponible", "n d", "na", "restaurante", "restaurant",
  "restaurantes", "cafeteria", "cafe", "cafeteria y restaurante", "abarrotes", "tienda de abarrotes",
  "abarrotes y miscelanea", "miscelanea", "tienda", "tiendita", "estanquillo", "farmacia", "farmacias",
  "taqueria", "taquería", "tacos", "fonda", "cocina economica", "loncheria", "papeleria", "ferreteria",
  "carniceria", "polleria", "tortilleria", "panaderia", "peluqueria", "estetica", "salon de belleza",
  "taller mecanico", "purificadora", "internet", "ciber", "boutique", "novedades", "regalos", "verduleria",
  "fruteria", "recauderia", "vinos y licores", "deposito", "cremeria", "dulceria", "lonchería", "comedor",
  "consultorio", "consultorio medico", "escuela", "kinder", "gimnasio", "lavanderia", "mueblería", "muebleria",
  "zapateria", "refaccionaria", "vulcanizadora", "cerrajeria", "hotel", "bar", "cantina", "pizzeria", "pizza",
  "marisqueria", "juguerias", "jugueria", "nevería", "neveria", "paleteria", "tlapaleria",
]);
function normalizeAddress(raw) {
  if (!raw) return "";
  return raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function parseExteriorNumber(address) {
  if (!address) return null;
  const m = address.match(/#\s*([0-9]+[a-zA-Z]?)/) ?? address.match(/\bno\.?\s*([0-9]+[a-zA-Z]?)/i) ??
    address.match(/\bnum\.?\s*([0-9]+[a-zA-Z]?)/i) ?? address.match(/\bnumero\s*([0-9]+[a-zA-Z]?)/i);
  return m ? m[1].toLowerCase() : null;
}
function parsePostalCode(address) {
  if (!address) return null;
  const m = address.match(/\bc\.?\s*p\.?\s*:?\s*([0-9]{5})\b/i); return m ? m[1] : null;
}
function distancePoi(a, b) { return haversineDistance(a.lat, a.lng, b.lat, b.lng); }
function metadataScore(p) {
  let s = 0; if (p.address) s++; if (p.brand) s++; if (p.scian) s++; if (p.maps_url) s++; if (typeof p.empleados_estimados === "number") s++; return s;
}
function pickSurvivor(members) {
  return [...members].sort((a, b) => {
    const va = a.updated_at ?? "", vb = b.updated_at ?? "";
    if (va !== vb) return vb.localeCompare(va);
    const ma = metadataScore(a), mb = metadataScore(b); if (ma !== mb) return mb - ma;
    return a.id.localeCompare(b.id);
  })[0];
}
function isHistoricalDuplicateCluster(members) {
  const first = members[0], addr0 = normalizeAddress(first.address);
  if (addr0 && members.every((m) => normalizeAddress(m.address) === addr0)) return true;
  const num0 = parseExteriorNumber(first.address), cp0 = parsePostalCode(first.address);
  return !!(num0 && cp0 && members.every((m) => parseExteriorNumber(m.address) === num0 && parsePostalCode(m.address) === cp0));
}
function aggregateEmployees(members) {
  const vals = members.map((m) => m.empleados_estimados).filter((v) => typeof v === "number");
  if (!vals.length) return members.some((m) => m.empleados_estimados === null) ? null : undefined;
  return isHistoricalDuplicateCluster(members) ? Math.max(...vals) : vals.reduce((a, b) => a + b, 0);
}
function dedupeRuleA(pois, thresholdM) {
  const groups = new Map();
  for (const p of pois) {
    if (p.source !== "DENUE") continue;
    const key = normalizeExactName(p.name); if (GENERIC_NAMES.has(key)) continue;
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(p);
  }
  const replacement = new Map(), absorbed = new Set();
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    const pending = [...bucket];
    while (pending.length) {
      const seed = pending.shift(), cluster = [seed];
      for (let i = pending.length - 1; i >= 0; i--) {
        const c = pending[i]; if (cluster.every((m) => distancePoi(m, c) <= thresholdM)) { cluster.push(c); pending.splice(i, 1); }
      }
      if (cluster.length < 2) continue;
      const survivor = pickSurvivor(cluster), employees = aggregateEmployees(cluster), merged = { ...survivor };
      if (employees === undefined) delete merged.empleados_estimados; else merged.empleados_estimados = employees;
      replacement.set(survivor.id, merged); for (const m of cluster) if (m.id !== survivor.id) absorbed.add(m.id);
    }
  }
  if (!replacement.size) return pois.slice();
  return pois.filter((p) => !absorbed.has(p.id)).map((p) => replacement.get(p.id) ?? p);
}
function dedupeRuleB(pois, thresholdM) {
  const groups = new Map();
  for (const p of pois) {
    if (p.source !== "DENUE") continue;
    const key = normalizeExactName(p.name); if (GENERIC_NAMES.has(key) || !p.updated_at) continue;
    const num = parseExteriorNumber(p.address), cp = parsePostalCode(p.address); if (!num || !cp) continue;
    const k = `${key}||${num}||${cp}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p);
  }
  const replacement = new Map(), absorbed = new Set();
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    const vintages = bucket.map((p) => p.updated_at); if (new Set(vintages).size !== vintages.length) continue;
    const pending = [...bucket];
    while (pending.length) {
      const seed = pending.shift(), cluster = [seed];
      for (let i = pending.length - 1; i >= 0; i--) {
        const c = pending[i];
        if (cluster.every((m) => distancePoi(m, c) <= thresholdM && m.updated_at !== c.updated_at)) { cluster.push(c); pending.splice(i, 1); }
      }
      if (cluster.length < 2) continue;
      const survivor = pickSurvivor(cluster), vals = cluster.map((m) => m.empleados_estimados).filter((v) => typeof v === "number"), merged = { ...survivor };
      if (vals.length) merged.empleados_estimados = Math.max(...vals);
      else if (cluster.some((m) => m.empleados_estimados === null)) merged.empleados_estimados = null;
      else delete merged.empleados_estimados;
      replacement.set(survivor.id, merged); for (const m of cluster) if (m.id !== survivor.id) absorbed.add(m.id);
    }
  }
  if (!replacement.size) return pois.slice();
  return pois.filter((p) => !absorbed.has(p.id)).map((p) => replacement.get(p.id) ?? p);
}
function dedupeDenuePois(pois) { return dedupeRuleB(dedupeRuleA(pois, 7.5), 50); }

// ---------------------------------------------------------------------------
// C1a baseline/candidate
// ---------------------------------------------------------------------------
function applyAuthority(pois, candidate) {
  return pois.flatMap((poi) => {
    if (poi.source !== "DENUE") return [poi];
    const scian = poi.scian?.trim(); if (!scian) return [poi];
    if (DROP_SCIANS.has(scian)) return [];
    if (FLOW_GENERATOR_SCIANS.has(scian)) {
      return [{ ...poi, category: "generador_flujo", ...(candidate ? { identity_category: poi.identity_category ?? poi.category } : {}) }];
    }
    return [poi];
  });
}

// ---------------------------------------------------------------------------
// Direct competition canonical cleaning — frozen runtime parity
// ---------------------------------------------------------------------------
const DIRECT_COMPETITION_CATEGORIES = new Set(["farmacia","gasolinera","fast_food","restaurantes","conveniencia","autoservicio","plaza_comercial"]);
const DIRECT_COMPETITION_BY_OPPORTUNITY = {
  farmacia:{label:"Farmacias",categories:["farmacia"]}, gasolinera:{label:"Gasolineras",categories:["gasolinera"]},
  tiendas_conveniencia:{label:"Tiendas de conveniencia",categories:["conveniencia"]}, autoservicios:{label:"Autoservicios",categories:["autoservicio"]},
  tiendas_descuento:{label:"Tiendas de descuento identificadas",categories:["autoservicio","conveniencia"]}, fast_food:{label:"Fast food",categories:["fast_food"]},
  restaurantes:{label:"Restaurantes",categories:["restaurantes"]}, cafeterias:{label:"Cafeterías",categories:["restaurantes","fast_food"]},
  plaza_comercial:{label:"Plazas comerciales",categories:["plaza_comercial"]},
};
function normalizeCompetitionName(input) { return input.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim(); }
function normalizedPoiText(p) { return normalizeCompetitionName([p.name,p.brand].filter(Boolean).join(" ")); }
const INSTITUTIONAL_EXACT_NAMES = new Set(["condusef"]);
const COMMON_NON_OUTLET_RULES = [/\boficina(s)?\b/,/\badministrativ[oa]s?\b/,/\bcorporativo\b/,/\bcentro\s+de\s+distribucion\b/,/\bcedis\b/];
const GASOLINERA_RETAIL_HINTS = [/\bgasolina\b/,/\bgasolinera\b/,/\bdiesel\b/,/\bestacion\b/,/\bservicio\b/,/\bpemex\b/,/\bbp\b/,/\bmobil\b/,/\bshell\b/,/\bg500\b/,/\bfullgas\b/];
const GASOLINERA_EXCLUSION_RULES = [
  ["gas_lp",/\bgas\s+l\s*p\b/],["gas_licuado",/\bgas\s+licuado\b/],["gas_natural",/\bgas\s+natural\b/],["carburacion_lp",/\bcarburacion\b/],
  ["gasera",/\bgasera(s)?\b/],["planta",/\bplanta\b/],["almacen",/\balmacen(es)?\b/],["bodega",/\bbodega(s)?\b/],["terminal",/\bterminal\b/],
  ["deposito",/\bdeposito(s)?\b/],["distribucion",/\bdistribucion\b/],["distribuidor",/\bdistribuidor(a|es|as)?\b/],["comercializador",/\bcomercializador(a|es|as)?\b/],
  ["club",/\bclub\s+de\b/], ["empresa_de_gas",null],
];
const FARMACIA_LAB_RETAIL_EVIDENCE_RE=/\b(farmacia(s)?|botica(s)?|similares|simi|benavides|yza)\b/;
const FARMACIA_EXCLUSION_RULES = [
  ["laboratorio",(n)=>/\blaboratorio(s)?\b/.test(n)&&!FARMACIA_LAB_RETAIL_EVIDENCE_RE.test(n)],
  ["distribuidora_farmaceutica",/\bdistribuidor(a|es|as)?\b/],["mayoreo_farmaceutico",/\b(mayoreo|mayorista)\b/],
  ["almacen_medicamentos",/\balmacen(es)?\s+(de\s+)?(medicamento|farmaceutic)/],
];
const FOOD_NON_RESTAURANT_RULES=[["banquetes",/\bbanquete(s)?\b/],["catering",/\bcatering\b/],["comedor_industrial",/\bcomedor(es)?\s+industrial(es)?\b/],["servicio_comedor",/\bservicio(s)?\s+de\s+comedor(es)?\b/],["salon_eventos",/\bsalon\s+de\s+(fiestas|eventos)\b/]];
const SCHOOL_CAPTIVE_CATEGORIES=new Set(["fast_food","conveniencia","mercado","restaurantes","autoservicio"]);
const COOP_RE=/\b(?:cooperativ|coperativ)[a-z0-9]*\b/;
const SCHOOL_CONTEXT_RE=/\b(escuela|escuelas|escolar|primaria|primarias|secundaria|secundarias|preescolar|jardin\s+de\s+ninos|kinder|bachillerato|bachiller|preparatoria|cbtis|cetis|conalep|cecyte|cecytem|cecyt|telebachillerato)\b/;
const SCHOOL_ABBREV_RE=/\b(?:sec|secund|prim|esc)\.?\s*(?:n(?:um)?\.?\s*)?\d+\b/;
const UNIVERSITY_RE=/\b(?:universidad|facultad)\b/;
const SCHOOL_PLANTEL_RE=/\b(escuela(s)?|secundaria(s)?|primaria(s)?|prepa|preparatoria(s)?|preescolar(es)?|kinder)\b/;
const SCHOOL_EDU_CONTEXT_RE=/\b(escolar(es)?|escuela(s)?|secundaria(s)?|primaria(s)?|prepa|preparatoria(s)?|facultad(es)?|universidad(es)?)\b/;
const CAFETERIA_EDU_CONTEXT_RE=/\b(prepa|preparatoria(s)?|licenciatura(s)?|facultad(es)?|universidad(es)?)\b/;
const SCHOOL_STRONG_PHRASE_RE=/\b(escuelas?\s+(secundarias?|primarias?|preparatorias?)|secundarias?\s+tecnicas?)\b/;
function isSchoolCaptiveCommerceV2Extension(p) {
  if(p.source!=="DENUE"||!SCHOOL_CAPTIVE_CATEGORIES.has(p.category)) return false; const n=normalizeCompetitionName(p.name||""); if(!n)return false;
  if(/\bpuesto(s)?\s+escolar(es)?\b/.test(n))return true; if(/\bpuesto(s)?\b/.test(n)&&SCHOOL_PLANTEL_RE.test(n))return true;
  if(/^(escuela|escuelas|secundaria|primaria|preparatoria|preescolar|kinder)\b/.test(n))return true;
  if(/\b(comedor(es)?|cocina(s)?)\b/.test(n)&&SCHOOL_EDU_CONTEXT_RE.test(n))return true;
  if(/\bcafeteria(s)?\b/.test(n)&&CAFETERIA_EDU_CONTEXT_RE.test(n))return true; if(SCHOOL_STRONG_PHRASE_RE.test(n))return true; return false;
}
function isSchoolCaptiveCommerce(p){
  if(p.source!=="DENUE"||!SCHOOL_CAPTIVE_CATEGORIES.has(p.category))return false; const n=normalizeCompetitionName(p.name||""); if(!n)return false;
  if(/\b(sociedad\s+de\s+padres|padres\s+de\s+familia)\b/.test(n))return true;
  if(/\b(estanquillo|tiendita|tienda|cafeteria|coperativa|cooperativa)\s+escolar\b/.test(n))return true;
  if(COOP_RE.test(n)&&(SCHOOL_CONTEXT_RE.test(n)||SCHOOL_ABBREV_RE.test(n)))return true; if(COOP_RE.test(n)&&UNIVERSITY_RE.test(n))return true;
  return isSchoolCaptiveCommerceV2Extension(p);
}
const SERVICE_RETAIL_SCOPE=["conveniencia","autoservicio","fast_food","restaurantes"], SERVICE_FOOD_ONLY_SCOPE=["fast_food","restaurantes"];
const SERVICE_INCOMPATIBLE_RULES=[
  [SERVICE_RETAIL_SCOPE,/\bcarpinteria(s)?\b/],[SERVICE_RETAIL_SCOPE,/\bestetica(s)?\b/],[SERVICE_RETAIL_SCOPE,/\bsalon(es)?\s+de\s+belleza\b/],
  [SERVICE_RETAIL_SCOPE,/\bpeluqueria(s)?\b/],[SERVICE_RETAIL_SCOPE,/\bbarberia(s)?\b/],[SERVICE_RETAIL_SCOPE,(n)=>/\btaller(es)?\b/.test(n)&&/\b(mecanico(s)?|mecanica(s)?|automotriz|motos)\b/.test(n)],
  [SERVICE_RETAIL_SCOPE,/\bvulcanizadora(s)?\b/],[SERVICE_RETAIL_SCOPE,/\blavanderia(s)?\b/],[SERVICE_FOOD_ONLY_SCOPE,/\bferreteria(s)?\b/],[SERVICE_FOOD_ONLY_SCOPE,/\bpapeleria(s)?\b/],
];
const FOOD_COMPATIBLE_RE=/\b(restaurante(s)?|restaurant|cafeteria(s)?|cafe|coffee|taqueria(s)?|taco(s)?|torta(s)?|loncheria(s)?|fonda(s)?|comedor(es)?|cocina(s)?|comida(s)?|alimento(s)?|antojito(s)?|cenaduria(s)?|pizzeria(s)?|pizza(s)?|sushi|marisco(s)?|hamburguesa(s)?|hot\s+dog(s)?|birria|menudo|panaderia(s)?|pasteleria(s)?|neveria(s)?|heladeria(s)?|jugo(s)?|bar|cantina(s)?)\b/;
const RETAIL_COMPATIBLE_RE=/\b(abarrote(s)?|tienda(s)?|tiendita(s)?|minisuper(es)?|mini\s+super|supermercado(s)?|autoservicio(s)?|mercado(s)?|mercadito(s)?|miscelanea(s)?|conveniencia|deposito(s)?|expendio(s)?|super)\b/;
function isServiceIncompatible(p){
  if(p.source!=="DENUE")return false; const n=normalizeCompetitionName(p.name||""); if(!n)return false;
  const matched=SERVICE_INCOMPATIBLE_RULES.some(([cats,test])=>cats.includes(p.category)&&(typeof test==="function"?test(n):test.test(n))); if(!matched)return false;
  const compatible=(p.category==="fast_food"||p.category==="restaurantes")?FOOD_COMPATIBLE_RE:(["conveniencia","autoservicio","mercado"].includes(p.category)?RETAIL_COMPATIBLE_RE:null);
  return !(compatible&&compatible.test(n));
}
function shouldPreserveAsFlowGenerator(p){return isServiceIncompatible(p)||isSchoolCaptiveCommerceV2Extension(p);}
const RETAIL_DISTRIBUTION_RULES=[["mayoreo",/\b(mayoreo|mayorista)\b/],["distribuidora",/\bdistribuidor(a|es|as)?\b/]];
const CONVENIENCIA_EXCLUSION_RULES=[...RETAIL_DISTRIBUTION_RULES,["puesto_revistas",/\bpuesto(s)?\s+de\s+revista(s)?\b/],["puesto_periodicos",/\bpuesto(s)?\s+de\s+periodico(s)?\b/],["revisteria",/\brevisteria(s)?\b/],["expendio_periodicos",/\bexpendio(s)?\s+de\s+periodico(s)?\b/],["polleria",/\bpolleria(s)?\b/],["carniceria",/\bcarniceria(s)?\b/],["alimentos_snack",/\balimento(s)?\s+snack(s)?\b/]];
const PLAZA_EXCLUSION_RULES=[["administracion_plaza",/\badministracion\s+(de\s+)?plaza\b/]];
function ruleTest(rule,n){const t=rule[1];return typeof t==="function"?t(n):t.test(n);}
function directCompetitionExclusionReason(p){
  if(p.source!=="DENUE"||!DIRECT_COMPETITION_CATEGORIES.has(p.category))return null; const n=normalizedPoiText(p); if(!n)return null;
  const common=COMMON_NON_OUTLET_RULES.find((rx)=>rx.test(n)); if(common)return "common_non_outlet";
  let rules=null;
  if(p.category==="farmacia")rules=FARMACIA_EXCLUSION_RULES;
  else if(p.category==="gasolinera")rules=GASOLINERA_EXCLUSION_RULES;
  else if(p.category==="fast_food"||p.category==="restaurantes")rules=FOOD_NON_RESTAURANT_RULES;
  else if(p.category==="conveniencia")rules=CONVENIENCIA_EXCLUSION_RULES;
  else if(p.category==="autoservicio")rules=RETAIL_DISTRIBUTION_RULES;
  else if(p.category==="plaza_comercial")rules=PLAZA_EXCLUSION_RULES;
  if(!rules)return null;
  for(const rule of rules){
    if(rule[0]==="empresa_de_gas"){
      if(/\b(de|venta de|empresa de)\s+gas\b/.test(n)&&!GASOLINERA_RETAIL_HINTS.some((h)=>h.test(n)))return rule[0];
    } else if(ruleTest(rule,n)) return rule[0];
  }
  return null;
}
const CATEGORY_OVERRIDE_RULES=[
  [["autoservicio"],"conveniencia",/\boxxo\b/],[["autoservicio"],"conveniencia",/\b7\s*eleven\b|\bseven\s+eleven\b/],[["autoservicio"],"conveniencia",/\bcircle\s+k\b/],[["autoservicio"],"conveniencia",/\btienda(s)?\s+extra\b/],[["autoservicio"],"conveniencia",/\byepas\b/],
  [["conveniencia"],"autoservicio",/\bwal\s*mart\b/],[["conveniencia"],"autoservicio",/\baurrera\b/],[["conveniencia"],"autoservicio",/\bsam\s*s\b|\bsams\b/],[["conveniencia"],"autoservicio",/\bsoriana\b/],[["conveniencia"],"autoservicio",/\bcalimax\b/],[["conveniencia"],"autoservicio",/\bcostco\b/],[["conveniencia"],"autoservicio",/\bsmart\s+(and\s+)?final\b/],
  [["autoservicio","conveniencia"],"farmacia",/\bfarmacia(s)?\s+guadalajara\b/],[["autoservicio","conveniencia"],"farmacia",/\bfarmacia(s)?\s+(del\s+)?ahorro\b/],[["autoservicio","conveniencia"],"farmacia",/\bfarmacia(s)?\s+similares\b|\bsimilares\b/],[["autoservicio","conveniencia"],"farmacia",/\bbenavides\b/],[["autoservicio","conveniencia"],"farmacia",/\bfarmacia\s+roma\b/],
];
function directCompetitionCategoryOverride(p){
  if(p.source!=="DENUE")return null; const n=normalizedPoiText(p); if(!n)return null;
  for(const [from,to,rx] of CATEGORY_OVERRIDE_RULES) if(from.includes(p.category)&&rx.test(n))return to; return null;
}
function isInstitutionalNonCommercial(p){return p.source==="DENUE"&&DIRECT_COMPETITION_CATEGORIES.has(p.category)&&INSTITUTIONAL_EXACT_NAMES.has(normalizeCompetitionName(p.name||""));}
function cleanCanonicalCompetitionPois(pois){
  const out=[]; for(const p of pois){
    if(isInstitutionalNonCommercial(p)||isSchoolCaptiveCommerce(p)||isServiceIncompatible(p)||directCompetitionExclusionReason(p)!==null)continue;
    const c=directCompetitionCategoryOverride(p); out.push(c&&c!==p.category?{...p,category:c}:p);
  } return out;
}
function deriveCompetitionPois(pois){return pois;}
const DIRECT_COMPETITION_BRAND_BLOCKLIST={autoservicios:[/\bwaldo\s*s?\b/],farmacia:[/\bnaturista(s)?\b/,/\bhomeopatic[oa](s)?\b/,/\bsuplemento(s)?\b/]};
const FARMACIA_DIRECT_EVIDENCE_RE=/\b(farmacia(s)?|famacia|frmacia|farmancia|farmaia|farmaica|farmarcia|botica(s)?|similares|simi|benavides|yza|pharmacy|farma(?!ceut)[a-z0-9]*)\b/;
const FARMACIA_WELLNESS_BRAND_RE=/\b(herbalife|omnilife|kromasol|gnc)\b/;
const FARMACIA_NON_COMPETITOR_SIGNALS=[/\bconsultorio(s)?\b/,/\bhospital(es|ari[oa]s?)?\b/,/\bclinica(s)?\b/,/\b(dental|dentista(s)?)\b/,/\bortoped(ia|ic[oa]s?)\b/,/\bveterinari[oa]s?\b/,/\boptica(s)?\b/,/\bpodolog(ia|[oa]s?)\b/,/\b(nutricion(al(es)?)?|nutriolog[oa]s?)\b/,/\bproductos?\s+naturales?\b/,/\bmaterial(es)?\s+de\s+curacion\b/,/\bhomeopatia\b/,/\b(vitamina(s)?|vitaminic[oa]s?)\b/,/\bsupplements?\b/];
function isFarmaciaDirectNonCompetitor(n){if(FARMACIA_WELLNESS_BRAND_RE.test(n))return true;if(FARMACIA_DIRECT_EVIDENCE_RE.test(n))return false;return FARMACIA_NON_COMPETITOR_SIGNALS.some(rx=>rx.test(n));}
function isDirectCompetitionPoi(p,opportunity){
  if(!opportunity)return true;const blocked=DIRECT_COMPETITION_BRAND_BLOCKLIST[opportunity];if(!blocked)return true;const t=normalizeCompetitionName([p.name,p.brand].filter(Boolean).join(" "));if(!t)return true;
  if(opportunity==="farmacia"&&isFarmaciaDirectNonCompetitor(t))return false;return !blocked.some(rx=>rx.test(t));
}

// ---------------------------------------------------------------------------
// Brand matcher — frozen runtime parity
// ---------------------------------------------------------------------------
function normalizeBrandText(s){
  return (s??"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/waldo['\u2019]?s\b/g," waldosbrand ").replace(/church['\u2019]?s\b/g," churchsbrand ")
    .replace(/[^a-z0-9]+/g," ").trim().split(" ").map(w=>(w==="arcos"?w:(w.length>3&&w.endsWith("s")?w.slice(0,-1):w))).join(" ")
    .replace(/\bmc\s+donald(?:\s+s)?\b/g,"mcdonald").replace(/\bmcdonald\s+s\b/g,"mcdonald").replace(/\bh e b\b/g,"heb").replace(/\bgo mart\b/g,"gomart").replace(/\bwal mart\b/g,"walmart").replace(/\bsuperama\b/g,"walmart")
    .replace(/\btienda 3b\b/g,"tienda3b").replace(/\btre b\b/g,"tienda3b").replace(/\bmi super bara\b/g,"tienda bara").replace(/\bwaldosbrand\b/g,"waldos").replace(/\bchurchsbrand\b/g,"churchs").replace(/\s+/g," ").trim();
}
function rule(canonical,anchors,exclusions=[],candidateAliases=[]){return{canonical:normalizeBrandText(canonical),anchors:anchors.map(normalizeBrandText).filter(Boolean),candidateAliases:candidateAliases.map(s=>s.map(normalizeBrandText).filter(Boolean)).filter(s=>s.length),exclusions:exclusions.map(normalizeBrandText).filter(Boolean)}}
const BRAND_CATALOG=[
rule("Farmacias Guadalajara",["farmacia","guadalajara"],["similares","ahorro","benavides","roma","san pablo","del ahorro"]),rule("Farmacias del Ahorro",["farmacia","ahorro"],["guadalajara","similares","benavides"]),rule("Farmacias Similares",["farmacia","similares"],["guadalajara","ahorro","benavides"]),rule("Farmacias Benavides",["benavides"],["similares","ahorro"]),rule("Farmacia Roma",["farmacia","roma"],["similares","ahorro","benavides","guadalajara"]),
rule("Pemex",["pemex"]),rule("Chevron",["chevron"]),rule("ARCO",["arco"],["marco","arcos"]),rule("Rendichicas",["rendichicas"]),rule("BP",["bp"]),rule("Shell",["shell"]),rule("Mobil",["mobil"],["mobilidad","movil"]),
rule("McDonald's",["mcdonald"]),rule("Burger King",["burger","king"]),rule("KFC",["kfc"]),rule("Carl's Jr.",["carl"]),rule("Carl's Jr",["carl"]),rule("Little Caesars",["caesars"]),rule("Domino's Pizza",["dominos"]),rule("Domino's",["dominos"]),rule("Subway",["subway"]),rule("Shake Shack",["shake","shack"]),rule("Taco Inn",["taco","inn"]),rule("Wingstop",["wingstop"],[],[["wing","stop"]]),rule("Pollo Feliz",["pollo","feliz"]),rule("Panda Express",["panda","express"],["kun fu","kung fu"]),rule("Church's Texas Chicken",["churchs"],[],[["church","chicken"],["church","chiken"]]),
rule("Walmart",["walmart"],[],[["supercenter"]]),rule("Bodega Aurrera",["aurrera"]),rule("Sam's Club",["sams"]),rule("Soriana",["soriana"]),rule("Ley",["ley"],["leyva"]),rule("Calimax",["calimax"]),rule("Smart & Final",["smart","final"]),rule("Costco",["costco"]),rule("H-E-B",["heb"]),rule("Fresko",["fresko"]),rule("City Market",["city market"]),rule("Sumesa",["sumesa"]),rule("Chedraui",["chedraui"]),rule("La Comer",["la comer"]),rule("La Cabaña",["cabana","monraz"]),
rule("OXXO",["oxxo"]),rule("7-Eleven",["eleven"]),rule("Circle K",["circle"]),rule("Extra",["extra"]),rule("Go Mart",["gomart"]),rule("Tiendas 3B",["tienda3b"]),rule("Tiendas Neto",["tienda neto"]),rule("Tiendas Bara",["tienda bara"],["bara bara"]),rule("Waldo's",["waldos"]),
rule("Pizza Hut",["pizza","hut"]),rule("Papa John's",["papa","john"]),rule("Benedetti's",["benedetti"]),rule("California Pizza Kitchen",["california","pizza"]),rule("Sushi Itto",["itto"]),rule("Sushi Roll",["sushi","roll"]),rule("Sushi Factory",["sushi","factory"]),rule("Tokai",["tokai"]),rule("Moshi Moshi",["moshi"]),rule("Wings Army",["wings","army"]),rule("Buffalo Wild Wings",["buffalo","wild"],[],[["bufalo","wild"]]),rule("Wings",["wings"],["army","buffalo","wild","stop"]),rule("Vips",["vips"]),rule("Toks",["toks"]),rule("Sanborns",["sanborns"]),rule("IHOP",["ihop"]),rule("Starbucks",["starbucks"]),rule("Chili's",["chilis"]),rule("Applebee's",["applebee"]),rule("Italianni's",["italianni"]),rule("P.F. Chang's",["chang"]),rule("Olive Garden",["olive","garden"]),rule("The Cheesecake Factory",["cheesecake"]),rule("La Casa de Toño",["tono"]),rule("La Mansión",["mansion"]),rule("El Fogoncito",["fogoncito"]),rule("La Casa de los Abuelos",["abuelos"]),rule("Sonora Grill",["sonora","grill"]),rule("Fisher's",["fishers"]),rule("Cabanna",["cabanna"]),
rule("Tim Hortons",["tim","horton"]),rule("Caffenio",["caffenio"]),rule("Café Punta del Cielo",["punta","cielo"]),rule("The Italian Coffee Company",["italian","coffee"]),rule("La Flor de Córdoba",["flor","cordoba"]),rule("Tierra Garat",["garat"]),
];
const GENERIC_TARGETS=new Set(["no especificada","otra marca","marca propia",""]);
function contains(h,n){return ` ${h} `.includes(` ${n} `)}
function matchesSignature(h,s){return s.every(a=>contains(h,a))}
function findBrandRule(targetBrand){const t=normalizeBrandText(targetBrand);if(!t||GENERIC_TARGETS.has(t))return null;const exact=BRAND_CATALOG.find(r=>r.canonical===t);if(exact)return exact;const words=new Set(t.split(" "));return BRAND_CATALOG.find(r=>r.anchors.every(a=>a.split(" ").every(w=>words.has(w)))&&!r.exclusions.some(x=>x.split(" ").every(w=>words.has(w))))??null;}
function normalizeLocalBrandText(s){return(s??"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim()}
const LOCAL_NON_IDENTITY_TOKENS=new Set([
"la","el","los","las","de","del","y","e","suc","sucursal","matriz","unidad","farmacia","farmacias","restaurante","restaurantes","restaurant","cafeteria","cafeterias","cafe","coffee","tienda","tiendas","tiendita","tienditas","abarrotes","abarrote","miscelanea","miscelaneas","minisuper","super","supermercado","autoservicio","market","mercado","mercadito","gasolinera","servicio","servicios","estacion","plaza","comercial","loncheria","loncherias","lonches","fonda","fondas","cocina","cocinas","comedor","comedores","comida","comidas","desayunos","cenaduria","cenadurias","jugos","licuados","aguas","antojitos","botanas","taqueria","taquerias","tacos","tortas","torteria","pizzeria","pizzerias","marisqueria","mariscos","birrieria","pollo","pollos","polleria","rosticeria","panaderia","panaderias","pasteleria","pastelerias","neveria","heladeria","paleteria","dulceria","carniceria","cremeria","verduleria","fruteria","bar","cantina","restaurantero","hamburguesa","hamburguesas","hotdog","hotdogs","dog","dogs","barbacoa","birria","menudo","pozole","carnitas","chicharron","quesadillas","gorditas","sopes","elotes","esquites","churros","tamales","atole","chocomil","chocomiles","licuado","malteadas","alitas","micheladas","cerveza","cervezas","botanero","ensaladas","sushi","pizza","pizzas","sandwich","sandwiches","baguettes","hamburgueseria","asada","pastor","carne","carnes","pescado","pescados","camarones","frutas","verduras","abarrotera","helados","nieves","paletas","pan","postres","reposteria","vinos","licores","agua","purificada","hielo","club","nutricion","deposito","expendio","papeleria","purificadora","refaccionaria","boutique","bodega"]);
const COMMON_OR_AMBIGUOUS_LOCAL_TOKENS=new Set(["centro","norte","sur","oriente","poniente","centrales","nuevo","nueva","viejo","vieja","grande","chico","chica","principal","central","local","sucursales","express","expres","familiar","familia","popular","economico","economica","barato","barata","mexico","mexicano","mexicana","nacional","mundial","internacional","guadalajara","monterrey","puebla","tijuana","cancun","queretaro","hermosillo","culiacan","mexicali","merida","toluca","leon","colonia","avenida","calle","carretera","boulevard","esquina","punto","casa","hogar","buena","bueno","mejor","mejores","servicios","grupo","empresa","negocio","sucursal","sin","nombre","con","para","por","sobre","todo","todos","productos","articulos","varios","varias","general","generales","gran","mini","micro","plus","premium","vip","star","san","santa","santo"]);
function localTokens(v){const n=normalizeLocalBrandText(v);return n?n.split(" ").filter(Boolean):[]}
function localDistinctiveTokens(v){const seen=new Set(),out=[];for(const t of localTokens(v)){if(LOCAL_NON_IDENTITY_TOKENS.has(t)||/^\d+$/.test(t)||seen.has(t))continue;seen.add(t);out.push(t)}return out}
function isStrongLocalToken(t){return !COMMON_OR_AMBIGUOUS_LOCAL_TOKENS.has(t)&&t.length>=5}
function matchesAnyCatalogRule(h){return !!h&&BRAND_CATALOG.some(r=>[r.anchors,...r.candidateAliases].some(s=>matchesSignature(h,s))&&!r.exclusions.some(x=>contains(h,x)))}
const ARTICLE_OR_BRANCH_TOKENS=new Set(["la","el","los","las","de","del","y","e","suc","sucursal","matriz","unidad"]);
const COMMERCIAL_DESCRIPTOR_TOKENS=new Set([...LOCAL_NON_IDENTITY_TOKENS].filter(t=>!ARTICLE_OR_BRANCH_TOKENS.has(t)));
const ORTHOGRAPHIC_SUBSTITUTIONS=new Set(["sz","cs","bv","iy","gj"]),VOWELS=new Set(["a","e","i","o","u"]);
function substitutionAllowed(a,b){return ORTHOGRAPHIC_SUBSTITUTIONS.has([a,b].sort().join(""))}
function insertionAllowed(s,l){if(l.length!==s.length+1)return false;let i=0;while(i<s.length&&s[i]===l[i])i++;if(s.slice(i)!==l.slice(i+1))return false;const ins=l[i];if(ins==="h")return true;if(VOWELS.has(ins))return false;return ins===(i>0?l[i-1]:null)||ins===(l[i+1]??null)}
function isControlledOrthographicVariant(a,b){if(!a||!b||a===b||a.length<6||b.length<6||a[0]!==b[0])return false;if(a.length===b.length){let d=-1;for(let i=0;i<a.length;i++){if(a[i]===b[i])continue;if(d!==-1)return false;d=i}return d>0&&substitutionAllowed(a[d],b[d])}if(Math.abs(a.length-b.length)!==1)return false;return a.length<b.length?insertionAllowed(a,b):insertionAllowed(b,a)}
function isOrthographicEligibleToken(t){return t.length>=6&&isStrongLocalToken(t)&&!LOCAL_NON_IDENTITY_TOKENS.has(t)&&!matchesAnyCatalogRule(normalizeBrandText(t))}
function localBrandTokensMatch(target,candidate){
 const tt=localDistinctiveTokens(target);if(!tt.length)return false;const strong=tt.filter(isStrongLocalToken);if(!strong.length)return false;const cl=localTokens(candidate),cs=new Set(cl);if(!cs.size)return false;let bridges=0;
 for(const t of tt){if(cs.has(t))continue;if(bridges>=1||!isOrthographicEligibleToken(t))return false;const bridged=cl.some(c=>isOrthographicEligibleToken(c)&&isControlledOrthographicVariant(t,c));if(!bridged)return false;bridges++}
 if(strong.length===1){const desc=localTokens(target).filter(t=>COMMERCIAL_DESCRIPTOR_TOKENS.has(t));if(desc.length&&!desc.some(d=>cs.has(d)))return false}return true;
}
function matchBrand(targetBrand,poi){
 const target=normalizeBrandText(targetBrand);if(!target||GENERIC_TARGETS.has(target))return false;const hs=[normalizeBrandText(poi.brand),normalizeBrandText(poi.name)].filter(Boolean);if(!hs.length)return false;
 const r=findBrandRule(targetBrand);if(r)return hs.some(h=>[r.anchors,...r.candidateAliases].some(s=>matchesSignature(h,s))&&!r.exclusions.some(x=>contains(h,x)));
 if(hs.some(h=>contains(h,target)))return true;const bn=normalizeBrandText(poi.brand),chs=bn?[bn]:hs;if(chs.some(matchesAnyCatalogRule))return false;
 return [poi.brand,poi.name].filter(v=>typeof v==="string"&&v.trim()).some(h=>localBrandTokensMatch(targetBrand,h));
}

const DISCOUNT_BRANDS=["Tiendas 3B","Tiendas Neto","Tiendas Bara","Waldo's"];
const COFFEE_BRANDS=["Starbucks","Tim Hortons","Caffenio","Café Punta del Cielo","The Italian Coffee Company","La Flor de Córdoba","Tierra Garat"];
const COFFEE_KEYWORD_RE=/\b(cafeteria|cafeterias|cafe|coffee)\b/;
function isCoffeePoi(p){return COFFEE_BRANDS.some(b=>matchBrand(b,p))||COFFEE_KEYWORD_RE.test(normalizedPoiText(p))}
function getValidCompetitionPois(pois,opportunity,targetBrand){
 if(!opportunity)return[];const direct=DIRECT_COMPETITION_BY_OPPORTUNITY[opportunity];if(!direct)return[];
 if(opportunity==="tiendas_descuento"){const manual=(targetBrand??"").trim();return pois.filter(p=>direct.categories.includes(p.category)&&(DISCOUNT_BRANDS.some(b=>matchBrand(b,p))||(manual&&matchBrand(manual,p))))}
 if(opportunity==="cafeterias")return pois.filter(p=>direct.categories.includes(p.category)&&isCoffeePoi(p));
 return pois.filter(p=>direct.categories.includes(p.category)&&isDirectCompetitionPoi(p,opportunity));
}
const SEMANTIC_FAMILY_BY_OPPORTUNITY={restaurantes:["restaurantes","fast_food"],fast_food:["restaurantes","fast_food"],cafeterias:["restaurantes","fast_food"],autoservicios:["autoservicio","conveniencia"],tiendas_conveniencia:["autoservicio","conveniencia"]};
function getSemanticFamilyCategories(op){return op?(SEMANTIC_FAMILY_BY_OPPORTUNITY[op]??null):null}
function getSemanticSearchPois(pois,op){const c=getSemanticFamilyCategories(op);return c?pois.filter(p=>c.includes(p.category)):null}
function getBrandSearchPois(pois,op,target){const s=getSemanticSearchPois(pois,op);return s??getValidCompetitionPois(pois,op,target)}
function getCanibalizationIdentityPois(pois,op,target){const base=getBrandSearchPois(pois,op,target),family=getSemanticFamilyCategories(op);if(!family)return base;const seen=new Set(base.map(p=>p.id));const extra=pois.filter(p=>p.category==="generador_flujo"&&p.identity_category!=null&&family.includes(p.identity_category)&&!seen.has(p.id));return extra.length?base.concat(extra):base}

// ---------------------------------------------------------------------------
// National identity-path gate
// ---------------------------------------------------------------------------
function projectRuntime(p){return stripIdentity(p)}
function identityLabel(p){if(p.brand&&p.brand.trim())return p.brand.trim();if(p.name&&p.name.trim())return p.name.trim();return null}
function highConfidenceBrand(p){return p.brand&&p.brand.trim()?normalizeLocalBrandText(p.brand):null}
async function buildNationalCorpus(manifest){
 const baseline=[],candidate=[],report=[];
 for(const r of REGIONS){
  const cells=resolveCellsForPoint(r.lat,r.lng,1000);
  const [base,brand,curated]=await Promise.all([
   fetchCells(manifest.base_url??manifest.cells_url,cells,manifest.base_version),
   fetchCells(manifest.brand_overrides_url,cells,manifest.brand_version),
   fetchCells(manifest.curated_url,cells,manifest.curated_version),
  ]);
  const merged=radarMergeLayers(base.pois,brand.pois,curated.pois);
  const dedup=dedupeDenuePois(merged);
  const b=cleanCanonicalCompetitionPois(applyAuthority(dedup,false));
  const c=cleanCanonicalCompetitionPois(applyAuthority(dedup,true));
  check(sameJson(b.map(projectRuntime),c.map(projectRuntime)),`${r.region}: canonical baseline/candidate differs beyond identity_category`);
  baseline.push(...b.map(p=>({...p,_region:r.region}))); candidate.push(...c.map(p=>({...p,_region:r.region})));
  report.push({region:r.region,base:base.pois.length,brand:brand.pois.length,curated:curated.pois.length,merged:merged.length,dedup:dedup.length,clean:b.length});
 }
 return {baseline,candidate,report};
}
function nationalIdentityMetrics(basePois,candPois){
 const perOpp=[];let hcDen=0,hcFp=0,nameDen=0,nameColl=0;const nameExamples=[],hcExamples=[];
 const baseCommercial=basePois.filter(p=>COMMERCIAL_CATEGORIES.has(p.category)),candCommercial=candPois.filter(p=>COMMERCIAL_CATEGORIES.has(p.category));
 check(sameJson(sortedIds(baseCommercial),sortedIds(candCommercial)),"national commercial IDs changed");
 check(basePois.filter(p=>p.category==="generador_flujo").length===candPois.filter(p=>p.category==="generador_flujo").length,"national flow count changed");
 for(const opp of OPPORTUNITIES){
  const b=getBrandSearchPois(basePois,opp),cb=getBrandSearchPois(candPois,opp);
  check(sameJson(ids(b),ids(cb)),`${opp}: getBrandSearchPois changed baseline->candidate`);
  check(sameJson(ids(getValidCompetitionPois(basePois,opp)),ids(getValidCompetitionPois(candPois,opp))),`${opp}: direct competition IDs changed`);
  const bs=getSemanticSearchPois(basePois,opp),cs=getSemanticSearchPois(candPois,opp);
  check(sameJson(bs?ids(bs):null,cs?ids(cs):null),`${opp}: semantic IDs changed`);
  const can=getCanibalizationIdentityPois(candPois,opp);const bset=new Set(b.map(p=>p.id)),extras=can.filter(p=>!bset.has(p.id));
  perOpp.push({opportunity:opp,base:b.length,candidate:can.length,extras:extras.length});
  const targets=b.slice(0,250);
  for(const a of targets){
   const ab=highConfidenceBrand(a),al=identityLabel(a),an=al?normalizeLocalBrandText(al):null;
   for(const e of extras){
    const eb=highConfidenceBrand(e);
    if(ab&&eb&&ab!==eb){hcDen++;if(matchBrand(a.brand,e)){hcFp++;if(hcExamples.length<20)hcExamples.push(`[${opp}] ${a.brand} => ${e.brand} | ${e.name}`)}}
    const el=identityLabel(e),en=el?normalizeLocalBrandText(el):null;
    if(an&&en&&an!==en){nameDen++;if(matchBrand(al,e)){nameColl++;if(nameExamples.length<30)nameExamples.push(`[${opp}] \"${al}\" => \"${el}\" id=${e.id}`)}}
   }
  }
 }
 return {perOpp,hcDen,hcFp,nameDen,nameColl,nameExamples,hcExamples,totalBase:basePois.length,totalCandidate:candPois.length,commercial:baseCommercial.length,flow:basePois.filter(p=>p.category==="generador_flujo").length};
}

// ---------------------------------------------------------------------------
// Live Mexicali runtime-like loader
// ---------------------------------------------------------------------------
function nearestPointOnVialGeometry(geometry,lat,lng){
 if(!geometry.length)return null;if(geometry.length===1)return{lat:geometry[0][0],lng:geometry[0][1],distanceM:haversineDistance(lat,lng,geometry[0][0],geometry[0][1])};
 const lat0=lat*Math.PI/180,cosLat=Math.max(1e-9,Math.cos(lat0));const xy=p=>({x:((p[1]-lng)*Math.PI/180)*EARTH_R*cosLat,y:((p[0]-lat)*Math.PI/180)*EARTH_R});let bestX=0,bestY=0,bestD2=Infinity;
 for(let i=0;i<geometry.length-1;i++){const a=xy(geometry[i]),b=xy(geometry[i+1]),dx=b.x-a.x,dy=b.y-a.y,den=dx*dx+dy*dy,t=den>0?Math.max(0,Math.min(1,-(a.x*dx+a.y*dy)/den)):0,px=a.x+t*dx,py=a.y+t*dy,d2=px*px+py*py;if(d2<bestD2){bestD2=d2;bestX=px;bestY=py}}
 const bl=lat+(bestY/EARTH_R)*(180/Math.PI),bg=lng+(bestX/(EARTH_R*cosLat))*(180/Math.PI);return{lat:bl,lng:bg,distanceM:haversineDistance(lat,lng,bl,bg)};
}
function collapseVialPoisByCanonical(pois){const non=[],best=new Map();for(const p of pois){if(!VIAL_CATEGORIES.has(p.category)){non.push(p);continue}const k=p.canonical_way_id?`${p.category}::${p.canonical_way_id}`:`${p.category}::legacy-id::${p.id}`,e=best.get(k),d=p.distance_m??Infinity,ed=e?.distance_m??Infinity;if(!e||d<ed)best.set(k,p)}return non.concat([...best.values()])}
async function loadVialV2(manifest,cells,lat,lng,radius){
 if(!manifest.vial_v2_url)return[];const root=rootUrl(manifest.vial_v2_url);const chunks=await mapLimit(cells,20,async cell=>{const j=await getJson(withVersion(`${root}${cell}.json`,manifest.vial_v2_version));if(!j)return[];return(j.pieces??[]).map(piece=>{if(!piece.id||!piece.canonical_way_id||!VIAL_CATEGORIES.has(piece.category))return null;const g=Array.isArray(piece.geometry)?piece.geometry.filter(p=>Array.isArray(p)&&p.length>=2&&Number.isFinite(p[0])&&Number.isFinite(p[1])):[],n=nearestPointOnVialGeometry(g,lat,lng);if(!n||n.distanceM>radius)return null;return{id:piece.id,canonical_way_id:piece.canonical_way_id,geometry:g,name:piece.name?.trim()||"Vía sin nombre",category:piece.category,brand:null,lat:n.lat,lng:n.lng,address:null,source:"OSM",maps_url:null,updated_at:null,distance_m:n.distanceM}}).filter(Boolean)});return collapseVialPoisByCanonical(chunks.flat());
}
async function loadPlazas(manifest,lat,lng,radius){
 if(!manifest.plazas_url)return[];let resolved=manifest.plazas_url;if(!/^https?:\/\//i.test(resolved))resolved=new URL(resolved,MANIFEST_URL).toString();resolved=rootUrl(resolved);const index=await getJson(withVersion(`${resolved}index.json`,manifest.plazas_version));if(!Array.isArray(index))return[];const near=index.filter(e=>typeof e?.lat==="number"&&typeof e?.lng==="number"&&haversineDistance(lat,lng,e.lat,e.lng)<=radius);const full=await mapLimit(near,10,async e=>(await getJson(withVersion(`${resolved}${e.id}.json`,manifest.plazas_version)))??e);return full.filter(p=>p&&typeof p.lat==="number"&&typeof p.lng==="number").map(p=>({id:p.id,name:p.name,category:"plaza_comercial",brand:null,lat:p.lat,lng:p.lng,address:null,source:"OSM",maps_url:null,updated_at:null,distance_m:haversineDistance(lat,lng,p.lat,p.lng)})).filter(p=>p.distance_m<=radius);
}
async function loadEmployees(manifest,cells){const out=new Map();if(!manifest.denue_empleados_cells_url)return out;const root=rootUrl(manifest.denue_empleados_cells_url);const chunks=await mapLimit(cells,20,c=>getJson(withVersion(`${root}${c}.json`,manifest.denue_empleados_version)));for(const j of chunks){if(!j||typeof j!=="object"||Array.isArray(j))continue;for(const[k,v]of Object.entries(j)){const n=typeof v==="number"?v:Number(v);if(Number.isFinite(n))out.set(k,n)}}return out}
function applyEmployees(pois,lookup){if(!lookup.size)return pois;return pois.map(p=>{if(p.source!=="DENUE")return p;const v=lookup.get(p.id)??lookup.get(`DENUE_${p.id}`);return typeof v==="number"?{...p,empleados_estimados:v}:p})}
async function loadMexicaliPrecanonical(manifest){
 const lat=32.658337,lng=-115.4290751,radius=1000,cells=resolveCellsForPoint(lat,lng,radius);
 const [base,brand,curated,transit,vial,aviation,plazas,employees]=await Promise.all([
  fetchCells(manifest.base_url??manifest.cells_url,cells,manifest.base_version),fetchCells(manifest.brand_overrides_url,cells,manifest.brand_version),fetchCells(manifest.curated_url,cells,manifest.curated_version),fetchCells(manifest.transit_url,cells,manifest.transit_version),loadVialV2(manifest,cells,lat,lng,radius),manifest.aviation_url?fetchCells(manifest.aviation_url,cells,manifest.aviation_version):Promise.resolve({pois:[]}),loadPlazas(manifest,lat,lng,radius),loadEmployees(manifest,cells)
 ]);
 let core=radarMergeLayers(base.pois,brand.pois,curated.pois);if(manifest.vial_v2_url){core=core.filter(p=>!VIAL_CATEGORIES.has(p.category)).concat(vial)}
 if(manifest.aviation_url){const av=new Set(["aeropuerto","aerodromo","helipuerto"]);core=core.filter(p=>!av.has(p.category))}
 const coreIds=new Set(core.map(p=>p.id)),additive=[...(transit.pois??[]),...(aviation.pois??[])].filter(p=>!coreIds.has(p.id)),seen=new Set(),dedAdd=additive.filter(p=>seen.has(p.id)?false:(seen.add(p.id),true));
 let merged=core.concat(dedAdd).map(p=>({...p,distance_m:haversineDistance(lat,lng,p.lat,p.lng)})).filter(p=>p.distance_m<=radius);
 merged=collapseVialPoisByCanonical(merged);const mids=new Set(merged.map(p=>p.id));merged=merged.concat(plazas.filter(p=>!mids.has(p.id)));merged=applyEmployees(merged,employees);return{pre:merged,lat,lng,radius,cells};
}
function finalizeRadar(pre,candidate){const ded=dedupeDenuePois(pre),auth=applyAuthority(ded,candidate),clean=cleanCanonicalCompetitionPois(auth),cleanIds=new Set(clean.map(p=>p.id));const shadows=auth.filter(p=>p.source==="DENUE"&&typeof p.empleados_estimados==="number"&&!cleanIds.has(p.id)&&shouldPreserveAsFlowGenerator(p)).map(p=>({...p,category:"generador_flujo"}));return clean.concat(shadows).sort((a,b)=>(a.distance_m??Infinity)-(b.distance_m??Infinity))}
function resolveManifestLayerUrl(url){if(!url)return null;if(/^https?:\/\//i.test(url))return url;return new URL(url,MANIFEST_URL).toString()}
async function loadIdentityMap(manifest){const url=resolveManifestLayerUrl(manifest.identity_entity_map_url);if(!url)return null;const d=await getJson(url);if(!d||typeof d!=="object"||!d.members)return null;const m=new Map(Object.entries(d.members));if(!m.has("DENUE_11680071"))m.set("DENUE_11680071","LANTIVO_ENTITY_E4261977FB457CF8");if(!m.has("DENUE_1958408"))m.set("DENUE_1958408","LANTIVO_ENTITY_E4261977FB457CF8");return m}
function collapsedDirectCount(rows,lookup){if(!lookup)return null;const keys=new Set();for(const p of rows){const eid=p.source==="DENUE"?(lookup.get(p.id)??null):null;keys.add(eid?`entity:${eid}`:`raw:${p.id}`)}return keys.size}
async function mexicaliMetrics(manifest){
 const {pre}=await loadMexicaliPrecanonical(manifest),b=finalizeRadar(pre,false),c=finalizeRadar(pre,true);check(sameJson(b.map(projectRuntime),c.map(projectRuntime)),"Mexicali final radar changed beyond identity_category");
 const op="autoservicios",target="super chivas",bd=getValidCompetitionPois(b,op,target),cd=getValidCompetitionPois(c,op,target),bs=getSemanticSearchPois(b,op)??[],cs=getSemanticSearchPois(c,op)??[],bb=getBrandSearchPois(b,op,target),cand=getCanibalizationIdentityPois(c,op,target),be=bb.filter(p=>matchBrand(target,p)),ce=cand.filter(p=>matchBrand(target,p));
 const lookup=await loadIdentityMap(manifest);const out={radarTotal:b.length,commercial:b.filter(p=>COMMERCIAL_CATEGORIES.has(p.category)).length,flow:b.filter(p=>p.category==="generador_flujo").length,semantic:bs.length,directRaw:bd.length,directCollapsed:collapsedDirectCount(bd,lookup),baseEffective:be.map(p=>({id:p.id,name:p.name,distance_m:p.distance_m})),candidateEffective:ce.map(p=>({id:p.id,name:p.name,distance_m:p.distance_m,identity_category:p.identity_category}))};
 check(b.length===c.length,"Mexicali radar total changed");check(out.commercial===c.filter(p=>COMMERCIAL_CATEGORIES.has(p.category)).length,"Mexicali commercial count changed");check(out.flow===c.filter(p=>p.category==="generador_flujo").length,"Mexicali flow count changed");check(sameJson(ids(bd),ids(cd)),"Mexicali raw direct IDs changed");check(sameJson(ids(bs),ids(cs)),"Mexicali semantic IDs changed");check(be.length===0,`Mexicali baseline effective expected 0 got ${be.length}`);check(ce.length===1,`Mexicali candidate effective expected 1 got ${ce.length}`);check(ce[0]?.id==="DENUE_6284925",`Mexicali effective expected DENUE_6284925 got ${ce[0]?.id}`);if(ce[0])check(Math.abs((ce[0].distance_m??Infinity)-22)<8,`Mexicali Super Chivas distance expected ~22m got ${ce[0].distance_m}`);
 return out;
}

async function main(){
 console.log("=== LANTIVO SUPER CHIVAS IDENTITY-ONLY INDEPENDENT GATE ===");console.log(`Frozen production HEAD: ${FROZEN_HEAD}`);console.log("Remote contract: HTTP GET only; no R2/GitHub production/Lovable/Supabase writes.");
 const manifest=await getJson(`${MANIFEST_URL}?gate=${Date.now()}`,{required:true});console.log(`Manifest base=${manifest.base_version} brand=${manifest.brand_version} curated=${manifest.curated_version}`);
 const corp=await buildNationalCorpus(manifest);console.log("\n=== SIX-REGION CORPUS ===");for(const r of corp.report)console.log(JSON.stringify(r));
 const nat=nationalIdentityMetrics(corp.baseline,corp.candidate);console.log("\n=== NATIONAL IDENTITY-PATH DELTA ===");for(const r of nat.perOpp)console.log(`${r.opportunity}: base=${r.base} candidate=${r.candidate} extras=${r.extras}`);console.log(`National canonical total=${nat.totalBase}; commercial=${nat.commercial}; flow=${nat.flow}`);console.log(`HC brand!=brand: FP=${nat.hcFp}/${nat.hcDen} = ${pct(nat.hcFp,nat.hcDen)}`);console.log(`NAME-PROXY diagnostic: collisions=${nat.nameColl}/${nat.nameDen} = ${pct(nat.nameColl,nat.nameDen)}`);if(nat.hcExamples.length)console.log("HC examples:\n  "+nat.hcExamples.join("\n  "));if(nat.nameExamples.length)console.log("Name-proxy examples (diagnostic, not proven FP):\n  "+nat.nameExamples.join("\n  "));
 if(nat.hcFp!==0)fail(`Hard gate HC-FP must be 0, got ${nat.hcFp}`);
 const mx=await mexicaliMetrics(manifest);console.log("\n=== MEXICALI LIVE BASELINE vs CANDIDATE ===");console.log(JSON.stringify(mx,null,2));
 console.log("\n=== RESULT ===");if(failures){console.log(`TEMP CANDIDATE NO-GO — failures=${failures} — REAL PRODUCTION REPO UNTOUCHED`);process.exitCode=1}else{console.log("TEMP CANDIDATE PASS — READY FOR CLAUDE SHA AUDIT — REAL PRODUCTION REPO UNTOUCHED")}
}
main().catch(e=>{console.error(e?.stack||e);console.log("TEMP CANDIDATE NO-GO — RUNNER ERROR — REAL PRODUCTION REPO UNTOUCHED");process.exitCode=2});
