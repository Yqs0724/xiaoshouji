/**
 * 最小自检：列工具 + 只读工具 + notes + start/end 一轮。
 * 用法：node gateway/mcp-check.mjs
 * 若本机锁门，自检期间临时开门，结束时还原。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "gateway", "mcp-server.mjs");
const require = createRequire(import.meta.url);
const { readSettings, patchSettings } = require("./settings.js");

function parseTool(res) {
  const text = res.content && res.content[0] && res.content[0].text;
  if (!text) throw new Error("empty tool result");
  return JSON.parse(text);
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    stderr: "pipe",
  });
  const client = new Client({ name: "coread-mcp-check", version: "0.0.3" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const need = [
    "ask_idle_read",
    "end_coread",
    "get_last_session",
    "get_progress",
    "get_recent_coread_context",
    "get_session_summary",
    "health_check",
    "list_bookshelf",
    "list_notes",
    "open_book",
    "search_notes",
    "set_budget",
    "set_door_lock",
    "set_mode",
    "start_coread",
    "sync_bookshelf",
  ];
  for (const n of need) {
    if (!names.includes(n)) throw new Error("missing tool " + n);
  }

  const health = parseTool(await client.callTool({ name: "health_check", arguments: {} }));
  if (!health.ok) throw new Error("health_check not ok");
  const wasLocked = !!health.door_locked;
  if (wasLocked) {
    const unlocked = parseTool(
      await client.callTool({ name: "set_door_lock", arguments: { locked: false } })
    );
    if (!unlocked.ok) throw new Error("unlock for check failed");
  }

  try {
    for (const name of ["list_bookshelf", "get_last_session", "list_notes"]) {
      const data = parseTool(await client.callTool({ name, arguments: {} }));
      if (!data.ok) throw new Error(name + " not ok: " + JSON.stringify(data));
    }

    {
      const empty = parseTool(
        await client.callTool({ name: "search_notes", arguments: { query: "" } })
      );
      if (empty.ok || empty.error !== "bad_query") {
        throw new Error("search_notes empty should bad_query: " + JSON.stringify(empty));
      }
      const searched = parseTool(
        await client.callTool({
          name: "search_notes",
          arguments: { query: "___no_such_token_xyz___" },
        })
      );
      if (!searched.ok || searched.mode !== "search" || searched.hits.length !== 0) {
        throw new Error("search_notes miss: " + JSON.stringify(searched));
      }
    }

    {
      const noOpen = parseTool(
        await client.callTool({ name: "set_mode", arguments: { mode: "ideas" } })
      );
      if (noOpen.ok || noOpen.error !== "no_open_session") {
        await client.callTool({ name: "end_coread", arguments: {} });
        const again = parseTool(
          await client.callTool({ name: "set_mode", arguments: { mode: "ideas" } })
        );
        if (again.ok || again.error !== "no_open_session") {
          throw new Error("set_mode without open should fail: " + JSON.stringify(again));
        }
      }
    }

    {
      const sync = parseTool(await client.callTool({ name: "sync_bookshelf", arguments: {} }));
      if (sync.ok) {
        if (typeof sync.synced !== "number") throw new Error("sync missing synced count");
      } else if (sync.error !== "weread_key_missing") {
        if (!sync.error) throw new Error("sync_bookshelf bad: " + JSON.stringify(sync));
      }
    }

    const shelf = parseTool(await client.callTool({ name: "list_bookshelf", arguments: {} }));
    const book =
      (shelf.books || []).find((b) => b.id && b.id !== "seed-placeholder") ||
      (shelf.books || [])[0];
    if (!book) throw new Error("no book for start/end check");

    const prog = parseTool(
      await client.callTool({ name: "get_progress", arguments: { book_id: book.id } })
    );
    if (!prog.ok || !prog.book || prog.book.id !== book.id) {
      throw new Error("get_progress failed: " + JSON.stringify(prog));
    }

    {
      const cleared = parseTool(await client.callTool({ name: "end_coread", arguments: {} }));
      if (!cleared.ok && cleared.error !== "no_open_session") {
        throw new Error("pre-end failed: " + JSON.stringify(cleared));
      }
    }

    {
      const opened = parseTool(
        await client.callTool({ name: "open_book", arguments: { book_id: book.id } })
      );
      if (!opened.ok || !opened.selected || !opened.links || !opened.links.pwa_url) {
        throw new Error("open_book failed: " + JSON.stringify(opened));
      }
    }

    const started = parseTool(
      await client.callTool({ name: "start_coread", arguments: { book_id: book.id } })
    );
    if (!started.ok || !started.open) {
      throw new Error("start_coread failed: " + JSON.stringify(started));
    }

    const modeSet = parseTool(
      await client.callTool({ name: "set_mode", arguments: { mode: "ideas" } })
    );
    if (!modeSet.ok || modeSet.open.follow_mode !== "ideas") {
      throw new Error("set_mode failed: " + JSON.stringify(modeSet));
    }

    const budSet = parseTool(
      await client.callTool({ name: "set_budget", arguments: { rmb: 5 } })
    );
    if (!budSet.ok || !(budSet.open.budget_tokens > 0)) {
      throw new Error("set_budget failed: " + JSON.stringify(budSet));
    }

    const resumed = parseTool(
      await client.callTool({ name: "start_coread", arguments: { book_id: book.id } })
    );
    if (!resumed.ok || !resumed.resumed) throw new Error("resume expected");
    if (resumed.open.follow_mode !== "ideas") throw new Error("mode not persisted on resume");

    {
      const idle = parseTool(
        await client.callTool({ name: "ask_idle_read", arguments: { limit: 3 } })
      );
      if (!idle.ok || idle.open !== true || !Array.isArray(idle.entries)) {
        throw new Error("ask_idle_read open: " + JSON.stringify(idle));
      }
    }

    {
      const ctx = parseTool(
        await client.callTool({
          name: "get_recent_coread_context",
          arguments: { limit: 5 },
        })
      );
      if (
        !ctx.ok ||
        ctx.open !== true ||
        !ctx.book ||
        ctx.book.id !== book.id ||
        !Array.isArray(ctx.entries)
      ) {
        throw new Error("get_recent_coread_context open: " + JSON.stringify(ctx));
      }
    }

    const ended = parseTool(await client.callTool({ name: "end_coread", arguments: {} }));
    if (!ended.ok || !ended.session) throw new Error("end_coread failed");
    if (ended.lore_written) throw new Error("end without write_lore should not write lore");

    const last = parseTool(await client.callTool({ name: "get_last_session", arguments: {} }));
    if (!last.session || last.session.id !== ended.session.id) {
      throw new Error("get_last_session mismatch");
    }

    {
      const ctx = parseTool(
        await client.callTool({
          name: "get_recent_coread_context",
          arguments: { limit: 5 },
        })
      );
      if (
        !ctx.ok ||
        ctx.open !== false ||
        !ctx.session ||
        ctx.session.id !== ended.session.id ||
        !Array.isArray(ctx.entries)
      ) {
        throw new Error("get_recent_coread_context closed: " + JSON.stringify(ctx));
      }
    }

    const byOmit = parseTool(
      await client.callTool({ name: "get_session_summary", arguments: {} })
    );
    if (!byOmit.session || byOmit.session.id !== ended.session.id) {
      throw new Error("get_session_summary omit mismatch");
    }
    const byId = parseTool(
      await client.callTool({
        name: "get_session_summary",
        arguments: { session_id: ended.session.id },
      })
    );
    if (!byId.session || byId.session.id !== ended.session.id) {
      throw new Error("get_session_summary by id mismatch");
    }
    const miss = parseTool(
      await client.callTool({
        name: "get_session_summary",
        arguments: { session_id: "no-such-session-id" },
      })
    );
    if (miss.ok || miss.error !== "session_not_found") {
      throw new Error("get_session_summary miss: " + JSON.stringify(miss));
    }

    {
      const idleClosed = parseTool(
        await client.callTool({ name: "ask_idle_read", arguments: {} })
      );
      if (!idleClosed.ok || idleClosed.open !== false) {
        throw new Error("ask_idle_read closed: " + JSON.stringify(idleClosed));
      }
    }

    {
      const started2 = parseTool(
        await client.callTool({ name: "start_coread", arguments: { book_id: book.id } })
      );
      if (!started2.ok) throw new Error("start for lore check failed");
      const withLore = parseTool(
        await client.callTool({
          name: "end_coread",
          arguments: { write_lore: true },
        })
      );
      if (
        !withLore.ok ||
        !withLore.lore_written ||
        !withLore.pass_lore ||
        !String(withLore.pass_lore.text || withLore.lore_summary || "").includes("【本场")
      ) {
        throw new Error("end_coread write_lore failed: " + JSON.stringify(withLore));
      }
    }
  } finally {
    if (wasLocked) {
      await client.callTool({ name: "set_door_lock", arguments: { locked: true } });
    }
  }

  await client.close();
  console.log("mcp ok", names.join(", "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
