#!/usr/bin/env node
/* ------------------------------------------------------------------ */
/*  Perigee data scraper                                               */
/*                                                                     */
/*  Run daily by .github/workflows/refresh-data.yml. Writes            */
/*  data/perigee-data.json, which the app fetches at startup.          */
/*                                                                     */
/*  Sources:                                                           */
/*    1. planet4589.org  — Starlink + Starshield census (Jonathan      */
/*       McDowell). Must be scraped server-side: the site sends no     */
/*       CORS headers, so a browser cannot read it directly.           */
/*    2. Launch Library 2 — launch history for the yearly cadence      */
/*       chart, plus Falcon booster flight counts.                     */
/*                                                                     */
/*  Every source is wrapped in its own try/catch. If one breaks, the   */
/*  others still publish and the missing key is simply omitted, so     */
/*  the app falls back to its baked-in snapshot for that section.      */
/*  No dependencies — plain Node 18+ fetch and regex.                  */
/* ------------------------------------------------------------------ */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = join(ROOT, "public", "data", "perigee-data.json");

const UA = "perigee-tracker/1.0 (personal project; contact via github)";
const LL2 = "https://ll.thespacedevs.com/2.3.0/launches";
const SPACEX_LSP_ID = 121;

/* ---------------------------------------------------------------- */
/*  helpers                                                          */
/* ---------------------------------------------------------------- */

async function getText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Strip HTML tags/entities from a table cell.
const clean = (s) =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Parse an HTML table into rows of cell strings.
 * planet4589's tables are plain <tr>/<td>, no nesting, so this is safe.
 */
export function parseRows(html) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html))) {
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let c;
    while ((c = tdRe.exec(m[1]))) cells.push(clean(c[1]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

// Find a row whose first cell matches, return it as numbers.
function findRow(rows, matcher) {
  return rows.find((r) => matcher(r[0] || ""));
}

const num = (v) => {
  const n = parseInt(String(v).replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
};

/* ---------------------------------------------------------------- */
/*  1. Starlink census (planet4589)                                  */
/* ---------------------------------------------------------------- */
/*
 * Column layout of the summary table (index -> meaning):
 *   0 Mission        1 Launched     2 Failed to orbit   3 Early deorbit
 *   4 Disposal       5 Reentry-fail 6 Total down        7 Total in orbit
 *   8 Screened       9 Failed/decay 10 Graveyard        11 TOTAL WORKING
 *  12 Disposal u/w  13 Out of con  14 Anomalous        15 Reserve
 *  16 Special       17 Drift       18 Ascent           19 Operational orbit
 *
 * We need "Total working" (col 11) per shell so we can split the fleet
 * into broadband vs direct-to-cell, and by hardware generation.
 */
const COL_LAUNCHED = 1;
const COL_IN_ORBIT = 7;
const COL_WORKING = 11;

async function scrapeStarlink() {
  const full = await getText("https://planet4589.org/space/con/star/stats.html");
  // The page has two tables: the summary, then a row per individual launch.
  // Only parse the first, or per-launch rows could be counted twice.
  const html = full.split(/List of all Starlink satellites/i)[0];
  const rows = parseRows(html);

  const dateMatch = html.match(/Data last updated:\s*(\d{4})\s+(\w{3})\s+(\d{1,2})/);
  const MONTHS = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
                   Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
  const asOf = dateMatch
    ? `${dateMatch[1]}-${MONTHS[dateMatch[2]] || "01"}-${String(dateMatch[3]).padStart(2, "0")}`
    : new Date().toISOString().slice(0, 10);

  return starlinkFromRows(rows, asOf);
}

/** Pure: turn parsed summary-table rows into the census object. */
export function starlinkFromRows(rows, asOf) {
  const total = findRow(rows, (t) => /^Total$/i.test(t));
  if (!total) throw new Error("Starlink: total row not found");

  // Sum "total working" across every row whose label matches a pattern.
  const sumWorking = (re) =>
    rows
      .filter((r) => re.test(r[0] || "") && r.length > COL_WORKING)
      .reduce((acc, r) => acc + num(r[COL_WORKING]), 0);

  // Direct-to-cell lives in its own two shells.
  const dtcWorking = sumWorking(/^Starlink V2 Mini DTC Shell/i);

  // V1.0: the Group 1 early + Visorsat shells.
  const v10 = sumWorking(/^Starlink Group 1 (Early|Visorsat)/i);

  // V1.5: Groups 2-5 (including the TSP oddity and the 43-degree Gen2 shell).
  const v15 =
    sumWorking(/^Starlink Group [2345] .*V1\.5/i) +
    sumWorking(/^Starlink Group 3 Launch/i);

  // V2 Mini: every Gen2 broadband shell, i.e. Gen2 subtotal minus DTC.
  const gen2 = findRow(rows, (t) => /^Starlink Gen2$/i.test(t));
  const v2mini = gen2 ? num(gen2[COL_WORKING]) - dtcWorking : 0;

  const totalWorking = num(total[COL_WORKING]);
  const broadbandWorking = totalWorking - dtcWorking;

  // Sanity: the three generations must reconstruct the broadband fleet.
  const versionSum = v10 + v15 + v2mini;
  if (versionSum !== broadbandWorking) {
    console.warn(
      `[starlink] version split ${versionSum} != broadband ${broadbandWorking}; ` +
        `shell labels may have changed. Emitting totals only.`
    );
  }

  const census = {
    asOf,
    source: "planet4589.org",
    sourceUrl: "https://planet4589.org/space/con/star/stats.html",
    totalLaunchedEver: num(total[COL_LAUNCHED]),
    totalInOrbit: num(total[COL_IN_ORBIT]),
    totalWorking,
    broadbandWorking,
    dtcWorking,
  };

  if (versionSum === broadbandWorking && versionSum > 0) {
    census.broadbandByVersion = [
      { label: "V1.0", value: v10, color: "#A7C8FB" },
      { label: "V1.5", value: v15, color: "#5E9CF8" },
      { label: "V2 Mini", value: v2mini, color: "#2F66D8" },
    ];
  }

  console.log(
    `[starlink] ${asOf}: ${totalWorking} working ` +
      `(${broadbandWorking} broadband + ${dtcWorking} DTC)`
  );
  return census;
}

/* ---------------------------------------------------------------- */
/*  2. Starshield census (planet4589)                                */
/* ---------------------------------------------------------------- */

async function scrapeStarshield() {
  const full = await getText("https://planet4589.org/space/con/stsh/stats.html");
  const html = full.split(/List of all Starshield satellites/i)[0];
  const rows = parseRows(html);

  const dateMatch = html.match(/Data last updated:\s*(\d{4})\s+(\w{3})\s+(\d{1,2})/);
  const MONTHS = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
                   Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
  const asOf = dateMatch
    ? `${dateMatch[1]}-${MONTHS[dateMatch[2]] || "01"}-${String(dateMatch[3]).padStart(2, "0")}`
    : new Date().toISOString().slice(0, 10);

  const total = findRow(rows, (t) => /^Total$/i.test(t));
  if (!total) throw new Error("Starshield: total row not found");

  const out = {
    asOf,
    source: "planet4589.org",
    sourceUrl: "https://planet4589.org/space/con/stsh/stats.html",
    totalLaunchedEver: num(total[COL_LAUNCHED]),
    totalInOrbit: num(total[COL_IN_ORBIT]),
    totalWorking: num(total[COL_WORKING]),
  };
  console.log(`[starshield] ${asOf}: ${out.totalWorking} working`);
  return out;
}

/* ---------------------------------------------------------------- */
/*  3. Launch cadence + boosters (Launch Library 2)                   */
/* ---------------------------------------------------------------- */

const isStarlink = (name = "") => /starlink/i.test(name);
const isStarship = (name = "") => /starship|super heavy/i.test(name);

/**
 * Page backwards through SpaceX launch history using a date cursor.
 * LL2 caps offset paging, so we walk net__lt instead.
 */
async function fetchLaunchHistory(pages = 8) {
  const out = [];
  let cursor = new Date(Date.now() + 86400000).toISOString();

  for (let i = 0; i < pages; i++) {
    const url =
      `${LL2}/?lsp__id=${SPACEX_LSP_ID}&limit=100&ordering=-net` +
      `&net__lt=${encodeURIComponent(cursor)}&mode=list`;
    const page = await getJson(url);
    const results = page.results || [];
    if (!results.length) break;

    out.push(...results);
    const last = results[results.length - 1];
    if (!last?.net) break;
    cursor = last.net;

    await sleep(1200); // be polite to a free API
  }
  return out;
}

async function scrapeCadence() {
  const launches = await fetchLaunchHistory();
  if (!launches.length) throw new Error("cadence: no launches returned");

  const byYear = new Map();
  for (const l of launches) {
    if (!l.net) continue;
    const year = new Date(l.net).getUTCFullYear();
    const name = l.name || "";

    // Starship flies its own program; the cadence chart is Falcon only.
    if (isStarship(name) || isStarship(l.rocket?.configuration?.name || "")) continue;

    if (!byYear.has(year)) byYear.set(year, { year, internal: 0, customer: 0 });
    const row = byYear.get(year);
    if (isStarlink(name)) row.internal += 1;
    else row.customer += 1;
  }

  const rows = [...byYear.values()]
    .filter((r) => r.internal + r.customer > 0)
    .sort((a, b) => a.year - b.year)
    .map((r) => ({ ...r, confidence: "live" }));

  const thisYear = rows[rows.length - 1];
  console.log(
    `[cadence] ${rows.length} years; ${thisYear?.year}: ` +
      `${thisYear?.internal}/${thisYear?.customer}`
  );
  return rows;
}

async function scrapeBoosters() {
  // Reusable Falcon first stages, most-flown first.
  const url =
    "https://ll.thespacedevs.com/2.3.0/launcher/" +
    "?search=Falcon&limit=100&ordering=-flights";
  const data = await getJson(url);
  const cores = (data.results || []).filter((c) => c.serial_number?.startsWith("B10"));
  if (!cores.length) throw new Error("boosters: none returned");

  const flights = cores.map((c) => c.flights || 0).filter((n) => n > 0);
  const active = cores.filter((c) => c.status === "active");
  const leader = cores[0];

  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };

  const out = {
    asOf: new Date().toISOString().slice(0, 10),
    recordSerial: leader.serial_number,
    recordFlights: leader.flights,
    operationalCount: active.length || cores.length,
    medianFlights: median(flights),
  };
  console.log(`[boosters] leader ${out.recordSerial} @ ${out.recordFlights} flights`);
  return out;
}

/* ---------------------------------------------------------------- */
/*  main                                                             */
/* ---------------------------------------------------------------- */

async function main() {
  const payload = { generatedAt: new Date().toISOString() };
  const errors = [];

  const tasks = [
    ["satelliteCensus", scrapeStarlink],
    ["starshieldCensus", scrapeStarshield],
    ["yearlyLaunchData", scrapeCadence],
    ["boosterSnapshot", scrapeBoosters],
  ];

  for (const [key, fn] of tasks) {
    try {
      payload[key] = await fn();
    } catch (err) {
      console.error(`[${key}] FAILED: ${err.message}`);
      errors.push(key);
    }
  }

  // Never publish an empty file — that would blank the app's data. If every
  // source failed, keep whatever is already committed and exit non-zero.
  const gotSomething = Object.keys(payload).length > 1;
  if (!gotSomething) {
    console.error("All sources failed; leaving existing data untouched.");
    process.exit(1);
  }

  // Carry forward any section that failed this run, so the file stays whole.
  try {
    const prev = JSON.parse(await readFile(OUT_FILE, "utf8"));
    for (const key of errors) {
      if (prev[key]) {
        payload[key] = prev[key];
        console.log(`[${key}] carried forward from previous run`);
      }
    }
  } catch {
    /* first run, nothing to carry */
  }

  payload.partial = errors.length > 0 ? errors : undefined;

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(payload, null, 2) + "\n");
  console.log(`\nWrote ${OUT_FILE}`);
  if (errors.length) console.log(`Partial: ${errors.join(", ")} used previous values.`);
}

// Only run when executed directly, so tests can import the helpers.
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
