import { similarity } from '../server/agents/memory-agent.js';

const pairs = [
  ['七年前东街往事与伍卿真实身份', '七年前东街往事与伍卿身世（无纹玉佩、凌玥虎口旧疤）', true],
  ['凌玥自称把你弄丢的人', '凌玥自称「把你弄丢的人」', true],
  ['凌玥的旧伤', '凌璇的旧识', false],
  ['奶奶被许映接走', '奶奶的病情诊断', false],
  ['查明七年前身份', '查明七年前身份与往事', true],
  ['凌总寻伍卿七年之谜', '凤翼/姬延寻找殿下（伍卿）', false],
  ['无纹玉佩发烫', '无纹玉佩异常发烫与身份关联', true],
  ['十七街鸣笛', '十七街鸣笛与嘉桌集团监视者', true],
  ['司楼的威胁', '凌家的私兵上限', false],
];

let ok = 0;
for (const [a, b, expectMerge] of pairs) {
  const s = similarity(a, b);
  const merged = s >= 0.62;
  const pass = merged === expectMerge;
  if (pass) ok++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  s=${s.toFixed(2)}  ${merged ? 'MERGE' : 'keep '}  ${a}  <>  ${b}`);
}
console.log(`\n${ok}/${pairs.length}`);
process.exit(ok === pairs.length ? 0 : 1);
