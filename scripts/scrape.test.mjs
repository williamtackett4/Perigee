/* Verifies the planet4589 parser against the real summary-table structure
 * and the real values published on 2026 Jul 25. Run: node scripts/scrape.test.mjs
 * No network needed — the fixture is the actual table content. */

import { parseRows, starlinkFromRows } from "./scrape.mjs";

// [label, launched, failedOrbit, earlyDeorbit, disposal, reentryFail,
//  totalDown, inOrbit, screened, failedDecay, graveyard, TOTALWORKING, ...]
// NOTE: the real page emits a one-cell section HEADER row with the same label
// as the subtotal row that follows the shells ("Starlink Gen1", "Starlink
// Gen2"). The first version of this fixture omitted them, so a bug where the
// parser grabbed the header instead of the subtotal slipped through. They are
// included below deliberately — do not remove them.
const ROWS = [
  ["Starlink Prototype Launch 0 (Tintin)", 2, 0, 0, 2, 0, 2, 0, 0, 0, 0, 0],
  ["Starlink Prototype Launch 1 (V0.9)", 60, 0, 0, 50, 10, 60, 0, 0, 0, 0, 0],
  ["Starlink Gen1"],
  ["Starlink Group 1 Early Launches 2-8 (V1.0 L1-7)", 420, 0, 9, 226, 49, 284, 136, 0, 3, 0, 133],
  ["Starlink Group 1 Visorsat Launches 9-17 (V1.0 L8-16)", 533, 0, 13, 346, 34, 393, 140, 0, 2, 0, 138],
  ["Starlink Group 1 Visorsat Launches 19+ (V1.0 L17+)", 712, 0, 20, 295, 11, 326, 386, 0, 0, 0, 386],
  ["Starlink Group 2 V1.5 Launches", 408, 0, 3, 48, 4, 55, 353, 0, 4, 0, 349],
  ["Starlink Group 3 Launch 18/31 (TSP-1/2)", 13, 0, 0, 12, 0, 12, 1, 0, 0, 0, 1],
  ["Starlink Group 3 V1.5 Launches", 230, 0, 0, 22, 0, 22, 208, 0, 0, 0, 208],
  ["Starlink Group 4 V1.5 Launches", 1637, 0, 64, 178, 22, 264, 1373, 0, 3, 0, 1370],
  ["Starlink Group 5 V1.5 Launches 43 deg (Gen2)", 699, 0, 5, 43, 3, 51, 648, 0, 1, 0, 647],
  ["Starlink Gen1", 4714, 0, 114, 1222, 133, 1469, 3245, 0, 13, 0, 3232],
  ["Starlink Gen2"],
  ["Starlink V2 Mini Shell 1, 53 deg (Group 7 to 11)", 989, 0, 18, 34, 3, 55, 934, 0, 1, 0, 933],
  ["Starlink V2 Mini Shell 2, 43 deg (Group 6,12,13)", 1736, 0, 28, 104, 7, 139, 1597, 0, 1, 0, 1596],
  ["Starlink V2 Mini DTC Shell 1, 53 deg", 337, 0, 14, 10, 1, 25, 312, 0, 0, 0, 312],
  ["Starlink V2 Mini DTC Shell 2, 43 deg", 337, 0, 0, 9, 0, 9, 328, 0, 0, 0, 328],
  ["Starlink V2 Mini Shell 3, 70 deg (Group NRO/15)", 42, 0, 0, 0, 0, 0, 42, 0, 0, 0, 42],
  ["Starlink V2 Mini/Opt Shell 1, 53 deg (Group 10,11)", 1827, 0, 1, 6, 2, 9, 1818, 0, 0, 0, 1818],
  ["Starlink V2 Mini/Opt Shell 2, 43 deg (Group 6,12)", 1065, 0, 5, 5, 1, 11, 1054, 0, 0, 0, 1054],
  ["Starlink V2 Mini/Opt Shell 3, 70 deg (Group 15)", 343, 0, 0, 1, 0, 1, 342, 0, 0, 0, 342],
  ["Starlink V2 Mini/Opt Shell 4, 97 deg (Group 13,17)", 1210, 0, 1, 0, 0, 1, 1209, 0, 1, 0, 1208],
  ["Starlink Gen2", 7886, 0, 67, 169, 14, 250, 7636, 0, 3, 0, 7633],
  ["Starlink Gen3D", 2, 2, 0, 0, 0, 2, 0, 0, 0, 0, 0],
  ["Starlink Gen3", 20, 20, 0, 0, 0, 20, 0, 0, 0, 0, 0],
  ["Total", 12620, 20, 181, 1391, 147, 1739, 10881, 0, 16, 0, 10865],
];

const html =
  "<table>" +
  ROWS.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("") +
  "</table>";

// Round-trip through the real HTML parser, not the arrays directly.
const parsed = parseRows(html);
const census = starlinkFromRows(parsed, "2026-07-25");

const expect = {
  totalLaunchedEver: 12620,
  totalInOrbit: 10881,
  totalWorking: 10865,
  broadbandWorking: 10225,
  dtcWorking: 640,
};

let failed = 0;
for (const [key, want] of Object.entries(expect)) {
  const got = census[key];
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${key}: got ${got}, want ${want}`);
}

const versions = census.broadbandByVersion;
const wantVersions = { "V1.0": 657, "V1.5": 2575, "V2 Mini": 6993 };
if (!versions) {
  console.log("FAIL  broadbandByVersion missing (split did not reconcile)");
  failed++;
} else {
  for (const v of versions) {
    const ok = v.value === wantVersions[v.label];
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${v.label}: got ${v.value}, want ${wantVersions[v.label]}`);
  }
  const sum = versions.reduce((a, v) => a + v.value, 0);
  const ok = sum === census.broadbandWorking;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  versions sum ${sum} == broadband ${census.broadbandWorking}`);
}

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
