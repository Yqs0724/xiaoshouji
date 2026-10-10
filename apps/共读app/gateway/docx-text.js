/**
 * Minimal .docx → plain text (no deps).
 * Reads word/document.xml from the ZIP; strips tags.
 */
const zlib = require("node:zlib");

const DOCX_MAX_BYTES = 2 * 1024 * 1024;

function extractZipEntry(buf, entryName) {
  let offset = 0;
  const want = String(entryName).replace(/\\/g, "/");
  while (offset + 30 <= buf.length) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buf.readUInt16LE(offset + 8);
    const flags = buf.readUInt16LE(offset + 6);
    let compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf
      .slice(offset + 30, offset + 30 + nameLen)
      .toString("utf8")
      .replace(/\\/g, "/");
    const dataStart = offset + 30 + nameLen + extraLen;
    if (flags & 0x08) {
      // ponytail: 少见 data descriptor；升级可扫 0x08074b50
      const err = new Error("docx zip uses data descriptor");
      err.code = "docx_unsupported";
      throw err;
    }
    if (dataStart + compSize > buf.length) {
      const err = new Error("docx truncated");
      err.code = "docx_bad";
      throw err;
    }
    const data = buf.slice(dataStart, dataStart + compSize);
    offset = dataStart + compSize;
    if (name !== want) continue;
    if (method === 0) return data;
    if (method === 8) {
      try {
        return zlib.inflateRawSync(data);
      } catch (_) {
        const err = new Error("docx inflate failed");
        err.code = "docx_bad";
        throw err;
      }
    }
    const err = new Error("unsupported zip method " + method);
    err.code = "docx_unsupported";
    throw err;
  }
  return null;
}

function decodeXmlEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      const n = parseInt(h, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    })
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n);
      return Number.isFinite(c) ? String.fromCodePoint(c) : "";
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function xmlToText(xml) {
  let t = String(xml || "");
  t = t.replace(/<w:tab\b[^>]*\/>/gi, "\t");
  t = t.replace(/<w:br\b[^>]*\/>/gi, "\n");
  t = t.replace(/<\/w:p>/gi, "\n");
  t = t.replace(/<[^>]+>/g, "");
  t = decodeXmlEntities(t);
  t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

function docxToText(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (!buf.length) {
    const err = new Error("empty file");
    err.code = "docx_empty";
    throw err;
  }
  if (buf.length > DOCX_MAX_BYTES) {
    const err = new Error("file too large");
    err.code = "docx_too_large";
    throw err;
  }
  if (buf.readUInt32LE(0) !== 0x04034b50) {
    const err = new Error("not a zip/docx");
    err.code = "docx_bad";
    throw err;
  }
  const xmlBuf = extractZipEntry(buf, "word/document.xml");
  if (!xmlBuf) {
    const err = new Error("missing word/document.xml");
    err.code = "docx_bad";
    throw err;
  }
  return xmlToText(xmlBuf.toString("utf8"));
}

function explainDocxError(code) {
  if (code === "docx_empty") return "文件是空的";
  if (code === "docx_too_large") return "文件太大（上限约 2MB）";
  if (code === "docx_unsupported") return "这种 Word 压缩方式暂不支持，请另存为 .docx 或导出 .txt";
  if (code === "docx_bad") return "读不出正文，请确认是 .docx（不是旧版 .doc）";
  return "导入失败";
}

/** Build a store-only ZIP local entry (enough for our reader). */
function zipStoreEntry(filename, content) {
  const name = Buffer.from(filename, "utf8");
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const local = Buffer.alloc(30 + name.length + data.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  name.copy(local, 30);
  data.copy(local, 30 + name.length);
  return local;
}

if (require.main === module) {
  const xml =
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    "<w:body><w:p><w:r><w:t>你好&amp;世界</w:t></w:r></w:p>" +
    "<w:p><w:r><w:t>第二行</w:t></w:r></w:p></w:body></w:document>";
  const fake = zipStoreEntry("word/document.xml", xml);
  const text = docxToText(fake);
  console.assert(text.includes("你好&世界") && text.includes("第二行"), text);
  console.assert(explainDocxError("docx_bad").includes("docx"));
  try {
    docxToText(Buffer.from("not-zip"));
    throw new Error("expected throw");
  } catch (e) {
    console.assert(e.code === "docx_bad");
  }
  console.log("docx-text ok");
}

module.exports = {
  docxToText,
  explainDocxError,
  DOCX_MAX_BYTES,
  zipStoreEntry,
};
