/**
 * config.js — Vapour Cloud Weather Telemetry
 * ─────────────────────────────────────────────────────────────
 * Central configuration for all external service integrations.
 *
 * HOW TO SET UP:
 *   1. Replace OPENWEATHER_API_KEY with your free key from:
 *      https://home.openweathermap.org/api_keys
 *   2. Replace AWS credentials with your Cognito Identity Pool
 *      details from the AWS console.
 *   3. Never commit real keys to source control — consider
 *      injecting them via environment variables at build time.
 * ─────────────────────────────────────────────────────────────
 */

const VapourConfig = Object.freeze({

  /* ── OpenWeatherMap ──────────────────────────────────────── */

  /**
   * Your OpenWeatherMap API key.
   * Free tier: https://openweathermap.org/appid
   * Leave as "YOUR_API_KEY_HERE" to run in demo/offline mode.
   */
  OPENWEATHER_API_KEY: "YOUR_API_KEY_HERE",

  /** Base URL for the Current Weather Data endpoint (v2.5) */
  OPENWEATHER_BASE_URL: "https://api.openweathermap.org/data/2.5/weather",

  /** Base URL for OpenWeatherMap condition icons */
  OPENWEATHER_ICON_URL: "https://openweathermap.org/img/wn",

  /* ── AWS ─────────────────────────────────────────────────── */

  /**
   * AWS region where your DynamoDB table lives.
   * Example: "us-east-1", "ap-south-1", "eu-west-2"
   */
  AWS_REGION: "ap-south-1",

  /**
   * Amazon Cognito Identity Pool ID for browser-side auth.
   * Format: "REGION:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
   * Create one at: AWS Console → Cognito → Identity Pools
   */
  AWS_COGNITO_IDENTITY_POOL_ID: "ap-south-1:YOUR_IDENTITY_POOL_ID_HERE",

  /**
   * DynamoDB table that stores per-user search history.
   * Ensure the Cognito Identity Pool has PutItem / GetItem
   * permissions on this table via its IAM role.
   */
  DYNAMODB_TABLE_NAME: "VapourSearchHistory",

  /* ── App Behaviour ───────────────────────────────────────── */

  /** Maximum number of recent-search chips displayed in the sidebar */
  MAX_RECENT_SEARCHES: 10,

  /** LocalStorage key for persisting recent searches client-side */
  LOCALSTORAGE_KEY: "vapour_recent_searches",

  /** Toast auto-dismiss duration in milliseconds */
  TOAST_DURATION_MS: 4500,

  /** Weather icon map: OWM condition id ranges → Remix Icon class */
  ICON_MAP: {
    thunderstorm: "ri-flashlight-line",   // 2xx
    drizzle:      "ri-drizzle-line",      // 3xx
    rain:         "ri-heavy-showers-line",// 5xx
    snow:         "ri-snowy-line",        // 6xx
    mist:         "ri-mist-line",         // 701, 741
    fog:          "ri-foggy-line",        // 762 (ash)
    tornado:      "ri-tornado-line",      // 781
    atmosphere:   "ri-haze-2-line",       // other 7xx
    clearDay:     "ri-sun-line",          // 800 day
    clearNight:   "ri-moon-clear-line",   // 800 night
    fewClouds:    "ri-sun-cloudy-line",   // 801-802
    clouds:       "ri-cloudy-2-line",     // 803-804
  },

});

/* Make the config available globally (non-module script environment) */
window.VapourConfig = VapourConfig;
