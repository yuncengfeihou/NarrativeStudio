# -*- coding: utf-8 -*-
"""Scan the novel: chapter files, name frequency, dialogue extraction."""
import os, re, sys, json, collections

ROOT = r"D:\开发目录\open ChatGPT\ai-roleplay\素材\我在女尊世界捡破烂"

def chap_no(name):
    m = re.match(r"第(\d+)章", name)
    return int(m.group(1)) if m else -1

files = [f for f in os.listdir(ROOT) if f.endswith(".txt")]
files.sort(key=chap_no)

chapters = []
for f in files:
    p = os.path.join(ROOT, f)
    with open(p, encoding="utf-8") as fh:
        t = fh.read()
    chapters.append({"no": chap_no(f), "file": f, "title": f[:-4], "text": t})

total_chars = sum(len(c["text"]) for c in chapters)
print("chapters:", len(chapters), "total chars:", total_chars)
print("avg:", total_chars // len(chapters))
print("min/max:", min(len(c["text"]) for c in chapters), max(len(c["text"]) for c in chapters))

# name frequency (whole-text occurrence)
cands = ["伍卿","凌玥","奶奶","谢沐","姬淮澄","南荣兰冰","大黑牛","顾","白西装","老秦","阿福",
         "李","王","赵","钱","孙","周","吴","郑","陈","张","刘","杨","黄","姜","苏","沈","韩",
         "小青","翠","春","秋","夏","冬","墨","玉","凤","凰","龙","云","霜","雪","月","星",
         "安安","阿蛮","小满","阿福","老周","柳","叶","花","桃","李妈","王妈","阿婆","郎中","大夫"]
cnt = collections.Counter()
for c in chapters:
    for n in cands:
        cnt[n] += c["text"].count(n)
print("\n--- raw name counts ---")
for n, v in cnt.most_common(40):
    print(n, v)

# two-char names: find 小X / 阿X patterns
print("\n--- 小X / 阿X patterns ---")
pat = re.compile(r"[小阿][\u4e00-\u9fa5]")
c2 = collections.Counter()
for c in chapters:
    for m in pat.findall(c["text"]):
        c2[m] += 1
for n, v in c2.most_common(60):
    if v >= 5:
        print(n, v)

print("\n--- per-chapter first 200 chars (index) ---")
for c in chapters:
    body = c["text"].replace("\n"," ").strip()
    print(c["no"], c["title"][:30], "|", body[:80])
