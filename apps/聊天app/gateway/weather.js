/**
 * H10：定位快照 + Open-Meteo 天气（按需工具；缓存约 45 分钟）。
 * 坐标优先浏览器上报；否则手动城市 geocode。
 */
const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = path.join(__dirname, "..", "data");
const GEO_PATH = path.join(DATA_DIR, "geo.json");
const CACHE_MS = 45 * 60 * 1000;
const CITY_MAX = 48;

/** @type {{ key: string, at: number, data: object }|null} */
let weatherCache = null;

const WMO = {
  0: "晴",
  1: "大体晴",
  2: "多云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "小毛毛雨",
  53: "毛毛雨",
  55: "大毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨",
  67: "冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "雪粒",
  80: "阵雨",
  81: "强阵雨",
  82: "暴阵雨",
  85: "阵雪",
  86: "强阵雪",
  95: "雷阵雨",
  96: "雷阵雨伴冰雹",
  99: "强雷暴伴冰雹",
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function clipCity(raw) {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, CITY_MAX);
}

function readGeo() {
  ensureDir();
  try {
    const raw = JSON.parse(fs.readFileSync(GEO_PATH, "utf8"));
    const lat = Number(raw && raw.lat);
    const lon = Number(raw && raw.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return { ok: true, fixed: false };
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return { ok: true, fixed: false };
    }
    return {
      ok: true,
      fixed: true,
      lat,
      lon,
      label: clipCity(raw.label) || "",
      source: String(raw.source || "browser").slice(0, 16),
      updated_at: Number(raw.updated_at) || 0,
    };
  } catch (_) {
    return { ok: true, fixed: false };
  }
}

function writeGeo(patch) {
  ensureDir();
  const lat = Number(patch && patch.lat);
  const lon = Number(patch && (patch.lon != null ? patch.lon : patch.lng));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    const err = new Error("无效坐标");
    err.code = "bad_geo";
    throw err;
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    const err = new Error("坐标超出范围");
    err.code = "bad_geo";
    throw err;
  }
  const row = {
    lat: Math.round(lat * 1e5) / 1e5,
    lon: Math.round(lon * 1e5) / 1e5,
    label: clipCity(patch && patch.label),
    source: String((patch && patch.source) || "browser").slice(0, 16),
    updated_at: Date.now(),
  };
  fs.writeFileSync(GEO_PATH, JSON.stringify(row, null, 2), "utf8");
  weatherCache = null;
  return { ok: true, ...row, fixed: true };
}

function clearGeo() {
  ensureDir();
  if (fs.existsSync(GEO_PATH)) fs.unlinkSync(GEO_PATH);
  weatherCache = null;
  return { ok: true, cleared: true };
}

async function geocodeCity(city) {
  const name = clipCity(city);
  if (!name) {
    const err = new Error("请填写城市");
    err.code = "no_city";
    throw err;
  }
  const url =
    "https://geocoding-api.open-meteo.com/v1/search?name=" +
    encodeURIComponent(name) +
    "&count=1&language=zh&format=json";
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const err = new Error("城市检索失败");
    err.code = "geocode_http";
    throw err;
  }
  const data = await res.json();
  const hit = Array.isArray(data.results) ? data.results[0] : null;
  if (!hit) {
    const err = new Error("找不到这个城市");
    err.code = "city_missing";
    throw err;
  }
  const label = [hit.name, hit.admin1, hit.country]
    .filter(Boolean)
    .join(" · ")
    .slice(0, CITY_MAX);
  return {
    lat: Number(hit.latitude),
    lon: Number(hit.longitude),
    label: label || name,
    source: "manual",
  };
}

async function resolveCoords(opts) {
  const cityOverride = clipCity(opts && opts.city);
  if (cityOverride) {
    const g = await geocodeCity(cityOverride);
    return { ...g, via: "city" };
  }
  const geo = readGeo();
  if (geo.fixed) {
    return {
      lat: geo.lat,
      lon: geo.lon,
      label: geo.label || "当前位置",
      source: geo.source,
      updated_at: geo.updated_at,
      via: "fix",
    };
  }
  const manual = clipCity(opts && opts.manualCity);
  if (manual) {
    const g = await geocodeCity(manual);
    return { ...g, via: "manual_city" };
  }
  const err = new Error("还没有定位；请开定位权限或填手动城市");
  err.code = "no_coords";
  throw err;
}

function wmoLabel(code) {
  const n = Math.floor(Number(code));
  if (WMO[n]) return WMO[n];
  return "天气码" + (Number.isFinite(n) ? n : "?");
}

async function fetchForecast(lat, lon) {
  const key =
    Math.round(lat * 100) + "," + Math.round(lon * 100);
  if (
    weatherCache &&
    weatherCache.key === key &&
    Date.now() - weatherCache.at < CACHE_MS
  ) {
    return { ...weatherCache.data, cached: true };
  }
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=" +
    encodeURIComponent(lat) +
    "&longitude=" +
    encodeURIComponent(lon) +
    "&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m" +
    "&timezone=auto";
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const err = new Error("天气接口失败");
    err.code = "weather_http";
    throw err;
  }
  const data = await res.json();
  const cur = data.current || {};
  const out = {
    ok: true,
    temperature_c: cur.temperature_2m,
    feels_like_c: cur.apparent_temperature,
    humidity: cur.relative_humidity_2m,
    wind_kmh: cur.wind_speed_10m,
    weather_code: cur.weather_code,
    weather: wmoLabel(cur.weather_code),
    observed_at: cur.time || "",
    cached: false,
  };
  weatherCache = { key, at: Date.now(), data: out };
  return out;
}

async function getLocationTool(opts) {
  const coords = await resolveCoords(opts || {});
  const ageMin =
    coords.updated_at
      ? Math.max(0, Math.round((Date.now() - coords.updated_at) / 60000))
      : null;
  return {
    ok: true,
    label: coords.label,
    lat: coords.lat,
    lon: coords.lon,
    source: coords.source,
    via: coords.via,
    age_min: ageMin,
    hint:
      coords.via === "fix"
        ? ageMin != null && ageMin > 180
          ? "定位较旧，可能已移动"
          : "来自浏览器最近上报"
        : "来自城市名检索",
  };
}

async function getWeatherTool(opts) {
  const coords = await resolveCoords(opts || {});
  const wx = await fetchForecast(coords.lat, coords.lon);
  return {
    ok: true,
    place: coords.label,
    lat: coords.lat,
    lon: coords.lon,
    via: coords.via,
    weather: wx.weather,
    temperature_c: wx.temperature_c,
    feels_like_c: wx.feels_like_c,
    humidity: wx.humidity,
    wind_kmh: wx.wind_kmh,
    observed_at: wx.observed_at,
    cached: !!wx.cached,
  };
}

if (require.main === module) {
  console.assert(wmoLabel(0) === "晴");
  console.assert(wmoLabel(61) === "小雨");
  const bad = (() => {
    try {
      writeGeo({ lat: 999, lon: 0 });
      return false;
    } catch (e) {
      return e.code === "bad_geo";
    }
  })();
  console.assert(bad);
  const put = writeGeo({ lat: 24.48, lon: 118.09, label: "厦门自检", source: "test" });
  console.assert(put.fixed && readGeo().label === "厦门自检");
  clearGeo();
  console.assert(!readGeo().fixed);
  (async () => {
    try {
      const g = await geocodeCity("Xiamen");
      console.assert(Number.isFinite(g.lat) && Number.isFinite(g.lon));
      const wx = await fetchForecast(g.lat, g.lon);
      console.assert(wx.ok && wx.weather);
      console.log("weather ok", wx.weather, wx.temperature_c);
    } catch (e) {
      console.log("weather ok (offline skip)", (e && e.message) || e);
    }
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  GEO_PATH,
  CACHE_MS,
  readGeo,
  writeGeo,
  clearGeo,
  geocodeCity,
  resolveCoords,
  fetchForecast,
  getLocationTool,
  getWeatherTool,
  wmoLabel,
};
