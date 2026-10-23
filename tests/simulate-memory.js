/**
 * Memory scaling simulation — proves the hierarchical memory system keeps
 * assembled context bounded across thousands of rounds.
 *
 * Uses synthetic turns/summaries (no LLM calls) and the real assembler +
 * store, then asserts budget.total stays under the 200K hard cap.
 *
 * Run: node tests/simulate-memory.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.DB_PATH = path.join(__dirname, '..', 'data', 'simulate.db');

const { createSession, addTurn, addSummary, archiveSummaries, upsertEntity, setState, closeDb } =
  await import('../server/memory/store.js');
const { assembleContext } = await import('../server/memory/assembler.js');
const { config } = await import('../server/config.js');

const TOTAL_ROUNDS = parseInt(process.env.SIM_ROUNDS || '1200', 10);
const NARRATOR_TOKENS = 2500;   // realistic round size
const PLAYER_TOKENS = 300;

const NAMES = ['林霜', '沈砚', '灰鸽组织', '青铜钥匙', '临江旧港', '赵四海', '夜枭', '苏晓'];
const PLACES = ['临江旧港区', '城南钟表铺', '废弃地铁三号线', '云顶会所', '老码头仓库'];
const HOOKS = ['铁链拖地声再次响起', '一封没有署名的信', '电话那头只剩呼吸声', '镜子里多了一个人'];

function chineseBlock(seed, approxTokens) {
  // deterministic pseudo-Chinese text of ~approxTokens chars
  let s = '';
  let x = seed * 9301 + 49297;
  const vocab = ['夜色', '雨水', '灯火', '沉默', '脚步', '目光', '冷笑', '低语', '远处', '忽然',
    '记忆', '线索', '真相', '危险', '交易', '代价', '雨幕', '江风', '锈迹', '铁门'];
  while (s.length < approxTokens) {
    x = (x * 9301 + 49297) % 233280;
    const r = x / 233280;
    if (r < 0.3) s += NAMES[Math.floor(r * 100) % NAMES.length];
    else if (r < 0.45) s += PLACES[Math.floor(r * 1000) % PLACES.length];
    else if (r < 0.5) s += HOOKS[Math.floor(r * 10000) % HOOKS.length];
    else s += vocab[Math.floor(r * 100000) % vocab.length];
    if (s.length % 7 === 0) s += '，';
    if (s.length % 23 === 0) s += '。';
  }
  return s;
}

function summaryBlock(turnFrom, turnTo) {
  return `第${turnFrom}-${turnTo}轮：林霜在临江旧港区追查灰鸽组织线索，发现青铜钥匙与赵四海有关；` +
    `沈砚负伤，苏晓提供假账本；夜枭在暗处观察。悬念：${HOOKS[turnTo % HOOKS.length]}。` +
    chineseBlock(turnFrom * 7 + turnTo, 250);
}

async function main() {
  const settings = {
    title: '模拟测试剧情',
    opening: '暴雨夜的临江旧港，林霜第一次见到那枚青铜钥匙。',
    worldview: '现代都市，表层繁华，里层存在隐秘组织"灰鸽"操控的地下交易网。',
    characters: [
      { name: '林霜', role: '女主', personality: '冷静敏锐', voice: '简短', secret: '曾是灰鸽成员' },
      { name: '沈砚', role: '线人', personality: '圆滑胆小', voice: '市井', secret: '' },
    ],
    player_role: '失踪案的唯一目击者',
    rules: '每轮1500-3000字，保持角色口吻。',
    style_tags: ['悬疑'],
    context_max_tokens: config.context.maxTokens,
  };

  const session = createSession({ id: 'sim-' + Date.now(), title: settings.title, settings });
  console.log(`session: ${session.id}`);
  console.log(`simulating ${TOTAL_ROUNDS} rounds (narrator ${NARRATOR_TOKENS} tok/round, player ${PLAYER_TOKENS} tok/round)...`);

  const curve = [];
  const arcEvery = config.context.arcEvery;
  const sagaEvery = config.context.sagaEvery;
  const chronicleEvery = config.context.chronicleEvery;

  let l1Buffer = [];
  let l2Buffer = [];
  let l3Buffer = [];

  for (let turn = 1; turn <= TOTAL_ROUNDS; turn++) {
    addTurn(session.id, {
      turn_no: turn, kind: 'player',
      content: `（第${turn}轮玩家行动）` + chineseBlock(turn, PLAYER_TOKENS),
      token_count: PLAYER_TOKENS,
    });
    addTurn(session.id, {
      turn_no: turn, kind: 'narrator',
      content: chineseBlock(turn * 3, NARRATOR_TOKENS),
      token_count: NARRATOR_TOKENS,
    });

    // memory agent: L1 round summary
    const l1 = addSummary(session.id, {
      level: 1, turnFrom: turn, turnTo: turn, content: summaryBlock(turn, turn),
    });
    l1Buffer.push({ id: l1.id, turn });

    // state update (cheap synthetic)
    if (turn % 3 === 0) {
      setState(session.id, turn, {
        time: `第${Math.ceil(turn / 5)}日`, location: PLACES[turn % PLACES.length],
        tension: 0.4 + (turn % 50) / 100, characters: { 林霜: { mood: '警惕' } },
        inventory: ['青铜钥匙', '假账本'], quests: [{ goal: '查明失踪案', status: 'active' }],
        last_hook: HOOKS[turn % HOOKS.length],
      });
    }
    if (turn % 7 === 0) {
      upsertEntity(session.id, {
        type: turn % 2 ? 'character' : 'item', name: NAMES[turn % NAMES.length],
        summary: chineseBlock(turn, 60), last_turn: turn, importance: 0.5 + (turn % 5) / 10,
      });
    }

    // compressor: L1 -> L2
    if (turn % arcEvery === 0) {
      const from = turn - arcEvery + 1;
      const l2 = addSummary(session.id, {
        level: 2, turnFrom: from, turnTo: turn, content: summaryBlock(from, turn) + chineseBlock(from, 500),
      });
      archiveSummaries(l1Buffer.map(b => b.id));
      l2Buffer.push({ id: l2.id, from, to: turn });
      l1Buffer = [];

      // L2 -> L3
      if (l2Buffer.length >= sagaEvery) {
        const group = l2Buffer.splice(0, sagaEvery);
        const l3 = addSummary(session.id, {
          level: 3, turnFrom: group[0].from, turnTo: group[group.length - 1].to,
          content: summaryBlock(group[0].from, group[group.length - 1].to) + chineseBlock(group[0].from, 900),
        });
        archiveSummaries(group.map(g => g.id));
        l3Buffer.push({ id: l3.id, from: group[0].from, to: group[group.length - 1].to });

        // L3 -> L4
        if (l3Buffer.length >= chronicleEvery) {
          const g = l3Buffer.splice(0, chronicleEvery);
          addSummary(session.id, {
            level: 4, turnFrom: g[0].from, turnTo: g[g.length - 1].to,
            content: summaryBlock(g[0].from, g[g.length - 1].to) + chineseBlock(g[0].from, 2200),
          });
          archiveSummaries(g.map(x => x.id));
        }
      }
    }

    if (turn % 100 === 0 || turn === TOTAL_ROUNDS) {
      const ctx = await assembleContext({
        session, turnNo: turn,
        playerText: `林霜追查灰鸽组织和青铜钥匙的下落`,
        images: null, branchChoice: null,
      });
      curve.push({ turn, total: ctx.budget.total });
      const pct = ((ctx.budget.total / config.context.maxTokens) * 100).toFixed(1);
      console.log(`  round ${String(turn).padStart(5)}: context ${String(ctx.budget.total).padStart(8)} tok (${pct}% of ${config.context.maxTokens.toLocaleString()})  layers: ${Object.entries(ctx.budget).filter(([k, v]) => k !== 'total' && typeof v === 'number').map(([k, v]) => `${k}=${v}`).join(' ')}`);
      if (ctx.budget.total > config.context.maxTokens) {
        console.error(`\nFAIL: context exceeded hard cap at round ${turn}: ${ctx.budget.total}`);
        process.exit(1);
      }
    }
  }

  const last = curve[curve.length - 1];
  console.log(`\ncurve: ${curve.map(c => `${c.turn}:${(c.total / 1000).toFixed(0)}K`).join(' -> ')}`);
  console.log(`final context: ${last.total} tokens after ${last.turn} rounds (cap ${config.context.maxTokens.toLocaleString()})`);

  // raw archive size for reference
  const rawArchive = TOTAL_ROUNDS * (NARRATOR_TOKENS + PLAYER_TOKENS);
  console.log(`raw archive if uncompressed: ~${rawArchive.toLocaleString()} tokens (${(rawArchive / 1000 / 1000).toFixed(2)}M)`);
  console.log(`compression ratio: ~${(rawArchive / last.total).toFixed(0)}x smaller working context\n`);

  closeDb();
  fs.rmSync(process.env.DB_PATH, { force: true });
  fs.rmSync(process.env.DB_PATH + '-wal', { force: true });
  fs.rmSync(process.env.DB_PATH + '-shm', { force: true });

  if (last.total < config.context.maxTokens) {
    console.log('MEMORY SCALING SIMULATION PASSED');
  } else {
    console.log('MEMORY SCALING SIMULATION FAILED');
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
