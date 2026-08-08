import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Rocket, Satellite, Users, MapPin, RefreshCw, Radio, Wifi, Shield,
  ChevronLeft, ChevronRight, ChevronDown, Award, Layers, Timer, Repeat,
  Newspaper, ExternalLink, Flame, Bell, BellOff, Gauge,
  Sun, CloudSun, Cloud, CloudRain, CloudSnow, CloudLightning, CloudFog, Wind, Droplets,
} from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  ResponsiveContainer, Tooltip, CartesianGrid,
} from "recharts";
import { fetchLiveData } from "./liveData.js";

/* ---------------------------------------------------------------- */
/*  Data layer                                                       */
/* ---------------------------------------------------------------- */

// Launch Library 2 — using the development mirror (lldev), which has far
// more generous rate limits than the production host (ll.thespacedevs.com
// throttles unauthenticated clients to ~15 calls/hour, which this app blows
// through, silently falling back to sample data). 2.3.0 is the current
// version; its launches live under /launches/ (plural).
const LL2_BASE = "https://lldev.thespacedevs.com/2.3.0/launches";

// SpaceX's stable agency ID in LL2. Used to filter server-side; we ALSO
// filter client-side (see isSpaceX) because the free-text provider filter
// is unreliable across versions and silently returns every provider.
const SPACEX_LSP_ID = 121;

function isSpaceX(item) {
  const provider = item?.launch_service_provider?.name || "";
  if (provider) return /spacex/i.test(provider);
  // Some LL2 response modes omit the provider object. Rather than filtering
  // everything out and falling back to sample data, recognise the hardware.
  const text = `${item?.name || ""} ${item?.rocket?.configuration?.name || ""}`;
  return /falcon\s?(9|heavy)|starship|super heavy|dragon/i.test(text);
}

// Falcon booster instances ("launchers" in LL2). Live source for the booster
// tracker; computes reuse + turnaround stats from the active fleet.
const LAUNCHER_BASE = "https://lldev.thespacedevs.com/2.3.0/launchers";

// Curated fallback from Wikipedia's "List of Falcon 9 first-stage boosters,"
// as of 2026-04-12, used only if the live launcher feed is unreachable.
let BOOSTER_SNAPSHOT = {
  asOf: "2026-07-09",
  recordSerial: "B1067",
  recordFlights: 36,
  operationalCount: 20,
  medianFlights: 14,
  fastestSerial: "B1088",
  fastestTurnaroundDays: 9,
  medianTurnaroundDays: 28,
};

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Parses an ISO-8601 duration (e.g. "P9DT4H30M") into a day count.
function parseDurationDays(iso) {
  if (!iso || typeof iso !== "string") return null;
  const m = iso.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
  if (!m) return null;
  const days = (+(m[1] || 0)) + (+(m[2] || 0)) / 24 + (+(m[3] || 0)) / 1440 + (+(m[4] || 0)) / 86400;
  return days > 0 ? days : null;
}

// Fetches the active Falcon booster fleet from LL2's launcher database and
// returns one normalized record per booster. "Operational" = LL2 status
// "active" on a Falcon booster (serial Bxxxx) — the live, structured
// equivalent of Wikipedia's "presumed active" fleet table (retired,
// on-display, expended, and lost boosters are excluded). We filter by
// manufacturer server-side AND by serial pattern client-side, because the
// list response doesn't always embed launcher_config to check the family.
// Sorted by flight count, most-flown first.
async function fetchOperationalBoosters() {
  const opts = { signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined };
  // Two pages of 100, ordered by most flights (a documented ordering field),
  // covers the whole ~160-booster catalog; we filter to active Falcon
  // boosters (serial Bxxxx) client-side. No fancy server filters that might
  // trip a 400/500. Dedupe in case offset paging returns overlapping pages.
  let raw = [];
  for (let page = 0; page < 2; page++) {
    const res = await fetch(`${LAUNCHER_BASE}/?mode=list&limit=100&offset=${page * 100}&ordering=-flights`, opts);
    if (!res.ok) throw new Error("bad status");
    const json = await res.json();
    raw = raw.concat(json.results || []);
    if (!json.next) break;
  }
  const seen = new Set();
  const boosters = raw
    .filter((b) => { const k = b.id ?? b.serial_number; if (seen.has(k)) return false; seen.add(k); return true; })
    .filter((b) => {
      const serial = b.serial_number || "";
      const st = (typeof b.status === "string" ? b.status : b.status?.name || "").toLowerCase();
      return /^B\d{4}$/.test(serial) && st === "active";
    })
    .map((b) => ({
      serial: b.serial_number,
      flights: b.flights || 0,
      reuses: Math.max(0, (b.flights || 0) - 1),
      firstFlight: b.first_launch_date || null,
      lastFlight: b.last_launch_date || null,
      fastestTurnaroundDays: parseDurationDays(b.fastest_turnaround),
    }))
    .filter((b) => b.flights >= 1)
    .sort((a, b) => b.flights - a.flights);
  if (!boosters.length) throw new Error("no active boosters");
  return boosters;
}

// Curated crew rosters for recent SpaceX crewed missions (Dragon). LL2 only
// exposes crew via per-launch detailed queries, so these well-documented
// rosters are kept as a dated snapshot. Names, nationalities, and roles as
// publicly reported. Most recent first.
const CREW_SNAPSHOT_AS_OF = "2026-06-01";
let CREW_MISSIONS = [
  {
    mission: "Crew-12", date: "2026-02-13", destination: "ISS", kind: "NASA rotation",
    crew: [
      { name: "Jessica Meir", nat: "USA", role: "Commander", sex: "f", img: null, birth: "1977-07-01" },
      { name: "Jack Hathaway", nat: "USA", role: "Pilot", sex: "m", img: null, birth: "1976-07-01" },
      { name: "Sophie Adenot", nat: "France", role: "Mission Specialist", sex: "f", img: null, birth: "1982-07-01" },
      { name: "Andrey Fedyaev", nat: "Russia", role: "Mission Specialist", sex: "m", img: null, birth: "1981-02-03" },
    ],
  },
  {
    mission: "Crew-11", date: "2025-08-01", destination: "ISS", kind: "NASA rotation",
    crew: [
      { name: "Zena Cardman", nat: "USA", role: "Commander", sex: "f", img: null, birth: "1987-09-23" },
      { name: "Michael Fincke", nat: "USA", role: "Pilot", sex: "m", img: null, birth: "1967-03-14" },
      { name: "Kimiya Yui", nat: "Japan", role: "Mission Specialist", sex: "m", img: null, birth: "1970-01-30" },
      { name: "Oleg Platonov", nat: "Russia", role: "Mission Specialist", sex: "m", img: null, birth: "1990-07-01" },
    ],
  },
  {
    mission: "Axiom Mission 4 (Ax-4)", date: "2025-06-25", destination: "ISS", kind: "Private",
    crew: [
      { name: "Peggy Whitson", nat: "USA", role: "Commander", sex: "f", img: null, birth: "1960-02-09" },
      { name: "Shubhanshu Shukla", nat: "India", role: "Pilot", sex: "m", img: null, birth: "1985-10-10" },
      { name: "Sławosz Uznański-Wiśniewski", nat: "Poland", role: "Mission Specialist", sex: "m", img: null, birth: "1984-04-12" },
      { name: "Tibor Kapu", nat: "Hungary", role: "Mission Specialist", sex: "m", img: null, birth: "1991-07-01" },
    ],
  },
  {
    mission: "Fram2", date: "2025-04-01", destination: "Polar orbit", kind: "Private",
    crew: [
      { name: "Chun Wang", nat: "Malta", role: "Commander", sex: "m", img: null, birth: "1985-07-01" },
      { name: "Jannicke Mikkelsen", nat: "Norway", role: "Vehicle Commander", sex: "f", img: null, birth: "1986-07-01" },
      { name: "Rabea Rogge", nat: "Germany", role: "Pilot", sex: "f", img: null, birth: "1995-07-01" },
      { name: "Eric Philips", nat: "Australia", role: "Mission Specialist", sex: "m", img: null, birth: "1962-07-01" },
    ],
  },
  {
    mission: "Crew-10", date: "2025-03-14", destination: "ISS", kind: "NASA rotation",
    crew: [
      { name: "Anne McClain", nat: "USA", role: "Commander", sex: "f", img: null, birth: "1979-06-07" },
      { name: "Nichole Ayers", nat: "USA", role: "Pilot", sex: "f", img: null, birth: "1989-07-01" },
      { name: "Takuya Onishi", nat: "Japan", role: "Mission Specialist", sex: "m", img: null, birth: "1975-12-22" },
      { name: "Kirill Peskov", nat: "Russia", role: "Mission Specialist", sex: "m", img: null, birth: "1990-07-01" },
    ],
  },
  {
    mission: "Crew-9", date: "2024-09-28", destination: "ISS", kind: "NASA rotation",
    crew: [
      { name: "Nick Hague", nat: "USA", role: "Commander", sex: "m", img: null, birth: "1975-09-24" },
      { name: "Aleksandr Gorbunov", nat: "Russia", role: "Mission Specialist", sex: "m", img: null, birth: "1990-07-01" },
    ],
  },
  {
    mission: "Polaris Dawn", date: "2024-09-10", destination: "Free flight (EVA)", kind: "Private",
    crew: [
      { name: "Jared Isaacman", nat: "USA", role: "Commander", sex: "m", img: null, birth: "1983-02-11" },
      { name: "Scott Poteet", nat: "USA", role: "Pilot", sex: "m", img: null, birth: "1974-07-01" },
      { name: "Sarah Gillis", nat: "USA", role: "Mission Specialist", sex: "f", img: null, birth: "1994-07-01" },
      { name: "Anna Menon", nat: "USA", role: "Medical Officer", sex: "f", img: null, birth: "1986-07-01" },
    ],
  },
  {
    mission: "Crew-8", date: "2024-03-04", destination: "ISS", kind: "NASA rotation",
    crew: [
      { name: "Matthew Dominick", nat: "USA", role: "Commander", sex: "m", img: null, birth: "1981-11-07" },
      { name: "Michael Barratt", nat: "USA", role: "Pilot", sex: "m", img: null, birth: "1959-04-16" },
      { name: "Jeanette Epps", nat: "USA", role: "Mission Specialist", sex: "f", img: null, birth: "1970-11-03" },
      { name: "Alexander Grebenkin", nat: "Russia", role: "Mission Specialist", sex: "m", img: null, birth: "1982-07-01" },
    ],
  },
  {
    mission: "Axiom Mission 3 (Ax-3)", date: "2024-01-18", destination: "ISS", kind: "Private",
    crew: [
      { name: "Michael López-Alegría", nat: "USA", role: "Commander", sex: "m", img: null, birth: "1958-05-30" },
      { name: "Walter Villadei", nat: "Italy", role: "Pilot", sex: "m", img: null, birth: "1974-07-26" },
      { name: "Alper Gezeravcı", nat: "Turkey", role: "Mission Specialist", sex: "m", img: null, birth: "1979-12-02" },
      { name: "Marcus Wandt", nat: "Sweden", role: "Mission Specialist", sex: "m", img: null, birth: "1980-05-12" },
    ],
  },
  {
    mission: "Crew-7", date: "2023-08-26", destination: "ISS", kind: "NASA rotation",
    crew: [
      { name: "Jasmin Moghbeli", nat: "USA", role: "Commander", sex: "f", img: null, birth: "1983-06-24" },
      { name: "Andreas Mogensen", nat: "Denmark", role: "Pilot", sex: "m", img: null, birth: "1976-11-02" },
      { name: "Satoshi Furukawa", nat: "Japan", role: "Mission Specialist", sex: "m", img: null, birth: "1964-04-04" },
      { name: "Konstantin Borisov", nat: "Russia", role: "Mission Specialist", sex: "m", img: null, birth: "1984-08-14" },
    ],
  },
  {
    mission: "Axiom Mission 2 (Ax-2)", date: "2023-05-21", destination: "ISS", kind: "Private",
    crew: [
      { name: "Peggy Whitson", nat: "USA", role: "Commander", sex: "f", img: null, birth: "1960-02-09" },
      { name: "John Shoffner", nat: "USA", role: "Pilot", sex: "m", img: null, birth: "1956-07-01" },
      { name: "Ali Al-Qarni", nat: "Saudi Arabia", role: "Mission Specialist", sex: "m", img: null, birth: "1992-07-01" },
      { name: "Rayyanah Barnawi", nat: "Saudi Arabia", role: "Mission Specialist", sex: "f", img: null, birth: "1989-07-01" },
    ],
  },
  {
    mission: "Crew-6", date: "2023-03-02", destination: "ISS", kind: "NASA rotation",
    crew: [
      { name: "Stephen Bowen", nat: "USA", role: "Commander", sex: "m", img: null, birth: "1964-02-13" },
      { name: "Warren Hoburg", nat: "USA", role: "Pilot", sex: "m", img: null, birth: "1985-09-16" },
      { name: "Sultan Al Neyadi", nat: "UAE", role: "Mission Specialist", sex: "m", img: null, birth: "1981-05-23" },
      { name: "Andrey Fedyaev", nat: "Russia", role: "Mission Specialist", sex: "m", img: null, birth: "1981-02-03" },
    ],
  },
  {
    mission: "Crew-5", date: "2022-10-05", destination: "ISS", kind: "NASA rotation",
    crew: [
      { name: "Nicole Mann", nat: "USA", role: "Commander", sex: "f", img: null, birth: "1977-06-27" },
      { name: "Josh Cassada", nat: "USA", role: "Pilot", sex: "m", img: null, birth: "1973-07-18" },
      { name: "Koichi Wakata", nat: "Japan", role: "Mission Specialist", sex: "m", img: null, birth: "1963-08-01" },
      { name: "Anna Kikina", nat: "Russia", role: "Mission Specialist", sex: "f", img: null, birth: "1984-08-27" },
    ],
  },
  {
    mission: "Crew-4", date: "2022-04-27", destination: "ISS", kind: "NASA rotation",
    crew: [
      { name: "Kjell Lindgren", nat: "USA", role: "Commander", sex: "m", img: null, birth: "1973-01-23" },
      { name: "Robert Hines", nat: "USA", role: "Pilot", sex: "m", img: null, birth: "1975-07-01" },
      { name: "Samantha Cristoforetti", nat: "Italy", role: "Mission Specialist", sex: "f", img: null, birth: "1977-04-26" },
      { name: "Jessica Watkins", nat: "USA", role: "Mission Specialist", sex: "f", img: null, birth: "1988-05-14" },
    ],
  },
  {
    mission: "Axiom Mission 1 (Ax-1)", date: "2022-04-08", destination: "ISS", kind: "Private",
    crew: [
      { name: "Michael López-Alegría", nat: "USA", role: "Commander", sex: "m", img: null, birth: "1958-05-30" },
      { name: "Larry Connor", nat: "USA", role: "Pilot", sex: "m", img: null, birth: "1950-07-01" },
      { name: "Eytan Stibbe", nat: "Israel", role: "Mission Specialist", sex: "m", img: null, birth: "1958-07-01" },
      { name: "Mark Pathy", nat: "Canada", role: "Mission Specialist", sex: "m", img: null, birth: "1971-07-01" },
    ],
  },
  {
    mission: "Crew-3", date: "2021-11-11", destination: "ISS", kind: "NASA rotation",
    crew: [
      { name: "Raja Chari", nat: "USA", role: "Commander", sex: "m", img: null, birth: "1977-06-24" },
      { name: "Tom Marshburn", nat: "USA", role: "Pilot", sex: "m", img: null, birth: "1960-08-29" },
      { name: "Kayla Barron", nat: "USA", role: "Mission Specialist", sex: "f", img: null, birth: "1987-09-19" },
      { name: "Matthias Maurer", nat: "Germany", role: "Mission Specialist", sex: "m", img: null, birth: "1970-03-18" },
    ],
  },
  {
    mission: "Inspiration4", date: "2021-09-16", destination: "Free flight", kind: "Private",
    crew: [
      { name: "Jared Isaacman", nat: "USA", role: "Commander", sex: "m", img: null, birth: "1983-02-11" },
      { name: "Sian Proctor", nat: "USA", role: "Pilot", sex: "f", img: null, birth: "1970-03-28" },
      { name: "Hayley Arceneaux", nat: "USA", role: "Medical Officer", sex: "f", img: null, birth: "1991-07-01" },
      { name: "Chris Sembroski", nat: "USA", role: "Mission Specialist", sex: "m", img: null, birth: "1979-07-01" },
    ],
  },
  {
    mission: "Crew-2", date: "2021-04-23", destination: "ISS", kind: "NASA rotation",
    crew: [
      { name: "Shane Kimbrough", nat: "USA", role: "Commander", sex: "m", img: null, birth: "1967-06-04" },
      { name: "Megan McArthur", nat: "USA", role: "Pilot", sex: "f", img: null, birth: "1971-08-30" },
      { name: "Akihiko Hoshide", nat: "Japan", role: "Mission Specialist", sex: "m", img: null, birth: "1968-12-28" },
      { name: "Thomas Pesquet", nat: "France", role: "Mission Specialist", sex: "m", img: null, birth: "1978-02-27" },
    ],
  },
  {
    mission: "Crew-1", date: "2020-11-15", destination: "ISS", kind: "NASA rotation",
    crew: [
      { name: "Michael Hopkins", nat: "USA", role: "Commander", sex: "m", img: null, birth: "1968-12-28" },
      { name: "Victor Glover", nat: "USA", role: "Pilot", sex: "m", img: null, birth: "1976-04-30" },
      { name: "Shannon Walker", nat: "USA", role: "Mission Specialist", sex: "f", img: null, birth: "1965-06-04" },
      { name: "Soichi Noguchi", nat: "Japan", role: "Mission Specialist", sex: "m", img: null, birth: "1965-04-15" },
    ],
  },
  {
    mission: "Demo-2", date: "2020-05-30", destination: "ISS", kind: "Crewed test flight",
    crew: [
      { name: "Doug Hurley", nat: "USA", role: "Commander", sex: "m", img: null, birth: "1966-10-21" },
      { name: "Bob Behnken", nat: "USA", role: "Joint Operations Commander", sex: "m", img: null, birth: "1970-07-28" },
    ],
  },
];

// Who's aboard the ISS now via SpaceX Crew Dragon (curated snapshot; the SpaceX
// app context means we show the Dragon-delivered crew). Days aboard tick from
// the docking date.
let CURRENT_ISS = {
  asOf: "2026-07-26",
  expedition: "Expedition 74/75",
  vehicle: "Crew Dragon Freedom · Crew-12",
  docked: "2026-02-14",
  crew: [
    { name: "Jessica Meir", nat: "USA", role: "Commander", sex: "f" },
    { name: "Jack Hathaway", nat: "USA", role: "Pilot", sex: "m" },
    { name: "Sophie Adenot", nat: "France", role: "Mission Specialist", sex: "f" },
    { name: "Andrey Fedyaev", nat: "Russia", role: "Mission Specialist", sex: "m" },
  ],
};

// Starbase vehicle pipeline (curated snapshot). state: test / flown / lost.
let STARSHIP_VEHICLES = {
  boosters: [
    { name: "Booster 20", version: "V3", status: "Flew Flight 13", note: "Hard Gulf splashdown; expended as planned", state: "flown" },
    { name: "Booster 19", version: "V3", status: "Flew Flight 12", note: "Lost during landing burn", state: "flown" },
    { name: "Booster 18", version: "V3", status: "Lost in test", note: "Destroyed before cryo; B19 took its place", state: "lost" },
  ],
  ships: [
    { name: "Ship 40", version: "V3", status: "Flew Flight 13", note: "Softest splashdown yet · Indian Ocean", state: "flown" },
    { name: "Ship 39", version: "V3", status: "Flew Flight 12", note: "Indian Ocean splashdown", state: "flown" },
    { name: "Ship 36", version: "V2", status: "Lost in test", note: "Exploded during a static fire", state: "lost" },
  ],
};

// Curated trending-news snapshot. Headlines, sources, dates, and links are
// real, gathered from the web; in a deployed build these would refresh live
// from a news API. Titles kept short and paraphrased; full articles live at
// the linked sources. Most recent first.
let NEWS_AS_OF = "2026-07-26";
const TRACKED_KEYWORDS = ["SpaceX", "Starlink", "Starship", "Falcon 9", "SPCX", "xAI", "Grok", "Terafab"];

let NEWS_ITEMS = [
  {
    title: "Starship Flight 13 deploys first Starlink V3 satellites, ship nails softest splashdown yet",
    source: "Space.com", date: "2026-07-24", tag: "Starship",
    url: "https://www.space.com/space-exploration/launches-spacecraft/spacexs-starship-megarocket-makes-the-softest-splashdown-ever-after-launching-next-gen-starlink-satellites-in-flight-13-test-video",
    keywords: ["Starship", "Starlink", "SpaceX"],
  },
  {
    title: "First Starship test since the record IPO draws investor scrutiny",
    source: "CNBC", date: "2026-07-24", tag: "SPCX · Starship",
    url: "https://www.cnbc.com/2026/07/24/spacex-launches-massive-starship-rocket-in-first-test-flight-since-ipo.html",
    keywords: ["SPCX", "Starship", "SpaceX", "Starlink"],
  },
  {
    title: "Engine ignition abort at T-0 scrubs first Flight 13 attempt; SPCX dips below IPO price",
    source: "CNBC", date: "2026-07-16", tag: "SPCX · Starship",
    url: "https://www.cnbc.com/2026/07/16/spacex-spcx-stock-starship-test-flight.html",
    keywords: ["SPCX", "Starship", "SpaceX"],
  },
  {
    title: "NASA picks Starlink laser terminals to beam Artemis III imagery from Orion",
    source: "NASA", date: "2026-07-16", tag: "Starlink",
    url: "https://www.nasa.gov/blogs/missions/2026/07/16/nasa-taps-spacexs-starlink-to-deliver-artemis-iii-imagery-from-orion/",
    keywords: ["Starlink", "SpaceX"],
  },
  {
    title: "Falcon 9 booster B1067 flies a record 36th time",
    source: "Space.com", date: "2026-07-09", tag: "Falcon 9",
    url: "https://www.space.com/space-exploration/launches-spacecraft/spacex-falcon-9-rocket-launch-36th-time-new-record",
    keywords: ["Falcon 9", "Starlink", "SpaceX"],
  },
  {
    title: "Grok 4.5 enters private beta at SpaceX and Tesla",
    source: "Crypto Briefing", date: "2026-06-28", tag: "xAI · Grok",
    url: "https://cryptobriefing.com/grok-4-5-private-beta-spacex-tesla/",
    keywords: ["xAI", "Grok", "SpaceX"],
  },
  {
    title: "How many Starlink satellites can SpaceX launch this year?",
    source: "The Motley Fool", date: "2026-06-27", tag: "Starlink",
    url: "https://www.fool.com/investing/2026/06/27/how-many-starlink-satellites-can-spacex-launch-thi/",
    keywords: ["Starlink", "SpaceX", "Starship"],
  },
  {
    title: "SpaceX IPO: valuation, timeline and how to invest",
    source: "SmartAsset", date: "2026-06-26", tag: "SPCX · IPO",
    url: "https://smartasset.com/investing/spacex-ipo",
    keywords: ["SPCX", "SpaceX", "Starlink", "Terafab"],
  },
  {
    title: "xAI expands video and image tools under the SpaceX umbrella",
    source: "Crypto Briefing", date: "2026-06-25", tag: "xAI · Grok",
    url: "https://cryptobriefing.com/xai-expands-video-image-tools-spacex/",
    keywords: ["xAI", "Grok", "SpaceX"],
  },
  {
    title: "West Coast Falcon 9 expands Starlink network from Vandenberg",
    source: "Spaceflight Now", date: "2026-06-24", tag: "Falcon 9",
    url: "https://spaceflightnow.com/2026/06/24/live-coverage-west-coast-falcon-9-launch-to-continue-expansion-of-spacexs-starlink-network/",
    keywords: ["Falcon 9", "Starlink", "SpaceX"],
  },
  {
    title: "Grok 5 still in training as its release date slips again",
    source: "GEO Toolbox", date: "2026-06-24", tag: "Grok",
    url: "https://geotoolbox.ai/blog/grok-5",
    keywords: ["Grok", "xAI"],
  },
  {
    title: "SpaceX preps Starship Flight 13 after first V3 launch",
    source: "Next Spaceflight", date: "2026-06-23", tag: "Starship",
    url: "https://nextspaceflight.com/starship/",
    keywords: ["Starship", "SpaceX"],
  },
  {
    title: "Why SpaceX merged with xAI: the real business is orbital compute",
    source: "Quasa", date: "2026-06-15", tag: "xAI · compute",
    url: "https://quasa.io/media/spacex-didn-t-merge-with-xai-for-grok-the-real-business-is-orbital-compute",
    keywords: ["xAI", "Grok", "SpaceX", "Starlink"],
  },
  {
    title: "SpaceX IPO raises $75B; SPCX surges 20% on day one",
    source: "KeepTrack", date: "2026-06-13", tag: "SPCX · IPO",
    url: "https://keeptrack.space/x-report/spacex-brief-2026-06-13",
    keywords: ["SPCX", "SpaceX", "Starlink"],
  },
  {
    title: "SpaceX launches Starlink as SPCX debuts on the Nasdaq",
    source: "Spaceflight Now", date: "2026-06-12", tag: "SPCX · Starlink",
    url: "https://spaceflightnow.com/2026/06/12/live-coverage-spacex-to-launch-final-starlink-mission-as-it-begins-publicly-trade-its-stock-on-the-nasdaq-for-the-first-time/",
    keywords: ["SPCX", "Starlink", "Falcon 9", "SpaceX"],
  },
  {
    title: "SpaceX may spend up to $119B on its 'Terafab' chip factory",
    source: "TechCrunch", date: "2026-05-06", tag: "Terafab",
    url: "https://techcrunch.com/2026/05/06/spacex-may-spend-up-to-119-billion-on-terafab-chip-factory-in-texas/",
    keywords: ["Terafab", "xAI", "Grok", "SpaceX"],
  },
  {
    title: "Musk's Terafab chip plan to be built in Austin by Tesla and SpaceX",
    source: "Fortune", date: "2026-03-22", tag: "Terafab",
    url: "https://fortune.com/2026/03/22/musk-terafab-chip-project-tesla-spacex-xai-space-data-center-satellite/",
    keywords: ["Terafab", "xAI", "SpaceX"],
  },
];

// Curated Starship program snapshot (Wikipedia "List of Starship launches" +
// SpaceX/NSF coverage), as of 2026-06-28. Flights newest first. Some 2025
// dates are month-approximate. Outcome tags mirror SpaceX's official tally
// (7 successes / 5 failures through Flight 12) even where a flight was mixed.
let STARSHIP_AS_OF = "2026-07-26";

let STARSHIP_STATS = {
  flights: 13, successes: 8, failures: 5,
  boostersFlown: 11, shipsFlown: 13, catches: 3, currentVersion: "V3 · Block 3",
};

let STARSHIP_NEXT = {
  flight: 14, booster: "TBD", ship: "TBD", version: "V3",
  window: "NET late 2026",
  profile: "Orbital attempt expected · vehicles not yet confirmed",
  status: "In production",
  notes: "Flight 13 was billed as potentially the last suborbital V3 test, so Flight 14 is expected to attempt a full orbital profile — but SpaceX has not confirmed the vehicle assignment or a date. Booster landing-burn reliability, which cost B20 a soft splashdown, is the open item going in.",
};

let STARSHIP_FLIGHTS = [
  {
    n: 13, date: "Jul 24, 2026", booster: "B20", ship: "S40", version: "V3",
    launch: "success", boosterLanding: "failure", shipLanding: "splashdown",
    profile: "Suborbital · first Starlink V3 deploy · dual splashdown",
    summary: "Deployed 20 Starlink V3 satellites — the first real V3 payloads — after two scrubbed attempts (a T-0 engine abort on Jul 16 and weather on Jul 23). Booster 20 completed an all-33-engine boostback but lit only about 5 of 13 engines on the landing burn and hit the Gulf hard. Ship 40 flew a clean ascent, relit a Raptor in space and made its softest splashdown yet in the Indian Ocean, staying afloat on camera.",
  },
  {
    n: 12, date: "May 22, 2026", booster: "B19", ship: "S39", version: "V3",
    launch: "success", boosterLanding: "failure", shipLanding: "splashdown",
    profile: "First V3 flight · Pad 2 · suborbital, dual splashdown",
    summary: "Debut of Block 3 hardware and the first launch from Starbase's second pad. After hot-staging the booster flipped, lost most engines and crashed into the Gulf, but Ship 39 deployed 22 Starlink simulators and splashed down in the Indian Ocean. The FAA opened a booster-mishap review.",
  },
  {
    n: 11, date: "Oct 13, 2025", booster: "B15-2", ship: "S38", version: "V2",
    launch: "success", boosterLanding: "splashdown", shipLanding: "splashdown",
    profile: "Final Block 2 flight · suborbital",
    summary: "Last flight of the Block 2 ship. Reflew Booster 15 to a controlled Gulf splashdown and Ship 38 to an ocean splashdown, retiring the V2 ship line ahead of the V3 transition.",
  },
  {
    n: 10, date: "Aug 26, 2025", booster: "B16", ship: "S37", version: "V2",
    launch: "success", boosterLanding: "splashdown", shipLanding: "splashdown",
    profile: "Suborbital · Starlink simulator deploy",
    summary: "Ship 37 became the first Starship to deploy Starlink simulators and splashed down under control; Booster 16 ran experimental descent maneuvers before its own Gulf splashdown.",
  },
  {
    n: 9, date: "May 27, 2025", booster: "B14-2", ship: "S35", version: "V2",
    launch: "failure", boosterLanding: "failure", shipLanding: "failure",
    profile: "First booster reflight · suborbital",
    summary: "First reflight of a Super Heavy (Booster 14). The booster was lost during a high-angle descent experiment, and Ship 35 lost attitude control after reaching engine cutoff.",
  },
  {
    n: 8, date: "Mar 6, 2025", booster: "B15", ship: "S34", version: "V2",
    launch: "failure", boosterLanding: "catch", shipLanding: "na",
    profile: "Booster tower catch · suborbital",
    summary: "Third successful tower catch of a Super Heavy. Ship 34 was lost earlier in the flight, so its landing was precluded, echoing Flight 7's upper-stage problems.",
  },
  {
    n: 7, date: "Jan 16, 2025", booster: "B14", ship: "S33", version: "V2",
    launch: "failure", boosterLanding: "catch", shipLanding: "na",
    profile: "Booster catch · first Block 2 ship",
    summary: "Booster 14 was caught on the tower, but Ship 33 — the first Block 2 ship — was lost before engine cutoff to harmonic vibrations and an aft-section fire, precluding its landing.",
  },
  {
    n: 6, date: "Nov 19, 2024", booster: "B13", ship: "S31", version: "V1",
    launch: "success", boosterLanding: "splashdown", shipLanding: "splashdown",
    profile: "Booster splashdown · ship reentry",
    summary: "Catch was waved off, so Booster 13 made a controlled Gulf splashdown while Ship 31 completed reentry to an ocean splashdown, including an in-space engine relight. Final Block 1 flight.",
  },
  {
    n: 5, date: "Oct 13, 2024", booster: "B12", ship: "S30", version: "V1",
    launch: "success", boosterLanding: "catch", shipLanding: "splashdown",
    profile: "First tower catch · suborbital",
    summary: "Booster 12 became the first Super Heavy caught by the tower 'chopstick' arms — the program's signature milestone. Ship 30 flew a clean reentry to a controlled Indian Ocean splashdown.",
  },
  {
    n: 4, date: "Jun 6, 2024", booster: "B11", ship: "S29", version: "V1",
    launch: "success", boosterLanding: "splashdown", shipLanding: "splashdown",
    profile: "Booster + ship soft splashdown",
    summary: "First flight where both stages reached controlled splashdowns. Ship 29 endured reentry despite losing several heat-shield tiles and part of a flap.",
  },
  {
    n: 3, date: "Mar 14, 2024", booster: "B10", ship: "S28", version: "V1",
    launch: "success", boosterLanding: "failure", shipLanding: "failure",
    profile: "Reached space · landings failed",
    summary: "Reached space and tested propellant transfer and the payload door, but the booster was lost during descent and the ship during reentry.",
  },
  {
    n: 2, date: "Nov 18, 2023", booster: "B9", ship: "S25", version: "V1",
    launch: "failure", boosterLanding: "failure", shipLanding: "na",
    profile: "First hot-staging",
    summary: "Demonstrated hot-stage separation for the first time. The booster was lost during boostback and the ship was terminated in flight, precluding its landing — but the upgraded pad held up cleanly.",
  },
  {
    n: 1, date: "Apr 20, 2023", booster: "B7", ship: "S24", version: "V1",
    launch: "failure", boosterLanding: "na", shipLanding: "na",
    profile: "Maiden integrated flight",
    summary: "First integrated launch of Super Heavy and Starship. Several engines failed, the stack never separated, and the flight-termination system destroyed it ~4 minutes in. Both landings were precluded; liftoff heavily damaged the pad.",
  },
];

function statusKindFromAbbrev(abbrev = "") {
  const a = abbrev.toLowerCase();
  if (a.includes("success")) return "success";
  if (a.includes("fail")) return "fail";
  if (a.includes("hold") || a.includes("tbd") || a.includes("tbc")) return "hold";
  return "go";
}

// A launch whose time has passed but still carries a pre-launch status
// ("Go"/"TBD") shouldn't read as upcoming — show it as flown instead.
function settleStatus(l, now) {
  if (l.net && new Date(l.net) <= now && (l.statusKind === "go" || l.statusKind === "hold")) {
    return { ...l, statusLabel: "Launched", statusKind: "flown" };
  }
  return l;
}

function normalizeLaunch(item) {
  const full = item.name || "Unknown mission";
  const parts = full.split("|");
  const rocket = (parts[0] || "").trim() || item.rocket?.configuration?.name || "Falcon 9";
  const mission = (parts[1] || full).trim();
  const abbrev = item.status?.abbrev || item.status?.name || "Go";
  return {
    id: item.id || `${mission}-${item.net}`,
    mission,
    rocket,
    net: item.net,
    pad: item.pad?.location?.name || item.pad?.name || "—",
    provider: item.launch_service_provider?.name || "",
    statusLabel: abbrev,
    statusKind: statusKindFromAbbrev(abbrev),
  };
}

// Fallback data used only if the live feed can't be reached.
// Grounded in publicly reported missions where possible; otherwise
// generic illustrative entries. Always shown with a "SAMPLE DATA" badge.
// Built relative to "now" so the offline sample always shows a sensible set of
// upcoming launches (with a confident "Go" soonest) rather than stale dates.
function makeSampleUpcoming() {
  const base = Date.now();
  const at = (h) => new Date(base + h * 3600000).toISOString();
  return [
    { id: "su1", mission: "Starlink Group 17-40", rocket: "Falcon 9", net: at(19), pad: "Vandenberg SFB, CA, USA", statusLabel: "Go", statusKind: "go" },
    { id: "su2", mission: "Globalstar 2-R Mission 1", rocket: "Falcon 9", net: at(41), pad: "Cape Canaveral SFS, FL, USA", statusLabel: "Go", statusKind: "go" },
    { id: "su3", mission: "Sirius SXM-11", rocket: "Falcon 9", net: at(63), pad: "Cape Canaveral SFS, FL, USA", statusLabel: "TBD", statusKind: "hold" },
    { id: "su4", mission: "Starlink Group 17-46", rocket: "Falcon 9", net: at(96), pad: "Vandenberg SFB, CA, USA", statusLabel: "TBD", statusKind: "hold" },
    { id: "su5", mission: "Starlink Group 10-50", rocket: "Falcon 9", net: at(140), pad: "Cape Canaveral SFS, FL, USA", statusLabel: "TBD", statusKind: "hold" },
  ];
}

// Generates a realistic-density month of fallback launches (SpaceX flies
// roughly 12-15 times/month in 2026) so the offline SAMPLE DATA view still
// looks like real cadence instead of a handful of placeholder rows.
function makeSyntheticMonth(year, month, internalCount, customerNames = []) {
  const mm = String(month).padStart(2, "0");
  const items = [];
  const sitePads = ["Cape Canaveral SFS, FL, USA", "Vandenberg SFB, CA, USA", "Kennedy Space Center, FL, USA"];
  for (let i = 0; i < internalCount; i++) {
    const day = Math.min(28, 1 + Math.floor((i * 27) / Math.max(1, internalCount - 1)));
    items.push({
      id: `gen-${year}${mm}-sl-${i}`,
      mission: `Starlink Group ${9 + (i % 8)}-${(i * 3 + 1) % 60}`,
      rocket: "Falcon 9",
      net: `${year}-${mm}-${String(day).padStart(2, "0")}T${String((i * 5) % 24).padStart(2, "0")}:00:00Z`,
      pad: sitePads[i % 3],
      statusLabel: "Success",
      statusKind: "success",
    });
  }
  customerNames.forEach((name, i) => {
    const day = Math.min(28, 22 + i * 2);
    items.push({
      id: `gen-${year}${mm}-cu-${i}`,
      mission: name,
      rocket: "Falcon 9",
      net: `${year}-${mm}-${String(day).padStart(2, "0")}T0${i}:00:00Z`,
      pad: /crew|axiom|polaris/i.test(name) ? "Kennedy Space Center, FL, USA" : "Cape Canaveral SFS, FL, USA",
      statusLabel: "Success",
      statusKind: "success",
    });
  });
  return items;
}

const SAMPLE_PAST = (() => {
  const out = [
    // Starship integrated test flights (real cadence) so the vehicle split
    // shows Starship alongside Falcon. Limited to the sample window.
    ...STARSHIP_FLIGHTS
      .filter((f) => new Date(`${f.date} UTC`) >= new Date("2024-05-01T00:00:00Z"))
      .map((f) => ({
        id: `ss-${f.n}`,
        mission: `Starship Flight ${f.n}`,
        rocket: "Starship",
        net: new Date(`${f.date} UTC`).toISOString(),
        pad: "Starbase, TX, USA",
        statusLabel: f.launch === "success" ? "Success" : "Failure",
        statusKind: f.launch === "success" ? "success" : "fail",
      })),
    // A handful of Falcon Heavy missions (all fly from LC-39A).
    { id: "fh-goes", mission: "GOES-U", rocket: "Falcon Heavy", net: "2024-06-25T21:16:00Z", pad: "Kennedy Space Center, FL, USA", statusLabel: "Success", statusKind: "success" },
    { id: "fh-ussf87", mission: "USSF-87", rocket: "Falcon Heavy", net: "2024-10-09T14:00:00Z", pad: "Kennedy Space Center, FL, USA", statusLabel: "Success", statusKind: "success" },
    { id: "fh-viasat", mission: "ViaSat-3 F2", rocket: "Falcon Heavy", net: "2025-03-18T23:10:00Z", pad: "Kennedy Space Center, FL, USA", statusLabel: "Success", statusKind: "success" },
    { id: "fh-ussf112", mission: "USSF-112", rocket: "Falcon Heavy", net: "2025-09-22T17:30:00Z", pad: "Kennedy Space Center, FL, USA", statusLabel: "Success", statusKind: "success" },
    { id: "fh-griffin", mission: "Griffin Mission 1", rocket: "Falcon Heavy", net: "2026-02-11T06:45:00Z", pad: "Kennedy Space Center, FL, USA", statusLabel: "Success", statusKind: "success" },
  ];
  // A rotating set of customer missions to sprinkle through the months.
  const customerSets = [
    ["CRS-35", "O3b mPOWER 9"], ["Crew-12"], ["SXM-11", "GPS III-9"], ["WorldView Legion 7"],
    ["NROL-212 (Starshield)"], ["CRS-34"], ["O3b mPOWER 10"], ["Transporter-14"],
    ["NROL-186"], ["Galileo L13"], ["Bandwagon-3"], ["Intelsat IS-45"],
  ];
  // 25 months of realistic-density history (~12 launches/month), so the
  // offline preview still shows a full two years of past launches.
  let y = 2026, m = 5;
  for (let i = 0; i < 25; i++) {
    out.push(...makeSyntheticMonth(y, m, 11 + (i % 4), customerSets[i % customerSets.length]));
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
})();

const SAMPLE_CREW = [
  { id: "su1", mission: "Crew-13", rocket: "Falcon 9", net: "2026-09-15T10:00:00Z", pad: "Kennedy Space Center, FL, USA", statusLabel: "Go", statusKind: "go" },
  { id: "sc1", mission: "Dragon Crew Rotation", rocket: "Falcon 9", net: "2026-03-01T08:00:00Z", pad: "Kennedy Space Center, FL, USA", statusLabel: "Success", statusKind: "success" },
];

// Approximate, illustrative — not exact telemetry.
const SAT_GROWTH = [
  { year: "2019", sats: 60 }, { year: "2020", sats: 955 }, { year: "2021", sats: 1900 },
  { year: "2022", sats: 3300 }, { year: "2023", sats: 5400 }, { year: "2024", sats: 6700 },
  { year: "2025", sats: 8800 }, { year: "2026", sats: 10689 },
];

// Precise satellite census, broken out by service type (broadband vs
// Direct-to-Cell). Sourced from Jonathan McDowell's independent satellite
// catalog (planet4589.org), which tracks orbital status per Starlink shell.
// This page has no JSON API and no CORS headers, so it can't be polled
// live from the browser — this is a dated snapshot, refreshed manually.
let SATELLITE_CENSUS = {
  asOf: "2026-07-25",
  source: "planet4589.org",
  sourceUrl: "https://planet4589.org/space/con/star/stats.html",
  totalLaunchedEver: 12620,
  totalInOrbit: 10881,
  totalWorking: 10865,
  broadbandWorking: 10225, // standard Ku/Ka shells (Gen1 + Gen2 non-DTC)
  dtcWorking: 640,         // Direct-to-Cell shells: 312 @53° + 328 @43°
  // All figures read directly from McDowell's per-shell "working" columns.
  // V1.0 = Group 1 early + Visorsat shells; V1.5 = Groups 2–5 shells;
  // V2 Mini = all Gen2 broadband shells (Mini + Mini/Opt), DTC excluded.
  // Sums to 10,225; with DTC that is the 10,865 total working.
  broadbandByVersion: [
    { label: "V1.0", value: 657, color: "#A7C8FB" },
    { label: "V1.5", value: 2575, color: "#5E9CF8" },
    { label: "V2 Mini", value: 6993, color: "#2F66D8" },
  ],
};

// Starshield is a separate SpaceX-operated constellation for U.S. national
// security customers (incl. the NRO) — deliberately kept out of the
// Starlink totals above per request. Same source, same caveats.
let STARSHIELD_CENSUS = {
  asOf: "2026-07-16",
  source: "planet4589.org",
  sourceUrl: "https://planet4589.org/space/con/stsh/stats.html",
  totalLaunchedEver: 245,
  totalInOrbit: 241,
  totalWorking: 241,
};

// All-time yearly Internal vs Customer split, back to Falcon 9's first
// flight. Confidence varies by year and is shown in the UI:
//  - "verified": counted directly from every individual 2024 launch's
//    listed Customer field in Wikipedia's official manifest (sums to the
//    confirmed total of 134, so the count checks out).
//  - "partial": 2025 counted the same way through ~August (141 of 165
//    launches), then the observed internal/customer ratio is extrapolated
//    to the confirmed full-year total of 165.
//  - "estimated": total launch counts are well-documented; the
//    internal/customer split is an estimate based on Starlink's known
//    share of the manifest that year, not a per-launch count.
//  - "presplit": before Starlink existed (pre-2019), every flight was
//    necessarily a customer mission.
let YEARLY_LAUNCH_DATA = [
  { year: 2010, internal: 0, customer: 2, confidence: "presplit" },
  { year: 2011, internal: 0, customer: 0, confidence: "presplit" },
  { year: 2012, internal: 0, customer: 2, confidence: "presplit" },
  { year: 2013, internal: 0, customer: 3, confidence: "presplit" },
  { year: 2014, internal: 0, customer: 6, confidence: "presplit" },
  { year: 2015, internal: 0, customer: 7, confidence: "presplit" },
  { year: 2016, internal: 0, customer: 8, confidence: "presplit" },
  { year: 2017, internal: 0, customer: 18, confidence: "presplit" },
  { year: 2018, internal: 0, customer: 22, confidence: "presplit" },
  { year: 2019, internal: 2, customer: 11, confidence: "estimated" },
  { year: 2020, internal: 14, customer: 12, confidence: "estimated" },
  { year: 2021, internal: 19, customer: 12, confidence: "estimated" },
  { year: 2022, internal: 34, customer: 27, confidence: "estimated" },
  { year: 2023, internal: 62, customer: 34, confidence: "estimated" },
  { year: 2024, internal: 89, customer: 45, confidence: "verified" },
  { year: 2025, internal: 118, customer: 47, confidence: "partial" },
  { year: 2026, internal: 70, customer: 18, confidence: "estimated" },
].map((d) => ({ ...d, label: `'${String(d.year).slice(2)}` }));

/* ---------------------------------------------------------------- */
/*  Helpers                                                          */
/* ---------------------------------------------------------------- */

function formatCountdown(targetIso, now) {
  const target = new Date(targetIso).getTime();
  const diff = target - now.getTime();
  const sign = diff < 0 ? "T+" : "T-";
  const abs = Math.abs(diff);
  const d = Math.floor(abs / 86400000);
  const h = Math.floor((abs % 86400000) / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  const s = Math.floor((abs % 60000) / 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${sign}${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
}

function formatDateOnly(iso) {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// Relative "x ago" label for news timestamps.
function timeAgo(iso, ref) {
  const d = new Date(iso + "T12:00:00Z");
  const days = Math.floor((ref - d) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 7) return `${days}d ago`;
  if (days < 35) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

// Short relative time for the live-feed sync indicator (seconds/minutes/hours).
function syncAgo(date, ref) {
  if (!date) return "";
  const s = Math.max(0, Math.floor((ref - date) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

// Age in whole years from a birth date (ISO) as of a reference date.
function computeAge(birthIso, ref) {
  if (!birthIso) return null;
  const b = new Date(birthIso + "T00:00:00Z");
  if (isNaN(b.getTime())) return null;
  let age = ref.getUTCFullYear() - b.getUTCFullYear();
  const mo = ref.getUTCMonth() - b.getUTCMonth();
  if (mo < 0 || (mo === 0 && ref.getUTCDate() < b.getUTCDate())) age -= 1;
  return age >= 0 ? age : null;
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return (
    d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) +
    " UTC"
  );
}

// Heuristic, refined against Wikipedia's "List of Falcon 9 and Falcon Heavy
// launches," which tags each flight's actual Customer. That table confirms
// Starshield missions are billed to the NRO (not SpaceX) — so despite being
// SpaceX-built, they count as Customer here, not Internal. Starlink and
// Starship (in-house test flights, self-funded) remain Internal.
function classifyLaunch(l) {
  const text = `${l.mission} ${l.rocket}`.toLowerCase();
  if (/starlink|starship/.test(text)) return "internal";
  return "customer";
}

// Builds all 12 months for one specific year (zero-filled so gaps are
// visible rather than skipped), trimming months that haven't happened yet
// if `year` is the current year.
function buildMonthsForYear(launches, year, upToMonth = 12) {
  const months = Array.from({ length: Math.min(12, upToMonth) }, (_, i) => {
    const key = `${year}-${String(i + 1).padStart(2, "0")}`;
    return {
      key,
      internal: 0,
      customer: 0,
      label: new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
    };
  });
  const byKey = Object.fromEntries(months.map((m) => [m.key, m]));
  launches.forEach((l) => {
    if (!l.net) return;
    const d = new Date(l.net);
    if (isNaN(d.getTime()) || d.getUTCFullYear() !== year) return;
    const key = `${year}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (byKey[key]) byKey[key][classifyLaunch(l)] += 1;
  });
  return months;
}

// Launch-site grouping. Pads come through as e.g. "Cape Canaveral SFS, FL, USA",
// "Kennedy Space Center, FL, USA", "Vandenberg SFB, CA, USA", "Starbase, TX".
const LAUNCH_SITES = [
  { key: "Cape Canaveral", color: "#4F8EF7" },
  { key: "Kennedy LC-39A", color: "#8C7BE8" },
  { key: "Vandenberg", color: "#FF9F40" },
  { key: "Starbase", color: "#3ED598" },
  { key: "Other", color: "#7B8494" },
];

function launchSite(l) {
  const p = (l.pad || "").toLowerCase();
  if (/vandenberg|slc-?4[ew]|complex 4[ew]/.test(p)) return "Vandenberg";
  if (/kennedy|ksc|lc-?39|complex 39|39a/.test(p)) return "Kennedy LC-39A";
  if (/canaveral|ccsfs|ccafs|slc-?40|complex 40/.test(p)) return "Cape Canaveral";
  if (/starbase|boca chica/.test(p)) return "Starbase";
  return "Other";
}

function buildMonthsForYearBySite(launches, year, upToMonth = 12) {
  const months = Array.from({ length: Math.min(12, upToMonth) }, (_, i) => {
    const key = `${year}-${String(i + 1).padStart(2, "0")}`;
    const row = { key, label: new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }) };
    LAUNCH_SITES.forEach((s) => { row[s.key] = 0; });
    return row;
  });
  const byKey = Object.fromEntries(months.map((m) => [m.key, m]));
  launches.forEach((l) => {
    if (!l.net) return;
    const d = new Date(l.net);
    if (isNaN(d.getTime()) || d.getUTCFullYear() !== year) return;
    const key = `${year}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (byKey[key]) byKey[key][launchSite(l)] += 1;
  });
  return months;
}

// Launch-vehicle grouping. rocket comes through as e.g. "Falcon 9 Block 5",
// "Falcon Heavy", "Starship".
const LAUNCH_VEHICLES = [
  { key: "Falcon 9", color: "#4F8EF7" },
  { key: "Falcon Heavy", color: "#FF9F40" },
  { key: "Other", color: "#7B8494" },
];

function launchVehicle(l) {
  const r = (l.rocket || "").toLowerCase();
  if (/falcon heavy/.test(r)) return "Falcon Heavy";
  if (/starship|super heavy/.test(r)) return "Starship";
  if (/falcon\s*9/.test(r)) return "Falcon 9";
  return "Other";
}

function buildMonthsForYearByVehicle(launches, year, upToMonth = 12) {
  const months = Array.from({ length: Math.min(12, upToMonth) }, (_, i) => {
    const key = `${year}-${String(i + 1).padStart(2, "0")}`;
    const row = { key, label: new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }) };
    LAUNCH_VEHICLES.forEach((v) => { row[v.key] = 0; });
    return row;
  });
  const byKey = Object.fromEntries(months.map((m) => [m.key, m]));
  launches.forEach((l) => {
    if (!l.net) return;
    const d = new Date(l.net);
    if (isNaN(d.getTime()) || d.getUTCFullYear() !== year) return;
    const key = `${year}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (byKey[key]) byKey[key][launchVehicle(l)] += 1;
  });
  return months;
}

/* ---------------------------------------------------------------- */
/*  Small UI pieces                                                  */
/* ---------------------------------------------------------------- */

// The dev API (lldev) is generous with rate limits but only carries a
// truncated dataset — about 160 SpaceX launches, i.e. back to roughly Aug
// 2025. Production carries the full ~700 back to 2014. So: use production
// for the one-off deep history pull, cache it for a day to stay well inside
// its tighter rate limit, and keep lldev for the small feed that refreshes
// every few minutes.
const LL2_DEEP_BASE = "https://ll.thespacedevs.com/2.3.0/launches";

// Deep history published daily by the scraper (public/data/perigee-data.json).
// Preferred over any client-side paging: it reaches back to 2014 and costs the
// phone nothing against the API's tight rate limit.
let PUBLISHED_HISTORY = null;
const HISTORY_CACHE_KEY = "perigee:history:v1";
const HISTORY_CACHE_MS = 24 * 60 * 60 * 1000;

function readHistoryCache() {
  try {
    const raw = localStorage.getItem(HISTORY_CACHE_KEY);
    if (!raw) return null;
    const { at, launches } = JSON.parse(raw);
    if (!at || !Array.isArray(launches) || !launches.length) return null;
    if (Date.now() - at > HISTORY_CACHE_MS) return null;
    return launches;
  } catch {
    return null; // private mode, quota, or corrupt entry — just refetch
  }
}

function writeHistoryCache(launches) {
  try {
    localStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify({ at: Date.now(), launches }));
  } catch {
    /* storage full or unavailable; caching is best-effort */
  }
}

// Walks backwards with a net__lt date cursor (reliable where offset paging
// stalls). Returns past launches, newest first.
async function fetchLaunchHistory(pages = 7, base = LL2_DEEP_BASE) {
  let all = [];
  let cursor = new Date().toISOString();
  for (let page = 0; page < pages; page++) {
    // A timeout per request, not one shared across the loop: a single
    // AbortSignal created up front starts counting immediately and would
    // kill the later pages, silently truncating history.
    const opts = {
      signal:
        typeof AbortSignal !== "undefined" && AbortSignal.timeout
          ? AbortSignal.timeout(15000)
          : undefined,
    };
    const res = await fetch(
      `${base}/?lsp__id=${SPACEX_LSP_ID}&ordering=-net&mode=normal&limit=100&net__lt=${encodeURIComponent(cursor)}`,
      opts
    );
    if (!res.ok) throw new Error("bad status");
    const json = await res.json();
    const raw = json.results || [];
    const batch = raw.filter(isSpaceX).map(normalizeLaunch).filter((l) => l.net);
    if (raw.length === 0) break;
    all = all.concat(batch);
    const oldest = raw[raw.length - 1].net;
    if (!oldest || oldest === cursor) break;
    cursor = oldest;
    // Trust the API's own "is there more" flag. Checking `raw.length < 100`
    // instead ends the walk on any short page, which is exactly how history
    // used to stop dead at Aug 2025.
    if (!json.next) break;
  }
  if (all.length === 0) throw new Error("empty");
  return all;
}

// Launch type glyph: internal (Starlink/Starship) = three blue satellites
// laser-linked in a mesh; customer = a single orange satellite stamped with
// a dollar sign (a paid, billed mission).
function LaunchGlyph({ l, size = 34 }) {
  const kind = classifyLaunch(l);
  const sat = (x, y, key) => (
    <g key={key} transform={`translate(${x} ${y})`}>
      <rect x="-7.6" y="-1.7" width="4.6" height="3.4" rx="0.6" fill="#9DB8F5" />
      <rect x="3" y="-1.7" width="4.6" height="3.4" rx="0.6" fill="#9DB8F5" />
      <rect x="-2.7" y="-3.3" width="5.4" height="6.6" rx="1.3" fill="#4F8EF7" />
    </g>
  );
  return (
    <svg width={size} height={size} viewBox="0 0 56 56" style={{ flexShrink: 0 }}>
      <circle cx="28" cy="28" r="26" fill="none" stroke="var(--hairline)" strokeWidth="1.5" />
      {kind === "internal" ? (
        <>
          <g stroke="#4F8EF7" strokeWidth="1.2" opacity="0.55" strokeLinecap="round">
            <line x1="28" y1="16" x2="17" y2="38" />
            <line x1="28" y1="16" x2="39" y2="38" />
            <line x1="17" y1="38" x2="39" y2="38" />
          </g>
          {sat(28, 16, "a")}
          {sat(17, 38, "b")}
          {sat(39, 38, "c")}
        </>
      ) : (
        <>
          <rect x="8" y="22.5" width="9" height="11" rx="1.5" fill="#FF9F40" opacity="0.5" />
          <rect x="39" y="22.5" width="9" height="11" rx="1.5" fill="#FF9F40" opacity="0.5" />
          <line x1="17" y1="28" x2="21" y2="28" stroke="#FF9F40" strokeWidth="1.4" />
          <line x1="35" y1="28" x2="39" y2="28" stroke="#FF9F40" strokeWidth="1.4" />
          <rect x="20.5" y="19" width="15" height="18" rx="3" fill="#FF9F40" />
          <text x="28" y="28.5" textAnchor="middle" dominantBaseline="central" fontFamily="ui-monospace, monospace" fontSize="13" fontWeight="700" fill="#0A0C10">$</text>
        </>
      )}
    </svg>
  );
}

function StatusPill({ kind, label }) {
  const map = {
    success: { bg: "rgba(62,213,152,0.12)", fg: "var(--ok)" },
    fail: { bg: "rgba(255,92,92,0.12)", fg: "var(--bad)" },
    go: { bg: "rgba(79,142,247,0.12)", fg: "var(--blue)" },
    hold: { bg: "rgba(255,159,64,0.12)", fg: "var(--amber)" },
    flown: { bg: "rgba(123,132,148,0.14)", fg: "var(--text-dim)" },
  };
  const s = map[kind] || map.go;
  return (
    <span
      className="mono"
      style={{ background: s.bg, color: s.fg, fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", padding: "3px 8px", borderRadius: 999, textTransform: "uppercase", whiteSpace: "nowrap" }}
    >
      {label}
    </span>
  );
}

function SectionLabel({ children }) {
  return (
    <div className="mono tick" style={{ fontSize: 11, letterSpacing: "0.08em", color: "var(--text-dim)", margin: "18px 4px 8px", textTransform: "uppercase" }}>
      {children}
    </div>
  );
}

// HUD-style targeting brackets for hero panels (parent must be position:relative).
function HudCorners({ color = "rgba(174,184,242,0.45)", inset = 7, size = 13, bw = 1.5 }) {
  const base = { position: "absolute", width: size, height: size, pointerEvents: "none" };
  return (
    <>
      <span style={{ ...base, top: inset, left: inset, borderTop: `${bw}px solid ${color}`, borderLeft: `${bw}px solid ${color}`, borderTopLeftRadius: 3 }} />
      <span style={{ ...base, top: inset, right: inset, borderTop: `${bw}px solid ${color}`, borderRight: `${bw}px solid ${color}`, borderTopRightRadius: 3 }} />
      <span style={{ ...base, bottom: inset, left: inset, borderBottom: `${bw}px solid ${color}`, borderLeft: `${bw}px solid ${color}`, borderBottomLeftRadius: 3 }} />
      <span style={{ ...base, bottom: inset, right: inset, borderBottom: `${bw}px solid ${color}`, borderRight: `${bw}px solid ${color}`, borderBottomRightRadius: 3 }} />
    </>
  );
}

// Renders a countdown/clock string with softly blinking colons.
function BlinkColons({ text }) {
  const parts = String(text).split(":");
  return parts.map((p, i) => (
    <React.Fragment key={i}>
      {p}
      {i < parts.length - 1 && <span className="blink">:</span>}
    </React.Fragment>
  ));
}

// Shimmering skeleton placeholders for loading states.
function Skeleton({ h = 12, w = "100%", style }) {
  return <div className="skeleton" style={{ height: h, width: w, ...style }} />;
}

function ChartSkeleton() {
  const hs = [40, 65, 50, 80, 60, 90, 55, 72, 45, 85, 62, 52];
  return (
    <div style={{ height: "100%", display: "flex", alignItems: "flex-end", gap: 6, padding: "6px 2px" }}>
      {hs.map((h, i) => <div key={i} className="skeleton" style={{ flex: 1, height: `${h}%`, borderRadius: "4px 4px 0 0" }} />)}
    </div>
  );
}

function RowSkeleton({ rows = 4 }) {
  return (
    <div style={{ padding: "6px 0" }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 4px" }}>
          <div className="skeleton" style={{ width: 34, height: 34, borderRadius: 99, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <Skeleton h={11} w={`${55 + (i % 3) * 12}%`} style={{ marginBottom: 6 }} />
            <Skeleton h={9} w={`${30 + (i % 2) * 10}%`} />
          </div>
        </div>
      ))}
    </div>
  );
}

function StatTile({ label, value, icon, sub }) {
  return (
    <div className="panel" style={{ padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-dim)" }}>
        {icon}
        <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</span>
      </div>
      <div className="mono" style={{ fontSize: 19, fontWeight: 700, marginTop: 6, color: "var(--text-primary)" }}>{value}</div>
      {sub && <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function LaunchRow({ l, now, onSelect }) {
  const clickable = typeof onSelect === "function";
  return (
    <div
      onClick={clickable ? () => onSelect(l) : undefined}
      style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 4px", borderBottom: "1px solid var(--hairline)", cursor: clickable ? "pointer" : "default" }}
    >
      <LaunchGlyph l={l} size={34} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {l.mission}
        </div>
        <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
          {l.rocket} · {formatDate(l.net)}
        </div>
      </div>
      <StatusPill kind={l.statusKind} label={l.statusLabel} />
      {clickable && <ChevronRight size={16} style={{ color: "var(--text-dim)", flexShrink: 0 }} />}
    </div>
  );
}

function LaunchDetailSheet({ launch, now, onClose }) {
  if (!launch) return null;
  const isFuture = new Date(launch.net) > now;
  const kind = classifyLaunch(launch);
  const rows = [
    ["Vehicle", launch.rocket],
    ["Launch pad", launch.pad || "—"],
    ["Type", kind === "internal" ? "Internal (SpaceX payload)" : "Customer (billed)"],
    ["Orbit", launch.orbit || "—"],
    ["Status", launch.statusLabel],
  ];
  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--ink)", zIndex: 20, display: "flex", flexDirection: "column" }}>
      {/* This sheet covers the whole screen, including the status bar area,
          so it needs its own top inset — otherwise the back button sits
          under the clock and is hard to tap. env() is 0 where there's no
          notch, so this is safe on every device. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "calc(16px + env(safe-area-inset-top)) 18px 10px", borderBottom: "1px solid var(--hairline)", flexShrink: 0 }}>
        <button onClick={onClose} aria-label="Back" style={{ background: "none", border: "none", color: "var(--text-primary)", cursor: "pointer", display: "flex", alignItems: "center", padding: 6, margin: -6 }}>
          <ChevronLeft size={22} />
        </button>
        <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.01em" }}>Launch detail</div>
      </div>

      <div className="perigee-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch", padding: "16px 16px calc(16px + env(safe-area-inset-bottom))" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <LaunchGlyph l={launch} size={52} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 19, fontWeight: 700, color: "var(--text-primary)" }}>{launch.mission}</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>{formatDate(launch.net)}</div>
          </div>
        </div>

        <div className="panel" style={{ padding: 16, marginTop: 14, textAlign: "center" }}>
          <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", letterSpacing: "0.08em" }}>{isFuture ? "T-MINUS" : "STATUS"}</div>
          <div className="mono" style={{ fontSize: 26, fontWeight: 700, color: isFuture ? "var(--blue)" : "var(--ok)", marginTop: 4, textShadow: isFuture ? "0 0 20px rgba(79,142,247,0.45)" : "none" }}>
            {isFuture ? <BlinkColons text={formatCountdown(launch.net, now)} /> : "Completed"}
          </div>
        </div>

        <div className="panel" style={{ padding: "4px 14px", marginTop: 12 }}>
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "11px 0", borderBottom: "1px solid var(--hairline)" }}>
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{k}</span>
              <span className="mono" style={{ fontSize: 12, color: "var(--text-primary)", textAlign: "right" }}>{v}</span>
            </div>
          ))}
        </div>

        <a href="https://www.spacex.com/launches/" target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
          <div style={{ marginTop: 14, padding: "13px 0", borderRadius: 12, border: "1px solid var(--hairline)", textAlign: "center", color: "var(--blue)", fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            Watch / details on spacex.com <ExternalLink size={14} />
          </div>
        </a>
      </div>
    </div>
  );
}

// Approx pad coordinates for the launch-weather forecast.
const PAD_COORDS = {
  "Vandenberg": [34.63, -120.61],
  "Kennedy LC-39A": [28.61, -80.60],
  "Cape Canaveral": [28.56, -80.58],
  "Starbase": [25.99, -97.15],
};

// WMO weather code → short label + icon.
function wmoInfo(code) {
  if (code === 0) return { label: "Clear", Icon: Sun };
  if (code <= 2) return { label: "Partly cloudy", Icon: CloudSun };
  if (code === 3) return { label: "Overcast", Icon: Cloud };
  if (code <= 48) return { label: "Fog", Icon: CloudFog };
  if (code <= 67) return { label: "Rain", Icon: CloudRain };
  if (code <= 77) return { label: "Snow", Icon: CloudSnow };
  if (code <= 82) return { label: "Showers", Icon: CloudRain };
  if (code <= 86) return { label: "Snow showers", Icon: CloudSnow };
  if (code >= 95) return { label: "Thunderstorm", Icon: CloudLightning };
  return { label: "—", Icon: Cloud };
}

// Surface-weather forecast for the pad at launch time, via Open-Meteo (free,
// no key). Blocked in the preview sandbox → graceful fallback; works in a
// deployed/local build. Only meaningful within the ~16-day forecast horizon.
function WeatherChip({ launch }) {
  const [state, setState] = useState({ status: "loading" });
  const site = launchSite(launch);
  const coords = PAD_COORDS[site];
  const net = launch.net;
  const lat = coords ? coords[0] : null;
  const lon = coords ? coords[1] : null;

  useEffect(() => {
    if (lat == null || !net) { setState({ status: "none" }); return; }
    const target = new Date(net);
    const horizonDays = (target - Date.now()) / 86400000;
    if (horizonDays > 16) { setState({ status: "toofar" }); return; }
    if (horizonDays < -0.25) { setState({ status: "none" }); return; }
    let alive = true;
    setState({ status: "loading" });
    (async () => {
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,weather_code,wind_speed_10m,precipitation_probability&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=UTC&forecast_days=16`;
        const res = await fetch(url);
        if (!res.ok) throw new Error("weather");
        const j = await res.json();
        const times = j.hourly.time;
        const tIso = target.toISOString().slice(0, 13);
        let idx = times.findIndex((t) => t.slice(0, 13) === tIso);
        if (idx < 0) {
          let best = 0, bd = Infinity;
          for (let i = 0; i < times.length; i++) {
            const d = Math.abs(new Date(times[i] + ":00Z") - target);
            if (d < bd) { bd = d; best = i; }
          }
          idx = best;
        }
        if (!alive) return;
        setState({
          status: "ok",
          temp: Math.round(j.hourly.temperature_2m[idx]),
          code: j.hourly.weather_code[idx],
          wind: Math.round(j.hourly.wind_speed_10m[idx]),
          precip: j.hourly.precipitation_probability[idx],
        });
      } catch (e) {
        if (alive) setState({ status: "error" });
      }
    })();
    return () => { alive = false; };
  }, [lat, lon, net]);

  if (state.status === "none") return null;

  let content;
  if (state.status === "loading") {
    content = <Skeleton h={11} w={150} />;
  } else if (state.status === "toofar") {
    content = <span>Forecast available closer to launch</span>;
  } else if (state.status === "error") {
    content = <span>Forecast unavailable here (live build only)</span>;
  } else {
    const { Icon, label } = wmoInfo(state.code);
    content = (
      <>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--text-primary)" }}>
          <Icon size={13} /> {state.temp}°F · {label}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><Wind size={11} /> {state.wind} mph</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><Droplets size={11} /> {state.precip ?? 0}%</span>
      </>
    );
  }

  return (
    <div className="mono" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 10.5, color: "var(--text-dim)", marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--hairline)" }}>
      <span style={{ letterSpacing: "0.06em" }}>PAD WX</span>
      {content}
    </div>
  );
}

function NextLaunchCard({ launch, now }) {
  if (!launch) {
    return <div className="panel" style={{ padding: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>No confirmed upcoming launch in feed.</div>;
  }
  return (
    <div className="panel" style={{ padding: 18, position: "relative" }}>
      <HudCorners />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.08em", color: "var(--text-dim)" }}>NEXT LAUNCH</div>
        <a
          href="https://www.spacex.com/launches/"
          target="_blank"
          rel="noopener noreferrer"
          style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}
          title="View on spacex.com"
        >
          <StatusPill kind={launch.statusKind} label={launch.statusLabel} />
        </a>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 10 }}>
        <LaunchGlyph l={launch} size={50} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>{launch.mission}</div>
          <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)" }}>{launch.rocket} · {launch.pad}</div>
        </div>
      </div>
      <div className="mono" style={{ fontSize: 28, fontWeight: 700, letterSpacing: "0.01em", marginTop: 16, color: "var(--blue)", textShadow: "0 0 20px rgba(79,142,247,0.45)" }}>
        <BlinkColons text={formatCountdown(launch.net, now)} />
      </div>
      <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{formatDate(launch.net)}</div>
      <WeatherChip launch={launch} />
    </div>
  );
}

/* ---------------------------------------------------------------- */
/*  Tabs                                                             */
/* ---------------------------------------------------------------- */

// Resolve our CSS-var colors to hex so SVG gradient stops render reliably.
const COLOR_HEX = { "var(--blue)": "#4F8EF7", "var(--amber)": "#FF9F40", "var(--ok)": "#3ED598", "var(--bad)": "#FF5C5C", "var(--brand)": "#AEB8F2" };
const colorHex = (c) => COLOR_HEX[c] || c;
const gradId = (c) => "pgbar" + colorHex(c).replace(/[^a-zA-Z0-9]/g, "");

function LaunchCadenceChart({ history, upcoming, now }) {
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  const [mode, setMode] = useState("monthly"); // 'monthly' | 'yearly'
  const [groupBy, setGroupBy] = useState("type"); // 'type' | 'site'
  const [selectedYear, setSelectedYear] = useState(currentYear);

  // Past history + scheduled upcoming. Starship is excluded — it has its own
  // view — so this is the Falcon cadence, consistent across every grouping.
  const allLaunches = useMemo(
    () => [...history.launches, ...upcoming].filter((l) => launchVehicle(l) !== "Starship"),
    [history.launches, upcoming]
  );

  // Which years the live data actually covers (drives the year navigator).
  const { minYear, maxYear } = useMemo(() => {
    const years = allLaunches
      .map((l) => new Date(l.net).getUTCFullYear())
      .filter((y) => !isNaN(y));
    if (!years.length) return { minYear: currentYear, maxYear: currentYear };
    return { minYear: Math.min(...years), maxYear: Math.max(currentYear, ...years) };
  }, [allLaunches, currentYear]);

  // Keep the selected year within the range the data supports.
  useEffect(() => {
    setSelectedYear((y) => Math.min(maxYear, Math.max(minYear, y)));
  }, [minYear, maxYear]);

  const upToMonth = selectedYear === currentYear ? currentMonth : 12;
  const monthlyData = useMemo(
    () => buildMonthsForYear(allLaunches, selectedYear, upToMonth),
    [allLaunches, selectedYear, upToMonth]
  );
  const monthlyDataSite = useMemo(
    () => buildMonthsForYearBySite(allLaunches, selectedYear, upToMonth),
    [allLaunches, selectedYear, upToMonth]
  );
  const monthlyDataVehicle = useMemo(
    () => buildMonthsForYearByVehicle(allLaunches, selectedYear, upToMonth),
    [allLaunches, selectedYear, upToMonth]
  );
  const loading = history.status === "loading";
  const canGoEarlier = selectedYear > minYear;
  const canGoLater = selectedYear < maxYear;

  // Site- and vehicle-level data only exist per-launch (the live/monthly
  // window); the all-time yearly view is curated type totals only, so those
  // groupings apply to the monthly view and yearly always falls back to type.
  const effectiveGroup = mode === "monthly" ? groupBy : "type";
  const bars = effectiveGroup === "site"
    ? LAUNCH_SITES.map((s) => ({ key: s.key, name: s.key, color: s.color }))
    : effectiveGroup === "vehicle"
      ? LAUNCH_VEHICLES.map((v) => ({ key: v.key, name: v.key, color: v.color }))
      : [{ key: "internal", name: "Internal", color: "var(--blue)" }, { key: "customer", name: "Customer", color: "var(--amber)" }];
  const chartData = mode === "yearly"
    ? YEARLY_LAUNCH_DATA
    : effectiveGroup === "site" ? monthlyDataSite
      : effectiveGroup === "vehicle" ? monthlyDataVehicle
        : monthlyData;
  const chartIsEmpty = !chartData.length || chartData.every((d) => bars.reduce((sum, b) => sum + (d[b.key] || 0), 0) === 0);

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {["monthly", "yearly"].map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              flex: 1, padding: "8px 0", borderRadius: 10, border: "1px solid var(--hairline)",
              background: mode === m ? "rgba(79,142,247,0.14)" : "transparent",
              color: mode === m ? "var(--blue)" : "var(--text-dim)",
              fontSize: 12, fontWeight: 700, cursor: "pointer",
            }}
          >
            {m === "monthly" ? "Monthly" : "Yearly · all-time"}
          </button>
        ))}
      </div>

      {mode === "monthly" && (
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {[["type", "Type"], ["site", "Site"], ["vehicle", "Vehicle"]].map(([g, label]) => (
            <button
              key={g}
              onClick={() => setGroupBy(g)}
              style={{
                flex: 1, padding: "7px 0", borderRadius: 10, border: "1px solid var(--hairline)",
                background: groupBy === g ? "rgba(174,184,242,0.14)" : "transparent",
                color: groupBy === g ? "var(--brand)" : "var(--text-dim)",
                fontSize: 12, fontWeight: 700, cursor: "pointer",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {mode === "monthly" && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14, marginBottom: 8 }}>
          <button
            onClick={() => canGoEarlier && setSelectedYear((y) => y - 1)}
            disabled={!canGoEarlier}
            aria-label="Previous year"
            style={{ background: "none", border: "none", color: canGoEarlier ? "var(--text-primary)" : "var(--hairline)", cursor: canGoEarlier ? "pointer" : "default", padding: 4 }}
          >
            <ChevronLeft size={18} />
          </button>
          <span className="mono" style={{ fontSize: 15, fontWeight: 700, minWidth: 48, textAlign: "center" }}>{selectedYear}</span>
          <button
            onClick={() => canGoLater && setSelectedYear((y) => y + 1)}
            disabled={!canGoLater}
            aria-label="Next year"
            style={{ background: "none", border: "none", color: canGoLater ? "var(--text-primary)" : "var(--hairline)", cursor: canGoLater ? "pointer" : "default", padding: 4 }}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      )}

      <div className="panel" style={{ padding: 12, height: 190 }}>
        {loading && chartIsEmpty ? (
          <ChartSkeleton />
        ) : chartIsEmpty ? (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13, textAlign: "center", padding: "0 12px" }}>
            {mode === "monthly" ? `No launch data for ${selectedYear} in the live window.` : "No site-level history in the live window."}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
              <defs>
                {[...new Set(bars.map((b) => colorHex(b.color)))].map((hex) => (
                  <linearGradient key={hex} id={gradId(hex)} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor={hex} stopOpacity="0.95" />
                    <stop offset="1" stopColor={hex} stopOpacity="0.45" />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid stroke="var(--hairline)" vertical={false} />
              <XAxis dataKey="label" stroke="var(--text-dim)" fontSize={mode === "yearly" ? 9 : 11} tickLine={false} axisLine={false} interval={mode === "yearly" ? 0 : undefined} />
              <YAxis hide allowDecimals={false} />
              <Tooltip contentStyle={{ background: "var(--panel)", border: "1px solid var(--hairline)", borderRadius: 8, fontSize: 12 }} labelStyle={{ color: "var(--text-dim)" }} cursor={{ fill: "rgba(255,255,255,0.03)" }} />
              {bars.map((b, i) => (
                <Bar key={b.key} dataKey={b.key} name={b.name} stackId="launches" fill={`url(#${gradId(b.color)})`} radius={i === bars.length - 1 ? [4, 4, 0, 0] : undefined} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap", marginTop: 8 }}>
        {bars.map((b) => (
          <span key={b.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-dim)" }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, background: b.color, display: "inline-block" }} />
            {effectiveGroup === "type" && b.key === "internal" ? "Internal (Starlink + other)" : b.name}
          </span>
        ))}
      </div>

      <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 6, lineHeight: 1.5 }}>
        {effectiveGroup === "site"
          ? (history.status === "sample"
              ? `By launch site · ${selectedYear} · sample data; live feed unavailable.`
              : `By launch site · ${selectedYear}. Page years with the arrows above; Cape Canaveral, Kennedy LC-39A, Vandenberg, Starbase.`)
          : effectiveGroup === "vehicle"
            ? (history.status === "sample"
                ? `By launch vehicle · ${selectedYear} · sample data; Starship test flights included.`
                : `By launch vehicle · ${selectedYear}. Falcon 9 vs Falcon Heavy; page years with the arrows.`)
            : mode === "yearly"
              ? "All-time yearly totals by type (curated): 2024 verified · 2025 extrapolated · others estimated · pre-2019 all customer. Use Monthly for the per-site or per-vehicle split."
              : history.status === "sample"
                ? "Live feed unavailable — showing sample data."
                : `Live Falcon monthly counts, ${minYear}–present. Starlink = Internal, all else = Customer (incl. Starshield, billed to NRO). Starship is on its own view.`}
      </div>
    </div>
  );
}

function BoosterTracker({ onOpen, refreshKey }) {
  const [stats, setStats] = useState(null);
  const [status, setStatus] = useState("loading"); // 'loading' | 'live' | 'snapshot'

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const boosters = await fetchOperationalBoosters();
        const flightsArr = boosters.map((b) => b.flights);
        const maxFlights = Math.max(...flightsArr);
        const recordBooster = boosters.find((b) => b.flights === maxFlights);

        // Fastest turnaround: real per-booster record from the API.
        const withFt = boosters.filter((b) => b.fastestTurnaroundDays != null);
        const fastest = withFt.length
          ? withFt.reduce((m, b) => (b.fastestTurnaroundDays < m.fastestTurnaroundDays ? b : m))
          : null;

        // Median turnaround: each booster's average cadence (span ÷ reuses).
        const cadence = boosters
          .filter((b) => b.flights > 1 && b.firstFlight && b.lastFlight)
          .map((b) => ((new Date(b.lastFlight) - new Date(b.firstFlight)) / 86400000) / (b.flights - 1))
          .filter((d) => isFinite(d) && d > 0);

        if (!alive) return;
        setStats({
          recordSerial: recordBooster.serial,
          recordFlights: maxFlights,
          operationalCount: boosters.length,
          medianFlights: Math.round(median(flightsArr)),
          fastestSerial: fastest ? fastest.serial : null,
          fastestTurnaroundDays: fastest ? Math.round(fastest.fastestTurnaroundDays) : null,
          medianTurnaroundDays: cadence.length ? Math.round(median(cadence)) : null,
        });
        setStatus("live");
      } catch (e) {
        if (!alive) return;
        setStats(BOOSTER_SNAPSHOT);
        setStatus("snapshot");
      }
    })();
    return () => { alive = false; };
  }, [refreshKey]);

  if (status === "loading" || !stats) {
    return (
      <div className="panel" style={{ padding: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} style={{ padding: 12, border: "1px solid var(--hairline)", borderRadius: 12 }}>
              <Skeleton h={9} w="60%" style={{ marginBottom: 8 }} />
              <Skeleton h={18} w="45%" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={() => onOpen && onOpen()}
        style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", padding: 0, cursor: "pointer" }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <StatTile label="Most flights (1 booster)" value={`${stats.recordFlights}× · ${stats.recordSerial}`} icon={<Award size={15} />} />
          <StatTile label="Operational boosters" value={stats.operationalCount} icon={<Layers size={15} />} />
          <StatTile label="Median flights (op.)" value={`${stats.medianFlights}×`} icon={<Repeat size={15} />} />
          <StatTile
            label="Fastest avg turnaround"
            value={stats.fastestTurnaroundDays != null ? `${stats.fastestTurnaroundDays}d${stats.fastestSerial ? ` · ${stats.fastestSerial}` : ""}` : "—"}
            icon={<Timer size={15} />}
          />
          <StatTile label="Median turnaround (op.)" value={stats.medianTurnaroundDays != null ? `${stats.medianTurnaroundDays}d` : "—"} icon={<Timer size={15} />} />
          <div className="panel" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 4, borderStyle: "dashed" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--blue)", fontSize: 13, fontWeight: 700 }}>
              View fleet <ChevronRight size={15} />
            </span>
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>all {status === "live" ? stats.operationalCount : ""} boosters</span>
          </div>
        </div>
      </button>
      <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 8, lineHeight: 1.5 }}>
        {status === "snapshot"
          ? `Snapshot via Wikipedia · as of ${formatDateOnly(BOOSTER_SNAPSHOT.asOf)}. `
          : "Live from Launch Library 2. "}
        Operational = active Falcon boosters (Wikipedia's "presumed active" fleet). Fastest = best single turnaround on record; median = typical cadence (span ÷ reuses).
      </div>
    </div>
  );
}

function BoosterListSheet({ open, onClose }) {
  const [boosters, setBoosters] = useState(null);
  const [status, setStatus] = useState("loading"); // 'loading' | 'live' | 'error'

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setStatus("loading");
    (async () => {
      try {
        const list = await fetchOperationalBoosters();
        if (!alive) return;
        setBoosters(list);
        setStatus("live");
      } catch (e) {
        if (!alive) return;
        setBoosters(null);
        setStatus("error");
      }
    })();
    return () => { alive = false; };
  }, [open]);

  if (!open) return null;

  const fmt = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { year: "2-digit", month: "short", day: "numeric", timeZone: "UTC" });
  };

  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--ink)", zIndex: 20, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "calc(16px + env(safe-area-inset-top)) 18px 10px", borderBottom: "1px solid var(--hairline)", flexShrink: 0 }}>
        <button onClick={onClose} aria-label="Back" style={{ background: "none", border: "none", color: "var(--text-primary)", cursor: "pointer", display: "flex", alignItems: "center", padding: 6, margin: -6 }}>
          <ChevronLeft size={22} />
        </button>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.01em" }}>Operational boosters</div>
          <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 1 }}>
            {status === "live" && boosters ? `${boosters.length} active · presumed-active fleet` : "Falcon fleet"}
          </div>
        </div>
      </div>

      <div className="perigee-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch", padding: "8px 16px calc(18px + env(safe-area-inset-bottom))" }}>
        {status === "loading" && <RowSkeleton rows={6} />}
        {status === "error" && (
          <div style={{ padding: "20px 6px", color: "var(--text-dim)", fontSize: 13, lineHeight: 1.6 }}>
            <div style={{ color: "var(--text-primary)", fontWeight: 600, marginBottom: 8 }}>Live booster feed unavailable here</div>
            This preview can't reach the Launch Library 2 launcher database (the sandbox blocks the external request). The per-booster list streams in once the app runs in a normal environment.
            <div className="panel" style={{ padding: 14, marginTop: 14 }}>
              <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 10 }}>KNOWN AS OF {formatDateOnly(BOOSTER_SNAPSHOT.asOf)}</div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", color: "var(--text-primary)" }}>
                <span>Fleet leader</span><span className="mono">{BOOSTER_SNAPSHOT.recordSerial} · {BOOSTER_SNAPSHOT.recordFlights} flights</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", color: "var(--text-primary)" }}>
                <span>Operational boosters</span><span className="mono">~{BOOSTER_SNAPSHOT.operationalCount}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", color: "var(--text-primary)" }}>
                <span>Median flights</span><span className="mono">{BOOSTER_SNAPSHOT.medianFlights}×</span>
              </div>
            </div>
            <div className="mono" style={{ fontSize: 10, marginTop: 10 }}>Source: Wikipedia "List of Falcon 9 first-stage boosters."</div>
          </div>
        )}
        {status === "live" && boosters && (
          <>
            <div style={{ display: "flex", padding: "6px 12px", color: "var(--text-dim)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              <span style={{ width: 64 }}>Booster</span>
              <span style={{ flex: 1, textAlign: "center" }}>First</span>
              <span style={{ flex: 1, textAlign: "center" }}>Last</span>
              <span style={{ width: 56, textAlign: "right" }}>Reuses</span>
            </div>
            <div className="panel" style={{ padding: "2px 12px" }}>
              {boosters.map((b) => (
                <div key={b.serial} style={{ display: "flex", alignItems: "center", padding: "11px 0", borderBottom: "1px solid var(--hairline)" }}>
                  <span className="mono" style={{ width: 64, fontWeight: 700, fontSize: 13, color: "var(--text-primary)" }}>{b.serial}</span>
                  <span className="mono" style={{ flex: 1, textAlign: "center", fontSize: 11, color: "var(--text-dim)" }}>{fmt(b.firstFlight)}</span>
                  <span className="mono" style={{ flex: 1, textAlign: "center", fontSize: 11, color: "var(--text-dim)" }}>{fmt(b.lastFlight)}</span>
                  <span className="mono" style={{ width: 56, textAlign: "right", fontSize: 13, fontWeight: 700, color: "var(--blue)" }}>{b.reuses}</span>
                </div>
              ))}
            </div>
            <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 10, lineHeight: 1.5 }}>
              Live from Launch Library 2. Reuses = flights − 1. List scoped to active Falcon boosters (Wikipedia's "presumed active" fleet); retired, expended, and lost boosters excluded.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Rows shown before the "show all" toggle, for both the upcoming and past
// lists. The live feed can return 30+ upcoming and 165+ past launches, which
// buries everything below them.
const LIST_LIMIT = 10;

function LaunchesTab({ upcoming, past, now, source, onOpenBoosters, onSelectLaunch, alertsOn, onToggleAlerts, refreshKey, historyVersion }) {
  const [liveHistory, setLiveHistory] = useState(null); // deep history, once loaded
  const [pastExpanded, setPastExpanded] = useState(false);
  const [upcomingExpanded, setUpcomingExpanded] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      // 1. The daily pipeline's history is the good path: full depth back to
      //    2014, and zero API calls from the phone.
      if (PUBLISHED_HISTORY && PUBLISHED_HISTORY.length) {
        if (alive) setLiveHistory(PUBLISHED_HISTORY);
        return;
      }

      // 2. Otherwise reuse a recent client pull if one is cached.
      const cached = readHistoryCache();
      if (cached) {
        if (alive) setLiveHistory(cached);
        return;
      }

      // 3. Last resort: page the API from here. Production holds the full
      //    record but throttles hard (~15 requests/hour), so cache what we
      //    get; the dev API carries only ~1 year but is far more forgiving.
      try {
        const all = await fetchLaunchHistory(7, LL2_DEEP_BASE);
        if (!alive) return;
        if (all.length) {
          setLiveHistory(all);
          writeHistoryCache(all);
        }
      } catch (e) {
        try {
          const fallback = await fetchLaunchHistory(3, LL2_BASE);
          if (alive && fallback.length) setLiveHistory(fallback);
        } catch (e2) { /* fall back to the feed below */ }
      }
    })();
    return () => { alive = false; };
  }, [refreshKey, historyVersion]);

  // Effective history: prefer the deep live pull; otherwise use whatever the
  // main feed already carries (sample or live "previous"), which updates
  // reactively — so we never freeze an empty array from first render.
  // Effective history: the deep pull is cached for a day, so merge the fresh
  // feed over the top — otherwise a launch that flew this morning wouldn't
  // show until the cache expired. Dedupe by id, newest first.
  const history = useMemo(() => {
    if (liveHistory && liveHistory.length) {
      const seen = new Set();
      const merged = [...past, ...liveHistory].filter((l) => {
        const k = l.id || `${l.mission}-${l.net}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      return { launches: merged, status: source === "sample" ? "sample" : "live" };
    }
    if (past.length) return { launches: past, status: source === "sample" ? "sample" : "live" };
    return { launches: [], status: "loading" };
  }, [liveHistory, past, source]);

  // Reclassify by the clock: only launches still in the future count as
  // "upcoming." Anything whose liftoff time has passed is complete and moves
  // to past — this is what bumps a just-flown mission (e.g. Starlink 17-40)
  // out of the next-launch slot the moment its window passes.
  const upcomingFuture = useMemo(
    () => upcoming.filter((l) => new Date(l.net) > now).sort((a, b) => new Date(a.net) - new Date(b.net)),
    [upcoming, now]
  );
  const stalePast = useMemo(() => upcoming.filter((l) => new Date(l.net) <= now), [upcoming, now]);

  // Past launches, newest first, de-duped, spanning the last ~2 years.
  const twoYearsAgo = useMemo(() => {
    const d = new Date(now);
    d.setUTCFullYear(d.getUTCFullYear() - 2);
    return d;
  }, [now]);
  const pastAll = useMemo(() => {
    const seen = new Set();
    return [...stalePast, ...history.launches]
      .filter((l) => l.net && new Date(l.net) <= now && new Date(l.net) >= twoYearsAgo)
      .filter((l) => { const k = l.id || `${l.mission}-${l.net}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => new Date(b.net) - new Date(a.net))
      .map((l) => settleStatus(l, now));
  }, [stalePast, history.launches, now, twoYearsAgo]);

  // The next launch gets its own card above, so the list starts at index 1.
  const upcomingRest = upcomingFuture.slice(1);
  const upcomingVisible = upcomingExpanded ? upcomingRest : upcomingRest.slice(0, LIST_LIMIT);
  const pastVisible = pastExpanded ? pastAll : pastAll.slice(0, LIST_LIMIT);

  return (
    <div>
      <NextLaunchCard launch={upcomingFuture[0]} now={now} />

      <button
        onClick={onToggleAlerts}
        style={{ width: "100%", marginTop: 10, padding: "11px 14px", borderRadius: 12, border: `1px solid ${alertsOn ? "rgba(79,142,247,0.4)" : "var(--hairline)"}`, background: alertsOn ? "rgba(79,142,247,0.08)" : "transparent", color: alertsOn ? "var(--blue)" : "var(--text-dim)", fontSize: 12.5, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
      >
        {alertsOn ? <Bell size={15} /> : <BellOff size={15} />}
        {alertsOn ? "Launch alerts on · you'll be notified at T-1 hour" : "Notify me at T-1 hour before launch"}
      </button>

      <SectionLabel>Falcon launches by month / year</SectionLabel>
      <LaunchCadenceChart history={history} upcoming={upcomingFuture} now={now} />

      <SectionLabel>Falcon 9 booster fleet</SectionLabel>
      <BoosterTracker onOpen={onOpenBoosters} refreshKey={refreshKey} />

      <SectionLabel>Upcoming{upcomingRest.length ? ` (${upcomingRest.length})` : ""}</SectionLabel>
      <div className="panel" style={{ padding: "4px 12px" }}>
        {upcomingVisible.map((l) => <LaunchRow key={l.id} l={l} now={now} onSelect={onSelectLaunch} />)}
        {upcomingFuture.length <= 1 && <div style={{ padding: "12px 4px", color: "var(--text-dim)", fontSize: 13 }}>No further launches in feed.</div>}
      </div>
      {upcomingRest.length > LIST_LIMIT && (
        <button
          onClick={() => setUpcomingExpanded((v) => !v)}
          style={{ width: "100%", marginTop: 8, padding: "10px 0", borderRadius: 10, border: "1px solid var(--hairline)", background: "transparent", color: "var(--blue)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
        >
          {upcomingExpanded ? "Show less" : `Show all ${upcomingRest.length} upcoming`}
        </button>
      )}

      <SectionLabel>Past{pastAll.length ? ` · last 2 yr (${pastAll.length})` : ""}</SectionLabel>
      <div className="panel" style={{ padding: "4px 12px" }}>
        {history.status === "loading" && pastAll.length === 0 && <RowSkeleton rows={5} />}
        {pastVisible.map((l) => <LaunchRow key={l.id} l={l} now={now} onSelect={onSelectLaunch} />)}
        {pastAll.length === 0 && history.status !== "loading" && (
          <div style={{ padding: "12px 4px", color: "var(--text-dim)", fontSize: 13 }}>No past launches in feed.</div>
        )}
      </div>
      {pastAll.length > LIST_LIMIT && (
        <button
          onClick={() => setPastExpanded((v) => !v)}
          style={{ width: "100%", marginTop: 8, padding: "10px 0", borderRadius: 10, border: "1px solid var(--hairline)", background: "transparent", color: "var(--blue)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
        >
          {pastExpanded ? "Show less" : `Show all ${pastAll.length} launches`}
        </button>
      )}
      {history.status === "sample" && (
        <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 8, lineHeight: 1.5 }}>
          Showing sample history; the full live 2-year record loads outside the preview sandbox.
        </div>
      )}
    </div>
  );
}

function ConstellationSplitBar({ broadband, dtc, breakdown }) {
  const [open, setOpen] = useState(false);
  const total = broadband + dtc;
  const bbPct = total ? (broadband / total) * 100 : 0;
  const dtcPct = total ? (dtc / total) * 100 : 0;
  const hasBreakdown = Array.isArray(breakdown) && breakdown.length > 0;
  const bbTotal = hasBreakdown ? breakdown.reduce((s, v) => s + v.value, 0) : broadband;
  const toggle = () => hasBreakdown && setOpen((o) => !o);

  return (
    <div>
      <div style={{ display: "flex", height: 10, borderRadius: 6, overflow: "hidden", background: "var(--hairline)" }}>
        <div
          onClick={toggle}
          title={hasBreakdown ? "Tap for version mix" : undefined}
          style={{ width: `${bbPct}%`, background: "var(--blue)", cursor: hasBreakdown ? "pointer" : "default" }}
        />
        <div style={{ width: `${dtcPct}%`, background: "var(--amber)" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, flexWrap: "wrap", gap: 8 }}>
        <button
          onClick={toggle}
          style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-dim)", background: "none", border: "none", padding: 0, cursor: hasBreakdown ? "pointer" : "default" }}
        >
          <span style={{ width: 8, height: 8, borderRadius: 99, background: "var(--blue)", display: "inline-block" }} />
          Broadband ·{" "}
          <span className="mono" style={{ color: "var(--text-primary)" }}>{broadband.toLocaleString()}</span>
          {" "}({bbPct.toFixed(0)}%)
          {hasBreakdown && <ChevronDown size={13} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />}
        </button>
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-dim)" }}>
          <span style={{ width: 8, height: 8, borderRadius: 99, background: "var(--amber)", display: "inline-block" }} />
          Direct-to-Cell ·{" "}
          <span className="mono" style={{ color: "var(--text-primary)" }}>{dtc.toLocaleString()}</span>
          {" "}({dtcPct.toFixed(0)}%)
        </span>
      </div>

      {open && hasBreakdown && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--hairline)" }}>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Broadband by version
          </div>
          <div style={{ display: "flex", height: 10, borderRadius: 6, overflow: "hidden", background: "var(--hairline)" }}>
            {breakdown.map((v) => (
              <div key={v.label} style={{ width: `${(v.value / bbTotal) * 100}%`, background: v.color }} title={`${v.label}: ${v.value.toLocaleString()}`} />
            ))}
          </div>
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 7 }}>
            {breakdown.map((v) => (
              <div key={v.label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-dim)" }}>
                <span style={{ width: 8, height: 8, borderRadius: 99, background: v.color, display: "inline-block", flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{v.label}</span>
                <span className="mono" style={{ color: "var(--text-primary)" }}>{v.value.toLocaleString()}</span>
                <span className="mono" style={{ width: 44, textAlign: "right" }}>{((v.value / bbTotal) * 100).toFixed(0)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StarlinkTab({ past, now }) {
  const starlinkLaunches = past.filter((l) => /starlink/i.test(l.mission)).slice(0, 6);
  const c = SATELLITE_CENSUS;
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <StatTile label="Working in orbit" value={c.totalWorking.toLocaleString()} icon={<Satellite size={15} />} />
        <StatTile label="Broadband sats" value={c.broadbandWorking.toLocaleString()} icon={<Wifi size={15} />} />
        <StatTile label="Direct-to-cell sats" value={c.dtcWorking.toLocaleString()} icon={<Radio size={15} />} />
        <StatTile label="Total ever launched" value={c.totalLaunchedEver.toLocaleString()} icon={<Rocket size={15} />} />
        <StatTile label="Active subscribers" value="12M+" icon={<Users size={15} />} />
        <StatTile label="Countries served" value="160+" icon={<MapPin size={15} />} />
      </div>

      <SectionLabel>Constellation split</SectionLabel>
      <div className="panel" style={{ padding: 16 }}>
        <ConstellationSplitBar broadband={c.broadbandWorking} dtc={c.dtcWorking} breakdown={c.broadbandByVersion} />
        <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 12 }}>
          Snapshot via {c.source} · as of {formatDateOnly(c.asOf)} · tap broadband for version mix
        </div>
      </div>

      <SectionLabel>Constellation growth (approx.)</SectionLabel>
      <div className="panel" style={{ padding: 12, height: 170 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={SAT_GROWTH}>
            <defs>
              <linearGradient id="satFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--blue)" stopOpacity={0.5} />
                <stop offset="100%" stopColor="var(--blue)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--hairline)" vertical={false} />
            <XAxis dataKey="year" stroke="var(--text-dim)" fontSize={11} tickLine={false} axisLine={false} />
            <YAxis hide />
            <Tooltip contentStyle={{ background: "var(--panel)", border: "1px solid var(--hairline)", borderRadius: 8, fontSize: 12 }} labelStyle={{ color: "var(--text-dim)" }} />
            <Area type="monotone" dataKey="sats" stroke="var(--blue)" fill="url(#satFill)" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <SectionLabel>Recent Starlink launches</SectionLabel>
      <div className="panel" style={{ padding: "4px 12px" }}>
        {starlinkLaunches.length
          ? starlinkLaunches.map((l) => <LaunchRow key={l.id} l={l} now={now} />)
          : <div style={{ padding: "12px 4px", color: "var(--text-dim)", fontSize: 13 }}>No Starlink missions in current feed.</div>}
      </div>

      <SectionLabel>Starshield (separate constellation)</SectionLabel>
      <div className="panel" style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: "rgba(123,132,148,0.12)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Shield size={18} style={{ color: "var(--text-dim)" }} />
          </div>
          <div>
            <div className="mono" style={{ fontSize: 24, fontWeight: 700, color: "var(--text-primary)" }}>
              {STARSHIELD_CENSUS.totalWorking.toLocaleString()}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>satellites working in orbit</div>
          </div>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 12, lineHeight: 1.5 }}>
          Starshield is a separate SpaceX-operated constellation for U.S. national-security customers (including the NRO).
          Not included in the Starlink figures above — tracked here on its own.
        </div>
        <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 10 }}>
          Snapshot via {STARSHIELD_CENSUS.source} · as of {formatDateOnly(STARSHIELD_CENSUS.asOf)}
        </div>
      </div>
    </div>
  );
}

const COUNTRY_CODES = {
  USA: "us", Japan: "jp", Russia: "ru", India: "in", Poland: "pl",
  Hungary: "hu", Malta: "mt", Norway: "no", Germany: "de", Australia: "au",
  France: "fr", Italy: "it", Denmark: "dk", Sweden: "se", Spain: "es",
  UAE: "ae", Israel: "il",
};

function FlagSVG({ code }) {
  const p = { viewBox: "0 0 24 16", width: 24, height: 16, style: { display: "block" }, preserveAspectRatio: "none" };
  switch (code) {
    case "jp":
      return <svg {...p}><rect width="24" height="16" fill="#fff" /><circle cx="12" cy="8" r="4" fill="#bc002d" /></svg>;
    case "ru":
      return <svg {...p}><rect width="24" height="16" fill="#fff" /><rect y="5.33" width="24" height="5.34" fill="#0039a6" /><rect y="10.67" width="24" height="5.33" fill="#d52b1e" /></svg>;
    case "pl":
      return <svg {...p}><rect width="24" height="8" fill="#fff" /><rect y="8" width="24" height="8" fill="#dc143c" /></svg>;
    case "fr":
      return <svg {...p}><rect width="8" height="16" fill="#0055A4" /><rect x="8" width="8" height="16" fill="#fff" /><rect x="16" width="8" height="16" fill="#EF4135" /></svg>;
    case "it":
      return <svg {...p}><rect width="8" height="16" fill="#009246" /><rect x="8" width="8" height="16" fill="#fff" /><rect x="16" width="8" height="16" fill="#ce2b37" /></svg>;
    case "es":
      return <svg {...p}><rect width="24" height="16" fill="#c60b1e" /><rect y="4" width="24" height="8" fill="#ffc400" /></svg>;
    case "dk":
      return <svg {...p}><rect width="24" height="16" fill="#c8102e" /><rect x="7" width="3" height="16" fill="#fff" /><rect y="6.5" width="24" height="3" fill="#fff" /></svg>;
    case "se":
      return <svg {...p}><rect width="24" height="16" fill="#006aa7" /><rect x="7" width="3" height="16" fill="#fecc00" /><rect y="6.5" width="24" height="3" fill="#fecc00" /></svg>;
    case "ae":
      return <svg {...p}><rect width="24" height="16" fill="#fff" /><rect width="24" height="5.33" fill="#00732f" /><rect y="10.67" width="24" height="5.33" fill="#000" /><rect width="6" height="16" fill="#ff0000" /></svg>;
    case "il":
      return <svg {...p}><rect width="24" height="16" fill="#fff" /><rect y="2.5" width="24" height="2" fill="#0038b8" /><rect y="11.5" width="24" height="2" fill="#0038b8" /><g stroke="#0038b8" strokeWidth="0.6" fill="none"><polygon points="12,5 14,9 10,9" /><polygon points="12,11 10,7 14,7" /></g></svg>;
    case "hu":
      return <svg {...p}><rect width="24" height="16" fill="#fff" /><rect width="24" height="5.33" fill="#ce2939" /><rect y="10.67" width="24" height="5.33" fill="#477050" /></svg>;
    case "de":
      return <svg {...p}><rect width="24" height="5.33" fill="#000" /><rect y="5.33" width="24" height="5.34" fill="#dd0000" /><rect y="10.67" width="24" height="5.33" fill="#ffce00" /></svg>;
    case "in":
      return <svg {...p}><rect width="24" height="5.33" fill="#ff9933" /><rect y="5.33" width="24" height="5.34" fill="#fff" /><rect y="10.67" width="24" height="5.33" fill="#138808" /><circle cx="12" cy="8" r="1.6" fill="none" stroke="#000080" strokeWidth="0.5" /></svg>;
    case "no":
      return <svg {...p}><rect width="24" height="16" fill="#ef2b2d" /><rect x="6" width="3" height="16" fill="#fff" /><rect y="6.5" width="24" height="3" fill="#fff" /><rect x="6.75" width="1.5" height="16" fill="#002868" /><rect y="7.25" width="24" height="1.5" fill="#002868" /></svg>;
    case "mt":
      return <svg {...p}><rect width="12" height="16" fill="#fff" /><rect x="12" width="12" height="16" fill="#cf142b" /><g stroke="#aeb0b3" strokeWidth="0.7"><line x1="2" y1="3" x2="5" y2="3" /><line x1="3.5" y1="1.5" x2="3.5" y2="4.5" /></g></svg>;
    case "us":
      return (
        <svg {...p}>
          <rect width="24" height="16" fill="#b22234" />
          {[1, 3, 5, 7, 9, 11].map((i) => <rect key={i} y={i * 1.2308} width="24" height="1.2308" fill="#fff" />)}
          <rect width="9.6" height="8.62" fill="#3c3b6e" />
          {[1.6, 3.4, 5.2, 7, 8.4].map((x, xi) =>
            [1.4, 3, 4.6, 6.2].map((y, yi) => <circle key={`${xi}-${yi}`} cx={x} cy={y} r="0.45" fill="#fff" />)
          )}
        </svg>
      );
    case "au":
      return (
        <svg {...p}>
          <rect width="24" height="16" fill="#00247d" />
          <g>
            <line x1="0" y1="0" x2="12" y2="8" stroke="#fff" strokeWidth="1.4" />
            <line x1="12" y1="0" x2="0" y2="8" stroke="#fff" strokeWidth="1.4" />
            <rect x="5" width="2" height="8" fill="#fff" /><rect y="3" width="12" height="2" fill="#fff" />
            <rect x="5.5" width="1" height="8" fill="#cf142b" /><rect y="3.5" width="12" height="1" fill="#cf142b" />
          </g>
          <circle cx="6" cy="12.5" r="1.3" fill="#fff" />
          {[[17, 4], [20.5, 7], [18, 10.5], [15.5, 12.5], [19.5, 12]].map(([cx, cy], i) => (
            <circle key={i} cx={cx} cy={cy} r="0.7" fill="#fff" />
          ))}
        </svg>
      );
    default:
      return null;
  }
}

function CountryFlag({ nat }) {
  const code = COUNTRY_CODES[nat];
  if (code) {
    return (
      <span
        title={nat}
        style={{ width: 24, height: 16, borderRadius: 3, overflow: "hidden", border: "1px solid var(--hairline)", flexShrink: 0, display: "inline-block", lineHeight: 0 }}
      >
        <FlagSVG code={code} />
      </span>
    );
  }
  return (
    <span className="mono" style={{ fontSize: 10, color: "var(--text-dim)", border: "1px solid var(--hairline)", borderRadius: 6, padding: "2px 7px", whiteSpace: "nowrap" }} title={nat}>{nat}</span>
  );
}

function CrewAvatar({ name, sex, img, size = 34 }) {
  const [failed, setFailed] = useState(false);
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  // Fallback colors: blue for men, pinkish-red for women.
  const tint = sex === "f" ? "#F2659B" : "#4F8EF7";
  const showImg = img && !failed;
  return (
    <div
      style={{
        width: size, height: size, borderRadius: 99, flexShrink: 0, overflow: "hidden",
        display: "flex", alignItems: "center", justifyContent: "center",
        background: showImg ? "transparent" : `${tint}22`,
        border: `1px solid ${tint}55`,
      }}
    >
      {showImg ? (
        <img
          src={img}
          alt={name}
          onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <span style={{ fontSize: size * 0.34, fontWeight: 700, color: tint }}>{initials}</span>
      )}
    </div>
  );
}

function CrewMissionCard({ m, now }) {
  const launched = new Date(m.date) < now;
  return (
    <div className="panel" style={{ padding: 14, marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>{m.mission}</div>
          <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
            {m.destination} · {m.kind}
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <StatusPill kind={launched ? "success" : "go"} label={launched ? "Flown" : "Upcoming"} />
          <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>{formatDateOnly(m.date)}</div>
        </div>
      </div>
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {m.crew.map((c) => {
          const age = computeAge(c.birth, now);
          return (
            <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <CrewAvatar name={c.name} sex={c.sex} img={c.img} size={34} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {c.name}
                  {age != null && <span style={{ color: "var(--text-dim)", fontWeight: 500 }}>{"  |  "}{age}</span>}
                </div>
                <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)" }}>{c.role}</div>
              </div>
              <CountryFlag nat={c.nat} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CrewTab({ crewMissions, now }) {
  const [showAllCrew, setShowAllCrew] = useState(false);
  // Days the current Dragon crew has been aboard (ticks live).
  const daysAboard = Math.max(0, Math.floor((now - new Date(CURRENT_ISS.docked + "T00:00:00Z")) / 86400000));
  // Feed-detected crewed missions whose rosters aren't in the curated set
  // (e.g. not-yet-announced future flights) → list them as "roster TBA".
  const curatedNames = CREW_MISSIONS.map((m) => m.mission.toLowerCase());
  const tbaMissions = (crewMissions || []).filter((l) => {
    const name = (l.mission || "").toLowerCase();
    const isFuture = new Date(l.net) > now;
    const known = curatedNames.some((c) => c.includes(name) || name.includes(c.split(" ")[0]));
    return isFuture && !known;
  });

  return (
    <div>
      <SectionLabel>In orbit now</SectionLabel>
      <div className="panel" style={{ padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>{CURRENT_ISS.expedition}</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>{CURRENT_ISS.vehicle}</div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: "var(--ok)" }}>{daysAboard}</div>
            <div className="mono" style={{ fontSize: 9, color: "var(--text-dim)", letterSpacing: "0.05em" }}>DAYS ABOARD</div>
          </div>
        </div>
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          {CURRENT_ISS.crew.map((c) => (
            <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <CrewAvatar name={c.name} sex={c.sex} img={c.img} size={30} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</div>
                <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)" }}>{c.role}</div>
              </div>
              <CountryFlag nat={c.nat} />
            </div>
          ))}
        </div>
        <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 12 }}>
          Aboard since {formatDateOnly(CURRENT_ISS.docked)} · snapshot {formatDateOnly(CURRENT_ISS.asOf)}
        </div>
      </div>

      <SectionLabel>Crew rosters by mission</SectionLabel>
      {(showAllCrew ? CREW_MISSIONS : CREW_MISSIONS.slice(0, 5)).map((m) => <CrewMissionCard key={m.mission} m={m} now={now} />)}
      {CREW_MISSIONS.length > 5 && (
        <button
          onClick={() => setShowAllCrew((v) => !v)}
          style={{ width: "100%", marginTop: 4, padding: "10px 0", borderRadius: 10, border: "1px solid var(--hairline)", background: "transparent", color: "var(--blue)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
        >
          {showAllCrew ? "Show fewer" : `Show all ${CREW_MISSIONS.length} missions (back to Demo-2)`}
        </button>
      )}

      {tbaMissions.length > 0 && (
        <>
          <SectionLabel>Upcoming crewed — roster TBA</SectionLabel>
          <div className="panel" style={{ padding: "4px 12px" }}>
            {tbaMissions.map((l) => <LaunchRow key={l.id} l={l} now={now} />)}
          </div>
        </>
      )}

      <div style={{ marginTop: 16, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
        Crew rosters are a curated snapshot (as of {formatDateOnly(CREW_SNAPSHOT_AS_OF)}); ages are computed from public birth dates (approximate where only the birth year is known). Upcoming rosters are typically announced closer to launch. Perigee is an independent, fan-made tracker — not affiliated with or endorsed by SpaceX. Launch data via The Space Devs' Launch Library 2.
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/*  Starship tab                                                     */
/* ---------------------------------------------------------------- */

function VersionBadge({ version }) {
  const map = {
    V1: { bg: "rgba(123,132,148,0.16)", fg: "var(--text-dim)" },
    V2: { bg: "rgba(79,142,247,0.14)", fg: "var(--blue)" },
    V3: { bg: "rgba(174,184,242,0.16)", fg: "var(--brand)" },
  };
  const s = map[version] || map.V1;
  return (
    <span className="mono" style={{ background: s.bg, color: s.fg, fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 6, whiteSpace: "nowrap" }}>
      {version}
    </span>
  );
}

// One outcome chip: success/failure for launch; catch/splashdown/failure/na
// for landings. Catch (tower) is bright green; a controlled water splashdown
// is teal, to make the controlled-landing-vs-catch distinction obvious.
function OutcomeChip({ phase, kind }) {
  const map = {
    success: { fg: "var(--ok)", bg: "rgba(62,213,152,0.13)", text: "Success" },
    failure: { fg: "var(--bad)", bg: "rgba(255,92,92,0.13)", text: "Failed" },
    catch: { fg: "var(--ok)", bg: "rgba(62,213,152,0.13)", text: "Caught" },
    splashdown: { fg: "#46C7B8", bg: "rgba(70,199,184,0.14)", text: "Splashdown" },
    na: { fg: "var(--text-dim)", bg: "rgba(123,132,148,0.10)", text: "N/A" },
  };
  const s = map[kind] || map.na;
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="mono" style={{ fontSize: 9, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>{phase}</div>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: s.fg, background: s.bg, borderRadius: 6, padding: "3px 4px", textAlign: "center", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.text}</div>
    </div>
  );
}

function StarshipFlightCard({ f }) {
  return (
    <div className="panel" style={{ padding: 14, marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>Flight {f.n}</span>
        <VersionBadge version={f.version} />
      </div>
      <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>
        {f.booster} · {f.ship} · {f.date}
      </div>
      <div style={{ fontSize: 11, color: "var(--brand)", marginTop: 6, fontWeight: 600 }}>{f.profile}</div>
      <div style={{ fontSize: 12.5, color: "var(--text-dim)", marginTop: 6, lineHeight: 1.5 }}>{f.summary}</div>
      <div style={{ display: "flex", gap: 6, marginTop: 11 }}>
        <OutcomeChip phase="Launch" kind={f.launch} />
        <OutcomeChip phase="Booster landing" kind={f.boosterLanding} />
        <OutcomeChip phase="Ship landing" kind={f.shipLanding} />
      </div>
    </div>
  );
}

function VehicleRow({ v }) {
  const stateStyle = {
    test: { fg: "var(--brand)", label: "In test" },
    flown: { fg: "var(--text-dim)", label: "Flown" },
    lost: { fg: "var(--bad)", label: "Lost" },
  }[v.state] || { fg: "var(--text-dim)", label: "" };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 0", borderBottom: "1px solid var(--hairline)" }}>
      <div style={{ width: 8, height: 8, borderRadius: 99, background: stateStyle.fg, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{v.name}</span>
          <VersionBadge version={v.version} />
        </div>
        <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{v.note}</div>
      </div>
      <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: stateStyle.fg, whiteSpace: "nowrap" }}>{v.status}</span>
    </div>
  );
}

function StarshipTab() {
  const s = STARSHIP_STATS;
  const n = STARSHIP_NEXT;
  return (
    <div>
      <div className="panel" style={{ padding: 18, position: "relative" }}>
        <HudCorners />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div className="mono" style={{ fontSize: 11, letterSpacing: "0.08em", color: "var(--text-dim)" }}>NEXT FLIGHT</div>
          <StatusPill kind="hold" label={n.status} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 10 }}>
          <div style={{ width: 50, height: 50, borderRadius: 12, background: "rgba(174,184,242,0.12)", border: "1px solid rgba(174,184,242,0.3)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Flame size={24} style={{ color: "var(--brand)" }} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>Flight {n.flight}</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)" }}>{n.booster} · {n.ship} · {n.version}</div>
          </div>
        </div>
        <div className="mono" style={{ fontSize: 20, fontWeight: 700, marginTop: 14, color: "var(--brand)" }}>{n.window}</div>
        <div style={{ fontSize: 11, color: "var(--brand)", marginTop: 6, fontWeight: 600 }}>{n.profile}</div>
        <div style={{ fontSize: 12.5, color: "var(--text-dim)", marginTop: 8, lineHeight: 1.5 }}>{n.notes}</div>
      </div>

      <SectionLabel>Program tracker</SectionLabel>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <StatTile label="Test flights" value={s.flights} icon={<Flame size={15} />} />
        <StatTile label="Outcome" value={`${s.successes}✓ / ${s.failures}✗`} icon={<Rocket size={15} />} />
        <StatTile label="Boosters flown" value={s.boostersFlown} icon={<Layers size={15} />} />
        <StatTile label="Ships flown" value={s.shipsFlown} icon={<Layers size={15} />} />
        <StatTile label="Booster catches" value={s.catches} icon={<Award size={15} />} />
        <StatTile label="Current vehicle" value={s.currentVersion} icon={<Rocket size={15} />} />
      </div>
      <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 8, lineHeight: 1.5 }}>
        Super Heavy boosters and Starship upper stages are test articles — most are expended or lost per flight. "Flown" counts distinct vehicles; 2 boosters were reflown.
      </div>

      <SectionLabel>Production &amp; test</SectionLabel>
      <div className="panel" style={{ padding: "4px 14px" }}>
        <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", padding: "10px 0 4px", letterSpacing: "0.05em" }}>SUPER HEAVY BOOSTERS</div>
        {STARSHIP_VEHICLES.boosters.map((v) => <VehicleRow key={v.name} v={v} />)}
        <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", padding: "12px 0 4px", letterSpacing: "0.05em", borderTop: "1px solid var(--hairline)", marginTop: 6 }}>SHIPS (UPPER STAGE)</div>
        {STARSHIP_VEHICLES.ships.map((v) => <VehicleRow key={v.name} v={v} />)}
      </div>
      <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 8, lineHeight: 1.5 }}>
        Current Starbase pipeline · snapshot {formatDateOnly(STARSHIP_AS_OF)}. Vehicles are built and tested rapidly; this lists those in test plus the most recent flown and lost articles.
      </div>

      <SectionLabel>Flight history</SectionLabel>
      <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 10, lineHeight: 1.6 }}>
        Per Wikipedia's three outcome columns. <span style={{ color: "var(--ok)" }}>Caught</span> = tower catch · <span style={{ color: "#46C7B8" }}>Splashdown</span> = controlled water landing (not a catch) · <span style={{ color: "var(--bad)" }}>Failed</span> = lost · N/A = no landing attempted (precluded).
      </div>
      {STARSHIP_FLIGHTS.map((f) => <StarshipFlightCard key={f.n} f={f} />)}

      <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 6, lineHeight: 1.5 }}>
        Curated snapshot as of {formatDateOnly(STARSHIP_AS_OF)} (Wikipedia "List of Starship launches," SpaceX, NSF). A flight can have a successful launch with a failed landing (or vice-versa) — each phase is scored separately.
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/*  News tab                                                         */
/* ---------------------------------------------------------------- */

function NewsCard({ item, now }) {
  return (
    <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none", display: "block", marginBottom: 8 }}>
      <div className="panel" style={{ padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <span className="mono" style={{ fontSize: 10, color: "var(--blue)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{item.tag}</span>
          <span className="mono" style={{ fontSize: 10, color: "var(--text-dim)" }}>{timeAgo(item.date, now)}</span>
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginTop: 6, lineHeight: 1.35 }}>{item.title}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 8, color: "var(--text-dim)", fontSize: 11 }}>
          {item.source} <ExternalLink size={11} />
        </div>
      </div>
    </a>
  );
}

function NewsTab({ now }) {
  const [kw, setKw] = useState("All");
  const filtered = NEWS_ITEMS.filter((i) => kw === "All" || i.keywords.includes(kw));

  return (
    <div>
      <div className="perigee-scroll" style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 6, marginBottom: 2 }}>
        {["All", ...TRACKED_KEYWORDS].map((k) => (
          <button
            key={k}
            onClick={() => setKw(k)}
            style={{
              flexShrink: 0, padding: "5px 11px", borderRadius: 999, border: "1px solid var(--hairline)",
              background: kw === k ? "rgba(79,142,247,0.16)" : "transparent",
              color: kw === k ? "var(--blue)" : "var(--text-dim)",
              fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
            }}
          >
            {k}
          </button>
        ))}
      </div>

      <SectionLabel>Top stories</SectionLabel>
      {filtered.map((i) => <NewsCard key={i.url} item={i} now={now} />)}
      {filtered.length === 0 && (
        <div className="panel" style={{ padding: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>No stories tagged {kw}.</div>
      )}

      <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 14, lineHeight: 1.5 }}>
        Curated headline snapshot as of {formatDateOnly(NEWS_AS_OF)}; in a deployed build, stories refresh live from a news API. Tracking: SpaceX, Starlink, SPCX, Falcon 9, Starship, Terafab, xAI, Grok.
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/*  Overview (home)                                                  */
/* ---------------------------------------------------------------- */

const SPACEX_SITES = [
  { id: "redmond", name: "Redmond", kind: "Starlink", lat: 47.67, lon: -122.12, blurb: "Starlink satellite design and production in Washington state." },
  { id: "hawthorne", name: "Hawthorne", kind: "HQ / Mfg", lat: 33.92, lon: -118.33, blurb: "Falcon and Dragon manufacturing and mission control, Los Angeles." },
  { id: "vandenberg", name: "Vandenberg SLC-4E", kind: "Launch", lat: 34.63, lon: -120.61, blurb: "West Coast Falcon 9 pad for polar and sun-synchronous orbits." },
  { id: "mcgregor", name: "McGregor", kind: "Engines", lat: 31.43, lon: -97.41, blurb: "Engine test facility, Texas — every Merlin and Raptor is fired here before flight." },
  { id: "bastrop", name: "Bastrop", kind: "Starlink", lat: 30.11, lon: -97.32, blurb: "Starlink consumer hardware production — dishes and routers — near Austin, TX." },
  { id: "starbase", name: "Starbase", kind: "Starship", lat: 25.99, lon: -97.15, blurb: "Starship development, production and launch — Boca Chica, TX, and now SpaceX's HQ." },
  { id: "colossus", name: "Colossus (Memphis)", kind: "AI / Compute", lat: 35.11, lon: -90.05, blurb: "xAI's Colossus supercomputer, now under SpaceX following the 2026 xAI acquisition — Memphis, TN." },
  { id: "cape", name: "Cape Canaveral & KSC", kind: "Launch", lat: 28.57, lon: -80.6, blurb: "SLC-40 and LC-39A — Falcon 9, Falcon Heavy and Dragon crew launches, Florida." },
];

const SITE_KIND_COLOR = { Launch: "#4F8EF7", Starship: "#AEB8F2", Engines: "#FF9F40", Starlink: "#3ED598", "HQ / Mfg": "#8C7BE8", "AI / Compute": "#E0729B" };

// Simple equirectangular projection of the continental US into a fixed box.
const MAP_W = 320, MAP_H = 196;
const LON_MIN = -125, LON_MAX = -66, LAT_MIN = 24, LAT_MAX = 49.5;
const projX = (lon) => ((lon - LON_MIN) / (LON_MAX - LON_MIN)) * MAP_W;
const projY = (lat) => ((LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) * MAP_H;

// Simplified continental-US outline (lon,lat), clockwise from the Pacific NW.
const US_OUTLINE = [
  [-124.6, 48.3], [-124.1, 46.3], [-124.2, 43.3], [-123.8, 40.4], [-122.4, 37.8],
  [-120.6, 34.6], [-117.3, 32.5], [-114.7, 32.7], [-111.1, 31.3], [-108.2, 31.8],
  [-106.5, 31.8], [-103.0, 29.0], [-101.5, 29.8], [-99.2, 26.4], [-97.1, 25.9],
  [-96.5, 28.4], [-93.8, 29.7], [-90.0, 29.2], [-88.0, 30.3], [-84.1, 30.1],
  [-82.7, 27.9], [-81.8, 26.0], [-81.1, 25.1], [-80.3, 25.4], [-80.6, 28.4],
  [-81.4, 30.4], [-80.9, 32.0], [-78.5, 33.8], [-75.5, 35.6], [-73.9, 40.5],
  [-71.0, 41.4], [-69.9, 43.7],
  [-67.0, 44.8], [-69.2, 47.4], [-74.7, 45.0], [-79.2, 43.3], [-82.7, 41.7],
  [-83.1, 45.9], [-88.4, 48.3], [-94.6, 49.0], [-104.0, 49.0], [-123.0, 49.0],
];

function LocationMap() {
  const [sel, setSel] = useState("starbase");
  const site = SPACEX_SITES.find((s) => s.id === sel) || SPACEX_SITES[0];
  const path = "M " + US_OUTLINE.map((p) => `${projX(p[0]).toFixed(1)} ${projY(p[1]).toFixed(1)}`).join(" L ") + " Z";
  return (
    <>
      <div className="panel" style={{ padding: 12 }}>
        <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} width="100%" style={{ display: "block" }}>
          <g stroke="var(--hairline)" strokeWidth="0.5" opacity="0.5">
            {[30, 35, 40, 45].map((lat) => <line key={lat} x1="0" y1={projY(lat)} x2={MAP_W} y2={projY(lat)} />)}
            {[-120, -110, -100, -90, -80, -70].map((lon) => <line key={lon} x1={projX(lon)} y1="0" x2={projX(lon)} y2={MAP_H} />)}
          </g>
          <path d={path} fill="rgba(174,184,242,0.06)" stroke="rgba(174,184,242,0.3)" strokeWidth="1" strokeLinejoin="round" />
          {SPACEX_SITES.map((s) => {
            const x = projX(s.lon), y = projY(s.lat), color = SITE_KIND_COLOR[s.kind] || "#fff", active = s.id === sel;
            return (
              <g key={s.id} onClick={() => setSel(s.id)} style={{ cursor: "pointer" }}>
                {active && <circle cx={x} cy={y} r="9" fill={color} opacity="0.25" />}
                <circle cx={x} cy={y} r={active ? 5 : 4} fill={color} stroke="#0A0C10" strokeWidth="1.2" />
                {active && <text x={x} y={y - 11} textAnchor="middle" fontSize="8" fontWeight="700" fill="var(--text-primary)" fontFamily="'Space Mono', monospace">{s.name}</text>}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="panel" style={{ padding: 14, marginTop: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 10, height: 10, borderRadius: 99, background: SITE_KIND_COLOR[site.kind], flexShrink: 0 }} />
          <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>{site.name}</span>
          <span className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>{site.kind}</span>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-dim)", marginTop: 8, lineHeight: 1.5 }}>{site.blurb}</div>
        <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 8 }}>
          {Math.abs(site.lat).toFixed(2)}°{site.lat >= 0 ? "N" : "S"}, {Math.abs(site.lon).toFixed(2)}°{site.lon >= 0 ? "E" : "W"}
        </div>
      </div>
      <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 6 }}>Tap a pin to explore · stylized map, positions approximate.</div>
    </>
  );
}

function CompanyRow({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--hairline)" }}>
      <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{label}</span>
      <span className="mono" style={{ fontSize: 12, color: "var(--text-primary)", textAlign: "right" }}>{value}</span>
    </div>
  );
}

function ProvenanceRow({ label, kind, detail }) {
  const map = {
    live: { fg: "var(--ok)", bg: "rgba(62,213,152,0.12)", text: "LIVE" },
    sample: { fg: "var(--amber)", bg: "rgba(255,159,64,0.12)", text: "SAMPLE" },
    snapshot: { fg: "var(--brand)", bg: "rgba(174,184,242,0.12)", text: "SNAPSHOT" },
  };
  const s = map[kind] || map.snapshot;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid var(--hairline)" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{label}</div>
        <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{detail}</div>
      </div>
      <span className="mono" style={{ fontSize: 9, fontWeight: 700, padding: "3px 7px", borderRadius: 6, whiteSpace: "nowrap", color: s.fg, background: s.bg }}>{s.text}</span>
    </div>
  );
}

function OverviewTab({ upcoming, now, source }) {
  const nextLaunch = useMemo(
    () => [...upcoming].filter((l) => new Date(l.net) > now).sort((a, b) => new Date(a.net) - new Date(b.net))[0] || null,
    [upcoming, now]
  );
  const year = now.getUTCFullYear();
  const yearRow = YEARLY_LAUNCH_DATA.find((r) => r.year === year);
  const launchesThisYear = yearRow ? yearRow.internal + yearRow.customer : 0;
  const dayOfYear = Math.max(1, Math.floor((now - Date.UTC(year, 0, 1)) / 86400000) + 1);
  const perDay = launchesThisYear / dayOfYear;
  const totalLaunches = YEARLY_LAUNCH_DATA.reduce((s, r) => s + r.internal + r.customer, 0);
  const starlinkOps = SATELLITE_CENSUS.broadbandWorking + SATELLITE_CENSUS.dtcWorking;
  const astronauts = new Set(CREW_MISSIONS.flatMap((m) => m.crew.map((c) => c.name))).size;

  return (
    <div>
      <div style={{ display: "flex", gap: 10 }}>
        <div className="panel" style={{ flex: 1, padding: 14, position: "relative" }}>
          <HudCorners size={11} inset={6} />
          <div className="mono" style={{ fontSize: 9, letterSpacing: "0.08em", color: "var(--text-dim)" }}>NEXT LAUNCH</div>
          {nextLaunch ? (
            <>
              <div className="mono" style={{ fontSize: 18, fontWeight: 700, marginTop: 8, color: "var(--blue)", textShadow: "0 0 16px rgba(79,142,247,0.45)" }}>
                <BlinkColons text={formatCountdown(nextLaunch.net, now)} />
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginTop: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{nextLaunch.mission}</div>
            </>
          ) : (
            <div style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 10 }}>No launch in feed</div>
          )}
        </div>
        <div className="panel" style={{ width: 116, padding: 14, position: "relative" }}>
          <HudCorners size={11} inset={6} />
          <div className="mono" style={{ fontSize: 9, letterSpacing: "0.08em", color: "var(--text-dim)" }}>NEXT STARSHIP</div>
          <div className="mono" style={{ fontSize: 17, fontWeight: 700, color: "var(--brand)", marginTop: 8 }}>Flight {STARSHIP_NEXT.flight}</div>
          <div className="mono" style={{ fontSize: 9, color: "var(--text-dim)", marginTop: 2, lineHeight: 1.4 }}>{STARSHIP_NEXT.window}</div>
        </div>
      </div>

      <SectionLabel>Key stats</SectionLabel>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <StatTile label={`Launches in ${year}`} value={launchesThisYear} sub={`≈ ${perDay.toFixed(2)} / day`} icon={<Rocket size={15} />} />
        <StatTile label="Launches since 2010" value={totalLaunches} icon={<Rocket size={15} />} />
        <StatTile label="Starlink in service" value={starlinkOps.toLocaleString()} icon={<Satellite size={15} />} />
        <StatTile label="Operational boosters" value={BOOSTER_SNAPSHOT.operationalCount} icon={<Layers size={15} />} />
        <StatTile label="Starship flights" value={`${STARSHIP_STATS.flights} · ${STARSHIP_STATS.successes}✓/${STARSHIP_STATS.failures}✗`} icon={<Flame size={15} />} />
        <StatTile label="Astronauts flown" value={astronauts} icon={<Users size={15} />} />
      </div>
      <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 8, lineHeight: 1.5 }}>
        Next launch is live; the rest are curated snapshots (Starlink {formatDateOnly(SATELLITE_CENSUS.asOf)}, boosters {formatDateOnly(BOOSTER_SNAPSHOT.asOf)}, Starship {formatDateOnly(STARSHIP_AS_OF)}). Yearly totals are estimated.
      </div>

      <SectionLabel>Major sites</SectionLabel>
      <LocationMap />

      <SectionLabel>Company</SectionLabel>
      <div className="panel" style={{ padding: "4px 14px" }}>
        <CompanyRow label="Founded" value="March 2002" />
        <CompanyRow label="Founder & CEO" value="Elon Musk" />
        <CompanyRow label="Headquarters" value="Starbase, Texas" />
        <CompanyRow label="Employees" value="~13,000" />
        <CompanyRow label="Active vehicles" value="Falcon 9 · Heavy · Dragon · Starship" />
        <CompanyRow label="First orbital flight" value="Falcon 1, 2008" />
      </div>
      <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 8, lineHeight: 1.5 }}>
        Curated company facts; employee count is approximate.
      </div>

      <SectionLabel>Data sources</SectionLabel>
      <div className="panel" style={{ padding: "4px 14px" }}>
        <ProvenanceRow label="Launches & cadence" kind={source === "live" ? "live" : "sample"} detail={source === "live" ? "Launch Library 2 · refreshes in-app" : "Launch Library 2 · sample in preview"} />
        <ProvenanceRow label="Falcon booster fleet" kind={source === "live" ? "live" : "sample"} detail={`Launch Library 2 · fallback ${formatDateOnly(BOOSTER_SNAPSHOT.asOf)}`} />
        <ProvenanceRow label="Starlink constellation" kind="snapshot" detail={`planet4589 · ${formatDateOnly(SATELLITE_CENSUS.asOf)}`} />
        <ProvenanceRow label="Starship program" kind="snapshot" detail={`Wikipedia / SpaceX / NSF · ${formatDateOnly(STARSHIP_AS_OF)}`} />
        <ProvenanceRow label="Crew & in-orbit" kind="snapshot" detail={`Curated · ${formatDateOnly(CURRENT_ISS.asOf)}`} />
        <ProvenanceRow label="News" kind="snapshot" detail={`Curated · ${formatDateOnly(NEWS_AS_OF)}`} />
        <ProvenanceRow label="Company & site map" kind="snapshot" detail="Curated facts" />
      </div>
      <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 8, lineHeight: 1.5 }}>
        Live sources refresh each time you open the app and every 12 minutes while it stays open. Snapshots come from the daily data pipeline, with the dates above showing when each was last published.
      </div>
    </div>
  );
}

// Combined Launches view: Falcon (launches, cadence, boosters) + Starship,
// switched with a sub-toggle so they share one tab.
function LaunchesHub(props) {
  const [sub, setSub] = useState("falcon");
  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {[["falcon", "Falcon"], ["starship", "Starship"]].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setSub(id)}
            style={{
              flex: 1, padding: "9px 0", borderRadius: 10, border: "1px solid var(--hairline)",
              background: sub === id ? "rgba(79,142,247,0.12)" : "transparent",
              color: sub === id ? "var(--blue)" : "var(--text-dim)",
              fontSize: 13, fontWeight: 700, cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {sub === "falcon" ? <LaunchesTab {...props} /> : <StarshipTab />}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/*  Brand                                                            */
/* ---------------------------------------------------------------- */
// Inline recreation of the Perigee app icon (rendered as SVG so it works
// without any external image): navy squircle, thin white "p", a tilted
// periwinkle orbit and a satellite dot.
function PerigeeIcon({ size = 28 }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} style={{ display: "block", flexShrink: 0 }}>
      <defs>
        <linearGradient id="pgBg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#26315E" />
          <stop offset="0.5" stopColor="#121A33" />
          <stop offset="1" stopColor="#070A15" />
        </linearGradient>
        <linearGradient id="pgOrbit" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#D6DCFA" />
          <stop offset="1" stopColor="#7C8BDF" />
        </linearGradient>
      </defs>
      <rect x="3" y="3" width="94" height="94" rx="23" fill="url(#pgBg)" />
      <g transform="rotate(-26 50 50)">
        <ellipse cx="50" cy="50" rx="40" ry="15.5" fill="none" stroke="url(#pgOrbit)" strokeWidth="2.4" />
      </g>
      <g fill="none" stroke="#F2F5FF" strokeWidth="5" strokeLinecap="round">
        <line x1="43" y1="35" x2="43" y2="80" />
        <circle cx="54" cy="48" r="12.5" />
      </g>
      <circle cx="33.5" cy="30" r="4.6" fill="#AEB8F2" />
    </svg>
  );
}

// The "perigee" wordmark lockup: icon + thin geometric wordmark.
function PerigeeWordmark({ iconSize = 22, fontSize = 19 }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <PerigeeIcon size={iconSize} />
      <span style={{ fontFamily: '"Jost", "Century Gothic", "Futura", "Avenir Next", system-ui, sans-serif', fontSize, fontWeight: 300, letterSpacing: "0.5px", color: "var(--text-primary)" }}>
        perigee
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/*  App shell                                                        */
/* ---------------------------------------------------------------- */

// Onboarding splash: the Perigee mark with its satellite tracing the fixed
// orbital path (SMIL animateMotion, which renders reliably in the sandbox).
// Fades out after a beat; the app removes it shortly after.
function SplashScreen() {
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 60, background: "radial-gradient(ellipse at 50% 35%, #161B33, var(--ink) 70%)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 22, animation: "pgSplashFade 0.55s ease 2.05s forwards" }}>
      <svg viewBox="0 0 100 100" width={118} height={118} style={{ animation: "pgSplashPop 0.7s cubic-bezier(.2,.9,.3,1.2) both" }}>
        <defs>
          <linearGradient id="pgBg2" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#26315E" />
            <stop offset="0.5" stopColor="#121A33" />
            <stop offset="1" stopColor="#070A15" />
          </linearGradient>
          <linearGradient id="pgOrbit2" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#D6DCFA" />
            <stop offset="1" stopColor="#7C8BDF" />
          </linearGradient>
        </defs>
        <rect x="3" y="3" width="94" height="94" rx="23" fill="url(#pgBg2)" />
        {/* fixed tilted orbit; only the satellite body travels along it */}
        <g transform="rotate(-26 50 50)">
          <path id="pgOrbitPath" d="M 10,50 A 40,15.5 0 1,1 90,50 A 40,15.5 0 1,1 10,50" fill="none" stroke="url(#pgOrbit2)" strokeWidth="2.4" />
          <circle r="4.8" fill="#AEB8F2">
            <animateMotion dur="3.4s" repeatCount="indefinite">
              <mpath href="#pgOrbitPath" />
            </animateMotion>
          </circle>
        </g>
        {/* static p */}
        <g fill="none" stroke="#F2F5FF" strokeWidth="5" strokeLinecap="round">
          <line x1="43" y1="35" x2="43" y2="80" />
          <circle cx="54" cy="48" r="12.5" />
        </g>
      </svg>
      <div style={{ textAlign: "center", animation: "pgWordFade 0.8s ease 0.35s both" }}>
        <div style={{ fontFamily: '"Jost", "Century Gothic", "Futura", "Avenir Next", system-ui, sans-serif', fontSize: 34, fontWeight: 300, letterSpacing: "1px", color: "var(--text-primary)" }}>perigee</div>
        <div className="mono" style={{ fontSize: 10, letterSpacing: "0.28em", color: "var(--text-dim)", textTransform: "uppercase", marginTop: 6 }}>SpaceX Tracker</div>
      </div>
    </div>
  );
}

const TABS = [
  { id: "overview", label: "Overview", icon: Gauge },
  { id: "launches", label: "Launches", icon: Rocket },
  { id: "starlink", label: "Starlink", icon: Satellite },
  { id: "crew", label: "Crew", icon: Users },
  { id: "news", label: "News", icon: Newspaper },
];

const TITLE_MAP = { overview: "Overview", launches: "Launches", starlink: "Starlink", crew: "Crew", news: "News" };

/* ---------------------------------------------------------------- */
/*  Live data overlay                                                 */
/* ---------------------------------------------------------------- */

// Keys the daily scraper can publish, mapped to the module constants they
// replace. Anything absent from the payload keeps its baked-in snapshot,
// so a partial scrape degrades one section instead of blanking the app.
function applyLiveData(data) {
  if (!data || typeof data !== "object") return [];
  const applied = [];

  const set = (key, validate, assign) => {
    const value = data[key];
    if (value == null) return;
    try {
      if (!validate(value)) {
        console.warn(`[perigee] ignoring malformed "${key}"`);
        return;
      }
      assign(value);
      applied.push(key);
    } catch (err) {
      console.warn(`[perigee] failed to apply "${key}":`, err);
    }
  };

  const isCensus = (v) => typeof v.totalWorking === "number" && v.totalWorking > 0;

  set("satelliteCensus", isCensus, (v) => {
    // Keep the existing version breakdown if the scraper couldn't reconcile one.
    SATELLITE_CENSUS = { ...SATELLITE_CENSUS, ...v };
  });
  set("starshieldCensus", isCensus, (v) => {
    STARSHIELD_CENSUS = { ...STARSHIELD_CENSUS, ...v };
  });
  set(
    "boosterSnapshot",
    (v) => typeof v.recordFlights === "number" && v.recordFlights > 0,
    (v) => {
      BOOSTER_SNAPSHOT = { ...BOOSTER_SNAPSHOT, ...v };
    }
  );
  set(
    "yearlyLaunchData",
    (v) => Array.isArray(v) && v.length > 0 && typeof v[0].year === "number",
    (v) => {
      YEARLY_LAUNCH_DATA = v;
    }
  );
  set(
    "launchHistory",
    (v) => Array.isArray(v) && v.length > 0 && v[0].net,
    (v) => {
      // Published daily by the scraper. Shaped like the API's normalized
      // launches so the chart's site/vehicle helpers work unchanged.
      PUBLISHED_HISTORY = v.map((l) => ({
        id: l.id,
        net: l.net,
        mission: l.name || "",
        rocket: l.rocket || "",
        pad: [l.pad, l.loc].filter(Boolean).join(", "),
        statusLabel: l.status || "",
        statusKind: statusKindFromAbbrev(l.status || ""),
      }));
    }
  );

  // Curated sections. The scraper does not currently produce these, but the
  // hooks are here so a hand-edited JSON can update them without a rebuild.
  set("starshipAsOf", (v) => typeof v === "string", (v) => { STARSHIP_AS_OF = v; });
  set("starshipStats", (v) => typeof v.flights === "number", (v) => {
    STARSHIP_STATS = { ...STARSHIP_STATS, ...v };
  });
  set("starshipNext", (v) => typeof v.flight === "number", (v) => {
    STARSHIP_NEXT = { ...STARSHIP_NEXT, ...v };
  });
  set("starshipFlights", (v) => Array.isArray(v) && v.length > 0, (v) => {
    STARSHIP_FLIGHTS = v;
  });
  set("starshipVehicles", (v) => Array.isArray(v.boosters), (v) => {
    STARSHIP_VEHICLES = v;
  });
  set("currentIss", (v) => Array.isArray(v.crew), (v) => {
    CURRENT_ISS = { ...CURRENT_ISS, ...v };
  });
  set("crewMissions", (v) => Array.isArray(v) && v.length > 0, (v) => {
    CREW_MISSIONS = v;
  });
  set("newsAsOf", (v) => typeof v === "string", (v) => { NEWS_AS_OF = v; });
  set("newsItems", (v) => Array.isArray(v) && v.length > 0, (v) => { NEWS_ITEMS = v; });

  return applied;
}

export default function PerigeeApp() {
  const [tab, setTab] = useState("overview");
  const [dataVersion, setDataVersion] = useState(0);
  // CSS media queries handle this too, but a real class on the element means
  // the full-bleed layout also survives if a stale cached stylesheet loads,
  // and lets standalone (home-screen) mode be detected explicitly.
  const [isPhone, setIsPhone] = useState(() => {
    if (typeof window === "undefined") return false;
    return (
      window.innerWidth <= 560 ||
      window.matchMedia?.("(display-mode: standalone)")?.matches ||
      window.navigator?.standalone === true
    );
  });

  useEffect(() => {
    const check = () =>
      setIsPhone(
        window.innerWidth <= 560 ||
          window.matchMedia?.("(display-mode: standalone)")?.matches ||
          window.navigator?.standalone === true
      );
    check();
    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", check);
    return () => {
      window.removeEventListener("resize", check);
      window.removeEventListener("orientationchange", check);
    };
  }, []);
  const [upcoming, setUpcoming] = useState([]);
  const [past, setPast] = useState([]);
  const [source, setSource] = useState("loading"); // 'loading' | 'live' | 'sample'
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(new Date());
  const [syncedAt, setSyncedAt] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [boostersOpen, setBoostersOpen] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [selectedLaunch, setSelectedLaunch] = useState(null);
  const [alertsOn, setAlertsOn] = useState(false);
  const notifiedRef = useRef(new Set());

  // Pull the scraper's published snapshots. Runs on mount and whenever the
  // app auto-refreshes, so a phone left open overnight picks up new data.
  useEffect(() => {
    let alive = true;
    (async () => {
      const data = await fetchLiveData();
      if (!alive || !data) return;
      const applied = applyLiveData(data);
      if (applied.length) {
        console.log(
          `[perigee] data from ${data._source}, generated ${data.generatedAt}: ` +
            applied.join(", ")
        );
        setDataVersion((v) => v + 1); // re-render with the new values
      }
    })();
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  useEffect(() => {
    const t = setTimeout(() => setShowSplash(false), 2600);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const opts = { signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined };
        const [upRes, prevRes] = await Promise.all([
          fetch(`${LL2_BASE}/upcoming/?lsp__id=${SPACEX_LSP_ID}&mode=normal&limit=30`, opts),
          fetch(`${LL2_BASE}/previous/?lsp__id=${SPACEX_LSP_ID}&mode=normal&limit=40&ordering=-net`, opts),
        ]);
        if (!upRes.ok || !prevRes.ok) throw new Error("bad status");
        const [upJson, prevJson] = await Promise.all([upRes.json(), prevRes.json()]);
        // Client-side filter is the reliable guarantee that only SpaceX
        // launches show, regardless of whether the server honored lsp__id.
        const up = (upJson.results || []).filter(isSpaceX).map(normalizeLaunch).filter((l) => l.net);
        const pa = (prevJson.results || []).filter(isSpaceX).map(normalizeLaunch).filter((l) => l.net);
        if (!alive) return;
        if (up.length === 0 && pa.length === 0) throw new Error("empty");
        setUpcoming(up);
        setPast(pa);
        setSource("live");
      } catch (e) {
        if (!alive) return;
        setUpcoming(makeSampleUpcoming());
        setPast(SAMPLE_PAST);
        setSource("sample");
      } finally {
        if (alive) {
          setLoading(false);
          setSyncedAt(new Date());
        }
      }
    })();
    return () => { alive = false; };
  }, [refreshKey]);

  // Auto-refresh the live feed while the app is open: every 12 minutes, and
  // whenever the tab regains focus (so it's current when you come back).
  useEffect(() => {
    const id = setInterval(() => setRefreshKey((k) => k + 1), 12 * 60 * 1000);
    const onVis = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        setRefreshKey((k) => k + 1);
      }
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const crewMissions = useMemo(() => {
    const all = [...upcoming, ...past];
    const filtered = all.filter((l) => /crew|dragon|axiom|polaris/i.test(l.mission) || /crew|dragon/i.test(l.rocket));
    const result = filtered.length ? filtered : (source === "sample" ? SAMPLE_CREW : []);
    return [...result].sort((a, b) => new Date(a.net) - new Date(b.net));
  }, [upcoming, past, source]);

  // Earliest still-upcoming launch — used for the T-1h alert.
  const nextFuture = useMemo(
    () => [...upcoming].filter((l) => new Date(l.net) > now).sort((a, b) => new Date(a.net) - new Date(b.net))[0] || null,
    [upcoming, now]
  );

  const toggleAlerts = () => {
    if (!alertsOn) {
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission();
      } catch (e) { /* sandbox may block */ }
    }
    setAlertsOn((v) => !v);
  };

  // Fire a one-time browser notification when the next launch crosses inside
  // T-1 hour. Real iOS push needs a backend + APNs; this is the web prototype.
  useEffect(() => {
    if (!alertsOn || !nextFuture) return;
    const secs = (new Date(nextFuture.net) - now) / 1000;
    if (secs > 0 && secs <= 3600 && !notifiedRef.current.has(nextFuture.id)) {
      notifiedRef.current.add(nextFuture.id);
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification("Perigee · Launch in under 1 hour", {
            body: `${nextFuture.mission} — ${formatDate(nextFuture.net)}`,
          });
        }
      } catch (e) { /* notifications unavailable */ }
    }
  }, [alertsOn, nextFuture, now]);

  return (
    <div
      className={`pg-stage${isPhone ? " is-phone" : ""}`}
      style={{
        // These must be set inline-conditionally, not just in the .is-phone
        // CSS: an inline style always wins over a class rule, so a static
        // padding here would survive the media query and push the layout
        // 48px taller than the viewport — clipping the tab bar off the
        // bottom and leaving a dead band above the header.
        minHeight: isPhone ? 0 : 640,
        padding: isPhone ? 0 : "24px 12px",
        display: "flex",
        justifyContent: "center",
        alignItems: isPhone ? "stretch" : "flex-start",
        background: "radial-gradient(ellipse at 50% -10%, rgba(140,150,235,0.16), transparent 60%), var(--ink)",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&family=Jost:wght@300;400;500&display=swap');
        :root {
          --ink:#0A0C10; --panel:#131720; --hairline:#222837;
          --text-primary:#F4F6F8; --text-dim:#7B8494;
          --blue:#4F8EF7; --amber:#FF9F40; --ok:#3ED598; --bad:#FF5C5C;
          --brand:#AEB8F2;
        }
        .mono { font-family: "Space Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
        .perigee-root, .perigee-root * { box-sizing: border-box; }
        .perigee-root { color: var(--text-primary); font-family: "Space Grotesk", -apple-system, "SF Pro Text", system-ui, sans-serif; font-variant-numeric: tabular-nums; }
        .perigee-screen {
          background:
            radial-gradient(ellipse at 50% -4%, rgba(140,150,235,0.12), transparent 55%),
            radial-gradient(rgba(174,184,242,0.05) 1px, transparent 1px),
            var(--ink);
          background-size: auto, 22px 22px, auto;
        }
        .panel { background: var(--panel); border: 1px solid var(--hairline); border-radius: 16px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.045); }
        .perigee-scroll::-webkit-scrollbar { width: 0px; }
        .perigee-root button { transition: transform 0.09s ease; }
        .perigee-root button:active { transform: scale(0.97); }
        .spin { animation: pgspin 1s linear infinite; }
        .blink { animation: pgblink 1.05s steps(1, end) infinite; }
        .pulse { animation: pgpulse 1.8s ease-in-out infinite; }
        .skeleton { position: relative; overflow: hidden; background: var(--hairline); border-radius: 6px; }
        .skeleton::after { content: ""; position: absolute; inset: 0; transform: translateX(-100%); background: linear-gradient(90deg, transparent, rgba(255,255,255,0.07), transparent); animation: pgshimmer 1.4s infinite; }
        .tab-enter { animation: pgRise 0.42s cubic-bezier(.2,.7,.3,1) both; }
        .tick::before { content: ""; display: inline-block; width: 3px; height: 11px; border-radius: 2px; background: var(--brand); margin-right: 8px; vertical-align: -1px; }
        @keyframes pgspin { to { transform: rotate(360deg); } }
        @keyframes pgblink { 50% { opacity: 0.2; } }
        @keyframes pgpulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        @keyframes pgshimmer { 100% { transform: translateX(100%); } }
        @keyframes pgRise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
        @keyframes pgSplashFade { to { opacity: 0; visibility: hidden; } }
        @keyframes pgSplashPop { from { opacity: 0; transform: scale(0.82); } to { opacity: 1; transform: scale(1); } }
        @keyframes pgWordFade { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: translateY(0); } }

        /* ---- Phone-frame vs real device -----------------------------
           On a desktop browser the app is drawn inside a mock iPhone so
           it reads as a prototype. On an actual phone (or once added to
           the home screen) that framing is wrong: drop the bezel, fill
           the viewport, and let the tab bar pin to the bottom. */
        .pg-frame {
          width: 100%;
          max-width: 380px;
          background: #000;
          border-radius: 44px;
          padding: 10px;
          box-shadow: 0 30px 70px rgba(0, 0, 0, 0.55);
        }
        .pg-screen {
          border-radius: 34px;
          overflow: hidden;
          position: relative;
          min-height: 660px;
          display: flex;
          flex-direction: column;
        }
        .pg-stage.is-phone { padding: 0; min-height: 0; align-items: stretch; }
        .pg-stage.is-phone .pg-frame {
          max-width: none; border-radius: 0; padding: 0; box-shadow: none; background: var(--ink);
        }
        .pg-stage.is-phone .pg-screen {
          border-radius: 0; min-height: 0;
          height: 100vh;   /* fallback */
          height: 100dvh;  /* true full screen incl. safe areas */
        }
        .pg-stage.is-phone .pg-header { padding-top: calc(14px + env(safe-area-inset-top)); }
        .pg-stage.is-phone .pg-tabbar { padding-bottom: calc(12px + env(safe-area-inset-bottom)); }

        @media (max-width: 560px), (display-mode: standalone) {
          .pg-stage {
            padding: 0;
            min-height: 0;
            align-items: stretch;
          }
          .pg-frame {
            max-width: none;
            border-radius: 0;
            padding: 0;
            box-shadow: none;
            background: var(--ink);
          }
          .pg-screen {
            border-radius: 0;
            min-height: 0;
            /* The screen alone defines the height, in dvh. A percentage
               chain (html/body/#root) resolves short of the real screen on
               iOS when body is position:fixed, which left a dead band under
               the tab bar. */
            height: 100vh;
            height: 100dvh;
          }
          /* Clear the notch / dynamic island. */
          .pg-header { padding-top: calc(14px + env(safe-area-inset-top)); }
          /* Clear the home indicator. */
          .pg-tabbar { padding-bottom: calc(12px + env(safe-area-inset-bottom)); }
        }
      `}</style>

      <div className="perigee-root pg-frame">
        <div className="perigee-screen pg-screen" data-data-version={dataVersion}>
          {/* header — the safe-area inset has to be part of this inline
              shorthand: a `padding` shorthand here would otherwise beat any
              `padding-top` rule from CSS, sliding the wordmark under the
              status bar. */}
          <div
            className="pg-header"
            style={{
              padding: isPhone
                ? "calc(14px + env(safe-area-inset-top)) 20px 2px"
                : "14px 20px 2px",
              flexShrink: 0,
            }}
          >
            <PerigeeWordmark iconSize={22} fontSize={19} />
            <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.02em", marginTop: 6 }}>{TITLE_MAP[tab]}</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                {/* On a real phone the mock status bar is hidden, so carry
                    the live/sample indicator here instead of losing it. */}
                <span className={source === "live" ? "pulse" : ""} style={{ width: 6, height: 6, borderRadius: 99, flexShrink: 0, background: source === "live" ? "var(--ok)" : source === "sample" ? "var(--amber)" : "var(--text-dim)", display: "inline-block" }} />
                {syncedAt ? `Updated ${syncAgo(syncedAt, now)}${source === "sample" ? " · sample" : ""}` : "Connecting…"}
              </span>
              <button
                onClick={() => setRefreshKey((k) => k + 1)}
                aria-label="Refresh"
                style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", display: "flex", alignItems: "center", padding: 4 }}
              >
                <RefreshCw size={13} className={loading ? "spin" : ""} />
              </button>
            </div>
          </div>

          {/* content — the only scrolling element, so the tab bar stays put */}
          <div className="perigee-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch", padding: "8px 20px 12px" }}>
            <div key={tab} className="tab-enter">
              {tab === "overview" && <OverviewTab upcoming={upcoming} now={now} source={source} />}
              {tab === "launches" && <LaunchesHub upcoming={upcoming} past={past} now={now} source={source} onOpenBoosters={() => setBoostersOpen(true)} onSelectLaunch={setSelectedLaunch} alertsOn={alertsOn} onToggleAlerts={toggleAlerts} refreshKey={refreshKey} historyVersion={dataVersion} />}
              {tab === "starlink" && <StarlinkTab past={past} now={now} />}
              {tab === "crew" && <CrewTab crewMissions={crewMissions} now={now} />}
              {tab === "news" && <NewsTab now={now} />}
            </div>
          </div>

          {/* tab bar — same reasoning as the header: the bottom inset must
              live in the inline shorthand or the bar sits under the home
              indicator. */}
          <div
            className="pg-tabbar"
            style={{
              display: "flex",
              flexShrink: 0,
              borderTop: "1px solid var(--hairline)",
              padding: isPhone
                ? "10px 8px calc(10px + env(safe-area-inset-bottom))"
                : "10px 8px 18px",
              background: "rgba(19,23,32,0.92)",
            }}
          >
            {TABS.map((t) => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, background: "none", border: "none", cursor: "pointer", color: active ? "var(--blue)" : "var(--text-dim)" }}
                >
                  <Icon size={20} strokeWidth={active ? 2.4 : 1.8} />
                  <span style={{ fontSize: 10, fontWeight: active ? 700 : 500 }}>{t.label}</span>
                </button>
              );
            })}
          </div>

          <BoosterListSheet open={boostersOpen} onClose={() => setBoostersOpen(false)} />
          <LaunchDetailSheet launch={selectedLaunch} now={now} onClose={() => setSelectedLaunch(null)} />
          {showSplash && <SplashScreen />}
        </div>
      </div>
    </div>
  );
}
