/* ------------------------------------------------------------------ */
/*  Live data loader                                                   */
/*                                                                     */
/*  A GitHub Action runs scripts/scrape.mjs once a day and commits     */
/*  data/perigee-data.json back to this repo. The app reads that file  */
/*  at startup and overlays it on the snapshots baked into             */
/*  PerigeeApp.jsx.                                                    */
/*                                                                     */
/*  Reading it from raw.githubusercontent.com (rather than from the    */
/*  deployed site) means new data goes live the moment the Action      */
/*  commits — no rebuild, no redeploy. raw.githubusercontent.com       */
/*  sends `access-control-allow-origin: *`, so the fetch is allowed    */
/*  from any origin.                                                   */
/*                                                                     */
/*  If anything fails — offline, rate limited, bad JSON — the app      */
/*  keeps its baked-in values and simply reports "snapshot".           */
/* ------------------------------------------------------------------ */

// EDIT THESE TWO LINES after you create the repo.
const GITHUB_USER = "williamtackett4";
const GITHUB_REPO = "Perigee";
const GITHUB_BRANCH = "main";

const REMOTE_URL = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/public/data/perigee-data.json`;

// Bundled copy, used when the remote is unreachable (offline, first run).
const LOCAL_URL = "./data/perigee-data.json";

const TIMEOUT_MS = 8000;

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // cache-bust so iOS doesn't serve a stale copy from its HTTP cache
    const res = await fetch(`${url}?t=${Date.now()}`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the freshest data payload available, or null.
 * Tries the GitHub copy first, then the bundled copy.
 */
export async function fetchLiveData() {
  const isPlaceholder = GITHUB_USER === "YOUR_GITHUB_USERNAME";
  const sources = isPlaceholder ? [LOCAL_URL] : [REMOTE_URL, LOCAL_URL];

  for (const url of sources) {
    try {
      const data = await getJson(url);
      if (data && typeof data === "object") {
        return { ...data, _source: url === REMOTE_URL ? "github" : "bundled" };
      }
    } catch {
      // try the next source
    }
  }
  return null;
}
