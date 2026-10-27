/**
 * IB D1：DIY 外部 HTTP 工具（网关代发；与 MCP 互补）。
 * 配置：name / URL / method / params；可选调用前确认。
 */
const { randomUUID } = require("node:crypto");

const DIY_MAX = 20;
const BODY_CAP = 8000;
const PENDING_TTL_MS = 15 * 60 * 1000;

/** @type {Map<string, { tool: object, args: object, at: number }>} */
const pending = new Map();

function clip(s, n) {
  return String(s == null ? "" : s).trim().slice(0, n);
}

function sanitizeDiyName(raw) {
  let n = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  if (!n || !/^[a-z]/.test(n)) n = "diy_" + (n || "tool");
  if (!n.startsWith("diy_")) n = "diy_" + n;
  return n.slice(0, 56);
}

function normalizeParam(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = clip(raw.name, 40).replace(/[^a-zA-Z0-9_]/g, "");
  if (!name) return null;
  const type = ["string", "number", "boolean", "integer"].includes(
    String(raw.type || "").toLowerCase()
  )
    ? String(raw.type).toLowerCase()
    : "string";
  return {
    name,
    type: type === "integer" ? "integer" : type,
    required: !!raw.required,
    description: clip(raw.description, 160),
  };
}

function normalizeDiyTool(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = clip(raw.id, 40) || randomUUID().replace(/-/g, "").slice(0, 12);
  const method = String(raw.method || "GET")
    .trim()
    .toUpperCase();
  const allowed = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
  const url = clip(raw.url, 500);
  if (!url) return null;
  const params = Array.isArray(raw.params)
    ? raw.params.map(normalizeParam).filter(Boolean).slice(0, 16)
    : [];
  const headers =
    raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)
      ? Object.fromEntries(
          Object.entries(raw.headers)
            .map(([k, v]) => [clip(k, 64), clip(v, 400)])
            .filter(([k, v]) => k && v)
            .slice(0, 12)
        )
      : {};
  return {
    id,
    name: sanitizeDiyName(raw.name || raw.label || id),
    label: clip(raw.label || raw.name || "外部工具", 32) || "外部工具",
    url,
    method: allowed.has(method) ? method : "GET",
    params,
    headers,
    confirm: !!raw.confirm,
    enabled: raw.enabled !== false,
  };
}

function normalizeDiyHttpTools(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const used = new Set();
  for (const row of raw) {
    if (out.length >= DIY_MAX) break;
    const t = normalizeDiyTool(row);
    if (!t) continue;
    let name = t.name;
    let n = 2;
    while (used.has(name)) {
      name = sanitizeDiyName(t.name + "_" + n);
      n += 1;
    }
    used.add(name);
    out.push({ ...t, name });
  }
  return out;
}

function assertSafeUrl(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch (_) {
    const err = new Error("URL 无效");
    err.code = "diy_bad_url";
    throw err;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    const err = new Error("只允许 http/https");
    err.code = "diy_bad_protocol";
    throw err;
  }
  if (u.hostname === "169.254.169.254" || u.hostname === "metadata.google.internal") {
    const err = new Error("禁止该地址");
    err.code = "diy_blocked_host";
    throw err;
  }
  return u;
}

function paramsToSchema(params) {
  const properties = {};
  const required = [];
  for (const p of params || []) {
    properties[p.name] = {
      type: p.type === "integer" ? "integer" : p.type,
      description: p.description || p.name,
    };
    if (p.required) required.push(p.name);
  }
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
  };
}

function diyToolsFromSettings(settings) {
  if (settings && settings.diy_http_enabled === false) return [];
  return normalizeDiyHttpTools(settings && settings.diy_http_tools).filter(
    (t) => t.enabled
  );
}

function buildDiyToolDefs(settings) {
  const tools = diyToolsFromSettings(settings);
  const defs = [];
  const map = new Map();
  for (const t of tools) {
    defs.push({
      type: "function",
      function: {
        name: t.name,
        description:
          (t.label ? t.label + " · " : "") +
          "外部 HTTP（" +
          t.method +
          "）。" +
          (t.confirm ? "调用前需你确认。" : ""),
        parameters: paramsToSchema(t.params),
      },
    });
    map.set(t.name, t);
  }
  return { defs, map, catalog: tools };
}

function sweepPending() {
  const now = Date.now();
  for (const [id, row] of pending) {
    if (!row || now - (row.at || 0) > PENDING_TTL_MS) pending.delete(id);
  }
}

function enqueueDiyCall(tool, args) {
  sweepPending();
  const id = randomUUID();
  pending.set(id, { tool, args: args || {}, at: Date.now() });
  return {
    ok: true,
    needs_confirm: true,
    pending_id: id,
    kind: "diy_http",
    label: tool.label || tool.name,
    method: tool.method,
    url: tool.url,
    message: "待你同意后调用「" + (tool.label || tool.name) + "」",
  };
}

async function executeHttp(tool, args) {
  assertSafeUrl(tool.url);
  let urlStr = String(tool.url);
  const used = new Set();
  const argObj = args && typeof args === "object" ? args : {};
  for (const [k, v] of Object.entries(argObj)) {
    const token = "{{" + k + "}}";
    if (urlStr.includes(token)) {
      urlStr = urlStr.split(token).join(encodeURIComponent(String(v)));
      used.add(k);
    }
  }
  const rest = {};
  for (const [k, v] of Object.entries(argObj)) {
    if (!used.has(k)) rest[k] = v;
  }
  const method = tool.method || "GET";
  const headers = Object.assign(
    { Accept: "application/json, text/plain, */*" },
    tool.headers || {}
  );
  const opts = { method, headers };
  if (method === "GET" || method === "DELETE") {
    const u = new URL(urlStr);
    for (const [k, v] of Object.entries(rest)) {
      if (v == null) continue;
      u.searchParams.set(k, String(v));
    }
    urlStr = u.toString();
  } else {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    opts.body = JSON.stringify(rest);
  }
  const res = await fetch(urlStr, opts);
  const text = (await res.text()).slice(0, BODY_CAP);
  return {
    ok: res.ok,
    status: res.status,
    body: text,
    url: urlStr.replace(/([?&](token|key|password|secret|auth)=)[^&]*/gi, "$1***"),
  };
}

async function runDiyHttpTool(tool, argsRaw, opts) {
  const args =
    typeof argsRaw === "string"
      ? (() => {
          try {
            return JSON.parse(argsRaw || "{}");
          } catch (_) {
            return {};
          }
        })()
      : argsRaw && typeof argsRaw === "object"
        ? argsRaw
        : {};
  if (tool.confirm && !(opts && opts.confirmed)) {
    return {
      ok: true,
      name: tool.name,
      result: JSON.stringify(enqueueDiyCall(tool, args)),
    };
  }
  try {
    const out = await executeHttp(tool, args);
    return {
      ok: out.ok,
      name: tool.name,
      result: JSON.stringify(out),
    };
  } catch (e) {
    return {
      ok: false,
      name: tool.name,
      result: JSON.stringify({
        ok: false,
        error: e.code || "diy_http_failed",
        message: e.message || "外部 HTTP 失败",
      }),
    };
  }
}

async function confirmDiyPending(pendingId, accept) {
  sweepPending();
  const id = String(pendingId || "").trim();
  const row = pending.get(id);
  if (!row) {
    const err = new Error("确认已过期或不存在");
    err.code = "diy_pending_missing";
    throw err;
  }
  pending.delete(id);
  if (!accept) {
    return {
      ok: true,
      rejected: true,
      message: "已拒绝调用",
      label: (row.tool && row.tool.label) || "",
    };
  }
  const ran = await runDiyHttpTool(row.tool, row.args, { confirmed: true });
  return {
    ok: !!ran.ok,
    confirmed: true,
    name: row.tool.name,
    label: row.tool.label,
    result: ran.result,
  };
}

if (require.main === module) {
  const list = normalizeDiyHttpTools([
    {
      name: "ping",
      label: "探活",
      url: "https://example.com/{{q}}",
      method: "GET",
      params: [{ name: "q", type: "string", required: true }],
      confirm: true,
    },
    { url: "" },
  ]);
  console.assert(list.length === 1 && list[0].name.startsWith("diy_"));
  console.assert(list[0].confirm === true);
  try {
    assertSafeUrl("file:///etc/passwd");
    throw new Error("should block");
  } catch (e) {
    console.assert(e.code === "diy_bad_protocol");
  }
  console.log("diy-http ok");
}

module.exports = {
  DIY_MAX,
  normalizeDiyHttpTools,
  normalizeDiyTool,
  sanitizeDiyName,
  diyToolsFromSettings,
  buildDiyToolDefs,
  runDiyHttpTool,
  confirmDiyPending,
  assertSafeUrl,
};
