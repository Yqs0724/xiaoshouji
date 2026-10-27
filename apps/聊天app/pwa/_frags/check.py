# -*- coding: utf-8 -*-
import re
from collections import Counter

p = r"d:\cursor-projects\Ariadne\apps\聊天app\pwa\chat.js"
t = open(p, encoding="utf-8").read()
fns = re.findall(r"^\s*(?:async\s+)?function\s+(\w+)", t, re.M)
c = Counter(fns)
dups = [(k, v) for k, v in c.items() if v > 1]
print("dups:", dups)
print("fill voice:", 'kind === "voice"' in t)
print("hist voice:", 'm.kind === "voice"' in t)
print("bindBubbleCtx in append:", t.count("bindBubbleCtx(bubble, msg)"))
print("lines", t.count("\n") + 1)
print("家机 count", t.count("家机"))
# Check for broken replacements - old PLUS still?
print("PLUS_ITEMS count", t.count("const PLUS_ITEMS"))
print("HIST_CATS count", t.count("const HIST_CATS"))
