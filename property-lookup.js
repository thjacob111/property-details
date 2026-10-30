#!/usr/bin/env node
/**
 * property-lookup.js — owner name + zoning for Denver-metro (Colorado) property addresses.
 *
 * Every source is public and keyless:
 *   - Owner, parcel, land use: Colorado OIT statewide parcel composite (annual county submissions).
 *   - Address → point:          Colorado OIT statewide address points; US Census geocoder as fallback.
 *   - Jurisdiction:             DRCOG MUNI_2026 municipal boundaries (no hit = unincorporated county).
 *   - Zoning:                   the parcel layer's zoningCode where the county supplies it (Denver,
 *                               Broomfield); otherwise the jurisdiction's own zoning layer from
 *                               sources/zoning-*.json, queried point-in-polygon.
 *
 * Usage:
 *   node property-lookup.js --address "7473 W Cedar Cir, Lakewood, CO 80226"
 *   node property-lookup.js --in addresses.csv [--out results.csv] [--column address]
 *   node property-lookup.js --selftest
 *
 * Input CSV: one address per row in the column named by --column (default: the first column whose
 * header contains "address", else column 1). Output: CSV + a .json twin carrying every source URL.
 * A field that cannot be found is written as NOT_FOUND with the reason in `notes` — never guessed.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PARCELS = 'https://gis.colorado.gov/public/rest/services/Address_and_Parcel/Colorado_Public_Parcels/FeatureServer/0';
const ADDRESSES = 'https://gis.colorado.gov/public/rest/services/Address_and_Parcel/Colorado_Public_Addresses/FeatureServer/0';
const MUNIS = 'https://services2.arcgis.com/lCUrzfRwZYxmwIse/arcgis/rest/services/MUNI_2026/FeatureServer/0';
const CENSUS = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const METRO_COUNTIES = ['Denver', 'Adams', 'Arapahoe', 'Jefferson', 'Douglas', 'Broomfield', 'Boulder'];
// Counties whose parcel submission carries the zoning code (verified 2026-10-29: Denver 240,249/240,257; Broomfield 27,476/27,476).
const PARCEL_ZONING_COUNTIES = new Set(['Denver', 'Broomfield']);
const NF = 'NOT_FOUND';
const PLACEHOLDER_CODES = new Set(['ADCO', 'SPLT', 'UNK', 'ROW', 'NULL', 'NONE', '<NULL>']);

// ---------- address parsing ----------

const DIRS = { N: 'N', S: 'S', E: 'E', W: 'W', NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', NE: 'NE', NW: 'NW', SE: 'SE', SW: 'SW' };
const SUFFIXES = new Set(['ST', 'STREET', 'AVE', 'AVENUE', 'AV', 'BLVD', 'BOULEVARD', 'DR', 'DRIVE', 'RD', 'ROAD', 'LN', 'LANE',
  'CT', 'COURT', 'CIR', 'CIRCLE', 'WAY', 'PL', 'PLACE', 'PKWY', 'PARKWAY', 'TRL', 'TRAIL', 'TER', 'TERRACE', 'HWY', 'HIGHWAY',
  'LOOP', 'PT', 'POINT', 'SQ', 'SQUARE', 'RUN', 'PASS', 'XING', 'CROSSING', 'ALY', 'ALLEY', 'GRN', 'GREEN', 'PATH', 'ROW', 'WALK']);
const UNIT_WORDS = new Set(['APT', 'UNIT', 'STE', 'SUITE', '#', 'BLDG', 'LOT', 'SPC', 'SPACE', 'TRLR']);

/** Splits "7473 W Cedar Cir Apt 2, Lakewood, CO 80226" into number, street core, unit, city, zip. */
function parseAddress(raw) {
  const text = String(raw || '').toUpperCase().replace(/[.]/g, '').replace(/\s+/g, ' ').trim();
  const parts = text.split(',').map(s => s.trim()).filter(Boolean);
  const zipMatch = text.match(/\b(\d{5})(?:-\d{4})?\s*$/);
  const zip = zipMatch ? zipMatch[1] : null;
  let city = null;
  if (parts.length >= 2) city = parts[1].replace(/\b(CO|COLORADO)\b.*$/, '').replace(/\d{5}(-\d{4})?/, '').trim() || null;

  const tokens = parts[0].replace(/#\s*/, '# ').split(' ');
  const number = /^\d+[A-Z]?$/.test(tokens[0]) ? tokens.shift() : null;
  let unit = null;
  const unitAt = tokens.findIndex(t => UNIT_WORDS.has(t));
  if (unitAt >= 0) { unit = tokens.slice(unitAt + 1).join(' ') || null; tokens.splice(unitAt); }
  if (tokens.length > 1 && DIRS[tokens[0]]) tokens.shift();
  if (tokens.length > 1 && DIRS[tokens[tokens.length - 1]]) tokens.pop();
  if (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return { raw: String(raw).trim(), number, street: tokens.join(' ') || null, unit, city, zip };
}

// Counties disagree on ordinal streets: Denver stores "2ND AVE", Byers stores "SECOND AVE". Search both spellings.
const ORDINALS = ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH', 'EIGHTH', 'NINTH', 'TENTH',
  'ELEVENTH', 'TWELFTH', 'THIRTEENTH', 'FOURTEENTH', 'FIFTEENTH', 'SIXTEENTH', 'SEVENTEENTH', 'EIGHTEENTH', 'NINETEENTH', 'TWENTIETH'];
const ordinalSuffix = n => (n % 100 >= 11 && n % 100 <= 13) ? 'TH' : ({ 1: 'ST', 2: 'ND', 3: 'RD' }[n % 10] || 'TH');
function streetVariants(street) {
  if (!street) return [];
  const out = new Set([street]);
  const word = ORDINALS.indexOf(street);
  if (word >= 0) out.add(`${word + 1}${ordinalSuffix(word + 1)}`);
  const num = street.match(/^(\d+)(ST|ND|RD|TH)?$/);
  if (num) { const n = Number(num[1]); out.add(`${n}${ordinalSuffix(n)}`); if (n <= ORDINALS.length) out.add(ORDINALS[n - 1]); }
  return [...out];
}

const sqlStr = s => String(s).replace(/'/g, "''");
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---------- HTTP ----------

async function getJson(url, params, tries = 3) {
  const qs = new URLSearchParams({ f: 'json', ...params }).toString();
  const full = `${url}?${qs}`;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(full, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(`ArcGIS ${body.error.code}: ${body.error.message}`);
      return body;
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
  }
  throw new Error(`${url} — ${lastErr.message}`);
}

const pointQuery = (layer, lon, lat, outFields = '*', extra = {}) => getJson(`${layer}/query`, {
  geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
  outFields, returnGeometry: 'false', ...extra,
});

// ---------- lookup steps ----------

const PARCEL_FIELDS = 'countyName,parcel_id,account,owner,owner2,ownerAdd,ownAddCty,ownAddStt,ownAddZip,situsAdd,sitAddCty,sitAddZip,zoningCode,zoningDesc,landUseDsc,dateReceived';

/** Picks the candidate whose unit (if any) and city/zip agree with the input best. */
function bestParcel(cands, a) {
  const score = c => {
    let s = 0;
    const situs = norm(c.situsAdd);
    if (a.unit && situs.endsWith(norm(a.unit))) s += 4;
    if (!a.unit && !/(APT|UNIT|STE|#)/i.test(c.situsAdd || '')) s += 1;
    if (a.zip && String(c.sitAddZip || '').startsWith(a.zip)) s += 2;
    if (a.city && norm(c.sitAddCty) === norm(a.city)) s += 2;
    if (c.owner) s += 1;
    return s;
  };
  return cands.map(c => ({ c, s: score(c) })).sort((x, y) => y.s - x.s)[0]?.c || null;
}

async function parcelBySitus(a) {
  if (!a.number || !a.street) return null;
  const streets = streetVariants(a.street);
  const likes = streets.map(s => `UPPER(situsAdd) LIKE '${sqlStr(a.number)} %${sqlStr(s)}%'`).join(' OR ');
  const where = `countyName IN (${METRO_COUNTIES.map(c => `'${c}'`).join(',')}) AND (${likes})`;
  const body = await getJson(`${PARCELS}/query`, { where, outFields: PARCEL_FIELDS, returnGeometry: 'false', returnCentroid: 'true', outSR: '4326' });
  // Guard against "123 MAIN" matching "123 MAINSTREET CT": number and street core must be whole words.
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${a.number}\\b.*\\b(${streets.map(esc).join('|')})\\b`);
  const feats = (body.features || []).filter(f => re.test(String(f.attributes.situsAdd || '').toUpperCase()));
  if (!feats.length) return null;
  const cands = feats.map(f => ({ ...f.attributes, _centroid: f.centroid }));
  const pick = bestParcel(cands, a);
  // Same number + street in two places (e.g. 100 MAIN ST in Longmont and Littleton) and nothing in the input to separate them.
  const places = new Set(cands.map(c => `${c.countyName}|${norm(c.sitAddCty)}`));
  const pinned = (a.zip && String(pick.sitAddZip || '').startsWith(a.zip)) || (a.city && norm(pick.sitAddCty) === norm(a.city));
  // The input names a city or ZIP and the match agrees with neither (e.g. "Denver" input matched a Byers parcel).
  const contradicts = (a.city || a.zip) && !pinned;
  return { parcel: pick, candidates: feats.length, ambiguous: places.size > 1 && !pinned && !contradicts, contradicts };
}

async function pointFromAddressPoints(a) {
  if (!a.number || !a.street) return null;
  const names = streetVariants(a.street).map(s => `'${sqlStr(s)}'`).join(',');
  let where = `AddrNum='${sqlStr(a.number)}' AND StreetName IN (${names}) AND County IN (${METRO_COUNTIES.map(c => `'${c}'`).join(',')})`;
  if (a.zip) where += ` AND Zipcode='${a.zip}'`;
  const body = await getJson(`${ADDRESSES}/query`, { where, outFields: 'AddrFull,Unit,PlaceName,Zipcode,Latitude,Longitude,County', returnGeometry: 'false' });
  let feats = (body.features || []).map(f => f.attributes).filter(x => x.Latitude && x.Longitude);
  // Without a ZIP, the typed city is the only thing separating same-named streets in different towns.
  if (!a.zip && a.city) feats = feats.filter(x => norm(x.PlaceName) === norm(a.city));
  if (!feats.length) return null;
  const pick = feats.find(x => a.unit && norm(x.Unit) === norm(a.unit)) || feats.find(x => !x.Unit) || feats[0];
  return { lon: pick.Longitude, lat: pick.Latitude, method: 'state-address-point', matched: `${pick.AddrFull}, ${pick.PlaceName} ${pick.Zipcode}` };
}

async function pointFromCensus(a) {
  const body = await getJson(CENSUS, { address: a.raw, benchmark: 'Public_AR_Current', format: 'json' });
  const m = body.result?.addressMatches?.[0];
  return m ? { lon: m.coordinates.x, lat: m.coordinates.y, method: 'census-geocoder', matched: m.matchedAddress } : null;
}

async function parcelAtPoint(lon, lat) {
  // Census points sit on the street centreline, so search a small radius and prefer a real owned parcel.
  for (const distance of [0, 25]) {
    const extra = distance ? { distance: String(distance), units: 'esriSRUnit_Meter' } : {};
    const body = await pointQuery(PARCELS, lon, lat, PARCEL_FIELDS, extra);
    const owned = (body.features || []).map(f => f.attributes).filter(p => p.owner && p.parcel_id !== 'ROW');
    if (owned.length) return { parcel: owned[0], ambiguous: owned.length > 1 && distance > 0 };
  }
  return null;
}

/** Every city whose DRCOG boundary contains the point (boundaries can overlap), postal-city match first. */
async function jurisdictionsAt(lon, lat, postalCity) {
  const body = await pointQuery(MUNIS, lon, lat, 'CITY');
  const cities = [...new Set((body.features || []).map(f => f.attributes.CITY).filter(Boolean))];
  return cities.sort((x, y) => (norm(y) === norm(postalCity)) - (norm(x) === norm(postalCity)));
}

function loadZoningRegistry() {
  const dir = path.join(__dirname, 'sources');
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter(n => /^zoning-.*\.json$/.test(n))) {
    for (const e of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) {
      const key = e.kind === 'county-unincorporated' ? `county:${norm(e.county)}` : `city:${norm(e.jurisdiction)}`;
      if (!out.has(key) || (!out.get(key).url && e.url)) out.set(key, e);
    }
  }
  return out;
}

/** True when a zoning layer answered with a pointer to another jurisdiction rather than a zone. */
function isHandoff(code, registry) {
  const c = code.toUpperCase();
  if (/^CONTACT\b/.test(c) || /^X[A-Z]{2}$/.test(c) || c === 'CTY' || /\bCOUNTY$/.test(c)) return true; // Jeffco, Boulder, Douglas, Parker
  return registry.has(`city:${norm(c)}`); // Adams County labels each city polygon with the city name
}

async function queryZoning(src, lon, lat) {
  // Parcel-based layers leave gaps in streets; retry with a small radius before giving up.
  for (const distance of [0, 15]) {
    const extra = distance ? { distance: String(distance), units: 'esriSRUnit_Meter' } : {};
    const body = await pointQuery(src.url, lon, lat, '*', extra);
    if (body.features?.length) return body.features[0].attributes;
  }
  return null;
}

async function zoningAt(registry, cities, county, lon, lat) {
  // Each overlapping city in turn, then the county layer.
  const chain = [...cities.map(c => ({ key: `city:${norm(c)}`, label: c })), { key: `county:${norm(county)}`, label: `Unincorporated ${county} County` }];
  if (cities.length > 1) chain.overlap = cities.join(' / ');
  const notes = [];
  for (const { key, label } of chain) {
    const src = registry.get(key);
    if (!src) { notes.push(`no zoning source registered for ${label}`); continue; }
    if (!src.url) { notes.push(`${label} publishes no queryable zoning layer${src.notes ? ` (${String(src.notes).slice(0, 160)})` : ''}`); break; }
    const attrs = await queryZoning(src, lon, lat);
    if (!attrs) { notes.push(`point falls outside every polygon in the ${label} zoning layer`); continue; }
    const code = String(attrs[src.codeField] ?? '').trim();
    // Parcel-based layers (Commerce City) store bookkeeping values in the zoning field; they are not zoning.
    if (!code || PLACEHOLDER_CODES.has(code.toUpperCase())) { notes.push(`${label} layer holds no zoning here (value "${code || 'blank'}")`); continue; }
    if (isHandoff(code, registry)) {
      // A city layer pointing back at the county (Parker "DOUGLAS COUNTY") falls through to the county layer;
      // a county layer pointing at a city means DRCOG and the county disagree on the boundary.
      notes.push(key.startsWith('city:') ? `${label} layer marks this as county land ("${code}")`
        : `boundary mismatch: DRCOG says unincorporated but the county layer says "${code}" — check the city's zoning`);
      continue;
    }
    if (src.authority === 'third-party') notes.push(`zoning from an UNOFFICIAL third-party copy for ${label} — confirm with the city`);
    if (chain.overlap) notes.push(`DRCOG city boundaries overlap here (${chain.overlap}); zoning taken from the ${label} layer`);
    return { code, desc: (src.descField && attrs[src.descField]) || '', source: src.url, note: notes.join('; '), jurisdiction: label };
  }
  return { code: NF, desc: NF, source: NF, note: notes.join('; ') };
}

// ---------- one address ----------

async function lookup(raw, registry) {
  const a = parseAddress(raw);
  const r = { input_address: a.raw, matched_address: NF, county: NF, jurisdiction: NF, parcel_id: NF, owner: NF, owner2: '',
    owner_mailing: '', land_use: '', zoning_code: NF, zoning_desc: '', match_method: '', lat: '', lon: '',
    parcel_data_date: '', owner_source: PARCELS, zoning_source: NF, notes: [] };
  try {
    let parcel = null, point = null;

    let situs = await parcelBySitus(a);
    if (situs?.contradicts) {
      // The only street-address match is in another city — locate the address independently before trusting it.
      const p = (await pointFromAddressPoints(a)) || (await pointFromCensus(a));
      const hit = p && await parcelAtPoint(p.lon, p.lat);
      if (hit) {
        parcel = hit.parcel; point = p;
        r.match_method = `point-in-parcel (${p.method})`;
        if (hit.ambiguous) r.notes.push('point was on the street; nearest owned parcel within 25 m used — confirm the address');
        situs = null;
      } else {
        r.notes.push(`CITY MISMATCH: the only parcel at this street address is in ${situs.parcel.sitAddCty || situs.parcel.countyName}, not the city/ZIP given — confirm the address`);
      }
    }
    if (situs?.parcel) {
      parcel = situs.parcel;
      r.match_method = 'parcel-situs-address';
      if (situs.ambiguous) r.notes.push(`AMBIGUOUS: this street address exists in more than one city (${situs.candidates} parcels) — add city or ZIP to the input`);
      if (parcel._centroid) point = { lon: parcel._centroid.x, lat: parcel._centroid.y };
    }
    if (!point) point = (await pointFromAddressPoints(a)) || (await pointFromCensus(a));
    if (!parcel && point) {
      const hit = await parcelAtPoint(point.lon, point.lat);
      if (hit) {
        parcel = hit.parcel;
        r.match_method = `point-in-parcel (${point.method})`;
        if (hit.ambiguous) r.notes.push('point was on the street; nearest owned parcel within 25 m used — confirm the address');
      }
    }
    if (!point) { r.notes.push('address could not be located by the state address points or the Census geocoder'); return finish(r); }
    r.lat = point.lat; r.lon = point.lon;

    if (parcel) {
      r.matched_address = [parcel.situsAdd, parcel.sitAddCty, parcel.sitAddZip].filter(Boolean).join(', ');
      r.county = parcel.countyName;
      r.parcel_id = parcel.parcel_id || NF;
      r.owner = parcel.owner || NF;
      r.owner2 = parcel.owner2 || '';
      r.owner_mailing = [parcel.ownerAdd, parcel.ownAddCty, parcel.ownAddStt, parcel.ownAddZip].filter(Boolean).join(', ');
      r.land_use = parcel.landUseDsc || '';
      r.parcel_data_date = parcel.dateReceived || '';
      if (!parcel.owner) r.notes.push('parcel found but the county left the owner blank');
    } else {
      r.notes.push('no parcel at this location in the statewide parcel layer');
    }

    const cities = await jurisdictionsAt(point.lon, point.lat, parcel?.sitAddCty || a.city);
    r.jurisdiction = cities[0] || (r.county !== NF ? `Unincorporated ${r.county} County` : NF);

    // The jurisdiction's own zoning layer wins: the parcel composite abbreviates codes (Denver "U-RH-2.5" arrives as "URH").
    const z = r.county !== NF ? await zoningAt(registry, cities, r.county, point.lon, point.lat) : null;
    if (z && z.code !== NF) {
      r.zoning_code = z.code; r.zoning_desc = z.desc; r.zoning_source = z.source;
      if (z.jurisdiction) r.jurisdiction = z.jurisdiction;
      if (z.note) r.notes.push(z.note);
    } else if (parcel?.zoningCode && PARCEL_ZONING_COUNTIES.has(parcel.countyName)) {
      r.zoning_code = parcel.zoningCode;
      r.zoning_desc = parcel.zoningDesc || '';
      r.zoning_source = PARCELS;
    } else if (z) {
      r.zoning_source = z.source;
      if (z.note) r.notes.push(z.note);
    } else {
      r.notes.push('county unknown, so no zoning source could be chosen');
    }
  } catch (e) {
    r.notes.push(`lookup error: ${e.message}`);
  }
  return finish(r);
}

const finish = r => ({ ...r, notes: r.notes.join('; ') });

// ---------- CSV ----------

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}

const csvCell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// ---------- main ----------

async function runPool(items, worker, size = 4) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await worker(items[i], i); }
  }));
  return out;
}

function arg(name) { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; }

async function main() {
  const registry = loadZoningRegistry();

  if (process.argv.includes('--selftest')) {
    const cases = [
      ['7473 W Cedar Cir, Lakewood, CO 80226', { number: '7473', street: 'CEDAR', city: 'LAKEWOOD', zip: '80226' }],
      ['1451 N. Madison St Apt 2, Denver CO 80206', { number: '1451', street: 'MADISON', unit: '2', zip: '80206' }],
      ['13821 Del Corso Way, Broomfield, CO', { number: '13821', street: 'DEL CORSO' }],
      ['138 W second Ave, Denver, CO', { number: '138', street: 'SECOND', city: 'DENVER' }],
    ];
    for (const [street, want] of [['SECOND', '2ND'], ['2ND', 'SECOND'], ['11TH', 'ELEVENTH'], ['112TH', '112TH']]) {
      if (!streetVariants(street).includes(want)) { fail++; console.log(`FAIL streetVariants(${street}) lacks ${want}`); }
    }
    let fail = 0;
    for (const [input, want] of cases) {
      const got = parseAddress(input);
      for (const [k, v] of Object.entries(want)) if (got[k] !== v) { fail++; console.log(`FAIL parse ${input}: ${k}=${got[k]} want ${v}`); }
    }
    console.log(fail ? `SELFTEST FAILED (${fail})` : `SELFTEST PASS — ${cases.length} parse cases; zoning registry entries: ${registry.size}`);
    process.exit(fail ? 1 : 0);
  }

  const single = arg('address');
  if (single) { console.log(JSON.stringify(await lookup(single, registry), null, 2)); return; }

  const inPath = arg('in');
  if (!inPath) { console.error('usage: --address "<addr>" | --in <file.csv> [--out <file.csv>] [--column <name>] | --selftest'); process.exit(2); }
  const rows = parseCsv(fs.readFileSync(inPath, 'utf8').replace(/^﻿/, ''));
  const header = rows[0].map(h => h.trim());
  const wanted = arg('column');
  let col = wanted ? header.findIndex(h => h.toLowerCase() === wanted.toLowerCase()) : header.findIndex(h => /address/i.test(h));
  let body = rows.slice(1);
  if (col < 0) { if (wanted) { console.error(`column "${wanted}" not found`); process.exit(2); } col = 0; if (!/address/i.test(header[0])) body = rows; }

  const addresses = body.map(r => (r[col] || '').trim()).filter(Boolean);
  console.error(`Looking up ${addresses.length} addresses (zoning registry: ${registry.size} jurisdictions)...`);
  const results = await runPool(addresses, async (addr, i) => {
    const r = await lookup(addr, registry);
    console.error(`  ${i + 1}/${addresses.length} ${addr} → ${r.owner} | ${r.zoning_code}`);
    return r;
  });

  const outPath = arg('out') || inPath.replace(/\.csv$/i, '') + '-property-intel.csv';
  const cols = Object.keys(results[0] || { input_address: '' });
  fs.writeFileSync(outPath, [cols.join(','), ...results.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\r\n') + '\r\n');
  fs.writeFileSync(outPath.replace(/\.csv$/i, '.json'), JSON.stringify({ generated: new Date().toISOString(), sources: { PARCELS, ADDRESSES, MUNIS, CENSUS }, results }, null, 2));
  const owners = results.filter(r => r.owner !== NF).length, zones = results.filter(r => r.zoning_code !== NF).length;
  console.error(`DONE ${results.length} rows → ${outPath}\n  owner found: ${owners}/${results.length}   zoning found: ${zones}/${results.length}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { parseAddress, lookup, loadZoningRegistry };
