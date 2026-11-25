/**
 * app.js — Vapour Cloud Weather Telemetry
 * ─────────────────────────────────────────────────────────────
 * ES Module. Requires config.js to execute first (sets window.VapourConfig).
 *
 * Persistence layer (auto-selected at runtime):
 *   ┌─ AWS DynamoDB ──── when AWS_COGNITO_IDENTITY_POOL_ID is configured
 *   └─ localStorage ──── automatic fallback (or when AWS keys are placeholders)
 *
 * Table schema (DynamoDB):
 *   Partition Key : city      (String)  — canonical OWM city name
 *   Attributes    : country   (String)
 *                   timestamp (Number)  — Date.now() epoch ms
 * ─────────────────────────────────────────────────────────────
 */

/* ══════════════════════════════════════════════════════════════
   AWS SDK v3 — LAZY dynamic imports via esm.sh CDN
   Loaded on-demand only when AWS is actually configured,
   so a missing/slow CDN never blocks the weather functionality.
══════════════════════════════════════════════════════════════ */

/** Cached SDK modules after first successful load. */
let _sdk = null;

/**
 * Dynamically import all three AWS SDK packages in parallel.
 * Returns a cached result on subsequent calls.
 * @returns {Promise<{ DynamoDBClient, DynamoDBDocumentClient, PutCommand, ScanCommand, BatchWriteCommand, fromCognitoIdentityPool }>}
 */
async function loadAWSSDK() {
  if (_sdk) return _sdk;
  try {
    const [dynamo, docLib, credPkg] = await Promise.all([
      import("https://esm.sh/@aws-sdk/client-dynamodb@3"),
      import("https://esm.sh/@aws-sdk/lib-dynamodb@3"),
      import("https://esm.sh/@aws-sdk/credential-providers@3"),
    ]);
    _sdk = {
      DynamoDBClient:          dynamo.DynamoDBClient,
      DynamoDBDocumentClient:  docLib.DynamoDBDocumentClient,
      PutCommand:              docLib.PutCommand,
      ScanCommand:             docLib.ScanCommand,
      BatchWriteCommand:       docLib.BatchWriteCommand,
      fromCognitoIdentityPool: credPkg.fromCognitoIdentityPool,
    };
    return _sdk;
  } catch (err) {
    console.warn("[Vapour] AWS SDK failed to load from esm.sh:", err);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════
   DEMO DATA  — served when OWM API key is still a placeholder
══════════════════════════════════════════════════════════════ */
const DEMO_DATA = {
  london:     { name: "London",   sys: { country: "GB" }, main: { temp: 14.2, feels_like: 12.5, humidity: 78, pressure: 1008 }, wind: { speed: 6.1 }, visibility: 9000,  weather: [{ id: 500, description: "light rain",       icon: "10d" }], dt: 0 },
  "new york": { name: "New York", sys: { country: "US" }, main: { temp: 22.4, feels_like: 23.0, humidity: 61, pressure: 1015 }, wind: { speed: 4.5 }, visibility: 10000, weather: [{ id: 801, description: "few clouds",       icon: "02d" }], dt: 0 },
  tokyo:      { name: "Tokyo",    sys: { country: "JP" }, main: { temp: 29.1, feels_like: 31.5, humidity: 70, pressure: 1010 }, wind: { speed: 3.2 }, visibility: 10000, weather: [{ id: 800, description: "clear sky",         icon: "01d" }], dt: 0 },
  mumbai:     { name: "Mumbai",   sys: { country: "IN" }, main: { temp: 32.6, feels_like: 36.0, humidity: 85, pressure: 1005 }, wind: { speed: 7.8 }, visibility: 6000,  weather: [{ id: 804, description: "overcast clouds",   icon: "04d" }], dt: 0 },
  sydney:     { name: "Sydney",   sys: { country: "AU" }, main: { temp: 18.3, feels_like: 17.0, humidity: 65, pressure: 1018 }, wind: { speed: 5.5 }, visibility: 10000, weather: [{ id: 802, description: "scattered clouds",  icon: "03d" }], dt: 0 },
  paris:      { name: "Paris",    sys: { country: "FR" }, main: { temp: 11.0, feels_like:  9.5, humidity: 82, pressure: 1012 }, wind: { speed: 4.2 }, visibility: 8000,  weather: [{ id: 300, description: "light drizzle",     icon: "09d" }], dt: 0 },
  dubai:      { name: "Dubai",    sys: { country: "AE" }, main: { temp: 38.0, feels_like: 42.0, humidity: 42, pressure: 1002 }, wind: { speed: 2.8 }, visibility: 10000, weather: [{ id: 800, description: "clear sky",         icon: "01d" }], dt: 0 },
};

/* ══════════════════════════════════════════════════════════════
   PURE HELPERS
══════════════════════════════════════════════════════════════ */

/** Map OWM condition id + icon code → Remix Icon class name. */
function getIconClass(id, icon) {
  const m       = window.VapourConfig.ICON_MAP;
  const isNight = icon?.endsWith("n");
  if (id >= 200 && id < 300)  return m.thunderstorm;
  if (id >= 300 && id < 400)  return m.drizzle;
  if (id >= 500 && id < 600)  return m.rain;
  if (id >= 600 && id < 700)  return m.snow;
  if (id === 701 || id === 741) return m.mist;
  if (id === 762)              return m.fog;
  if (id === 781)              return m.tornado;
  if (id >= 700 && id < 800)  return m.atmosphere;
  if (id === 800)              return isNight ? m.clearNight : m.clearDay;
  if (id <= 802)               return m.fewClouds;
  return m.clouds;
}

/** Format a UNIX timestamp (seconds) into display strings. */
function formatDateTime(unixSec) {
  const d = new Date(unixSec * 1000);
  return {
    dateStr:  d.toLocaleDateString("en-GB",  { weekday: "long",   day: "numeric", month: "short", year: "numeric" }),
    timeStr:  d.toLocaleTimeString("en-GB",  { hour: "2-digit", minute: "2-digit", hour12: false }),
    isoDate:  d.toISOString().split("T")[0],
    isoTime:  d.toISOString(),
  };
}

/** Convert metres → "X.X km" or "10+ km". */
const formatVisibility = m => (!m && m !== 0) ? "N/A" : m >= 10000 ? "10+ km" : `${(m / 1000).toFixed(1)} km`;

/** Title-case every word. */
const titleCase = str => str.replace(/\b\w/g, c => c.toUpperCase());

/** Chunk an array into groups of size n (for DynamoDB batch ops). */
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/* ══════════════════════════════════════════════════════════════
   CONFIG SHORTCUTS
══════════════════════════════════════════════════════════════ */
const cfg    = () => window.VapourConfig;
const LS_KEY = () => cfg()?.LOCALSTORAGE_KEY   ?? "vapour_recent_searches";
const MAX    = () => cfg()?.MAX_RECENT_SEARCHES ?? 10;

/* ══════════════════════════════════════════════════════════════
   TOAST NOTIFICATION SYSTEM
══════════════════════════════════════════════════════════════ */
(function installToastStyles() {
  if (document.getElementById("vapour-toast-styles")) return;
  const s = Object.assign(document.createElement("style"), { id: "vapour-toast-styles" });
  s.textContent = `
    #vapour-toast-container {
      position: fixed; top: 76px; right: 20px; z-index: 9999;
      display: flex; flex-direction: column; gap: 10px; pointer-events: none;
    }
    .vapour-toast {
      pointer-events: auto; display: flex; align-items: flex-start; gap: 10px;
      padding: 14px 18px; min-width: 280px; max-width: 420px;
      border-radius: 12px; border: 1px solid;
      backdrop-filter: blur(18px) saturate(1.4);
      -webkit-backdrop-filter: blur(18px) saturate(1.4);
      font-family: 'Inter', system-ui, sans-serif; font-size: 0.85rem; line-height: 1.5;
      box-shadow: 0 8px 40px rgba(0,0,0,.6);
      animation: toast-in 250ms cubic-bezier(.4,0,.2,1) forwards; cursor: pointer;
    }
    .vapour-toast.dismissing { animation: toast-out 300ms cubic-bezier(.4,0,.2,1) forwards; }
    .vapour-toast--error   { background:rgba(20,4,4,.88);   border-color:rgba(255,82,82,.5);  color:#ffcdd2; box-shadow:0 8px 40px rgba(0,0,0,.6),0 0 20px rgba(255,82,82,.2); }
    .vapour-toast--warning { background:rgba(20,14,2,.88);  border-color:rgba(255,193,7,.45); color:#fff9c4; box-shadow:0 8px 40px rgba(0,0,0,.6),0 0 20px rgba(255,193,7,.15); }
    .vapour-toast--success { background:rgba(2,20,12,.88);  border-color:rgba(0,255,159,.4);  color:#b2f5e0; box-shadow:0 8px 40px rgba(0,0,0,.6),0 0 20px rgba(0,255,159,.15); }
    .vapour-toast--info    { background:rgba(3,11,20,.90);  border-color:rgba(0,229,255,.4);  color:#b3eaf5; box-shadow:0 8px 40px rgba(0,0,0,.6),0 0 20px rgba(0,229,255,.15); }
    .vapour-toast__icon  { font-size:1.1rem; flex-shrink:0; margin-top:1px; }
    .vapour-toast__body  { flex:1; }
    .vapour-toast__title { font-weight:600; font-size:.82rem; letter-spacing:.04em; margin-bottom:2px; }
    .vapour-toast__msg   { opacity:.85; }
    @keyframes toast-in  { from{opacity:0;transform:translateX(100%) scale(.95)} to{opacity:1;transform:translateX(0) scale(1)} }
    @keyframes toast-out { from{opacity:1;transform:translateX(0) scale(1);max-height:120px} to{opacity:0;transform:translateX(60%) scale(.9);max-height:0;margin-bottom:-10px} }
    @media(max-width:480px) { #vapour-toast-container{right:10px;left:10px;top:70px} .vapour-toast{min-width:0;width:100%} }
  `;
  document.head.appendChild(s);
})();

function getToastContainer() {
  let el = document.getElementById("vapour-toast-container");
  if (!el) {
    el = Object.assign(document.createElement("div"), { id: "vapour-toast-container" });
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  return el;
}

/**
 * Display a self-dismissing toast notification.
 * @param {"error"|"warning"|"success"|"info"} type
 * @param {string} title
 * @param {string} message  May contain safe inline HTML (e.g. <code>)
 */
function showToast(type, title, message) {
  const ICONS = { error:"ri-error-warning-line", warning:"ri-alert-line", success:"ri-checkbox-circle-line", info:"ri-information-line" };
  const toast = document.createElement("div");
  toast.className = `vapour-toast vapour-toast--${type}`;
  toast.setAttribute("role", "alert");
  toast.innerHTML = `
    <span class="vapour-toast__icon"><i class="${ICONS[type] ?? ICONS.info}"></i></span>
    <div class="vapour-toast__body">
      <div class="vapour-toast__title">${title}</div>
      <div class="vapour-toast__msg">${message}</div>
    </div>`;
  const dismiss = () => {
    toast.classList.add("dismissing");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
  };
  toast.addEventListener("click", dismiss);
  getToastContainer().appendChild(toast);
  setTimeout(dismiss, cfg()?.TOAST_DURATION_MS ?? 4500);
}

/* ══════════════════════════════════════════════════════════════
   SIDEBAR STORAGE-MODE BADGE
══════════════════════════════════════════════════════════════ */

/**
 * Update the pill inside the Recent Searches sidebar.
 * @param {"cloud"|"local"|"loading"} mode
 */
function setSidebarStorageMode(mode) {
  const badge  = document.getElementById("storage-badge");
  const iconEl = document.getElementById("storage-badge-icon");
  const textEl = document.getElementById("storage-badge-text");
  if (!badge || !iconEl || !textEl) return;

  badge.classList.remove("mode--cloud", "mode--local");

  if (mode === "cloud") {
    badge.classList.add("mode--cloud");
    iconEl.className   = "ri-cloud-line";
    textEl.textContent = "AWS DynamoDB";
    badge.title        = "History is synced to your AWS DynamoDB table";
  } else if (mode === "local") {
    badge.classList.add("mode--local");
    iconEl.className   = "ri-hard-drive-2-line";
    textEl.textContent = "Local Storage";
    badge.title        = "Add AWS keys to config.js to enable cloud sync";
  } else {
    iconEl.className   = "ri-loader-4-line";
    textEl.textContent = "Initialising…";
    badge.title        = "";
  }
}

/* ══════════════════════════════════════════════════════════════
   NAVBAR STATUS BADGE
══════════════════════════════════════════════════════════════ */

/**
 * Possible badge states and their display values.
 *   "Standby"    → AWS DynamoDB: Standby         (teal)
 *   "Syncing"    → AWS DynamoDB: Syncing          (amber)
 *   "Connected"  → AWS DynamoDB: Connected        (green)
 *   "Error"      → AWS DynamoDB: Error            (red)
 *   "LocalMode"  → Local Mode (Add AWS Keys)      (amber)
 */
const BADGE_CFG = {
  Standby:   { label: "AWS DynamoDB: Standby",        color: "#00bcd4" },
  Syncing:   { label: "AWS DynamoDB: Syncing…",        color: "#ffca28" },
  Connected: { label: "AWS DynamoDB: Connected",       color: "#00e676" },
  Error:     { label: "AWS DynamoDB: Error",           color: "#ff5252" },
  LocalMode: { label: "Local Mode (Add AWS Keys)",     color: "#ffca28" },
};

function setDbStatus(state) {
  const badge = document.querySelector(".status-badge");
  if (!badge) return;
  const { label, color } = BADGE_CFG[state] ?? BADGE_CFG.Standby;
  const dot = badge.querySelector(".status-badge__dot");
  // Update text node after the icons
  const textNodes = [...badge.childNodes].filter(n => n.nodeType === Node.TEXT_NODE);
  if (textNodes.length) {
    textNodes[textNodes.length - 1].textContent = ` ${label}`;
  } else {
    badge.appendChild(document.createTextNode(` ${label}`));
  }
  if (dot) {
    dot.style.background = color;
    dot.style.boxShadow  = `0 0 6px ${color}, 0 0 14px ${color}55`;
  }
}

/* ══════════════════════════════════════════════════════════════
   MODE DETECTION
══════════════════════════════════════════════════════════════ */

/** True → OWM API key is still the placeholder. */
const isDemoMode = () =>
  !cfg()?.OPENWEATHER_API_KEY ||
   cfg().OPENWEATHER_API_KEY === "YOUR_API_KEY_HERE";

/** True → AWS Cognito pool ID has been configured by the user. */
const isAWSConfigured = () => {
  const id = cfg()?.AWS_COGNITO_IDENTITY_POOL_ID ?? "";
  return Boolean(id) && !id.includes("YOUR_IDENTITY_POOL_ID_HERE");
};

/* ══════════════════════════════════════════════════════════════
   AWS DynamoDB CLIENT  (lazy singleton)
══════════════════════════════════════════════════════════════ */
let _docClient = null;

/**
 * Lazily load the AWS SDK, then create and cache a DynamoDB DocumentClient
 * authenticated via an Amazon Cognito Identity Pool (unauthenticated role).
 * @returns {Promise<DynamoDBDocumentClient|null>}
 */
async function getDocClient() {
  if (_docClient) return _docClient;

  const sdk = await loadAWSSDK();
  if (!sdk) return null;                // SDK failed to load — caller handles null

  const { AWS_REGION, AWS_COGNITO_IDENTITY_POOL_ID } = cfg();

  const rawClient = new sdk.DynamoDBClient({
    region: AWS_REGION,
    credentials: sdk.fromCognitoIdentityPool({
      clientConfig:   { region: AWS_REGION },
      identityPoolId: AWS_COGNITO_IDENTITY_POOL_ID,
    }),
  });

  _docClient = sdk.DynamoDBDocumentClient.from(rawClient, {
    marshallOptions:   { removeUndefinedValues: true, convertEmptyValues: true },
    unmarshallOptions: { wrapNumbers: false },
  });

  return _docClient;
}

/* ══════════════════════════════════════════════════════════════
   LOCAL STORAGE HELPERS  (private — used by fallback layer)
══════════════════════════════════════════════════════════════ */

/** @returns {{ city: string, country: string, timestamp: number }[]} */
function _lsLoad() {
  try   { return JSON.parse(localStorage.getItem(LS_KEY())) ?? []; }
  catch { return []; }
}

/** @param {{ city: string, country: string, timestamp: number }[]} items */
function _lsSave(items) {
  try { localStorage.setItem(LS_KEY(), JSON.stringify(items)); }
  catch { /* quota or private-mode — fail silently */ }
}

/* ══════════════════════════════════════════════════════════════
   IN-MEMORY CACHE  (keeps sidebar reactive without extra fetches)
══════════════════════════════════════════════════════════════ */

/** @type {{ city: string, country: string, timestamp: number }[]} */
let _cache = [];

/* ══════════════════════════════════════════════════════════════
   DYNAMODB PERSISTENCE LAYER
══════════════════════════════════════════════════════════════ */

/**
 * Write a searched city to DynamoDB (upserts by city name).
 * Falls back to localStorage when AWS is not configured or on error.
 *
 * @param {string} cityName  Canonical city name from OWM API
 * @param {string} country   Two-letter ISO country code
 */
async function saveCityToCloud(cityName, country) {
  const item = { city: cityName, country: country ?? "", timestamp: Date.now() };

  /* ── LocalStorage path ───────────────────────────────────── */
  if (!isAWSConfigured()) {
    let list = _lsLoad();
    list     = [item, ...list.filter(r => r.city.toLowerCase() !== cityName.toLowerCase())].slice(0, MAX());
    _lsSave(list);
    return;
  }

  /* ── DynamoDB path ───────────────────────────────────────── */
  try {
    const sdk    = await loadAWSSDK();
    const client = await getDocClient();
    if (!sdk || !client) throw new Error("AWS SDK unavailable");

    await client.send(new sdk.PutCommand({
      TableName: cfg().DYNAMODB_TABLE_NAME,
      Item:      item,
    }));
    console.debug("[Vapour] DynamoDB PutItem →", cityName);
  } catch (err) {
    console.warn("[Vapour] DynamoDB PutItem failed — falling back to localStorage:", err);
    let list = _lsLoad();
    list     = [item, ...list.filter(r => r.city.toLowerCase() !== cityName.toLowerCase())].slice(0, MAX());
    _lsSave(list);
    showToast("warning", "Cloud Sync Failed", "History saved locally. Check your Cognito config in <code>config.js</code>.");
    setDbStatus("LocalMode");
  }
}

/**
 * Load search history from DynamoDB (or localStorage), sort by most-recent
 * timestamp, populate the in-memory cache, and render the sidebar chips.
 *
 * Called on page load and after every successful search.
 */
async function loadSearchHistory() {
  /* ── LocalStorage path ───────────────────────────────────── */
  if (!isAWSConfigured()) {
    _cache = _lsLoad();
    renderSidebar(_cache.map(r => r.city));
    setDbStatus("LocalMode");
    setSidebarStorageMode("local");
    return;
  }

  /* ── DynamoDB path ───────────────────────────────────────── */
  setDbStatus("Syncing");
  setSidebarStorageMode("loading");
  try {
    const sdk    = await loadAWSSDK();
    const client = await getDocClient();
    if (!sdk || !client) throw new Error("AWS SDK unavailable");

    const result = await client.send(new sdk.ScanCommand({
      TableName: cfg().DYNAMODB_TABLE_NAME,
      ProjectionExpression: "#c, country, #ts",
      ExpressionAttributeNames: { "#c": "city", "#ts": "timestamp" },
    }));

    _cache = (result.Items ?? [])
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
      .slice(0, MAX());

    renderSidebar(_cache.map(r => r.city));
    setDbStatus("Connected");
    setSidebarStorageMode("cloud");
    console.debug(`[Vapour] DynamoDB Scan → ${_cache.length} item(s) loaded`);
  } catch (err) {
    console.warn("[Vapour] DynamoDB Scan failed — falling back to localStorage:", err);
    _cache = _lsLoad();
    renderSidebar(_cache.map(r => r.city));
    setDbStatus("LocalMode");
    setSidebarStorageMode("local");
    showToast("warning", "Cloud Unavailable", "Could not reach DynamoDB. Showing locally cached history.");
  }
}

/**
 * Delete all search history from DynamoDB (batch delete, max 25/request)
 * or clear localStorage, then refresh the sidebar.
 */
async function clearHistory() {
  /* Snapshot the keys to delete before we clear the cache */
  const toDelete = [..._cache];
  _cache = [];
  renderSidebar([]);

  /* ── LocalStorage path ───────────────────────────────────── */
  if (!isAWSConfigured()) {
    _lsSave([]);
    showToast("info", "History Cleared", "All local search history has been removed.");
    return;
  }

  /* ── DynamoDB batch-delete path ──────────────────────────── */
  if (toDelete.length === 0) {
    showToast("info", "History Already Empty", "There are no saved searches to remove.");
    return;
  }

  try {
    const sdk    = await loadAWSSDK();
    const client = await getDocClient();
    if (!sdk || !client) throw new Error("AWS SDK unavailable");

    // DynamoDB BatchWrite accepts ≤25 requests per call → chunk if needed
    const batches = chunk(toDelete, 25);
    await Promise.all(batches.map(batch =>
      client.send(new sdk.BatchWriteCommand({
        RequestItems: {
          [cfg().DYNAMODB_TABLE_NAME]: batch.map(({ city }) => ({
            DeleteRequest: { Key: { city } },
          })),
        },
      }))
    ));
    console.debug(`[Vapour] DynamoDB BatchDelete → ${toDelete.length} item(s) removed`);
    showToast("success", "History Cleared", `${toDelete.length} record(s) deleted from DynamoDB.`);
    setDbStatus("Connected");
  } catch (err) {
    console.warn("[Vapour] DynamoDB BatchDelete failed:", err);
    // Also clear localStorage mirror
    _lsSave([]);
    showToast("warning", "Cloud Delete Failed", "Local history cleared. DynamoDB records may remain — verify IAM permissions.");
    setDbStatus("LocalMode");
  }
}

/**
 * Add a city to the in-memory cache + persist (cloud or local).
 * Updates the sidebar immediately without waiting for the async write.
 *
 * @param {string} cityName  Canonical name from OWM API
 * @param {string} country   ISO country code
 */
async function addToHistory(cityName, country) {
  const item = { city: cityName, country: country ?? "", timestamp: Date.now() };

  // 1. Update cache immediately (deduplicated, capped)
  _cache = [item, ..._cache.filter(r => r.city.toLowerCase() !== cityName.toLowerCase())].slice(0, MAX());

  // 2. Re-render chips right away (zero perceived latency)
  renderSidebar(_cache.map(r => r.city));

  // 3. Persist asynchronously in background
  await saveCityToCloud(cityName, country);
}

/* ══════════════════════════════════════════════════════════════
   SIDEBAR RENDER
══════════════════════════════════════════════════════════════ */

/**
 * Render city name strings as clickable chip buttons.
 * @param {string[]} cities  Ordered list (most-recent first)
 */
function renderSidebar(cities) {
  const chipList = document.getElementById("chip-list");
  const emptyMsg = document.getElementById("sidebar-empty");
  if (!chipList) return;

  chipList.innerHTML = "";

  if (!cities.length) {
    if (emptyMsg) emptyMsg.hidden = false;
    return;
  }

  if (emptyMsg) emptyMsg.hidden = true;

  cities.forEach(city => {
    const li  = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "chip";
    btn.setAttribute("role",       "listitem");
    btn.setAttribute("aria-label", `Search ${city} again`);
    btn.innerHTML = `<i class="ri-map-pin-line" aria-hidden="true"></i>${city}`;
    btn.addEventListener("click", () => {
      // Populate the search input so the user sees what was searched
      const input = document.getElementById("city-input");
      if (input) input.value = city;
      triggerSearch(city);
    });
    li.appendChild(btn);
    chipList.appendChild(li);
  });
}

/* ══════════════════════════════════════════════════════════════
   WEATHER PANEL — DOM STATE MACHINE
══════════════════════════════════════════════════════════════ */

const showLoading = () => {
  document.getElementById("weather-placeholder").hidden = true;
  document.getElementById("weather-data").hidden        = true;
  document.getElementById("weather-loading").hidden     = false;
};

const showWeatherData = () => {
  document.getElementById("weather-placeholder").hidden = true;
  document.getElementById("weather-loading").hidden     = true;
  document.getElementById("weather-data").hidden        = false;
};

const showPlaceholder = () => {
  document.getElementById("weather-loading").hidden     = true;
  document.getElementById("weather-data").hidden        = true;
  document.getElementById("weather-placeholder").hidden = false;
};

/**
 * Hydrate the weather panel with data from the OWM API response.
 * @param {object} data  Parsed OWM /weather JSON
 */
function renderWeather(data) {
  const { name, sys, main, wind, weather, visibility, dt } = data;
  const condition = weather[0];
  const { dateStr, timeStr, isoDate, isoTime } = formatDateTime(dt);

  // Location
  document.getElementById("city-name").textContent    = name;
  document.getElementById("country-name").textContent = sys.country;

  // Date / time
  const dateEl = document.getElementById("weather-date");
  dateEl.textContent = dateStr;
  dateEl.setAttribute("datetime", isoDate);

  const timeEl = document.getElementById("weather-time");
  timeEl.textContent = timeStr;
  timeEl.setAttribute("datetime", isoTime);

  // Temperature
  document.getElementById("temperature").innerHTML =
    `${Math.round(main.temp)}<sup>°C</sup>`;
  document.getElementById("feels-like").textContent =
    `Feels like ${Math.round(main.feels_like)}°C`;

  // Icon + description
  const iconEl = document.getElementById("weather-icon");
  iconEl.className = `${getIconClass(condition.id, condition.icon)} weather-data__icon`;
  document.getElementById("weather-desc").textContent = titleCase(condition.description);

  // Stat cards
  document.getElementById("humidity").textContent   = `${main.humidity}%`;
  document.getElementById("wind-speed").textContent = `${wind.speed.toFixed(1)} m/s`;
  document.getElementById("visibility").textContent = formatVisibility(visibility);
  document.getElementById("pressure").textContent   = `${main.pressure} hPa`;

  showWeatherData();
}

/* ══════════════════════════════════════════════════════════════
   DEMO MODE
══════════════════════════════════════════════════════════════ */

function getDemoData(city) {
  const key  = city.trim().toLowerCase();
  const data = DEMO_DATA[key] ??
    DEMO_DATA[Object.keys(DEMO_DATA).find(k => k.startsWith(key.slice(0, 3))) ?? ""];
  return data
    ? { data: { ...data, dt: Date.now() / 1000 }, found: true }
    : { data: null, found: false };
}

/* ══════════════════════════════════════════════════════════════
   CORE SEARCH LOGIC
══════════════════════════════════════════════════════════════ */

/**
 * Entry-point for every city lookup — from the search bar OR a sidebar chip.
 * Handles validation, demo fallback, live fetch, error reporting, and history.
 *
 * @param {string} rawCity  City name (may have leading/trailing whitespace)
 */
async function triggerSearch(rawCity) {
  const city = rawCity?.trim();

  if (!city) {
    showToast("warning", "Empty Query", "Please enter a city name before searching.");
    document.getElementById("city-input")?.focus();
    return;
  }

  showLoading();
  setDbStatus("Syncing");

  /* ── Demo mode ──────────────────────────────────────────── */
  if (isDemoMode()) {
    showToast("info", "Demo Mode Active",
      "No OWM API key detected — serving built-in sample data. Add your key to <code>config.js</code>.");

    await new Promise(r => setTimeout(r, 850)); // simulate realistic latency

    const { data, found } = getDemoData(city);
    if (!found) {
      showPlaceholder();
      setDbStatus(isAWSConfigured() ? "Connected" : "LocalMode");
      showToast("warning", "City Not in Demo Data",
        `"${city}" isn't in the offline dataset. Try: London, Tokyo, Mumbai, New York, Sydney, Paris, Dubai.`);
      return;
    }

    renderWeather(data);
    await addToHistory(data.name, data.sys.country);
    setDbStatus(isAWSConfigured() ? "Connected" : "LocalMode");
    showToast("success", "Telemetry Loaded (Demo)", `Weather data for ${data.name} served from local dataset.`);
    return;
  }

  /* ── Live OpenWeatherMap mode ───────────────────────────── */
  const url = new URL(cfg().OPENWEATHER_BASE_URL);
  url.searchParams.set("q",     city);
  url.searchParams.set("units", "metric");
  url.searchParams.set("appid", cfg().OPENWEATHER_API_KEY);

  try {
    const response = await fetch(url.toString());

    if (!response.ok) {
      showPlaceholder();
      setDbStatus("Error");

      switch (response.status) {
        case 404: showToast("error",   "City Not Found",
          `"${city}" could not be located. Check the spelling or try a nearby major city.`); break;
        case 401: showToast("error",   "Invalid API Key",
          "Your OpenWeatherMap key was rejected (401). Verify it in <code>config.js</code> and ensure it has been activated."); break;
        case 429: showToast("warning", "Rate Limited",
          "Too many requests (60/min on the free tier). Please wait a moment before searching again."); break;
        default:  showToast("error",   `API Error ${response.status}`,
          `The weather service returned an unexpected error (${response.status}). Try again shortly.`);
      }
      return;
    }

    const data = await response.json();
    renderWeather(data);
    await addToHistory(data.name, data.sys.country);
    setDbStatus(isAWSConfigured() ? "Connected" : "LocalMode");
    showToast("success", "Telemetry Stream Live", `Realtime weather data for ${data.name} loaded successfully.`);

  } catch (err) {
    showPlaceholder();
    setDbStatus("Error");
    showToast(
      "error",
      navigator.onLine ? "Network Error" : "No Network Connection",
      navigator.onLine
        ? "Could not reach OpenWeatherMap. Check your connection or firewall settings."
        : "You appear to be offline. Reconnect and try again."
    );
    console.error("[Vapour] Fetch error:", err);
  }
}

/* ══════════════════════════════════════════════════════════════
   LIVE CLOCK — syncs to the next full minute, then ticks every 60s
══════════════════════════════════════════════════════════════ */
function startLiveClock() {
  const tick = () => {
    const timeEl = document.getElementById("weather-time");
    const dataEl = document.getElementById("weather-data");
    if (!timeEl || dataEl?.hidden) return;
    const now = new Date();
    timeEl.textContent = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
    timeEl.setAttribute("datetime", now.toISOString());
  };
  setTimeout(() => { tick(); setInterval(tick, 60_000); }, (60 - new Date().getSeconds()) * 1000);
}

/* ══════════════════════════════════════════════════════════════
   EVENT BINDING
══════════════════════════════════════════════════════════════ */
function bindSearchControls() {
  const input  = document.getElementById("city-input");
  const button = document.getElementById("search-btn");
  if (!input || !button) return;

  input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); triggerSearch(input.value); } });
  button.addEventListener("click", () => triggerSearch(input.value));
  input.addEventListener("input",  () => { if (input.value.trim()) input.classList.remove("input--error"); });
}

function bindClearHistory() {
  document.getElementById("clear-btn")?.addEventListener("click", clearHistory);
}

/* ══════════════════════════════════════════════════════════════
   BOOTSTRAP
   External module scripts run after the DOM is parsed (like defer),
   but DOMContentLoaded may have already fired by then in some browsers.
   We handle both cases with a readyState guard.
══════════════════════════════════════════════════════════════ */
async function init() {
  /* 1. Bind controls */
  bindSearchControls();
  bindClearHistory();

  /* 2. Initialise status badge to reflect current persistence mode */
  setDbStatus(isAWSConfigured() ? "Standby" : "LocalMode");
  setSidebarStorageMode("loading");

  /* 3. Load history from DynamoDB or localStorage */
  await loadSearchHistory();

  /* 4. Start the live clock */
  startLiveClock();

  /* 5. Announce modes */
  setTimeout(() => {
    if (isDemoMode()) {
      showToast("info", "Demo Mode — No OWM Key",
        `Vapour is running in offline mode. Add your OpenWeatherMap key to <code>config.js</code>.`);
    }
    if (!isAWSConfigured()) {
      showToast("info", "Local Storage Mode",
        "No AWS Cognito pool configured — search history is saved to your browser only.");
    }
  }, 700);

  /* 6. Focus search input */
  document.getElementById("city-input")?.focus();

  /* 7. Console branding */
  console.log(
    "%c VAPOUR %c Cloud Weather Telemetry ",
    "background:#00e5ff;color:#030b14;font-weight:900;font-family:monospace;padding:3px 8px;border-radius:4px 0 0 4px;",
    "background:#071525;color:#00e5ff;font-weight:400;font-family:monospace;padding:3px 8px;border-radius:0 4px 4px 0;border:1px solid #00e5ff44;"
  );
  console.log(
    `%c${isDemoMode()      ? "⚠ OWM Demo mode — add API key to config.js"      : "✓ OWM Live mode — API key detected"}`,
    `color:${isDemoMode()      ? "#ffca28" : "#00e676"};font-weight:600;`
  );
  console.log(
    `%c${isAWSConfigured() ? "✓ AWS DynamoDB configured — cloud sync active"    : "⚠ AWS not configured — using localStorage"}`,
    `color:${isAWSConfigured() ? "#00e676" : "#ffca28"};font-weight:600;`
  );
}

// Guard: run init() now if DOM is ready, or wait for DOMContentLoaded
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
