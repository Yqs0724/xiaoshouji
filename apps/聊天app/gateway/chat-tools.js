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
  cam_check: "看一眼屏幕",
  view_activity: "查看动态",
  schedule_monitor: "定时监控",
  share_music: "点歌",
};

/** AionsHome CAM_CHECK：提示后缓冲再截；真摄像头后置，V2 先截主屏 */
const CAM_CHECK_DELAY_SEC = 5;

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
  {
    type: "function",
    function: {
      name: "cam_check",
      description:
        "主动看一眼对方电脑主屏（会先提示对方并等待数秒再截屏）。" +
        "用于：对方让你看一下、描述屏幕、关心在干嘛且文字不够。" +
        "不要频繁调用；隐私/开会/聊天界面时慎用。",
      parameters: {
        type: "object",
        properties: {
          why: {
            type: "string",
            description: "为什么要看一眼（短中文）",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_activity",
      description:
        "查看对方电脑近一段时间前台在干什么（窗口采样摘要，不截屏）。" +
        "对齐教程「查看动态」：slots=1～12 表示约 10～120 分钟（slots×10）。" +
        "关心摸鱼/卡关/久坐时可调用；需对方已开「记录 PC 前台活动」。不要连续刷。",
      parameters: {
        type: "object",
        properties: {
          slots: {
            type: "integer",
            description: "1～12，对应约 10～120 分钟窗口（默认 6=约60分）",
          },
          why: {
            type: "string",
            description: "为什么要看动态（短中文）",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_monitor",
      description:
        "预约一次到点看护（对齐教程「定时监控」/[Monitor:]）。" +
        "到点会看活动或屏幕并主动发一条短讯；不是闹钟、不响铃。" +
        "action=schedule 时用 minutes 或 at；list 列待执行；cancel 需 id。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["schedule", "list", "cancel"],
            description: "默认 schedule",
          },
          minutes: {
            type: "integer",
            description: "几分钟后（1～720）；与 at 二选一",
          },
          at: {
            type: "string",
            description: "钟点 HH:MM（今日未过用今日，否则明日）",
          },
          why: {
            type: "string",
            description: "到点要关心什么（短中文）",
          },
          id: {
            type: "string",
            description: "cancel 时的预约 id",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "share_music",
      description:
        "点歌并生成真音乐卡（Cove：优先网易云整曲代理；否则 Apple 试听/外链）。" +
        "搜歌用 query，或 name+artist；多版本时 status=needs_choice，再用 pick_id 选定。" +
        "或 from_presence 分享共听当前曲。只有成功出卡后才能说找到了；勿假装已播。" +
        "网易云需本机兼容 API；VIP 曲可能要 Cookie。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "检索词（歌名 歌手，或自然语言）",
          },
          name: {
            type: "string",
            description: "歌名（无 query 时用）",
          },
          artist: {
            type: "string",
            description: "歌手（可选）",
          },
          pick_id: {
            type: "integer",
            description: "从 needs_choice 候选里选中的曲目 id（网易云或 Apple）",
          },
          from_presence: {
            type: "boolean",
            description: "true=分享共听正在播的歌（可忽略 name）",
          },
        },
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
    if (n === "cam_check") {
      if (o && o.scene) {
        const s = String(o.scene).replace(/\s+/g, " ").trim();
        const short = s.length > 36 ? s.slice(0, 36) + "…" : s;
        return short ? "已看：" + short : "已看一眼";
      }
      if (o && o.capture_ok === false) return "截屏失败";
      return "已看一眼";
    }
    if (n === "view_activity") {
      if (o && o.disabled) return "未开活动采样";
      if (o && o.samples === 0) return "暂无采样";
      const w = Number(o && o.window_min) || 0;
      const head = w ? "近" + w + "分" : "动态";
      if (o && o.summary) {
        const one = String(o.summary)
          .split(/\n/)
          .map((s) => s.trim())
          .filter(Boolean)[0];
        if (one) {
          const short = one.length > 28 ? one.slice(0, 28) + "…" : one;
          return head + "：" + short;
        }
      }
      return head + "已查";
    }
    if (n === "schedule_monitor") {
      if (o && o.job && o.job.fire_local) {
        if (o.job.status === "cancelled") return "已取消";
        return "约@" + String(o.job.fire_local).slice(-5);
      }
      if (o && typeof o.count === "number") {
        return o.count ? "待执行" + o.count + "条" : "无预约";
      }
      if (o && typeof o.message === "string" && o.message.trim()) {
        return o.message.trim().slice(0, 40);
      }
      return "已处理";
    }
    if (n === "share_music") {
      if (o && o.status === "needs_choice") return "多首候选";
      if (o && o.track && o.track.name) {
        const t = String(o.track.name).trim().slice(0, 20);
        const prov = String((o.track && o.track.provider) || "").toLowerCase();
        const tag = o.from_presence
          ? "共听·"
          : prov === "netease"
            ? "网易云·"
            : prov === "apple"
              ? "Apple·"
              : "";
        return tag + t;
      }
      if (o && typeof o.message === "string" && o.message.trim()) {
        return o.message.trim().slice(0, 40);
      }
      return "已发音乐卡";
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
  const hiddenRemote = new Set(
    Array.isArray(settings.mcp_tool_hidden)
      ? settings.mcp_tool_hidden.map((x) => String(x || "").trim()).filter(Boolean)
      : []
  );
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
      enabled: true,
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
        const remoteName = String(rt.name || "").trim();
        const enabled = !hiddenRemote.has(remoteName);
        if (enabled) {
          mcpMap.set(llmName, remoteName);
          defs.push({
            type: "function",
            function: {
              name: llmName,
              description: rt.description || rt.name,
              parameters: rt.inputSchema || { type: "object", properties: {} },
            },
          });
        }
        catalog.push({
          name: llmName,
          label: resolveToolLabel(llmName, labels),
          description: rt.description || rt.name,
          source: "mcp",
          remote: remoteName,
          enabled,
        });
      }
    } catch (e) {
      mcpError = (e && e.message) || "MCP 连接失败";
    }
  }

  return { defs, mcpMap, catalog, mcpError };
}

/**
 * H1.23：设定页测连通。用表单里的 url/token（可未保存），强制绕过缓存。
 * @returns {Promise<{ ok: true, count: number, names: string[] }>}
 */
async function pingMcpConnection(opts = {}) {
  const url = String(opts.url != null ? opts.url : "").trim();
  const token = String(opts.token != null ? opts.token : "").trim();
  if (!url) {
    const err = new Error("请先填写 MCP Base URL");
    err.code = "mcp_no_url";
    throw err;
  }
  const tools = await fetchMcpTools({ url, token, force: true });
  const names = (tools || [])
    .map((t) => String((t && t.name) || "").trim())
    .filter(Boolean);
  return { ok: true, count: names.length, names: names.slice(0, 12) };
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
      Object.prototype.hasOwnProperty.call(settingsOrLabels, "chat_tool_labels") ||
      Object.prototype.hasOwnProperty.call(settingsOrLabels, "mcp_tool_hidden")
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

/**
 * 截主屏 → 轻量描述给主模型（非真摄像头；V5 再接 CAM）。
 * @param {object} [opts]
 * @param {boolean} [opts.skipCapture] 自检用
 * @param {function} [opts.chatCompletion] 可注入
 * @param {string} [opts.why]
 */
async function runCamCheck(opts = {}) {
  const why = String(opts.why || "").trim().slice(0, 120);
  let capture = { ok: false, error: "skip_capture" };
  if (!opts.skipCapture) {
    try {
      const { capturePrimaryScreen } = require("./presence");
      capture = capturePrimaryScreen();
    } catch (e) {
      capture = {
        ok: false,
        error: "capture_throw",
        message: String((e && e.message) || e).slice(0, 120),
      };
    }
  }
  if (!capture.ok) {
    try {
      require("./monitor-log").appendMonitorLog({
        kind: "cam_check",
        monitoringlog: "CAM_CHECK 截屏失败：" + (capture.error || "unknown"),
        call_core: false,
        capture_ok: false,
        woke: false,
      });
    } catch (_) {}
    return {
      ok: false,
      name: "cam_check",
      result: JSON.stringify({
        ok: false,
        capture_ok: false,
        error: capture.error || "capture_failed",
        message: capture.message || "截屏失败，看不到画面",
        why: why || undefined,
      }),
    };
  }

  const { readSettings } = require("../../共读app/gateway/settings");
  const settings = readSettings();
  const model =
    String(settings.sentinel_model || "").trim() ||
    String(settings.llm_model || "").trim() ||
    undefined;
  const chatCompletion =
    opts.chatCompletion ||
    require("../../共读app/gateway/llm").chatCompletion;

  const system =
    "你在描述一张桌面截图，供室友聊天用。用中文写 1～3 句客观短描述：对方大概在看什么/做什么。" +
    "不要朗读隐私文字全文（密码、聊天全文、证件号）；可以说「像在聊天/写文档/看视频」。" +
    "只输出描述正文，不要前缀、不要 JSON。";
  const userContent = [
    {
      type: "text",
      text:
        (why ? "查看原因：" + why + "\n" : "") +
        "请描述这张主屏截图。",
    },
    {
      type: "image_url",
      image_url: {
        url: `data:${capture.mime};base64,${capture.base64}`,
      },
    },
  ];

  try {
    const out = await chatCompletion({
      system,
      messages: [{ role: "user", content: userContent }],
      think: false,
      replyKind: "chat",
      model,
    });
    const { parseThinkBody } = require("../../共读app/gateway/llm");
    const parsed = parseThinkBody((out && out.content) || "", false);
    const scene = String((parsed && parsed.body) || (out && out.content) || "")
      .trim()
      .slice(0, 500);
    if (!scene) {
      return {
        ok: false,
        name: "cam_check",
        result: JSON.stringify({
          ok: false,
          capture_ok: true,
          error: "describe_empty",
          message: "截到了但描述失败",
        }),
      };
    }
    try {
      require("./monitor-log").appendMonitorLog({
        kind: "cam_check",
        monitoringlog: "CAM_CHECK：" + scene.slice(0, 120),
        call_core: false,
        core_reason: why || "",
        capture_ok: true,
        woke: false,
      });
    } catch (_) {}
    return {
      ok: true,
      name: "cam_check",
      result: JSON.stringify({
        ok: true,
        capture_ok: true,
        scene,
        why: why || undefined,
      }),
    };
  } catch (e) {
    return {
      ok: false,
      name: "cam_check",
      result: JSON.stringify({
        ok: false,
        capture_ok: true,
        error: e.code || "describe_failed",
        message: String((e && e.message) || e).slice(0, 160),
      }),
    };
  }
}

/** slots 1～12 → 10～120 分钟；也可传 minutes */
function clampActivityWindowMin(args) {
  const a = args && typeof args === "object" ? args : {};
  let slots = Number(a.slots);
  if (!Number.isFinite(slots) && a.n != null) slots = Number(a.n);
  if (Number.isFinite(slots)) {
    const s = Math.max(1, Math.min(12, Math.floor(slots)));
    return s * 10;
  }
  const min = Number(a.minutes);
  if (Number.isFinite(min)) {
    return Math.max(10, Math.min(120, Math.floor(min)));
  }
  return 60;
}

/**
 * 点歌：网易云/Apple 真卡（或共听当前曲）。聊天工具路径；与共听页弹窗无关，勿删。
 * @param {{ query?: string, name?: string, artist?: string, pick_id?: number, from_presence?: boolean, title?: string }} opts
 */
async function runShareMusic(opts = {}) {
  const a = opts && typeof opts === "object" ? opts : {};
  const fromPresence = !!(a.from_presence || a.fromPresence);
  let name = String(a.name || a.title || "").trim();
  let artist = String(a.artist || "").trim();
  let presence = false;
  if (fromPresence) {
    try {
      const {
        getListenPresence,
      } = require("../../共听app/gateway/listen");
      const pre = getListenPresence();
      if (pre && pre.active && pre.track && pre.track.title) {
        name = String(pre.track.title).trim();
        artist = String(pre.track.artist || artist || "").trim();
        presence = true;
      } else {
        return {
          ok: false,
          name: "share_music",
          result: JSON.stringify({
            ok: false,
            status: "error",
            error: "no_colisten",
            message: "现在没有进行中的共听，直接给歌名点一首吧。",
          }),
        };
      }
    } catch (_) {
      return {
        ok: false,
        name: "share_music",
        result: JSON.stringify({
          ok: false,
          status: "error",
          error: "presence_failed",
          message: "共听状态读不到，改用歌名点歌吧。",
        }),
      };
    }
  }

  if (presence) {
    try {
      const { appendBotMusic } = require("./daily-chat");
      const message = appendBotMusic({
        name,
        artist,
        fromPresence: true,
        recommended: false,
        source: "share_music",
      });
      return {
        ok: true,
        name: "share_music",
        result: JSON.stringify({
          ok: true,
          status: "ready",
          from_presence: true,
          track: {
            name: message.payload.name,
            artist: message.payload.artist || "",
          },
          message,
          hint: "已发共听歌名卡；勿声称正在整曲播放。",
        }),
      };
    } catch (e) {
      return {
        ok: false,
        name: "share_music",
        result: JSON.stringify({
          ok: false,
          status: "error",
          error: e.code || "share_failed",
          message: String((e && e.message) || e).slice(0, 160),
        }),
      };
    }
  }

  const query =
    String(a.query || "").trim() ||
    [name, artist].filter(Boolean).join(" ").trim();
  const pick_id = a.pick_id != null ? a.pick_id : a.pickId;

  async function tryProvider(resolveFn, label) {
    const resolved = await resolveFn(query, { pick_id, limit: 8 });
    if (resolved.status === "needs_choice") {
      return {
        kind: "needs_choice",
        payload: {
          ok: false,
          name: "share_music",
          result: JSON.stringify({
            ok: false,
            status: "needs_choice",
            provider: label,
            candidates: resolved.candidates,
            message: "有多首匹配，请让对方选一首或再用 pick_id 点定。",
            hint: "向用户列出候选歌名+歌手，勿擅自选第一首。",
          }),
        },
      };
    }
    if (resolved.ok && resolved.status === "ready" && resolved.song) {
      return { kind: "ready", song: resolved.song, label };
    }
    return {
      kind: "error",
      err: (resolved && resolved.error) || {
        code: "MUSIC_SOURCE_UNAVAILABLE",
        message: "音乐服务暂时无法连接",
      },
    };
  }

  try {
    let pref = "netease";
    try {
      pref = String(
        require("../../共读app/gateway/settings").readSettings().music_provider ||
          "netease"
      ).trim();
    } catch (_) {}

    const order = [];
    if (pref === "apple") order.push("apple", "netease");
    else if (pref === "auto") order.push("netease", "apple");
    else order.push("netease", "apple");

    let lastErr = null;
    let resolvedSong = null;
    let usedLabel = "";
    for (const p of order) {
      if (p === "netease") {
        const {
          resolvePlayQuery,
        } = require("../../共听app/gateway/netease-catalog");
        const out = await tryProvider(resolvePlayQuery, "netease");
        if (out.kind === "needs_choice") return out.payload;
        if (out.kind === "ready") {
          resolvedSong = out.song;
          usedLabel = "netease";
          break;
        }
        lastErr = out.err;
        continue;
      }
      if (p === "apple") {
        const {
          resolvePlayQuery,
        } = require("../../共听app/gateway/apple-catalog");
        const out = await tryProvider(resolvePlayQuery, "apple");
        if (out.kind === "needs_choice") return out.payload;
        if (out.kind === "ready") {
          resolvedSong = out.song;
          usedLabel = "apple";
          break;
        }
        lastErr = out.err;
      }
    }

    if (!resolvedSong) {
      return {
        ok: false,
        name: "share_music",
        result: JSON.stringify({
          ok: false,
          status: "error",
          error: (lastErr && lastErr.code) || "MUSIC_SOURCE_UNAVAILABLE",
          message:
            (lastErr && lastErr.message) ||
            "音乐服务暂时无法连接（网易云需先起兼容 API）",
        }),
      };
    }

    const song = resolvedSong;
    const { appendBotMusic } = require("./daily-chat");
    const message = appendBotMusic({
      name: song.name,
      artist: song.artist,
      album: song.album,
      provider: song.provider || usedLabel,
      id: song.id,
      song_key: song.song_key,
      apple_url: song.apple_url,
      preview_url: song.preview_url,
      stream_path: song.stream_path,
      cover: song.cover,
      preview_only: usedLabel === "apple" && !!song.preview_url,
      recommended: true,
      source: "share_music",
    });
    try {
      require("../../共听app/gateway/music-session").recordSessionEvent({
        event_type: "ready",
        actor: "companion",
        song,
        note: "点歌卡已备好",
      });
    } catch (_) {}
    try {
      require("../../共听app/gateway/music-playlists").enqueueSong(song);
    } catch (_) {}
    const isNetease = (song.provider || usedLabel) === "netease";
    return {
      ok: true,
      name: "share_music",
      result: JSON.stringify({
        ok: true,
        status: "ready",
        track: {
          provider: song.provider || usedLabel,
          id: song.id,
          name: song.name,
          artist: song.artist || "",
          album: song.album || "",
          preview_only: !isNetease && !!song.preview_url,
          has_stream: isNetease,
          has_apple_url: !!song.apple_url,
        },
        message,
        hint: isNetease
          ? "已发网易云整曲卡（点卡播放）；用一两句提歌名，用户点开才算在听。"
          : "已发 Apple 卡（试听/外链）；勿说正在整曲播放。",
      }),
    };
  } catch (e) {
    return {
      ok: false,
      name: "share_music",
      result: JSON.stringify({
        ok: false,
        status: "error",
        error: e.code || "share_failed",
        message: String((e && e.message) || e).slice(0, 160),
      }),
    };
  }
}

/**
 * 定时监控：预约 / 列表 / 取消。
 * @param {{ action?: string, minutes?: number, at?: string, why?: string, id?: string }} opts
 */
function runScheduleMonitor(opts = {}) {
  const a = opts && typeof opts === "object" ? opts : {};
  const action = String(a.action || "schedule")
    .trim()
    .toLowerCase();
  const {
    scheduleMonitor,
    listMonitors,
    cancelMonitor,
  } = require("./schedule-monitor");
  let out;
  if (action === "list") out = listMonitors();
  else if (action === "cancel") out = cancelMonitor(a.id || a.cancel_id);
  else out = scheduleMonitor({ minutes: a.minutes, at: a.at, why: a.why });
  return {
    ok: !!out.ok,
    name: "schedule_monitor",
    result: JSON.stringify({
      ...out,
      hint: out.ok
        ? "用一两句口语告诉对方约好了/取消了；勿说「监控指令」。"
        : undefined,
    }),
  };
}

/**
 * V4b/查看动态：读 PC 前台采样摘要（不截屏）。
 * @param {{ slots?: number, minutes?: number, why?: string }} opts
 */
function runViewActivity(opts = {}) {
  const why = String(opts.why || "").trim().slice(0, 120);
  const windowMin = clampActivityWindowMin(opts);
  let enabled = false;
  try {
    enabled = !!require("../../共读app/gateway/settings").readSettings()
      .activity_enabled;
  } catch (_) {}
  if (!enabled) {
    return {
      ok: false,
      name: "view_activity",
      result: JSON.stringify({
        ok: false,
        disabled: true,
        error: "activity_disabled",
        message:
          "对方还没开「记录 PC 前台活动」，看不到动态。提醒去设定→双脑监控打开即可。",
        why: why || undefined,
      }),
    };
  }
  try {
    const { summarizeActivity } = require("./activity");
    const sum = summarizeActivity(windowMin, 8);
    const summary = String(sum.text || "").trim();
    try {
      require("./monitor-log").appendMonitorLog({
        kind: "view_activity",
        monitoringlog: summary
          ? "查看动态近" + sum.window_min + "分：" + summary.split("\n")[0]
          : "查看动态近" + sum.window_min + "分：暂无采样",
        call_core: false,
        core_reason: why || "",
        woke: false,
      });
    } catch (_) {}
    return {
      ok: true,
      name: "view_activity",
      result: JSON.stringify({
        ok: true,
        window_min: sum.window_min,
        samples: sum.samples,
        lines: sum.lines || [],
        summary: summary || "（这段时间没有前台采样）",
        why: why || undefined,
        hint: summary
          ? "根据摘要用一两句口语关心对方；勿朗读完整标题堆、勿说「我监控了你」。"
          : "可以说最近没采到窗口，或提醒对方保持活动采样开着。",
      }),
    };
  } catch (e) {
    return {
      ok: false,
      name: "view_activity",
      result: JSON.stringify({
        ok: false,
        error: e.code || "activity_failed",
        message: String((e && e.message) || e).slice(0, 160),
      }),
    };
  }
}

async function runChatTool(name, argsRaw, ctx = {}) {
  const n = String(name || "").trim();
  if (n === "cam_check") {
    const args = parseArgs(argsRaw);
    return runCamCheck({
      why: args.why,
      skipCapture: !!args.skip_capture || !!(ctx && ctx.skipCapture),
      chatCompletion: ctx && ctx.chatCompletion,
    });
  }
  if (n === "view_activity") {
    const args = parseArgs(argsRaw);
    return runViewActivity({
      slots: args.slots != null ? args.slots : args.n,
      minutes: args.minutes,
      why: args.why,
    });
  }
  if (n === "schedule_monitor") {
    const args = parseArgs(argsRaw);
    return runScheduleMonitor(args);
  }
  if (n === "share_music") {
    const args = parseArgs(argsRaw);
    return await runShareMusic(args);
  }
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
    console.assert(catalog.ok && catalog.tools.length >= 8);
    console.assert(catalog.tools.every((t) => t.enabled === true));
    console.assert(catalog.tools.some((t) => t.name === "calendar_list_events"));
    console.assert(catalog.tools.some((t) => t.name === "cam_check"));
    console.assert(catalog.tools.some((t) => t.name === "view_activity"));
    console.assert(catalog.tools.some((t) => t.name === "schedule_monitor"));
    console.assert(catalog.tools.some((t) => t.name === "share_music"));
    console.assert(
      catalog.tools.find((t) => t.name === "calendar_list_events").label === "查行程"
    );
    console.assert(resolveToolLabel("cam_check") === "看一眼屏幕");
    console.assert(resolveToolLabel("view_activity") === "查看动态");
    console.assert(resolveToolLabel("schedule_monitor") === "定时监控");
    console.assert(resolveToolLabel("share_music") === "点歌");
    console.assert(
      summarizeToolResult(
        "cam_check",
        JSON.stringify({ ok: true, scene: "在看文档" }),
        true
      ).includes("已看")
    );
    console.assert(clampActivityWindowMin({ slots: 3 }) === 30);
    console.assert(clampActivityWindowMin({ slots: 99 }) === 120);
    console.assert(clampActivityWindowMin({}) === 60);
    const actOff = runViewActivity({ slots: 1, why: "自检" });
    console.assert(actOff.name === "view_activity");
    console.assert(
      summarizeToolResult(
        "view_activity",
        JSON.stringify({
          ok: true,
          window_min: 30,
          samples: 2,
          summary: "约2分 Code · foo.js",
        }),
        true
      ).includes("近30分")
    );
    const sched = await runChatTool("schedule_monitor", {
      minutes: 30,
      why: "工具自检预约",
    });
    console.assert(sched.ok && sched.name === "schedule_monitor");
    const schedJob = JSON.parse(sched.result).job;
    console.assert(schedJob && schedJob.id);
    console.assert(
      summarizeToolResult(
        "schedule_monitor",
        JSON.stringify({ ok: true, job: { fire_local: "2026-01-01 12:30", status: "pending" } }),
        true
      ).includes("12:30")
    );
    const listedM = await runChatTool("schedule_monitor", { action: "list" });
    console.assert(listedM.ok);
    const cancelM = await runChatTool("schedule_monitor", {
      action: "cancel",
      id: schedJob.id,
    });
    console.assert(cancelM.ok);
    console.assert(
      summarizeToolResult(
        "share_music",
        JSON.stringify({ ok: true, track: { name: "夜曲", artist: "周杰伦" } }),
        true
      ).includes("夜曲")
    );
    const song = await runChatTool("share_music", {
      query: "夜曲 周杰伦",
    });
    console.assert(song.name === "share_music");
    const songBody = JSON.parse(song.result);
    if (song.ok && songBody.message) {
      console.assert(songBody.message.kind === "music");
      console.assert(songBody.message.payload && songBody.message.payload.provider === "apple");
      try {
        const { readAll, writeAll, withPeer, DEFAULT_PEER_ID } = require("./daily-chat");
        const mid = songBody.message.id;
        withPeer(DEFAULT_PEER_ID, () => {
          const all = readAll();
          all.messages = (all.messages || []).filter((m) => m && m.id !== mid);
          writeAll(all);
        });
      } catch (_) {}
    } else {
      console.assert(
        songBody.status === "error" || songBody.status === "needs_choice",
        songBody
      );
    }
    const camFail = await runChatTool("cam_check", { why: "自检", skip_capture: true });
    console.assert(camFail.ok === false && camFail.name === "cam_check");
    const camOk = await runCamCheck({
      skipCapture: false,
      why: "自检",
      chatCompletion: async () => ({ content: "自检：看见桌面" }),
    });
    if (camOk.ok) {
      const o = JSON.parse(camOk.result);
      console.assert(o.scene && String(o.scene).includes("自检"));
    }
    const hiddenBundle = await getToolBundle({ mcp_tool_hidden: ["never_real_mcp_x"] });
    console.assert(hiddenBundle.defs.length >= 4);
    console.assert(hiddenBundle.catalog.every((t) => t.source !== "mcp" || t.enabled !== false));
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
  CAM_CHECK_DELAY_SEC,
  runChatTool,
  runCamCheck,
  runViewActivity,
  runScheduleMonitor,
  runShareMusic,
  clampActivityWindowMin,
  parseArgs,
  listChatTools,
  pingMcpConnection,
  resolveToolLabel,
  summarizeToolResult,
  getToolBundle,
  clearMcpToolsCache,
};
