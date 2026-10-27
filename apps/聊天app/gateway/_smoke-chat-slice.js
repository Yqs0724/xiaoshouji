/**
 * 冒烟：新建 peer / 位置 payload / 文件摘录 / 记忆追溯&脱水骨架 / 情绪批处理。
 * 不走 HTTP（避访问门），直接打模块。跑完删测试 peer。
 */
const path = require("node:path");
const fs = require("node:fs");

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert");
}

async function main() {
  const daily = require("./daily-chat");
  const fileEx = require("./file-excerpt");
  const memory = require("./memory");
  const mood = require("./mood");

  fileEx.selfCheck();
  console.log("[ok] file-excerpt");

  const created = daily.createPeer({ name: "冒烟测试-" + Date.now().toString(36).slice(-4) });
  assert(created && created.ok && created.peer && created.peer.id, "createPeer");
  const pid = created.peer.id;
  console.log("[ok] createPeer", pid);

  const renamed = daily.renamePeer(pid, "冒烟改名");
  assert(renamed.peer.name === "冒烟改名", "renamePeer");
  console.log("[ok] renamePeer");

  const group = daily.createPeer({
    name: "冒烟群",
    kind: "group",
    members: ["daily", "mint"],
  });
  assert(group.peer.kind === "group", "group kind");
  assert(
    Array.isArray(group.peer.members) && group.peer.members.includes("daily"),
    "group members"
  );
  console.log("[ok] createGroup", group.peer.id);

  const loc = daily.normalizeLocationPayload
    ? null
    : null;
  /* normalizeLocationPayload 未导出时用发消息路径 */
  const withPeer = daily.withPeer;
  const msg = withPeer(pid, () =>
    daily.createMessage({
      kind: "location",
      name: "咖啡馆",
      detail: "一楼",
      lat: 24.4797,
      lng: 118.0894,
    })
  );
  assert(msg && msg.message && msg.message.kind === "location", "location msg");
  assert(
    msg.message.payload &&
      Number(msg.message.payload.lat) > 20 &&
      Number(msg.message.payload.lng) > 100,
    "location coords"
  );
  console.log("[ok] location+coords");

  const xml = Buffer.from(
    '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>冒烟正文docx</w:t></w:r></w:p></w:body></w:document>'
  );
  const name = Buffer.from("word/document.xml");
  const local = Buffer.alloc(30 + name.length + xml.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(xml.length, 18);
  local.writeUInt32LE(xml.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  xml.copy(local, 30 + name.length);
  const excerpt = fileEx.excerptDocx(local);
  assert(/冒烟正文docx/.test(excerpt), "docx excerpt");
  console.log("[ok] docx excerpt");

  const mem = memory.addMemory(pid, {
    content: "冒烟记忆一条喜欢薄巧",
    keywords: ["薄巧"],
    importance: 6,
    source_start_ts: Date.now() - 1000,
    source_end_ts: Date.now(),
  });
  assert(mem && mem.memory && mem.memory.id, "addMemory");
  const traced = memory.traceMemorySource(pid, mem.memory.id);
  assert(traced && traced.ok, "traceMemorySource");
  console.log("[ok] memory trace", (traced.messages || []).length, "msgs");

  const m2 = memory.addMemory(pid, {
    content: "还是很喜欢薄巧蛋糕",
    keywords: ["薄巧", "蛋糕"],
    importance: 4,
    source_start_ts: Date.now() - 2000,
    source_end_ts: Date.now() - 1000,
  });
  const m3 = memory.addMemory(pid, {
    content: "薄巧口味的点心不错",
    keywords: ["薄巧"],
    importance: 3,
    source_start_ts: Date.now() - 3000,
    source_end_ts: Date.now() - 2000,
  });
  assert(m2.memory && m3.memory, "dehydrate seeds");
  const dropIds = [mem.memory.id, m2.memory.id, m3.memory.id];
  let dehyd;
  try {
    dehyd = await memory.dehydrateMemories(pid, {});
    console.log(
      "[ok] dehydrate llm",
      dehyd.merged ? "merged" : dehyd.message || "noop",
      "removed",
      (dehyd.removed || []).length
    );
  } catch (e) {
    if ((e && e.code) !== "llm_not_configured" && (e && e.code) !== "llm_http") {
      throw e;
    }
    dehyd = await memory.dehydrateMemories(pid, {
      chatCompletion: async () => ({
        content:
          '嗯\n```json\n{"content":"喜欢薄巧点心","keywords":["薄巧"],"importance":5,"drop_ids":' +
          JSON.stringify(dropIds) +
          "}\n```",
        tokens_in: 12,
        tokens_out: 20,
      }),
    });
    console.log("[ok] dehydrate mock (llm unavailable)", (dehyd.removed || []).length);
  }
  assert(dehyd && dehyd.ok, "dehydrate ok");
  if (dehyd.merged) {
    assert((dehyd.removed || []).length >= 2, "dehydrate removed");
    assert(dehyd.merged.tags && dehyd.merged.tags.includes("dehydrate"), "tag");
  }

  const batch = await mood.runMoodBatch({ force: true });
  assert(batch && batch.ok, "mood batch");
  console.log("[ok] mood batch scanned", batch.scanned, "hits", batch.hits);

  const pub = mood.getMoodPublic({ peerId: pid });
  assert(pub && pub.decayCurve && Array.isArray(pub.decayCurve.series), "decayCurve");
  assert(pub.decayCurve.series.length === 3, "decay 3 series");
  console.log("[ok] decayCurve");

  const lex0 = mood.listLexiconPublic();
  assert(lex0 && lex0.ok && lex0.builtin > 50, "lexicon list");
  const word = "冒烟词" + Date.now().toString(36).slice(-4);
  const lex1 = mood.addLexiconExtra({ w: word, v: -0.4, a: 0.5, i: 5 });
  assert(lex1.extra.some((e) => e.w === word), "lex add");
  const lex2 = mood.removeLexiconExtra(word);
  assert(!lex2.extra.some((e) => e.w === word), "lex del");
  console.log("[ok] lexicon extra");

  withPeer(pid, () => {
    daily.setPeerBlocksYou(true);
    assert(daily.peerBlocksYou(), "blocks_you");
    assert(daily.maybeSoftUnblockFromText("消消气我们和好吧"), "soft unblock");
    assert(!daily.peerBlocksYou(), "unblocked");
    const blocked = daily.createMessage({
      kind: "text",
      body: "拉黑测感叹号",
      blocked_send: true,
    });
    assert(blocked.message && blocked.message.blocked_send, "blocked_send");
  });
  console.log("[ok] block soft + blocked_send");

  const persona = daily.updatePeer(pid, { persona: "冒烟人设：爱吃草莓" });
  assert(persona.peer && persona.peer.persona.indexOf("草莓") >= 0, "peer persona");
  console.log("[ok] peer persona");

  const vaPeer = daily.createPeer({
    name: "共鸣测-" + Date.now().toString(36).slice(-3),
  });
  const vaid = vaPeer.peer.id;
  memory.addMemory(vaid, {
    content: "那年难过到哭",
    category: "日常",
    valence: -0.7,
    arousal: 0.5,
    importance: 6,
    unresolved: false,
  });
  memory.addMemory(vaid, {
    content: "春天很开心去野餐",
    category: "日常",
    valence: 0.7,
    arousal: 0.55,
    importance: 5,
    unresolved: false,
  });
  const hits = await memory.recallForTurn(vaid, "我现在好难过", 3, {
    sentinel: { mode: "search", keywords: ["难过"], topic: "" },
  });
  assert(hits.length >= 1, "recall hits");
  const top = hits[0];
  assert(Number(top.valence) < 0, "va resonance prefers neg");
  console.log("[ok] va resonance", top.content.slice(0, 12));

  daily.deletePeer(pid);
  daily.deletePeer(group.peer.id);
  daily.deletePeer(vaid);
  console.log("[ok] cleanup peers");

  console.log("SMOKE PASS");
}

main().catch((e) => {
  console.error("SMOKE FAIL", e && e.message, e && e.stack);
  process.exit(1);
});
