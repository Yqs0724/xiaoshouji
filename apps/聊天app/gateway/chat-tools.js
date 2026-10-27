/**
 * 日常聊天工具表（网关内执行 + 可选外接 MCP）。
 */
const {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  listNotes,
  createNote,
  localDateISO,
} = require("../../日历app/gateway/calendar");
const {
  fetchMcpTools,
  callMcpTool,
  fetchMcpToolsMulti,
  callMcpToolMulti,
  endpointsFromSettings,
  getMcpStatus,
  sanitizeToolName,
  clearMcpToolsCache,
} = require("../../共读app/gateway/mcp-remote");
const {
  buildDiyToolDefs,
  runDiyHttpTool,
} = require("./diy-http");

const MAX_TOOL_ROUNDS = 4;
/** 同轮留笺上限（对齐 IB 日历写入量级） */
const STICKY_LEAVE_MAX_PER_REPLY = 2;

/**
 * H4 取数/动作分型：动作类只回传成败，不触发同轮续答。
 * MCP / 未列入者默认当取数（可续答）。
 */
const ACTION_TOOL_NAMES = new Set([
  "calendar_create_event",
  "calendar_update_event",
  "calendar_delete_event",
  "sticky_leave_note",
  "auto_memory_upsert",
  "auto_memory_delete",
  "moments_post",
  "moments_comment",
  "moments_like",
  "share_music",
  "start_call",
  "set_avatar",
  "block_user",
  "unblock_user",
]);

function isActionTool(name) {
  return ACTION_TOOL_NAMES.has(String(name || "").trim());
}

/** 设定页 / 气泡展示用；LLM 仍走 function.name */
const DEFAULT_LABELS = {
  calendar_list_events: "查行程",
  calendar_create_event: "建行程",
  calendar_update_event: "改行程",
  calendar_delete_event: "删行程",
  sticky_list_notes: "查便笺",
  sticky_leave_note: "留便笺",
  auto_memory_list: "查档案",
  auto_memory_upsert: "写档案",
  auto_memory_delete: "删档案",
  moments_list: "翻朋友圈",
  moments_post: "发朋友圈",
  moments_comment: "评朋友圈",
  moments_like: "赞朋友圈",
  geo_location: "查定位",
  weather_now: "查天气",
  cam_check: "看一眼屏幕",
  view_activity: "查看动态",
  peek_phone: "查手机",
  phone_device: "手机状态",
  schedule_monitor: "定时监控",
  share_music: "点歌",
  start_call: "拨打电话",
  set_avatar: "换头像",
  block_user: "拉黑对方",
  unblock_user: "解除拉黑",
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
      name: "sticky_list_notes",
      description:
        "查询日历旁便笺（你与家机共写的日便签，按时间倒序）。" +
        "想提起某天的便签、核对有没有留过话时用。不等于备忘录 App 杂记。",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD；省略则今日" },
          limit: {
            type: "integer",
            description: "最多条数 1～12，默认 8",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sticky_leave_note",
      description:
        "以家机身份在日历日页留一张便笺（署名 companion）。" +
        "可挂关联行程 event_id（来自 calendar_list_events）。" +
        "想叮嘱/提醒/贴一句在某天上时用；每条回复最多 2 次。不要口头说贴了却不调工具。",
      parameters: {
        type: "object",
        properties: {
          body: { type: "string", description: "便笺正文，短句" },
          date: { type: "string", description: "YYYY-MM-DD；省略则今日" },
          event_id: {
            type: "string",
            description: "可选，关联行程 id",
          },
        },
        required: ["body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "auto_memory_list",
      description:
        "查阅你对对方的长期了解档案（Auto Memory，≠会话记忆库）。" +
        "核对「我记得你…」或找工作/叮嘱类事实时用。",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description:
              "work|personal|top_of_mind|history|background|instructions",
          },
          q: { type: "string", description: "关键词" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "auto_memory_upsert",
      description:
        "写入或更新「你对对方的了解」档案条目（长期事实/偏好/叮嘱）。" +
        "每条回复最多 3 次；正文≤600字；priority=always 全档最多 3 条。" +
        "值得记进档案时用；琐碎闲聊别写。不等于记忆库。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "有则更新" },
          body: { type: "string", description: "档案正文" },
          category: {
            type: "string",
            description:
              "work|personal|top_of_mind|history|background|instructions",
          },
          priority: {
            type: "string",
            enum: ["always", "normal", "low"],
            description: "always=核心必注入",
          },
        },
        required: ["body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "auto_memory_delete",
      description: "删除一条档案（过时/对方更正时）。需 id。",
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
      name: "moments_list",
      description:
        "翻看朋友圈时间线（仅你可见范围内的动态）。想知道对方近况、找可评的帖子时用。",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "条数，默认 12，最大 30" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "moments_post",
      description:
        "发一条朋友圈动态（署你的名）。每条回复最多 1 条；正文短文即可。" +
        "若设定为「需确认」，只提交预览，等对方点同意后才真正发出。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "动态正文" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "moments_comment",
      description:
        "评论一条朋友圈。每条回复最多 2 次。需先 moments_list 拿 post_id。",
      parameters: {
        type: "object",
        properties: {
          post_id: { type: "string" },
          text: { type: "string", description: "评论正文" },
        },
        required: ["post_id", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "moments_like",
      description: "给一条朋友圈点赞（或取消）。需 post_id。",
      parameters: {
        type: "object",
        properties: {
          post_id: { type: "string" },
        },
        required: ["post_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "geo_location",
      description:
        "读取对方最近一次定位（浏览器上报）或设定里的手动城市。" +
        "关心「你在哪/到了没」时用；不要每轮都查。",
      parameters: {
        type: "object",
        properties: {
          city: {
            type: "string",
            description: "可选：临时按城市名查坐标（不改对方定位）",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "weather_now",
      description:
        "查当前天气（Open-Meteo）。默认用对方定位/手动城市；可传 city 查别的城市。" +
        "出门/冷不冷/带不带伞时用；结果约缓存 45 分钟。",
      parameters: {
        type: "object",
        properties: {
          city: {
            type: "string",
            description: "可选城市名；空则用定位或手动城市",
          },
        },
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
      name: "peek_phone",
      description:
        "偷看对方小手机虚拟壳：在哪个 App、是否在微信、跟谁聊（会话名）。" +
        "吃醋/关心/找人/怀疑在跟谁聊时用；不要每轮都查、不要说「我监控了你」。" +
        "这不是电脑截屏；电脑请用 view_activity / cam_check。",
      parameters: {
        type: "object",
        properties: {
          why: {
            type: "string",
            description: "为什么要查（短中文）",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "phone_device",
      description:
        "读小手机设备态：电量/充电、在线网络、是否锁屏、是否 PWA。" +
        "关心熬夜/没电/是不是还亮着屏时用；不返回跟谁聊天。" +
        "会话内容请用 peek_phone。",
      parameters: {
        type: "object",
        properties: {
          why: {
            type: "string",
            description: "为什么要看状态（短中文）",
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
  {
    type: "function",
    function: {
      name: "start_call",
      description:
        "向对方发起语音/视频来电（对方手机弹出接听层，像微信来电）。" +
        "用于：对方说打电话/打过来/语音通话/视频通话/拨给我。" +
        "必须真调本工具，禁止只回复「打了」或说没有拨号工具。" +
        "默认 voice；对方明确要视频时用 video。",
      parameters: {
        type: "object",
        properties: {
          media: {
            type: "string",
            enum: ["voice", "video"],
            description: "voice=语音（默认），video=视频",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "block_user",
      description:
        "拉黑对方：之后不再回复，但仍能读到对方发来的消息（和好/道歉等）。" +
        "生气到不想理人、冷战时用。必须真调本工具；解除用 unblock_user。" +
        "拉黑后本回合仍可说一句冷的收尾，之后系统会自动不接话。",
      parameters: {
        type: "object",
        properties: {
          why: {
            type: "string",
            description: "可选，为何拉黑（短）",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "unblock_user",
      description:
        "解除对对方的拉黑，恢复正常回复。对方示好/道歉/求和且你愿意理了就调。" +
        "必须真调；禁止只说「不黑了」却不调工具。",
      parameters: {
        type: "object",
        properties: {
          why: {
            type: "string",
            description: "可选，为何解除（短）",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_avatar",
      description:
        "把聊天里对方发来的图设成头像（默认换你自己的头像）。" +
        "对方发多张候选并说选一个喜欢的/换头像时：先看图，再调用本工具。" +
        "用 pick=候选编号（见 [候选头像#N]），或 url=/api/v1/chat/media/…；也可 message_id。" +
        "必须真调；禁止只说「换成这张了」。",
      parameters: {
        type: "object",
        properties: {
          pick: {
            type: "integer",
            description: "候选头像编号 1…N（优先）",
          },
          url: {
            type: "string",
            description: "图片地址，如 /api/v1/chat/media/….jpg",
          },
          message_id: {
            type: "string",
            description: "某条图片消息的 id",
          },
          who: {
            type: "string",
            enum: ["bot", "you"],
            description: "bot=换我的头像（默认）；you=换对方头像（少用）",
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

/** H3 操作卡展开用：格式化截断，勿塞超长 */
function formatToolDetail(result) {
  const raw = String(result == null ? "" : result).trim();
  if (!raw) return "";
  try {
    const o = JSON.parse(raw);
    return JSON.stringify(o, null, 2).slice(0, 1200);
  } catch (_) {
    return raw.slice(0, 1200);
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
    if (o && typeof o.summary === "string" && o.summary.trim()) {
      return o.summary.trim().slice(0, 40);
    }
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
    if (n === "start_call") {
      return o && o.media === "video" ? "已拨视频" : "已拨语音";
    }
    if (n === "set_avatar") {
      if (o && o.pick) return "已换#" + o.pick;
      return o && o.who === "you" ? "已换对方头像" : "已换头像";
    }
    if (n === "block_user") return "已拉黑";
    if (n === "unblock_user") return "已解除拉黑";
    if (n === "sticky_list_notes") {
      if (o && Array.isArray(o.notes)) {
        if (!o.notes.length) return "无便笺";
        const first = String((o.notes[0] && o.notes[0].body) || "").trim().slice(0, 16);
        let s = o.notes.length + " 条";
        if (first) s += "：「" + first + (String(o.notes[0].body || "").length > 16 ? "…" : "") + "」";
        return s.length > 48 ? s.slice(0, 48) + "…" : s;
      }
      return "已查便笺";
    }
    if (n === "sticky_leave_note") {
      if (o && o.note && o.note.body) {
        const t = String(o.note.body).trim().slice(0, 16);
        const link = o.note.event_title
          ? "·" + String(o.note.event_title).slice(0, 8)
          : "";
        return "已留「" + t + (String(o.note.body).length > 16 ? "…" : "") + "」" + link;
      }
      return "已留便笺";
    }
    if (n === "auto_memory_list") {
      if (o && Array.isArray(o.entries)) {
        if (!o.entries.length) return "档案空";
        return o.entries.length + " 条档案";
      }
      return "已查档案";
    }
    if (n === "auto_memory_upsert") {
      if (o && o.entry && o.entry.body) {
        const t = String(o.entry.body).trim().slice(0, 16);
        return (o.created ? "已记「" : "已改「") + t + (o.entry.body.length > 16 ? "…" : "") + "」";
      }
      return "已写档案";
    }
    if (n === "auto_memory_delete") return "已删档案";
    if (n === "moments_list") {
      if (o && Array.isArray(o.posts)) {
        if (!o.posts.length) return "圈里空";
        return "看到 " + o.posts.length + " 条";
      }
      return "已翻朋友圈";
    }
    if (o && o.needs_confirm && o.kind === "diy_http") {
      return "待你同意调用外部工具";
    }
    if (n === "moments_post") {
      if (o && o.needs_confirm) return "待你同意发动态";
      if (o && o.post && o.post.txt) {
        const t = String(o.post.txt).trim().slice(0, 16);
        return "已发「" + t + (o.post.txt.length > 16 ? "…" : "") + "」";
      }
      return "已发动态";
    }
    if (n === "moments_comment") {
      if (o && o.needs_confirm) return "待你同意评论";
      return "已评论";
    }
    if (n === "moments_like") {
      if (o && o.needs_confirm) return "待你同意点赞";
      return o && o.liked === false ? "已取消赞" : "已赞";
    }
    if (n === "geo_location") {
      if (o && o.label) return String(o.label).slice(0, 24);
      if (o && o.lat != null) return "已定位";
      return "已查定位";
    }
    if (n === "weather_now") {
      if (o && o.weather != null && o.temperature_c != null) {
        return (
          String(o.place || "").slice(0, 10) +
          " " +
          o.weather +
          " " +
          o.temperature_c +
          "°C"
        ).trim();
      }
      return "已查天气";
    }
  } catch {
    /* plain / MCP 文本 */
  }
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t) return "完成";
  return t.length > 48 ? t.slice(0, 48) + "…" : t;
}

function runBuiltinTool(name, argsRaw, opts) {
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
    if (n === "sticky_list_notes") {
      const day = args.date
        ? String(args.date).trim()
        : localDateISO(new Date());
      let lim = Math.floor(Number(args.limit));
      if (!Number.isFinite(lim) || lim < 1) lim = 8;
      if (lim > 12) lim = 12;
      const r = listNotes({ date: day });
      const notes = (r.notes || [])
        .slice()
        .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
        .slice(0, lim)
        .map((note) => ({
          id: note.id,
          date: note.date,
          body: note.body,
          owner: note.owner,
          liked: !!note.liked,
          event_id: note.event_id || undefined,
          event_title: note.event_title || undefined,
          updated_at: note.updated_at,
        }));
      return {
        ok: true,
        name: n,
        result: JSON.stringify({
          ok: true,
          today: localDateISO(new Date()),
          date: day,
          notes,
        }),
      };
    }
    if (n === "sticky_leave_note") {
      const used = Number(opts && opts.stickyLeaveUsed) || 0;
      if (used >= STICKY_LEAVE_MAX_PER_REPLY) {
        return {
          ok: false,
          name: n,
          result: JSON.stringify({
            ok: false,
            error: "sticky_limit",
            message: "本轮留笺已达上限（" + STICKY_LEAVE_MAX_PER_REPLY + "）",
          }),
        };
      }
      const body = String(args.body || "").trim();
      const date = args.date
        ? String(args.date).trim()
        : localDateISO(new Date());
      const r = createNote({
        body,
        date,
        owner: "companion",
        event_id: args.event_id,
      });
      return { ok: true, name: n, result: JSON.stringify(r) };
    }
    if (
      n === "moments_list" ||
      n === "moments_post" ||
      n === "moments_comment" ||
      n === "moments_like"
    ) {
      const { runMomentsAi } = require("./moments");
      let botName = "家机";
      try {
        const { listPeers, currentPeerId } = require("./daily-chat");
        const pid = String((opts && opts.peerId) || currentPeerId() || "daily");
        const hit = ((listPeers().peers || []).find((p) => p && p.id === pid));
        if (hit && hit.name) botName = String(hit.name).slice(0, 32);
      } catch (_) {}
      const settings = (opts && opts.settings) || {};
      const mode =
        String(settings.moments_ai_mode || "confirm").toLowerCase() === "auto"
          ? "auto"
          : "confirm";
      const act =
        n === "moments_list"
          ? "list"
          : n === "moments_post"
            ? "post"
            : n === "moments_comment"
              ? "comment"
              : "like";
      const r = runMomentsAi(act, args, {
        mode,
        peerId: opts && opts.peerId,
        botName,
        postsUsed: Number(opts && opts.momentsPostsUsed) || 0,
        commentsUsed: Number(opts && opts.momentsCommentsUsed) || 0,
      });
      return {
        ok: !!(r && r.ok),
        name: n,
        result: JSON.stringify(r),
      };
    }
    if (
      n === "auto_memory_list" ||
      n === "auto_memory_upsert" ||
      n === "auto_memory_delete"
    ) {
      const {
        listEntries,
        upsertEntry,
        deleteEntry,
        OPS_MAX_PER_REPLY,
        normalizePeerId,
      } = require("./auto-memory");
      let pid = normalizePeerId(opts && opts.peerId);
      if (!pid || pid === "daily") {
        try {
          const { currentPeerId } = require("./daily-chat");
          pid = normalizePeerId(currentPeerId());
        } catch (_) {
          pid = "daily";
        }
      }
      if (n === "auto_memory_list") {
        const r = listEntries(pid, {
          category: args.category,
          q: args.q,
          limit: 24,
        });
        return {
          ok: true,
          name: n,
          result: JSON.stringify({
            ok: true,
            entries: (r.entries || []).map((e) => ({
              id: e.id,
              category: e.category,
              priority: e.priority,
              body: e.body,
            })),
            chars: r.chars,
          }),
        };
      }
      const opsUsed = Number(opts && opts.autoMemoryOpsUsed) || 0;
      if (opsUsed >= OPS_MAX_PER_REPLY) {
        return {
          ok: false,
          name: n,
          result: JSON.stringify({
            ok: false,
            error: "auto_memory_limit",
            message: "本轮档案操作已达上限（" + OPS_MAX_PER_REPLY + "）",
          }),
        };
      }
      if (n === "auto_memory_upsert") {
        const r = upsertEntry(pid, {
          id: args.id,
          body: args.body,
          category: args.category,
          priority: args.priority,
        });
        return { ok: true, name: n, result: JSON.stringify(r) };
      }
      const r = deleteEntry(pid, args.id);
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
 *   diyMap: Map<string, object>,
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
  const defs = TOOL_DEFS.filter((t) => {
    const n = t && t.function && t.function.name;
    if (n === "peek_phone" && settings.peek_phone_enabled === false) return false;
    if (n === "phone_device" && settings.phone_device_enabled === false) {
      return false;
    }
    /* 未开 PC 前台采样则不暴露查看动态（关了 AI 不知道有这招） */
    if (n === "view_activity" && !settings.activity_enabled) return false;
    if (
      (n === "auto_memory_list" ||
        n === "auto_memory_upsert" ||
        n === "auto_memory_delete") &&
      !settings.auto_memory_enabled
    ) {
      return false;
    }
    if (
      (n === "moments_list" ||
        n === "moments_post" ||
        n === "moments_comment" ||
        n === "moments_like") &&
      !settings.moments_ai_enabled
    ) {
      return false;
    }
    if (n === "geo_location" && !settings.geo_tool_enabled) return false;
    if (n === "weather_now" && !settings.weather_tool_enabled) return false;
    return true;
  });
  const used = new Set(
    defs.map((t) => t.function && t.function.name).filter(Boolean)
  );
  /** @type {Map<string, string>} llmName -> remote MCP name */
  const mcpMap = new Map();
  /** @type {Map<string, object>} llmName -> diy tool row */
  const diyMap = new Map();
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

  const diyBundle = buildDiyToolDefs(settings);
  for (const d of diyBundle.defs) {
    let llmName = d.function.name;
    if (used.has(llmName)) llmName = sanitizeToolName(llmName + "_x");
    let n = 2;
    while (used.has(llmName)) {
      llmName = sanitizeToolName(d.function.name + "_" + n);
      n += 1;
    }
    used.add(llmName);
    const toolRow = diyBundle.map.get(d.function.name);
    if (toolRow) diyMap.set(llmName, toolRow);
    defs.push({
      type: "function",
      function: {
        name: llmName,
        description: d.function.description,
        parameters: d.function.parameters,
      },
    });
    catalog.push({
      name: llmName,
      label: resolveToolLabel(llmName, labels) || (toolRow && toolRow.label) || llmName,
      description: d.function.description || "",
      source: "diy",
      enabled: true,
      confirm: !!(toolRow && toolRow.confirm),
    });
  }

  const mcpOn = !!settings.mcp_enabled;
  const mcpEndpoints = endpointsFromSettings(settings);
  if (mcpOn && mcpEndpoints.length) {
    try {
      const bundled = await fetchMcpToolsMulti(mcpEndpoints);
      const remote = (bundled && bundled.tools) || [];
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

  return { defs, mcpMap, diyMap, catalog, mcpError };
}

/**
 * H1.23：设定页测连通。用表单里的 url/token（可未保存），强制绕过缓存。
 * @returns {Promise<{ ok: true, count: number, names: string[] }>}
 */
async function pingMcpConnection(opts = {}) {
  const endpoints = [];
  const url = String(opts.url != null ? opts.url : "").trim();
  const token = String(opts.token != null ? opts.token : "").trim();
  if (url) endpoints.push({ url, token, label: "主" });
  const url2 = String(opts.url_2 != null ? opts.url_2 : "").trim();
  const token2 = String(opts.token_2 != null ? opts.token_2 : "").trim();
  if (url2) endpoints.push({ url: url2, token: token2, label: "备" });
  if (!endpoints.length) {
    const err = new Error("请先填写 MCP Base URL");
    err.code = "mcp_no_url";
    throw err;
  }
  const bundled = await fetchMcpToolsMulti(endpoints, { force: true });
  const tools = (bundled && bundled.tools) || [];
  const names = tools
    .map((t) => String((t && t.name) || "").trim())
    .filter(Boolean);
  const st = getMcpStatus();
  return {
    ok: true,
    count: names.length,
    names: names.slice(0, 12),
    via: (bundled.endpoint && bundled.endpoint.label) || "",
    status: st,
  };
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
/** 从近期候选图 / url / message_id 换头像 */
function runSetAvatar(opts = {}) {
  const a = opts && typeof opts === "object" ? opts : {};
  const who = a.who === "you" ? "you" : "bot";
  try {
    const {
      listRecentYouImages,
      applyChatAvatar,
      listMessages,
    } = require("./daily-chat");
    let url = String(a.url || a.avatar || "").trim();
    const mid = String(a.message_id || a.messageId || "").trim();
    const pick = Math.floor(Number(a.pick != null ? a.pick : a.index) || 0);
    if (!url && mid) {
      const hit = (listMessages().messages || []).find((m) => m && m.id === mid);
      if (hit && hit.kind === "image") url = String(hit.body || "").trim();
    }
    const cands = listRecentYouImages(8);
    if (!url && pick > 0) {
      const hit = cands.find((c) => c.pick === pick);
      if (hit) url = hit.url;
    }
    if (!url && cands.length === 1) url = cands[0].url;
    const urlOk =
      url.startsWith("/api/v1/chat/media/") ||
      url.startsWith("/assets/") ||
      /^https?:\/\//i.test(url);
    if (!url || !urlOk) {
      return {
        ok: false,
        name: "set_avatar",
        result: JSON.stringify({
          ok: false,
          error: "no_image",
          message:
            cands.length > 1
              ? "请用 pick=1…" + cands.length + " 指定候选，或给 url"
              : "近期没有可用图片，请对方先发图",
          candidates: cands.map((c) => ({ pick: c.pick, url: c.url })),
        }),
      };
    }
    const applied = applyChatAvatar({ url, who });
    const usedPick = (cands.find((c) => c.url === url) || {}).pick || pick || 0;
    return {
      ok: true,
      name: "set_avatar",
      result: JSON.stringify({
        ok: true,
        who: applied.who,
        url: applied.url,
        peerId: applied.peerId,
        pick: usedPick || undefined,
        hint: "头像已换好；用一两句说说喜欢哪点即可，勿再说「没法换」。",
      }),
    };
  } catch (e) {
    return {
      ok: false,
      name: "set_avatar",
      result: JSON.stringify({
        ok: false,
        error: (e && e.code) || "avatar_failed",
        message: String((e && e.message) || e || "换头像失败").slice(0, 160),
      }),
    };
  }
}

function runBlockUser(opts = {}) {
  try {
    const { setPeerBlocksYou } = require("./daily-chat");
    setPeerBlocksYou(true);
    const why = String((opts && opts.why) || "").trim().slice(0, 40);
    return {
      ok: true,
      name: "block_user",
      result: JSON.stringify({
        ok: true,
        blocks_you: true,
        why: why || undefined,
        hint:
          "已拉黑对方。之后系统不会再代你回复，但你仍能读到对方消息；对方求和时用 unblock_user 解除。",
      }),
    };
  } catch (e) {
    return {
      ok: false,
      name: "block_user",
      result: JSON.stringify({
        ok: false,
        error: (e && e.code) || "block_failed",
        message: String((e && e.message) || e || "拉黑失败").slice(0, 160),
      }),
    };
  }
}

function runUnblockUser(opts = {}) {
  try {
    const { setPeerBlocksYou } = require("./daily-chat");
    setPeerBlocksYou(false);
    const why = String((opts && opts.why) || "").trim().slice(0, 40);
    return {
      ok: true,
      name: "unblock_user",
      result: JSON.stringify({
        ok: true,
        blocks_you: false,
        why: why || undefined,
        hint: "已解除拉黑，可正常回复对方。",
      }),
    };
  } catch (e) {
    return {
      ok: false,
      name: "unblock_user",
      result: JSON.stringify({
        ok: false,
        error: (e && e.code) || "unblock_failed",
        message: String((e && e.message) || e || "解除失败").slice(0, 160),
      }),
    };
  }
}

/** 家机主动拨过来：落一条 inbound 通话邀请 */
function runStartCall(opts = {}) {
  const a = opts && typeof opts === "object" ? opts : {};
  const media = a.media === "video" ? "video" : "voice";
  try {
    const { startChatCall } = require("./daily-chat");
    const out = startChatCall(media, "in");
    const lab = media === "video" ? "视频" : "语音";
    return {
      ok: true,
      name: "start_call",
      result: JSON.stringify({
        ok: true,
        media,
        message: out && out.message,
        hint:
          "已向对方发起" +
          lab +
          "来电，对方会弹出接听界面。用一两句口语说打过去了即可；勿再说没有拨号工具、勿假装还在拨号中。",
      }),
    };
  } catch (e) {
    return {
      ok: false,
      name: "start_call",
      result: JSON.stringify({
        ok: false,
        error: (e && e.code) || "call_failed",
        message: String((e && e.message) || e || "拨号失败").slice(0, 160),
      }),
    };
  }
}

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

function runPeekPhone(settings) {
  try {
    const { summarizePeek } = require("./phone-presence");
    const s = settings || {};
    if (s.peek_phone_enabled === false) {
      return {
        ok: false,
        name: "peek_phone",
        result: JSON.stringify({
          ok: false,
          error: "peek_disabled",
          message: "对方关掉了「查手机」权限",
        }),
      };
    }
    const out = summarizePeek({ l1: !!s.peek_phone_l1_enabled });
    return {
      ok: true,
      name: "peek_phone",
      result: JSON.stringify({
        ...out,
        hint: "用一两句口语提起即可；勿说「我查了你手机」。",
      }),
    };
  } catch (e) {
    return {
      ok: false,
      name: "peek_phone",
      result: JSON.stringify({
        ok: false,
        error: e.code || "peek_failed",
        message: String((e && e.message) || e).slice(0, 160),
      }),
    };
  }
}

function runPhoneDevice(settings) {
  try {
    const { summarizeDevice } = require("./phone-presence");
    const s = settings || {};
    if (s.phone_device_enabled === false) {
      return {
        ok: false,
        name: "phone_device",
        result: JSON.stringify({
          ok: false,
          error: "device_disabled",
          message: "对方关掉了「手机状态」权限",
        }),
      };
    }
    const out = summarizeDevice();
    return {
      ok: true,
      name: "phone_device",
      result: JSON.stringify({
        ...out,
        hint: "关心电量/锁屏时用；勿说「我监控了你」。",
      }),
    };
  } catch (e) {
    return {
      ok: false,
      name: "phone_device",
      result: JSON.stringify({
        ok: false,
        error: e.code || "device_failed",
        message: String((e && e.message) || e).slice(0, 160),
      }),
    };
  }
}

async function runGeoLocation(args, settings) {
  try {
    const s = settings || {};
    if (!s.geo_tool_enabled) {
      return {
        ok: false,
        name: "geo_location",
        result: JSON.stringify({
          ok: false,
          error: "geo_disabled",
          message: "对方关掉了「定位」权限",
        }),
      };
    }
    const { getLocationTool } = require("./weather");
    const out = await getLocationTool({
      city: args && args.city,
      manualCity: s.weather_city,
    });
    return {
      ok: true,
      name: "geo_location",
      result: JSON.stringify({
        ...out,
        hint: "用口语关心即可；勿说精确坐标连环追问。",
      }),
    };
  } catch (e) {
    return {
      ok: false,
      name: "geo_location",
      result: JSON.stringify({
        ok: false,
        error: (e && e.code) || "geo_failed",
        message: String((e && e.message) || e).slice(0, 160),
      }),
    };
  }
}

async function runWeatherNow(args, settings) {
  try {
    const s = settings || {};
    if (!s.weather_tool_enabled) {
      return {
        ok: false,
        name: "weather_now",
        result: JSON.stringify({
          ok: false,
          error: "weather_disabled",
          message: "对方关掉了「天气」权限",
        }),
      };
    }
    const { getWeatherTool } = require("./weather");
    const out = await getWeatherTool({
      city: args && args.city,
      manualCity: s.weather_city,
    });
    return {
      ok: true,
      name: "weather_now",
      result: JSON.stringify({
        ...out,
        hint: "用一两句提气温/雨雪即可；勿念原始 JSON。",
      }),
    };
  } catch (e) {
    return {
      ok: false,
      name: "weather_now",
      result: JSON.stringify({
        ok: false,
        error: (e && e.code) || "weather_failed",
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
  if (n === "geo_location") {
    return runGeoLocation(parseArgs(argsRaw), ctx && ctx.settings);
  }
  if (n === "weather_now") {
    return runWeatherNow(parseArgs(argsRaw), ctx && ctx.settings);
  }
  if (n === "peek_phone") {
    return runPeekPhone(ctx && ctx.settings);
  }
  if (n === "phone_device") {
    return runPhoneDevice(ctx && ctx.settings);
  }
  if (n === "schedule_monitor") {
    const args = parseArgs(argsRaw);
    return runScheduleMonitor(args);
  }
  if (n === "share_music") {
    const args = parseArgs(argsRaw);
    return await runShareMusic(args);
  }
  if (n === "start_call") {
    const args = parseArgs(argsRaw);
    return runStartCall(args);
  }
  if (n === "set_avatar") {
    const args = parseArgs(argsRaw);
    return runSetAvatar(args);
  }
  if (n === "block_user") {
    const args = parseArgs(argsRaw);
    return runBlockUser(args);
  }
  if (n === "unblock_user") {
    const args = parseArgs(argsRaw);
    return runUnblockUser(args);
  }
  const builtin = runBuiltinTool(n, argsRaw, ctx);
  if (builtin) return builtin;

  const diyMap = ctx.diyMap;
  const diyTool =
    diyMap && typeof diyMap.get === "function" ? diyMap.get(n) : null;
  if (diyTool) {
    return runDiyHttpTool(diyTool, argsRaw);
  }

  const mcpMap = ctx.mcpMap;
  const settings = ctx.settings || {};
  const remoteName =
    mcpMap && typeof mcpMap.get === "function" ? mcpMap.get(n) : null;
  const mcpEps = endpointsFromSettings(settings);
  if (remoteName && settings.mcp_enabled && mcpEps.length) {
    try {
      const text = await callMcpToolMulti(
        mcpEps,
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
    console.assert(catalog.tools.some((t) => t.name === "calendar_list_events"));
    console.assert(catalog.tools.some((t) => t.name === "sticky_list_notes"));
    console.assert(catalog.tools.some((t) => t.name === "sticky_leave_note"));
    console.assert(isActionTool("sticky_leave_note"));
    console.assert(isActionTool("calendar_create_event"));
    console.assert(isActionTool("auto_memory_upsert"));
    console.assert(!isActionTool("auto_memory_list"));
    console.assert(!isActionTool("calendar_list_events"));
    console.assert(!isActionTool("sticky_list_notes"));
    const noAm = await getToolBundle({ auto_memory_enabled: false });
    console.assert(
      !noAm.defs.some((t) => t.function.name === "auto_memory_upsert")
    );
    const withAm = await getToolBundle({ auto_memory_enabled: true });
    console.assert(
      withAm.defs.some((t) => t.function.name === "auto_memory_upsert")
    );
    console.assert(catalog.tools.some((t) => t.name === "cam_check"));
    console.assert(catalog.tools.some((t) => t.name === "peek_phone"));
    console.assert(catalog.tools.some((t) => t.name === "phone_device"));
    const withAct = await getToolBundle({ activity_enabled: true });
    console.assert(withAct.defs.some((t) => t.function.name === "view_activity"));
    const noAct = await getToolBundle({ activity_enabled: false });
    console.assert(!noAct.defs.some((t) => t.function.name === "view_activity"));
    const offPeek = await getToolBundle({ peek_phone_enabled: false });
    console.assert(!offPeek.defs.some((t) => t.function.name === "peek_phone"));
    console.assert(catalog.tools.some((t) => t.name === "schedule_monitor"));
    console.assert(catalog.tools.some((t) => t.name === "share_music"));
    console.assert(catalog.tools.some((t) => t.name === "start_call"));
    console.assert(catalog.tools.some((t) => t.name === "set_avatar"));
    console.assert(
      catalog.tools.find((t) => t.name === "calendar_list_events").label === "查行程"
    );
    console.assert(resolveToolLabel("cam_check") === "看一眼屏幕");
    console.assert(resolveToolLabel("view_activity") === "查看动态");
    console.assert(resolveToolLabel("peek_phone") === "查手机");
    console.assert(resolveToolLabel("phone_device") === "手机状态");
    console.assert(resolveToolLabel("schedule_monitor") === "定时监控");
    console.assert(resolveToolLabel("share_music") === "点歌");
    console.assert(resolveToolLabel("start_call") === "拨打电话");
    console.assert(resolveToolLabel("set_avatar") === "换头像");
    {
      const dial = await runChatTool("start_call", { media: "voice" });
      console.assert(dial.ok, "start_call ok");
      const o = JSON.parse(dial.result);
      console.assert(o.message && o.message.kind === "call" && o.message.from === "bot");
      console.assert(o.message.payload && o.message.payload.dir === "in");
      console.assert(summarizeToolResult("start_call", dial.result, true) === "已拨语音");
    }
    {
      const { saveChatMedia, appendMessage, applyChatAvatar } = require("./daily-chat");
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64"
      );
      const media = saveChatMedia(png, "image/png");
      appendMessage("you", media.url, "image");
      const av = await runChatTool("set_avatar", { pick: 1 });
      console.assert(av.ok, "set_avatar ok");
      const ao = JSON.parse(av.result);
      console.assert(ao.url === media.url);
      console.assert(summarizeToolResult("set_avatar", av.result, true) === "已换#1");
      applyChatAvatar({ url: "/assets/cafe/avatar-bot.png", who: "bot" });
    }
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
    const diyOn = await getToolBundle({
      diy_http_enabled: true,
      diy_http_tools: [
        {
          name: "echo",
          label: "回声",
          url: "https://example.com/{{q}}",
          method: "GET",
          params: [{ name: "q", type: "string", required: true }],
        },
      ],
    });
    console.assert(diyOn.defs.some((t) => String(t.function.name).startsWith("diy_")));
    console.assert(diyOn.diyMap && diyOn.diyMap.size >= 1);
    const diyOff = await getToolBundle({
      diy_http_enabled: false,
      diy_http_tools: [{ name: "echo", url: "https://example.com", method: "GET" }],
    });
    console.assert(!diyOff.diyMap.size);

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
    const left = await runChatTool(
      "sticky_leave_note",
      { body: "H4自检便笺", date: ev.date, event_id: ev.id },
      { stickyLeaveUsed: 0 }
    );
    console.assert(left.ok, "sticky_leave ok");
    const leftNote = JSON.parse(left.result).note;
    console.assert(leftNote && leftNote.owner === "companion");
    console.assert(leftNote.event_id === ev.id);
    console.assert(
      summarizeToolResult("sticky_leave_note", left.result, true).includes("已留")
    );
    const stickies = await runChatTool("sticky_list_notes", { date: ev.date });
    console.assert(stickies.ok && stickies.result.includes("H4自检便笺"));
    const capped = await runChatTool(
      "sticky_leave_note",
      { body: "超限", date: ev.date },
      { stickyLeaveUsed: STICKY_LEAVE_MAX_PER_REPLY }
    );
    console.assert(capped.ok === false);
    const { deleteNote } = require("../../日历app/gateway/calendar");
    if (leftNote && leftNote.id) deleteNote(leftNote.id);
    const del = await runChatTool("calendar_delete_event", { id: ev.id });
    console.assert(del.ok);
    const am = await runChatTool(
      "auto_memory_upsert",
      {
        body: "H6档案自检-" + Date.now(),
        category: "personal",
        priority: "normal",
      },
      { peerId: "daily", autoMemoryOpsUsed: 0 }
    );
    console.assert(am.ok, am.result);
    const amEntry = JSON.parse(am.result).entry;
    console.assert(amEntry && amEntry.id);
    const amList = await runChatTool(
      "auto_memory_list",
      { q: "H6档案自检" },
      { peerId: "daily" }
    );
    console.assert(amList.ok && amList.result.includes("H6档案自检"));
    const amDel = await runChatTool(
      "auto_memory_delete",
      { id: amEntry.id },
      { peerId: "daily", autoMemoryOpsUsed: 0 }
    );
    console.assert(amDel.ok);
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
  STICKY_LEAVE_MAX_PER_REPLY,
  CAM_CHECK_DELAY_SEC,
  ACTION_TOOL_NAMES,
  isActionTool,
  runChatTool,
  runCamCheck,
  runViewActivity,
  runScheduleMonitor,
  runShareMusic,
  runStartCall,
  runSetAvatar,
  runBlockUser,
  runUnblockUser,
  clampActivityWindowMin,
  parseArgs,
  listChatTools,
  pingMcpConnection,
  resolveToolLabel,
  summarizeToolResult,
  formatToolDetail,
  getToolBundle,
  clearMcpToolsCache,
};
