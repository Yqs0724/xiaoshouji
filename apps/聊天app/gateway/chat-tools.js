/**
 * 日常聊天工具表（网关内执行 + 可选外接 MCP）。
 */
const {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  localDateISO,
} = require("../../日历app/gateway/calendar");
const {
  fetchMcpTools,
  callMcpTool,
  sanitizeToolName,
  clearMcpToolsCache,
} = require("../../共读app/gateway/mcp-remote");

const MAX_TOOL_ROUNDS = 4;

/** 设定页 / 气泡展示用；LLM 仍走 function.name */
const DEFAULT_LABELS = {
  calendar_list_events: "查行程",
  calendar_create_event: "建行程",
  calendar_update_event: "改行程",
  calendar_delete_event: "删行程",
};

function resolveToolLabel(name, labels) {
  const n = String(name || "").trim();
  if (!n) return "";
  const custom =
    labels && typeof labels === "object" && !Array.isArray(labels)
      ? String(labels[n] || "").trim()
      : "";
  return custom || DEFAULT_LABELS[n] || n;
}

const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "calendar_list_events",
      description: "查询现实日历行程。可按单日或日期范围。",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD 单日" },
          from: { type: "string", description: "YYYY-MM-DD 起" },
          to: { type: "string", description: "YYYY-MM-DD 止" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar_create_event",
      description: "在现实日历新建一条行程（全天）。owner: you|companion|both",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          date: { type: "string", description: "YYYY-MM-DD" },
          owner: { type: "string", enum: ["you", "companion", "both"] },
        },
        required: ["title", "date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar_update_event",
      description: "按 id 改行程标题或日期",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          date: { type: "string" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar_delete_event",
      description: "按 id 删除行程",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
      },
    },
  },
];

function parseArgs(raw) {
  if (raw && typeof raw === "object") return raw;
  const s = String(raw || "").trim();
  if (!s) return {};
  try {
    const o = JSON.parse(s);
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

/** 聊天 meta 一行用；勿塞全文 */
function summarizeToolResult(name, result, ok) {
  const n = String(name || "").trim();
  const raw = String(result == null ? "" : result);
  if (!ok) {
    try {
      const o = JSON.parse(raw);
      const msg = String((o && (o.message || o.error)) || "").trim();
      return (msg || "失败").slice(0, 40);
    } catch {
      return "失败";
    }
  }
  try {
    const o = JSON.parse(raw);
    if (o && Array.isArray(o.events)) {
      const events = o.events;
      if (!events.length) return "无行程";
      const titles = events
        .slice(0, 2)
        .map((e) => String((e && e.title) || "").trim())
        .filter(Boolean);
      let s = events.length + " 条";
      if (titles.length) s += "：" + titles.join("、");
      return s.length > 48 ? s.slice(0, 48) + "…" : s;
    }
    if (o && o.event && o.event.title) {
      const t = String(o.event.title).trim().slice(0, 16);
      if (n.includes("create")) return "已建「" + t + "」";
      if (n.includes("update")) return "已改「" + t + "」";
      return "「" + t + "」";
    }
    if (o && (o.deleted || o.ok === true) && n.includes("delete")) return "已删除";
    if (o && typeof o.message === "string" && o.message.trim()) {
      return o.message.trim().slice(0, 40);
    }
  } catch {
    /* plain / MCP 文本 */
  }
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t) return "完成";
  return t.length > 48 ? t.slice(0, 48) + "…" : t;
}

function runBuiltinTool(name, argsRaw) {
  const args = parseArgs(argsRaw);
  const n = String(name || "").trim();
  try {
    if (n === "calendar_list_events") {
      const q = {};
      if (args.date) q.date = args.date;
      if (args.from) q.from = args.from;
      if (args.to) q.to = args.to;
      if (!q.date && !q.from && !q.to) q.date = localDateISO(new Date());
      const r = listEvents(q);
      return {
        ok: true,
        name: n,
        result: JSON.stringify({
          ok: true,
          today: localDateISO(new Date()),
          events: (r.events || []).map((e) => ({
            id: e.id,
            title: e.title,
            date: e.date,
            owner: e.owner,
          })),
        }),
      };
    }
    if (n === "calendar_create_event") {
      const r = createEvent({
        title: args.title,
        date: args.date,
        owner: args.owner || "companion",
      });
      return { ok: true, name: n, result: JSON.stringify(r) };
    }
    if (n === "calendar_update_event") {
      const patch = {};
      if (args.title != null) patch.title = args.title;
      if (args.date != null) patch.date = args.date;
      const r = updateEvent(args.id, patch);
      return { ok: true, name: n, result: JSON.stringify(r) };
    }
    if (n === "calendar_delete_event") {
      const r = deleteEvent(args.id);
      return { ok: true, name: n, result: JSON.stringify(r) };
    }
    return null;
  } catch (e) {
    return {
      ok: false,
      name: n,
      result: JSON.stringify({
        ok: false,
        error: e.code || "tool_failed",
        message: e.message || "工具失败",
      }),
    };
  }
}

/**
 * 合并内置 + MCP 工具表。
 * @returns {Promise<{
 *   defs: object[],
 *   mcpMap: Map<string, string>,
 *   catalog: { name: string, label: string, description: string, source: string }[],
 *   mcpError: string|null,
 * }>}
 */
async function getToolBundle(settings = {}) {
  const labels = settings.chat_tool_labels || {};
  const defs = TOOL_DEFS.slice();
  const used = new Set(
    defs.map((t) => t.function && t.function.name).filter(Boolean)
  );
  /** @type {Map<string, string>} llmName -> remote MCP name */
  const mcpMap = new Map();
  const catalog = defs.map((t) => {
    const name = t.function.name;
    return {
      name,
      label: resolveToolLabel(name, labels),
      description: String(t.function.description || "").trim(),
      source: "builtin",
    };
  });
  let mcpError = null;

  const mcpOn = !!settings.mcp_enabled;
  const mcpUrl = String(settings.mcp_url || "").trim();
  if (mcpOn && mcpUrl) {
    try {
      const remote = await fetchMcpTools({
        url: mcpUrl,
        token: settings.mcp_token,
      });
      for (const rt of remote) {
        let llmName = sanitizeToolName(rt.name);
        if (used.has(llmName)) llmName = sanitizeToolName("mcp_" + rt.name);
        let n = 2;
        while (used.has(llmName)) {
          llmName = sanitizeToolName("mcp_" + rt.name + "_" + n);
          n += 1;
        }
        used.add(llmName);
        mcpMap.set(llmName, rt.name);
        defs.push({
          type: "function",
          function: {
            name: llmName,
            description: rt.description || rt.name,
            parameters: rt.inputSchema || { type: "object", properties: {} },
          },
        });
        catalog.push({
          name: llmName,
          label: resolveToolLabel(llmName, labels),
          description: rt.description || rt.name,
          source: "mcp",
          remote: rt.name,
        });
      }
    } catch (e) {
      mcpError = (e && e.message) || "MCP 连接失败";
    }
  }

  return { defs, mcpMap, catalog, mcpError };
}

/** 设定页 / 自检：当前可调工具一览 */
async function listChatTools(settingsOrLabels) {
  /* 兼容旧调用：listChatTools(labels) 或 listChatTools(settings) */
  let settings = {};
  if (settingsOrLabels && typeof settingsOrLabels === "object") {
    if (
      Object.prototype.hasOwnProperty.call(settingsOrLabels, "chat_tools_enabled") ||
      Object.prototype.hasOwnProperty.call(settingsOrLabels, "mcp_enabled") ||
      Object.prototype.hasOwnProperty.call(settingsOrLabels, "mcp_url") ||
      Object.prototype.hasOwnProperty.call(settingsOrLabels, "chat_tool_labels")
    ) {
      settings = settingsOrLabels;
    } else {
      settings = { chat_tool_labels: settingsOrLabels };
    }
  }
  const bundle = await getToolBundle(settings);
  return {
    ok: !bundle.mcpError,
    tools: bundle.catalog,
    source: bundle.mcpMap.size ? "builtin+mcp" : "builtin",
    mcp_error: bundle.mcpError,
  };
}

async function runChatTool(name, argsRaw, ctx = {}) {
  const n = String(name || "").trim();
  const builtin = runBuiltinTool(n, argsRaw);
  if (builtin) return builtin;

  const mcpMap = ctx.mcpMap;
  const settings = ctx.settings || {};
  const remoteName =
    mcpMap && typeof mcpMap.get === "function" ? mcpMap.get(n) : null;
  if (remoteName && settings.mcp_enabled && settings.mcp_url) {
    try {
      const text = await callMcpTool(
        { url: settings.mcp_url, token: settings.mcp_token },
        remoteName,
        parseArgs(argsRaw)
      );
      return { ok: true, name: n, result: text };
    } catch (e) {
      return {
        ok: false,
        name: n,
        result: JSON.stringify({
          ok: false,
          error: e.code || "mcp_failed",
          message: e.message || "MCP 调用失败",
        }),
      };
    }
  }

  return {
    ok: false,
    name: n,
    result: JSON.stringify({ ok: false, error: "unknown_tool", message: "没有这个工具" }),
  };
}

if (require.main === module) {
  (async () => {
    const catalog = await listChatTools();
    console.assert(catalog.ok && catalog.tools.length >= 4);
    console.assert(catalog.tools.some((t) => t.name === "calendar_list_events"));
    console.assert(
      catalog.tools.find((t) => t.name === "calendar_list_events").label === "查行程"
    );
    console.assert(
      (await listChatTools({ calendar_list_events: "日历列表" })).tools.find(
        (t) => t.name === "calendar_list_events"
      ).label === "日历列表"
    );
    console.assert(resolveToolLabel("calendar_list_events") === "查行程");
    console.assert(
      summarizeToolResult(
        "calendar_list_events",
        JSON.stringify({ events: [{ title: "午觉" }, { title: "散步" }] }),
        true
      ).includes("2 条")
    );
    console.assert(summarizeToolResult("x", JSON.stringify({ message: "没空" }), false) === "没空");
    console.assert(summarizeToolResult("mcp_x", "hello world", true) === "hello world");
    const listed = await runChatTool("calendar_list_events", {});
    console.assert(listed.ok && listed.result.includes("events"));
    const made = await runChatTool("calendar_create_event", {
      title: "工具自检-" + Date.now(),
      date: localDateISO(new Date()),
      owner: "companion",
    });
    console.assert(made.ok);
    const ev = JSON.parse(made.result).event;
    console.assert(ev && ev.id);
    const upd = await runChatTool("calendar_update_event", {
      id: ev.id,
      title: ev.title + "-改",
    });
    console.assert(upd.ok);
    const del = await runChatTool("calendar_delete_event", { id: ev.id });
    console.assert(del.ok);
    console.log("chat-tools ok");
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  TOOL_DEFS,
  DEFAULT_LABELS,
  MAX_TOOL_ROUNDS,
  runChatTool,
  parseArgs,
  listChatTools,
  resolveToolLabel,
  summarizeToolResult,
  getToolBundle,
  clearMcpToolsCache,
};
