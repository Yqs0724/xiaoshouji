/**
 * 共读小屋 MCP（stdio）
 * Chatbox：command=node，args=gateway/mcp-server.mjs，cwd=仓库根
 * 勿往 stdout 打日志。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const require = createRequire(import.meta.url);
const {
  healthFlags,
  readSettings,
  tokensFromBudgetRmb,
  patchSettings,
  assertDoorOpen,
  appendSessionToLore,
} = require("./settings.js");
const { readBooks, syncFromWeread } = require("./books.js");
const { findBook, listNotesIndex, searchNotes } = require("./highlights.js");

const NOTES_HIT_CAP = 30;
const NOTES_CLIP = 120;

function clipNote(s, n) {
  const t = String(s || "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function slimSearchHits(hits) {
  const list = Array.isArray(hits) ? hits : [];
  const truncated = list.length > NOTES_HIT_CAP;
  return {
    hits: list.slice(0, NOTES_HIT_CAP).map((h) => ({
      book_id: h.book_id,
      book_title: h.book_title,
      id: h.id,
      kind: h.kind,
      text: clipNote(h.text, NOTES_CLIP),
      idea: clipNote(h.idea, NOTES_CLIP) || null,
      chapter_title: h.chapter_title || null,
      follow_body: clipNote(h.follow_body, NOTES_CLIP) || null,
    })),
    hit_total: list.length,
    truncated,
  };
}
const {
  listSessions,
  getSession,
  getOpenSession,
  formatDurationMs,
  startSession,
  endSession,
  patchOpenSession,
} = require("./sessions.js");

function sessionCard(session) {
  if (!session) return null;
  return {
    ...session,
    duration_label: formatDurationMs(session.duration_ms),
  };
}

function formatReadSeconds(sec) {
  const n = Number(sec) || 0;
  if (n <= 0) return null;
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  if (h > 0) return h + "小时" + m + "分钟";
  return m + "分钟";
}

function progressPayload(book) {
  const open = getOpenSession();
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    source: book.source,
    in_progress: !!book.in_progress,
    cabin_progress: book.progress ?? 0,
    weread_progress: book.weread_progress ?? null,
    weread_read_seconds: book.weread_read_seconds ?? null,
    weread_read_label: formatReadSeconds(book.weread_read_seconds),
    updated_at: book.updated_at || null,
    session_open: !!(open && open.book_id === book.id),
  };
}

function resolveProgressBook(bookId) {
  if (bookId) {
    const book = findBook(bookId);
    if (!book) {
      const err = new Error("找不到这本书");
      err.code = "book_not_found";
      throw err;
    }
    return book;
  }
  const open = getOpenSession();
  if (open) {
    const b = findBook(open.book_id);
    if (b) return b;
  }
  const active = readBooks().books.find((b) => b.in_progress);
  if (!active) {
    const err = new Error("没有进行中的书，请传 book_id 或先 start_coread / 同步书架");
    err.code = "book_required";
    throw err;
  }
  return active;
}

function jsonText(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
}

function jsonError(e) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: false,
            error: e.code || "error",
            message: e.message || String(e),
            open: e.open || undefined,
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

function requireDoorOpen() {
  assertDoorOpen();
}

function createServer() {
  const server = new McpServer({
    name: "coread-cabin",
    version: "0.2.8",
  });

  server.registerTool(
    "health_check",
    {
      description: "共读小屋连接健康：微信 Key / LLM 是否已配置（读本机设定，不测远端连通）",
    },
    async () => {
      const flags = healthFlags();
      return jsonText({
        ok: true,
        gateway: "data_ok",
        note: "本工具读本地设定文件；HTTP 网关需另开 npm start",
        ...flags,
      });
    }
  );

  server.registerTool(
    "set_door_lock",
    {
      description:
        "开关门（小屋锁）。锁上后停自动跟批与短聊，MCP 读书类工具拒绝；划线仍可入库。locked=true 关门，false 开门。",
      inputSchema: {
        locked: z.boolean().describe("true=关门，false=开门"),
      },
    },
    async ({ locked }) => {
      const s = patchSettings({ door_locked: !!locked });
      return jsonText({
        ok: true,
        door_locked: !!s.door_locked,
        message: s.door_locked ? "已锁门" : "已开门",
      });
    }
  );

  server.registerTool(
    "list_bookshelf",
    {
      description: "列出本机已同步的书架（只读本地缓存，不触发微信同步）",
    },
    async () => {
      try {
        requireDoorOpen();
        const { books } = readBooks();
        const slim = books.map((b) => ({
          id: b.id,
          title: b.title,
          author: b.author,
          source: b.source,
          progress: b.progress,
          weread_progress: b.weread_progress,
          in_progress: !!b.in_progress,
          updated_at: b.updated_at,
        }));
        return jsonText({ ok: true, count: slim.length, books: slim });
      } catch (e) {
        return jsonError(e);
      }
    }
  );

  server.registerTool(
    "sync_bookshelf",
    {
      description:
        "从微信读书同步全量书架到本机（与 PWA「同步书架」相同；进度只刷新最近几本+在读）。需已配置 WEREAD API Key。",
    },
    async () => {
      try {
        requireDoorOpen();
        const key = (readSettings().weread_key || "").trim();
        if (!key) {
          const err = new Error("请先在设定或 .env 填写微信读书 API Key");
          err.code = "weread_key_missing";
          throw err;
        }
        const result = await syncFromWeread(key);
        return jsonText({
          ok: true,
          synced: result.synced,
          progress_enriched: result.progress_enriched,
          total_remote: result.total_remote,
          albums_skipped: result.albums,
          books: (result.books || []).map((b) => ({
            id: b.id,
            title: b.title,
            author: b.author,
            weread_progress: b.weread_progress,
            in_progress: !!b.in_progress,
          })),
          message: `已同步 ${result.synced} 本（进度刷新 ${result.progress_enriched} 本）`,
        });
      } catch (e) {
        return jsonError(e);
      }
    }
  );

  server.registerTool(
    "get_progress",
    {
      description:
        "查询当前书（或指定 book_id）的共读/微信读书进度与累计时长。读本地缓存，不即时打微信。",
      inputSchema: {
        book_id: z
          .string()
          .optional()
          .describe("书架书 id；省略则优先未结束场次，否则进行中的书"),
      },
    },
    async ({ book_id }) => {
      try {
        requireDoorOpen();
        const book = resolveProgressBook(book_id || undefined);
        return jsonText({ ok: true, book: progressPayload(book) });
      } catch (e) {
        return jsonError(e);
      }
    }
  );

  server.registerTool(
    "get_last_session",
    {
      description: "最近一场已结束共读的摘要卡（书名、时长、划线/跟批数、token）",
    },
    async () => {
      const { sessions } = listSessions();
      const last = sessions[0] || null;
      if (!last) {
        return jsonText({ ok: true, session: null, message: "还没有结束过的场次" });
      }
      return jsonText({ ok: true, session: sessionCard(last) });
    }
  );

  server.registerTool(
    "get_session_summary",
    {
      description:
        "取一场已结束共读的摘要卡（与记录 Tab / get_last_session 同库）。给 session_id 则按 id；省略则最近一场。",
      inputSchema: {
        session_id: z
          .string()
          .optional()
          .describe("场次 id；省略则等同 get_last_session"),
      },
    },
    async ({ session_id }) => {
      const id = String(session_id || "").trim();
      if (id) {
        const found = getSession(id);
        if (!found) {
          return jsonError({ code: "session_not_found", message: "找不到这场摘要" });
        }
        return jsonText({ ok: true, session: sessionCard(found) });
      }
      const { sessions } = listSessions();
      const last = sessions[0] || null;
      if (!last) {
        return jsonText({ ok: true, session: null, message: "还没有结束过的场次" });
      }
      return jsonText({ ok: true, session: sessionCard(last) });
    }
  );

  server.registerTool(
    "start_coread",
    {
      description:
        "开场或恢复未结束的同书共读。可选 book_id；省略则用书架进行中的书。返回 open、微信/PWA 链接。异书有未结束场次时会报错，须先 end_coread。",
      inputSchema: {
        book_id: z
          .string()
          .optional()
          .describe("书架书 id（如 wr-xxx）；省略则用 in_progress"),
      },
    },
    async ({ book_id }) => {
      try {
        requireDoorOpen();
        const result = startSession(book_id || undefined);
        return jsonText({
          ok: true,
          resumed: result.resumed,
          open: result.open,
          links: result.links,
          message: result.resumed
            ? `已恢复《${result.open.book_title}》本场`
            : `已开场《${result.open.book_title}》`,
        });
      } catch (e) {
        return jsonError(e);
      }
    }
  );

  server.registerTool(
    "end_coread",
    {
      description:
        "结束当前共读本场，写入摘要卡（与 PWA「结束本场」同一数据）。write_lore 默认 false；true 时才追加到设定·剧情摘要。",
      inputSchema: {
        book_id: z
          .string()
          .optional()
          .describe("可选；默认结束当前 open 场次对应的书"),
        write_lore: z
          .boolean()
          .optional()
          .describe("是否写入长期剧情摘要；默认 false"),
      },
    },
    async ({ book_id, write_lore }) => {
      try {
        const session = endSession(book_id || undefined);
        let lore_summary;
        if (write_lore) {
          const s = appendSessionToLore(session);
          lore_summary = s.lore_summary;
        }
        return jsonText({
          ok: true,
          session: sessionCard(session),
          lore_written: !!lore_summary,
          lore_summary,
          message: `已结束《${session.book_title}》`,
        });
      } catch (e) {
        return jsonError(e);
      }
    }
  );

  server.registerTool(
    "set_mode",
    {
      description:
        "改本场跟批方式（与 PWA「跟批方式」相同；同时记为该书默认）。须已有未结束场次。immersive=沉浸评论，ideas=仅想法，silent=定义静默。",
      inputSchema: {
        mode: z
          .enum(["immersive", "ideas", "silent"])
          .describe("immersive | ideas | silent"),
      },
    },
    async ({ mode }) => {
      try {
        requireDoorOpen();
        const open = patchOpenSession({ follow_mode: mode });
        const labels = {
          immersive: "沉浸评论",
          ideas: "仅想法",
          silent: "定义静默",
        };
        return jsonText({
          ok: true,
          open,
          message: `本场跟批方式 → ${labels[open.follow_mode] || open.follow_mode}`,
        });
      } catch (e) {
        return jsonError(e);
      }
    }
  );

  server.registerTool(
    "set_budget",
    {
      description:
        "改本场跟批额度（与 PWA「跟批额度」相同，人民币体感档）。须已有未结束场次。rmb：0=不限，或 1 / 5 / 10。",
      inputSchema: {
        rmb: z
          .number()
          .describe("人民币档：0 不限，常用 1 / 5 / 10"),
      },
    },
    async ({ rmb }) => {
      try {
        requireDoorOpen();
        const n = Number(rmb);
        if (!Number.isFinite(n) || n < 0) {
          const err = new Error("rmb 须为 ≥0 的数字（0=不限）");
          err.code = "bad_budget";
          throw err;
        }
        const open = patchOpenSession({ budget_tokens: tokensFromBudgetRmb(n) });
        const label =
          n <= 0 ? "不限" : n === 1 || n === 5 || n === 10 ? `约 ${n} 块` : `约 ¥${n}`;
        return jsonText({
          ok: true,
          open,
          budget_rmb: n <= 0 ? 0 : n,
          message: `本场额度 → ${label}（已用 token ${open.tokens_used || 0}）`,
        });
      } catch (e) {
        return jsonError(e);
      }
    }
  );

  server.registerTool(
    "list_notes",
    {
      description:
        "按书列出本机已同步笔记索引（划线/想法/跟批数量）。只读本地，不打微信。锁门时拒绝。",
    },
    async () => {
      try {
        requireDoorOpen();
        const data = listNotesIndex();
        return jsonText({
          ok: true,
          count: (data.books || []).length,
          books: data.books || [],
        });
      } catch (e) {
        return jsonError(e);
      }
    }
  );

  server.registerTool(
    "search_notes",
    {
      description:
        "关键词搜本机笔记：书名/作者/划线/想法/章节/跟批。返回精简命中（最多 30 条）。锁门时拒绝。",
      inputSchema: {
        query: z.string().describe("搜索词，勿传空"),
      },
    },
    async ({ query }) => {
      try {
        requireDoorOpen();
        const q = String(query || "").trim();
        if (!q) {
          const err = new Error("query 不能为空；列索引请用 list_notes");
          err.code = "bad_query";
          throw err;
        }
        const data = searchNotes(q);
        const slim = slimSearchHits(data.hits);
        return jsonText({
          ok: true,
          query: data.query,
          mode: data.mode,
          books: (data.books || []).map((b) => ({
            id: b.id,
            title: b.title,
            author: b.author,
            hit_count: b.hit_count || 0,
            title_match: !!b.title_match,
            mark_count: b.mark_count,
            idea_count: b.idea_count,
            follow_count: b.follow_count,
          })),
          ...slim,
        });
      } catch (e) {
        return jsonError(e);
      }
    }
  );

  return server;
}

export { createServer };

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("coread-cabin MCP (stdio) ready");
}

const isMain =
  !!process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
