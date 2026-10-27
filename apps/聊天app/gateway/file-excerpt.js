/**
 * 非文本文件正文摘录（docx / xlsx / pdf 粗提）。
 * ponytail: 无第三方库；PDF 只抽可打印串，复杂版式会漏；要准再接专用解析器。
 */
const zlib = require("node:zlib");

const TEXT_MAX = 8 * 1024;

function stripXml(s) {
  return String(s || "")
    .replace(/<w:tab[^/]*\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n) || 32))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 极简 ZIP：只读 store / deflate 条目，按名取文件 */
function zipRead(buf, wantNames) {
  const out = {};
  const want = new Set(
    (wantNames || []).map((n) => String(n).replace(/^\/+/, ""))
  );
  let i = 0;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  while (i + 30 <= b.length) {
    if (b.readUInt32LE(i) !== 0x04034b50) break;
    const method = b.readUInt16LE(i + 8);
    const compSize = b.readUInt32LE(i + 18);
    const nameLen = b.readUInt16LE(i + 26);
    const extraLen = b.readUInt16LE(i + 28);
    const name = b.slice(i + 30, i + 30 + nameLen).toString("utf8");
    const start = i + 30 + nameLen + extraLen;
    const end = start + compSize;
    if (end > b.length) break;
    if (!want.size || want.has(name)) {
      const raw = b.slice(start, end);
      try {
        if (method === 0) out[name] = raw;
        else if (method === 8) out[name] = zlib.inflateRawSync(raw);
      } catch (_) {
        /* skip bad entry */
      }
    }
    i = end;
    if (want.size && Object.keys(out).length >= want.size) break;
  }
  return out;
}

function excerptDocx(buf) {
  const files = zipRead(buf, ["word/document.xml"]);
  const xml = files["word/document.xml"];
  if (!xml) return "";
  return stripXml(xml.toString("utf8")).slice(0, TEXT_MAX);
}

function excerptXlsx(buf) {
  const files = zipRead(buf, [
    "xl/sharedStrings.xml",
    "xl/worksheets/sheet1.xml",
  ]);
  const parts = [];
  const ss = files["xl/sharedStrings.xml"];
  if (ss) {
    const xml = ss.toString("utf8");
    const re = /<t[^>]*>([^<]*)<\/t>/g;
    let m;
    while ((m = re.exec(xml))) {
      const t = String(m[1] || "").trim();
      if (t) parts.push(t);
      if (parts.join(" ").length > TEXT_MAX) break;
    }
  }
  const sheet = files["xl/worksheets/sheet1.xml"];
  if (sheet && parts.join(" ").length < TEXT_MAX) {
    const xml = sheet.toString("utf8");
    const re = /<v>([^<]*)<\/v>/g;
    let m;
    while ((m = re.exec(xml))) {
      const t = String(m[1] || "").trim();
      if (t && !/^\d+(\.\d+)?$/.test(t)) parts.push(t);
      if (parts.join(" ").length > TEXT_MAX) break;
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);
}

function excerptPdf(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString("latin1") : String(buf);
  const chunks = [];
  const re = /\((?:\\.|[^\\)]){1,200}\)/g;
  let m;
  while ((m = re.exec(s))) {
    let t = m[0].slice(1, -1);
    t = t
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "")
      .replace(/\\t/g, "\t")
      .replace(/\\(.)/g, "$1");
    if (/[\x00-\x08\x0e-\x1f]/.test(t)) continue;
    if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(t)) continue;
    chunks.push(t);
    if (chunks.join("").length > TEXT_MAX) break;
  }
  return chunks.join("").replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);
}

function excerptByName(fileName, buf) {
  const name = String(fileName || "").toLowerCase();
  if (name.endsWith(".docx")) return excerptDocx(buf);
  if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) return excerptXlsx(buf);
  if (name.endsWith(".pdf")) return excerptPdf(buf);
  return "";
}

function selfCheck() {
  /* minimal zip with one stored file word/document.xml */
  const xml = Buffer.from(
    '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>你好世界</w:t></w:r></w:p></w:body></w:document>'
  );
  const name = Buffer.from("word/document.xml");
  const local = Buffer.alloc(30 + name.length + xml.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(xml.length, 18);
  local.writeUInt32LE(xml.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  name.copy(local, 30);
  xml.copy(local, 30 + name.length);
  const t = excerptDocx(local);
  console.assert(/你好世界/.test(t), "docx excerpt");
}

if (require.main === module) {
  selfCheck();
  console.log("file-excerpt ok");
}

module.exports = {
  TEXT_MAX,
  excerptByName,
  excerptDocx,
  excerptXlsx,
  excerptPdf,
  selfCheck,
};
