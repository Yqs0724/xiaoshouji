# -*- coding: utf-8 -*-
from pathlib import Path
import re
html = Path(r"d:\cursor-projects\Ariadne\apps\共读app\pwa\index.html").read_text(encoding="utf-8")
body = html.split("<body>", 1)[1].split("</body>", 1)[0]
body = re.sub(r"<script[\s\S]*?</script>", "", body)
ids = list(re.finditer(r'<div class="view[^"]*" id="(view-[^"]+)"', body))
for i, m in enumerate(ids):
    start = m.start()
    end = ids[i + 1].start() if i + 1 < len(ids) else len(body)
    chunk = body[start:end]
    opens = len(re.findall(r"<div\b", chunk, re.I))
    closes = len(re.findall(r"</div>", chunk, re.I))
    print(m.group(1), "opens", opens, "closes", closes, "balance", opens - closes)
