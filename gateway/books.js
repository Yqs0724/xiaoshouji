const fs = require("node:fs");
const path = require("node:path");
const { fetchBookshelf, fetchProgress } = require("./weread");

const DATA_DIR = path.join(__dirname, "..", "data");
const BOOKS_PATH = path.join(DATA_DIR, "books.json");

const SEED = {
  books: [
    {
      id: "seed-placeholder",
      title: "占位书",
      author: "待导入",
      progress: 0,
      source: "local",
      passes: [],
      active_pass: null,
      in_progress: false,
      updated_at: "—",
    },
  ],
};

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BOOKS_PATH)) {
    fs.writeFileSync(BOOKS_PATH, JSON.stringify(SEED, null, 2), "utf8");
  }
}

function readBooks() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(BOOKS_PATH, "utf8"));
    const list = Array.isArray(raw.books) ? raw.books : Array.isArray(raw) ? raw : [];
    return { books: list };
  } catch {
    return { books: [...SEED.books] };
  }
}

function writeBooks(books) {
  ensureFile();
  fs.writeFileSync(BOOKS_PATH, JSON.stringify({ books }, null, 2), "utf8");
  return { books };
}

function formatTime(unix) {
  if (!unix) return "—";
  const d = new Date(Number(unix) * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function mapWereadBook(b) {
  return {
    id: `wr-${b.bookId}`,
    weread_id: String(b.bookId),
    title: b.title || "未命名",
    author: b.author || "",
    cover: b.cover || "",
    progress: 0, // 小屋共读进度；微信读书进度见 weread_progress
    weread_progress: null,
    weread_read_seconds: null,
    source: "weread",
    passes: [],
    active_pass: null,
    in_progress: false,
    updated_at: formatTime(b.readUpdateTime),
    read_update_time: Number(b.readUpdateTime) || 0,
    finish_reading: Number(b.finishReading) === 1,
  };
}

async function enrichWithWereadProgress(apiKey, books) {
  await Promise.all(
    books.map(async (b) => {
      if (!b.weread_id) return;
      try {
        const data = await fetchProgress(apiKey, b.weread_id);
        const book = data.book || {};
        b.weread_progress = Number(book.progress) || 0;
        // 官方文档写 recordReadingTime；实测累计时常在 readingTime（秒）
        b.weread_read_seconds =
          Number(book.readingTime) || Number(book.recordReadingTime) || 0;
      } catch {
        // 单本失败不阻断整次同步
        b.weread_progress = null;
        b.weread_read_seconds = null;
      }
    })
  );
  return books;
}

/**
 * 用微信读书 /shelf/sync 合并本机书架：
 * - 最近 10 本 + getprogress 补进度/时长
 * - 保留纯本地书
 */
async function syncFromWeread(apiKey) {
  const shelf = await fetchBookshelf(apiKey);
  const remote = Array.isArray(shelf.books) ? shelf.books.map(mapWereadBook) : [];
  remote.sort((a, b) => b.read_update_time - a.read_update_time);
  // ponytail: 书架 800+ 本时全量入库太重；先只留最近 10 本，全量同步另开切片
  const recent = remote.slice(0, 10);
  await enrichWithWereadProgress(apiKey, recent);
  if (recent.length) recent[0].in_progress = true;

  const prev = readBooks().books;
  const localOnly = prev.filter((b) => b.source === "local" && !b.weread_id);
  const books = [...recent, ...localOnly];
  writeBooks(books);
  return {
    books,
    synced: recent.length,
    total_remote: remote.length,
    albums: Array.isArray(shelf.albums) ? shelf.albums.length : 0,
  };
}

module.exports = { readBooks, writeBooks, syncFromWeread, BOOKS_PATH };
