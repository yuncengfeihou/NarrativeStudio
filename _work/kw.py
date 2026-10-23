# -*- coding: utf-8 -*-
"""Targeted keyword extraction with chapter numbers and context."""
import os, re, sys

ROOT = r"D:\开发目录\open ChatGPT\ai-roleplay\素材\我在女尊世界捡破烂"

def chap_no(name):
    m = re.match(r"第(\d+)章", name)
    return int(m.group(1)) if m else -1

files = sorted([f for f in os.listdir(ROOT) if f.endswith(".txt")], key=chap_no)

KEYS = sys.argv[1:]
if not KEYS:
    KEYS = ["湘曲"]

out = []
for f in files:
    with open(os.path.join(ROOT, f), encoding="utf-8") as fh:
        t = fh.read().replace("\ufeff", "")
    paras = [p.strip() for p in t.split("\n") if p.strip()]
    no = chap_no(f)
    for p in paras:
        for k in KEYS:
            if k in p:
                out.append(f"[{no}] {p[:300]}")
                break

with open(r"D:\开发目录\open ChatGPT\ai-roleplay\_work\kw.txt", "w", encoding="utf-8") as fh:
    fh.write("\n".join(out))
print(len(out), "hits for", KEYS)
