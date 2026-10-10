/**
 * Minimal .epub → plain text（无依赖）。
 * ZIP → container.xml → OPF spine → 各章 XHTML 去标签拼接。
 */
const zlib = require("node:zlib");

/** ponytail: 挡离谱体积；超大书再抬或改流式 */
const EPUB_MAX_BYTES = 12 * 1024 * 1024;

function inflateEntry(method, data) {
  if (method === 0) return data;
  if (method === 8) {
    try {
      return zlib.inflateRawSync(data);
    } catch (_) {
      const err = new Error("epub inflate failed");
      err.code = "epub_bad";
      throw err;
    }
  }
  const err = new Error("unsupported zip method " + method);
  err.code = "epub_unsupported";
  throw err;
}

/** 扫 local headers（与 docx 自检 zip 兼容；不支持 data descriptor） */
function readZipViaLocalHeaders(buf) {
  const map = new Map();
  let offset = 0;
  while (offset + 30 <= buf.length) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buf.readUInt16LE(offset + 8);
    const flags = buf.readUInt16LE(offset + 6);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf
      .slice(offset + 30, offset + 30 + nameLen)
      .toString("utf8")
      .replace(/\\/g, "/");
    const dataStart = offset + 30 + nameLen + extraLen;
    if (flags & 0x08) {
      const err = new Error("epub zip uses data descriptor");
      err.code = "epub_unsupported";
      throw err;
    }
    if (dataStart + compSize > buf.length) {
      const err = new Error("epub truncated");
      err.code = "epub_bad";
      throw err;
    }
    const data = buf.slice(dataStart, dataStart + compSize);
    offset = dataStart + compSize;
    if (name.endsWith("/")) continue;
    map.set(name, inflateEntry(method, data));
  }
  return map;
}

/** 经中央目录读取（多数真实 epub） */
function readZipViaCentralDirectory(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const map = new Map();
  let off = cdOffset;
  while (off + 46 <= buf.length) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf
      .slice(off + 46, off + 46 + nameLen)
      .toString("utf8")
      .replace(/\\/g, "/");
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (localOff + 30 > buf.length) continue;
    if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const locNameLen = buf.readUInt16LE(localOff + 26);
    const locExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + locNameLen + locExtraLen;
    if (dataStart + compSize > buf.length) continue;
    const data = buf.slice(dataStart, dataStart + compSize);
    map.set(name, inflateEntry(method, data));
  }
  return map.size ? map : null;
}

function readZipMap(buf) {
  if (buf.readUInt32LE(0) !== 0x04034b50) {
    const err = new Error("not a zip/epub");
    err.code = "epub_bad";
    throw err;
  }
  const viaCd = readZipViaCentralDirectory(buf);
  if (viaCd && viaCd.size) return viaCd;
  return readZipViaLocalHeaders(buf);
}

function entryText(map, pathName) {
  const want = String(pathName || "").replace(/\\/g, "/");
  if (map.has(want)) return map.get(want).toString("utf8");
  const lower = want.toLowerCase();
  for (const [k, v] of map) {
    if (String(k).toLowerCase() === lower) return v.toString("utf8");
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
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function htmlToText(html) {
  let t = String(html || "");
  t = t.replace(/<script[\s\S]*?<\/script>/gi, "");
  t = t.replace(/<style[\s\S]*?<\/style>/gi, "");
  t = t.replace(/<br\s*\/?>/gi, "\n");
  t = t.replace(/<\/p>/gi, "\n\n");
  t = t.replace(/<\/div>/gi, "\n");
  t = t.replace(/<\/h[1-6]>/gi, "\n\n");
  t = t.replace(/<\/li>/gi, "\n");
  t = t.replace(/<[^>]+>/g, "");
  t = decodeXmlEntities(t);
  t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

function chapterTitleFromHtml(html, fallback) {
  const raw = String(html || "");
  const titleM = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleM) {
    const s = decodeXmlEntities(titleM[1].replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    if (s && !/^untitled$/i.test(s)) return s.slice(0, 80);
  }
  const h1M = raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1M) {
    const s = decodeXmlEntities(h1M[1].replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    if (s) return s.slice(0, 80);
  }
  const plain = htmlToText(raw);
  const first = plain.split("\n").find((l) => l.trim());
  if (first) {
    const s = first.trim();
    if (s.length <= 40) return s;
  }
  return fallback || "未命名";
}

function dirnamePath(p) {
  const s = String(p || "").replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return i < 0 ? "" : s.slice(0, i);
}

function resolveHref(baseDir, href) {
  const raw = decodeURIComponent(String(href || "").split("#")[0].trim());
  if (!raw) return "";
  const joined = (baseDir ? baseDir + "/" : "") + raw;
  const parts = joined.replace(/\\/g, "/").split("/");
  const out = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function parseRootfile(containerXml) {
  const m = String(containerXml || "").match(
    /full-path\s*=\s*["']([^"']+)["']/i
  );
  return m ? m[1].replace(/\\/g, "/") : null;
}

function parseOpf(opfXml) {
  const xml = String(opfXml || "");
  const titleM = xml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
  const title = titleM ? decodeXmlEntities(titleM[1]).replace(/\s+/g, " ").trim() : "";

  const manifest = new Map();
  const itemRe = /<item\b([^>]*?)\/>/gi;
  let im;
  while ((im = itemRe.exec(xml))) {
    const attrs = im[1];
    const idM = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i);
    const hrefM = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    const mtM = attrs.match(/\bmedia-type\s*=\s*["']([^"']+)["']/i);
    if (!idM || !hrefM) continue;
    manifest.set(idM[1], {
      href: hrefM[1],
      mediaType: (mtM && mtM[1]) || "",
    });
  }

  const spine = [];
  const spineBlock = xml.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i);
  if (spineBlock) {
    const refRe = /<itemref\b([^>]*?)\/>/gi;
    let rm;
    while ((rm = refRe.exec(spineBlock[1]))) {
      const idrefM = rm[1].match(/\bidref\s*=\s*["']([^"']+)["']/i);
      if (idrefM) spine.push(idrefM[1]);
    }
  }
  return { title, manifest, spine };
}

function isTextChapter(mediaType, href) {
  const mt = String(mediaType || "").toLowerCase();
  if (mt.includes("xhtml") || mt.includes("html") || mt === "text/html") return true;
  if (!mt && /\.(xhtml|html|htm)$/i.test(href || "")) return true;
  return false;
}

function epubToText(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (!buf.length) {
    const err = new Error("empty file");
    err.code = "epub_empty";
    throw err;
  }
  if (buf.length > EPUB_MAX_BYTES) {
    const err = new Error("file too large");
    err.code = "epub_too_large";
    throw err;
  }
  const map = readZipMap(buf);
  if (!map.size) {
    const err = new Error("empty epub zip");
    err.code = "epub_bad";
    throw err;
  }
  const container = entryText(map, "META-INF/container.xml");
  if (!container) {
    const err = new Error("missing container.xml");
    err.code = "epub_bad";
    throw err;
  }
  const rootPath = parseRootfile(container);
  if (!rootPath) {
    const err = new Error("missing rootfile");
    err.code = "epub_bad";
    throw err;
  }
  const opfXml = entryText(map, rootPath);
  if (!opfXml) {
    const err = new Error("missing opf");
    err.code = "epub_bad";
    throw err;
  }
  const { title, manifest, spine } = parseOpf(opfXml);
  if (!spine.length) {
    const err = new Error("empty spine");
    err.code = "epub_bad";
    throw err;
  }
  const baseDir = dirnamePath(rootPath);
  let text = "";
  const chapters = [];
  let n = 0;
  for (const idref of spine) {
    const item = manifest.get(idref);
    if (!item || !isTextChapter(item.mediaType, item.href)) continue;
    const pathName = resolveHref(baseDir, item.href);
    const html = entryText(map, pathName);
    if (!html) continue;
    const chunk = htmlToText(html);
    if (!chunk) continue;
    n += 1;
    if (text) text += "\n\n";
    chapters.push({
      title: chapterTitleFromHtml(html, "第 " + n + " 章"),
      offset: text.length,
    });
    text += chunk;
  }
  text = text.trim();
  if (!text) {
    const err = new Error("no readable chapters");
    err.code = "epub_empty_text";
    throw err;
  }
  // trim 可能吃掉尾部空白，不影响 offset（章间为 \n\n）
  return {
    text,
    title: title || null,
    chars: text.length,
    chapters,
  };
}

function explainEpubError(code) {
  if (code === "epub_empty") return "文件是空的";
  if (code === "epub_too_large") return "文件太大（上限约 12MB）";
  if (code === "epub_unsupported")
    return "这种 epub 压缩方式暂不支持，请另存或导出 .txt";
  if (code === "epub_empty_text") return "读不出正文（可能只有图片页）";
  if (code === "epub_bad") return "读不出 epub，请确认文件未损坏";
  return "导入失败";
}

/** Build a store-only ZIP local entry（自检用；无中央目录） */
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
  const container =
    '<?xml version="1.0"?>' +
    '<container><rootfiles><rootfile full-path="OEBPS/content.opf" /></rootfiles></container>';
  const opf =
    '<?xml version="1.0"?>' +
    '<package><metadata><dc:title>试读本</dc:title></metadata>' +
    '<manifest>' +
    '<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>' +
    "</manifest>" +
    '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>';
  const c1 =
    '<?xml version="1.0"?><html><body><p>第一章：你好&amp;世界</p></body></html>';
  const c2 =
    '<?xml version="1.0"?><html><body><p>第二章</p><p>第二段</p></body></html>';
  const fake = Buffer.concat([
    zipStoreEntry("META-INF/container.xml", container),
    zipStoreEntry("OEBPS/content.opf", opf),
    zipStoreEntry("OEBPS/c1.xhtml", c1),
    zipStoreEntry("OEBPS/c2.xhtml", c2),
  ]);
  const out = epubToText(fake);
  console.assert(out.title === "试读本", out.title);
  console.assert(out.text.includes("你好&世界") && out.text.includes("第二章"), out.text);
  console.assert(Array.isArray(out.chapters) && out.chapters.length === 2, out.chapters);
  console.assert(out.chapters[0].offset === 0, out.chapters[0]);
  console.assert(out.chapters[1].offset > 0, out.chapters[1]);
  console.assert(explainEpubError("epub_bad").includes("epub"));
  try {
    epubToText(Buffer.from("not-zip"));
    throw new Error("expected throw");
  } catch (e) {
    console.assert(e.code === "epub_bad", e.code);
  }
  console.log("epub-text ok");
}

module.exports = {
  epubToText,
  explainEpubError,
  EPUB_MAX_BYTES,
  zipStoreEntry,
  htmlToText,
  chapterTitleFromHtml,
};
