# -*- coding: utf-8 -*-
"""Build a condensed digest of every chapter: head, tail, dialogue samples."""
import os, re, sys, json

ROOT = r"D:\开发目录\open ChatGPT\ai-roleplay\素材\我在女尊世界捡破烂"
OUT  = r"D:\开发目录\open ChatGPT\ai-roleplay\_work\digest.txt"

def chap_no(name):
    m = re.match(r"第(\d+)章", name)
    return int(m.group(1)) if m else -1

files = sorted([f for f in os.listdir(ROOT) if f.endswith(".txt")], key=chap_no)

def clean(t):
    t = t.replace("\ufeff", "")
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{2,}", "\n", t)
    return t.strip()

lines = []
for f in files:
    with open(os.path.join(ROOT, f), encoding="utf-8") as fh:
        t = clean(fh.read())
    paras = [p.strip() for p in t.split("\n") if p.strip()]
    # drop title line
    body = paras[1:] if paras and paras[0].startswith("第") and "章" in paras[0][:8] else paras
    head = " / ".join(body[:3])[:420]
    tail = " / ".join(body[-2:])[:260]
    # dialogue lines
    dial = [p for p in body if ("“" in p or "「" in p)]
    # pick spread-out dialogues
    picks = []
    if dial:
        idxs = [0, len(dial)//3, 2*len(dial)//3, len(dial)-1]
        for i in sorted(set(idxs)):
            if i < len(dial):
                picks.append(dial[i][:110])
    lines.append(f"### {paras[0] if paras else f}")
    lines.append("HEAD: " + head)
    lines.append("TAIL: " + tail)
    lines.append("DLG: " + " || ".join(dict.fromkeys(picks)))
    lines.append("")

with open(OUT, "w", encoding="utf-8") as fh:
    fh.write("\n".join(lines))
print("wrote", OUT, len("\n".join(lines)))
