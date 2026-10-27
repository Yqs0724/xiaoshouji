const fs = require("fs");
const xml = fs.readFileSync("./_echoes-unzip/word/document.xml", "utf8");
const t = xml
  .replace(/<w:tab[^/]*\/>/g, "\t")
  .replace(/<\/w:p>/g, "\n")
  .replace(/<w:br[^/]*\/>/g, "\n")
  .replace(/<[^>]+>/g, "")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/[ \t]+\n/g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();
fs.writeFileSync("./_echoes.txt", t, "utf8");
console.log(t);
