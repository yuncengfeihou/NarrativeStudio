#!/usr/bin/env node
/**
 * _work/longrun-drive.mjs — 真实上游长跑驱动（45 拍，可断点续跑）
 *
 *   node _work/longrun-drive.mjs                 # 新建会话并跑满 45 拍
 *   node _work/longrun-drive.mjs --session <id>  # 从已有会话继续（按 DB 已落回合续跑）
 *   node _work/longrun-drive.mjs --repair        # 清掉「有玩家行、没有旁白行」的孤儿回合再续跑
 *
 * 设计约束（见 _work/longrun-baseline.md）：
 *   - 只走 HTTP/SSE，与前端同一条产品路径，不绕过 orchestrator / assembleContext。
 *   - 每跑完一拍就把记录 append 到 _work/tmp-longrun-<session>.jsonl，进程被杀也能看出跑到哪。
 *   - 续跑以 DB 的 narrator 回合为准，不用本地进度文件当真相。
 *   - 剧本里的 5 个记忆探针（t6/t9/t12/t18/t22 种下，t26/t31/t34/t38/t44 回指）是预注册的，
 *     改剧本等于改实验，别顺手改。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const BASE = opt('base', process.env.TEST_BASE_URL || 'http://127.0.0.1:3210');
const WORLD = opt('world', 'nvzun-jianpolan');
const ANCHOR = opt('anchor', 'prologue');
const TURN_TIMEOUT_MS = Number(opt('turn-timeout', 720)) * 1000;
const ONLY = opt('only', ''); // 只跑某几拍（调试用，如 "12,13"）
// 只跑前 N 拍。回归验证用（改完管线跑 8–10 拍确认数值/场次/生死三条路径真生效），
// 不写进实验：实验长度由 PLAN 决定，改成靠 --limit 会把「45 拍」变成不可复现的口头约定。
const LIMIT = Number(opt('limit', '0')) || 0;
const TAG = opt('tag', '长跑评测'); // 会话标题前缀，验证跑用 `契约验证`
// 会话级设置透传（A/B 实验用）。默认不传 = 线上默认行为。
// 实验臂必须靠它区分，否则两局跑的是同一份代码路径，比较不出任何东西。
//   node _work/longrun-drive.mjs --settings '{"branch_sheet_trim":"core_only"}'
const SETTINGS = (() => {
  const raw = opt('settings', '');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) {
    console.error(`--settings 不是合法 JSON: ${err.message}`);
    process.exit(2);
  }
})();

/* ══════════════════════════════════════════════════════════════════════════
 * 行动剧本。45 拍。
 *   branch: 该拍走「选项 → 行动」路径，按 tone 优先序从上一拍给出的走向里挑一条。
 *   probe:  预注册探针标记（种下 / 回指），只影响报告标注，不影响发送内容。
 *
 * 写作原则：玩家只写「我做了什么」，不写结果、不替旁白叙事；地点变化由玩家主动走，
 * 不假设上一拍一定发生了什么。低张力/等待/跨日节拍约占 1/3。
 * ══════════════════════════════════════════════════════════════════════════ */
const ACTIONS = [
  // ── 第一场：雨街（拍 1–8，凌玥当街认人）────────────────────────
  { text: '不跟她上车。先把牛牵到屋檐下避雨，问她一句话：你到底是怎么认出我来的。', branch: { tones: ['谨慎', '智取'] } }, // 1
  { text: '嘴上应下，脚往后退半步，说我得先把牛牵回村里，天黑前不回去奶奶要急。' }, // 2
  { text: '让她把话说完，但我不接「卿儿」这个称呼，只问她找我做什么。' }, // 3
  { text: '雨小了，我说今天到此为止，牵着牛往城外走，不回头。' }, // 4
  { text: '路上盘算这女人到底图什么，顺手把车上散开的麻袋重新码一遍，绳子勒紧点。' }, // 5
  { text: '在牛车边蹲下来，把今天捡的瓶罐数一遍，又从怀里摸出个粗布小包，塞进牛车底板第三块木板的缝里，压实。', probe: 'P1-plant' }, // 6
  { text: '天快黑了，找处背风的墙根歇脚，啃两口冷馍，把腿伸直让脚腕缓一缓。' }, // 7
  { text: '回到村里，先把牛牵进棚添把草，再跟奶奶说今天卖了多少、路上遇见了谁。' }, // 8
  // ── 第二场：村里（拍 9–15）────────────────────────────────────
  { text: '夜里把墙上那盏掉了漆的旧马灯摘下来擦干净，点了半天才亮，我跟它说：行啊老伙计，还能用。', probe: 'P2-plant', branch: { tones: ['日常', '谨慎'] } }, // 9
  { text: '第二天一早把昨天挣的钱摊在桌上数，抽出一部分留给奶奶抓药，剩下的揣好。' }, // 10
  { text: '去牛棚给大黑牛添草，把牛脖子上的旧绳子解开重新系一道，怕磨着它。' }, // 11
  { text: '再进城一趟，这回绕开商务大厦那一片，走东街十五路看看那地方。路过张兰身边，我没骂她，也没低头，只注意到她左手腕上有只银镯。', probe: 'P3-plant', branch: { tones: ['探索', '谨慎'] } }, // 12
  { text: '去废品站把车上的东西过秤，跟赵大婶打听一句：这城里最近有没有什么风声。' }, // 13
  { text: '听见巷子里有人议论商务大厦那位女老板在到处找人，我没停脚，低着头推车走开。' }, // 14
  { text: '回去把今天听见的跟奶奶提一句，问她认不认识姓凌的人。', branch: { tones: ['情感', '谨慎'] } }, // 15
  // ── 第三场：凌玥追到村里（拍 16–23）──────────────────────────
  { text: '傍晚院门外有车声，我先躲进柴房，从门缝里看是谁。' }, // 16
  { text: '出来见她，但只站在院门口说话，不让她进院子。' }, // 17
  { text: '趁她在门外、奶奶在屋里，我从那七十五块里抽出五块，回来压在奶奶药罐底下。', probe: 'P4-plant' }, // 18
  { text: '她说要给我钱、给我看病，我摇头，说无功不受禄，要还的我还不清。', branch: { tones: ['情感', '谨慎'] } }, // 19
  { text: '这一夜没睡好，翻来覆去想十年前到底发生过什么，想不起来就起来喝水。' }, // 20
  { text: '第二天一早去村口，站在那棵老槐树底下看了一会儿，心里记了一笔。' }, // 21
  { text: '找了块尖石头，在老槐树上刻一道印子，记今天是第几天。', probe: 'P5-plant' }, // 22
  { text: '中午奶奶咳嗽加重，我赶紧去镇上药店抓药，钱不够，跟郎中商量赊一半。' }, // 23
  // ── 第四场：关系推进（拍 24–33）──────────────────────────────
  { text: '凌玥跟到镇上来，在药店门口等我。这次我没跑，问她：你图什么。', branch: { tones: ['情感', '激进'] } }, // 24
  { text: '把药煎上，守在灶边，听奶奶说起我小时候的事。' }, // 25
  { text: '去牛车那儿翻东西，手伸进底板第三块木板的缝里摸了摸，看那个布包还在不在。', probe: 'P1-recall' }, // 26
  { text: '夜里翻出七年前那封信——被人塞在我书包里的那封，就着火光又看一遍。' }, // 27
  { text: '决定跟她谈一次正式的：我要知道十年前那晚的全部经过，一句不许瞒。', branch: { tones: ['激进', '智取'] } }, // 28
  { text: '听完之后我没说话，蹲在门槛上很久，只问她一句：那封信是不是你写的。' }, // 29
  { text: '陆可找上门来，说能给我一条不用欠任何人的路。我让她在院外说。', branch: { tones: ['智取', '探索'] } }, // 30
  { text: '天黑了，屋里没灯，摸索着把那盏旧马灯点起来。', probe: 'P2-recall' }, // 31
  { text: '把陆可的话原样告诉凌玥，看她怎么答。' }, // 32
  { text: '牵着牛去河边饮水，蹲在水边把这几天的账在心里算一遍。' }, // 33
  // ── 第五场：抉择（拍 34–45）──────────────────────────────────
  { text: '想起张兰那只银镯，越想越觉得那不是寻常货色，琢磨她跟凌家是什么关系。', probe: 'P3-recall' }, // 34
  { text: '奶奶问我那个人是不是对我好，我没答，只说药快好了。', branch: { tones: ['情感', '日常'] } }, // 35
  { text: '决定离开村子几天，进城把事情了结，先跟奶奶说清楚什么时候回来。' }, // 36
  { text: '进城路上又遇见张兰，她拦我的车，我停下来听她说完。' }, // 37
  { text: '回家看奶奶，煎药前掀开药罐，看看压在底下的钱还在不在。', probe: 'P4-recall' }, // 38
  { text: '把张兰的话在心里记下来，找个能坐下的地方，一条一条捋。' }, // 39
  { text: '陆可和凌玥的两种条件在心里对着比，谁的我都不太想欠。', branch: { tones: ['智取', '激进'] } }, // 40
  { text: '去牛棚把大黑牛的草添满，跟它说可能要出趟远门。' }, // 41
  { text: '收拾行李，把该带的东西摊在席子上看一遍，能减的都减掉。' }, // 42
  { text: '做出决定，去告诉奶奶，让她别送。', branch: { tones: ['情感', '日常'] } }, // 43
  { text: '去村口，站在那棵老槐树底下，摸一摸我自己刻的那道印子。', probe: 'P5-recall' }, // 44
  { text: '跟凌玥把话说完，把出发的日子定下来。', branch: { tones: ['日常', '情感'] } }, // 45
];

if (ACTIONS.length !== 45) {
  console.error(`剧本必须是 45 拍（预注册探针按拍号校验），当前 ${ACTIONS.length} 拍`);
  process.exit(2);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 第二阶段剧本（拍 46–65，`--phase2` 开启）。
 *
 * 为什么单列一份而不是改上面 45 拍：第一阶段 45 拍的剧本、探针拍号、判据都在
 * `_work/longrun-baseline.md` 里**开跑前冻结**了，改它等于改实验。第二阶段是
 * **追加**观测：同一会话、同一模型、同一上游，只把长度从 46 拍拉到 66 拍，
 * 用来回答「再跑 20 拍会不会更差」和「第一阶段的行数阈值是否随长度漂移」。
 *
 * 探针 Q1–Q5 与 P1–P5 同构（种下 / 回指），但**换成第一阶段没测过的载体**：
 *   Q1 实体拓印（把槐树印子拓在纸上塞鞋底）  plant 拍 48 → recall 拍 58
 *   Q2 借来的物件（向许映要一支旧钢笔）      plant 拍 50 → recall 拍 61
 *   Q3 第三方信息（账本封面上的名字）        plant 拍 52 → recall 拍 62
 *   Q4 私人物件（奶奶留下的半块糖纸）        plant 拍 55 → recall 拍 64
 *   Q5 环境细节（窗外第三个路灯是坏的）      plant 拍 57 → recall 拍 65
 * P1–P5 测的是「身体记忆 + 玩家指令」，Q1–Q5 测的是「外部载体的具体内容」，
 * 后者更容易被「假装记得」污染，正好对上第一阶段最硬的失效形态。
 * ══════════════════════════════════════════════════════════════════════════ */
const PHASE2 = [
  { text: '上车。但先问一句：奶奶的后事，谁在办。', branch: { tones: ['情感'] } }, // 46
  { text: '车上把话憋着，只把窗外的路一处一处看过去，记这是第几次进这条官道。' }, // 47
  { text: '把掌心那道红印拓在一张纸上，折好塞进鞋底——万一哪天这条命不归我自己，总得留个记号。', probe: 'Q1-plant' }, // 48
  { text: '到了城里先不下车，问她：那本账本现在在你手上，还是在南荣手上。' }, // 49
  { text: '跟许映要一支能用的旧钢笔，说以后我自己记账。', probe: 'Q2-plant' }, // 50
  { text: '夜里睡不着，起来把这几天的钱重新数一遍，数到一半不想数了，坐着听院子里的雨。' }, // 51
  { text: '问南荣兰冰，账本封面上写的是谁的名字。', probe: 'Q3-plant' }, // 52
  { text: '白天没出门，把那本账本的前三页一个字一个字看过去，不认识的字抄下来。', branch: { tones: ['谨慎', '探索'] } }, // 53
  { text: '去东街十五路，站在那盏坏掉的路灯底下，把那天闻到的味道再闻一遍。' }, // 54
  { text: '把奶奶留下的半块糖纸夹进账本里，夹在写着我名字的那一页。', probe: 'Q4-plant' }, // 55
  { text: '跟凌玥说：我要的不是钱，是把七年前那天晚上的人一个一个找出来。' }, // 56
  { text: '到了帝都，住的地方窗外有一排路灯，我数了数，第三个是坏的。', probe: 'Q5-plant' }, // 57
  { text: '睡前脱鞋，鞋底那张拓印的纸还在，摸出来看一眼。', probe: 'Q1-recall' }, // 58
  { text: '有人上门递帖，我不接，让他把话留在门房。' }, // 59
  { text: '去医馆问一句：肺上的病拖了十年，还有没有别的说法。' }, // 60
  { text: '找许映要来的那支笔，第一次用它记下今天的账。', probe: 'Q2-recall' }, // 61
  { text: '把账本翻开，看看封面那个名字我记不记得住。', probe: 'Q3-recall' }, // 62
  { text: '一个人坐着，把陆可、凌玥、南荣三方的话在桌上摆成三条，看哪条能走。', branch: { tones: ['智取'] } }, // 63
  { text: '翻账本，翻到夹着糖纸的那一页，坐了一会儿。', probe: 'Q4-recall' }, // 64
  { text: '夜里站在窗前数路灯，第三个还是坏的，就把窗关上了。', probe: 'Q5-recall' }, // 65
];

if (PHASE2.length !== 20) {
  console.error(`第二阶段剧本必须是 20 拍（探针按拍号校验），当前 ${PHASE2.length} 拍`);
  process.exit(2);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 第三阶段剧本（拍 66–110，`--phase3` 开启，含第二阶段的 20 拍）。
 *
 * 为什么再加一段：第一/第二阶段合计 65 拍，按实测约 230s/拍只有 4 小时出头，
 * 不够「跑满一个下午」的量。第三阶段把总长推到 110 拍，用来回答两个问题：
 *   1. D32（life_state 两套存储合并）在**长时间、多次生死事件**下是否还一致；
 *   2. 第一阶段定下的行数阈值（断言 300 / 关系 200 / 声线 perWho）在 100 拍量级
 *      会不会漂——45 拍那次断言只到 175/300，看不出撞墙。
 *
 * 探针 R1–R5 与 P/Q 同构（种下 / 回指），但换成**更靠后、更长的跨度**（12–14 拍）：
 *   R1 人名清单（把七年前那晚在场的人名写在纸背上）  plant 68 → recall 80
 *   R2 身体标记（在左腕上刻一个记号）                plant 72 → recall 86
 *   R3 第三方口供（问出送信人的口音）                plant 75 → recall 89
 *   R4 数字（攒到第几笔、共多少）                    plant 79 → recall 93
 *   R5 物件去处（把铜钥匙交给谁保管）                plant 82 → recall 96
 * 跨度比第一阶段（8–12 拍）更长，因为这一段离开局最远，最容易把「假装记得」暴露出来。
 * ══════════════════════════════════════════════════════════════════════════ */
const PHASE3 = [
  { text: '进宫门前把车停下，在外头站一会儿，看那些穿玄衣的人怎么进出。' }, // 66
  { text: '跟着引路的人走，路记在心里，哪处拐弯、哪处有门，都在心里画一遍。' }, // 67
  { text: '把七年前那晚在场的人名一个一个写在纸背上，写完折起来。', probe: 'R1-plant' }, // 68
  { text: '见了太女不跪，站着把话说完。' }, // 69
  { text: '她要问玉佩，我就把玉佩放在桌上，不推过去也不收回来。', branch: { tones: ['谨慎', '智取'] } }, // 70
  { text: '夜里被安排在偏院住下，先把窗、门、墙看一遍，再躺下。' }, // 71
  { text: '用小刀在左腕上刻一个记号，不大，藏在袖子里。', probe: 'R2-plant' }, // 72
  { text: '天亮先去寻水，看井在哪、谁在打水。' }, // 73
  { text: '找人问一句：往东宫送信的人，是从哪条道走的。' }, // 74
  { text: '再问一句：那送信的人，说话是什么口音。', probe: 'R3-plant' }, // 75
  { text: '把这几天的开销记在账本上，一笔一笔，连买水的钱都记。', branch: { tones: ['谨慎'] } }, // 76
  { text: '一个人坐在廊下，把凌玥、陆可、南荣三方各自要我做什么，在心里排一遍。' }, // 77
  { text: '去东宫那边转过一次，只看门，不进去。' }, // 78
  { text: '回屋把账本翻到最后一页，写上「第几笔」和「共多少」。', probe: 'R4-plant' }, // 79
  { text: '把纸背上那张人名清单拿出来对一遍，看还差谁没找着。', probe: 'R1-recall' }, // 80
  { text: '有人来试探我知不知道玉佩的来历，我只说不知道，也不多问。', branch: { tones: ['诡道', '谨慎'] } }, // 81
  { text: '把铜钥匙交给一个信得过的人保管，说三日后还我。', probe: 'R5-plant' }, // 82
  { text: '白天帮人搬东西，换来一顿饭，吃的时候不抬头。' }, // 83
  { text: '听说南荣兰冰也进了城，我托人带个话，说想见一面。' }, // 84
  { text: '见了面不谈条件，只问她为什么当年要收下那笔钱。', branch: { tones: ['情感', '智取'] } }, // 85
  { text: '挽起袖子洗手，看腕上那个记号还在不在。', probe: 'R2-recall' }, // 86
  { text: '回偏院路上绕了一段，去看那盏坏掉的路灯是不是还坏着。' }, // 87
  { text: '夜里有人敲门，我不立刻应，先听脚步。' }, // 88
  { text: '把送信人那口音在心里学一遍，再找人对一对这是哪里的话。', probe: 'R3-recall' }, // 89
  { text: '太女再找我，这次带了条件，我听完了才开口。', branch: { tones: ['智取', '探索'] } }, // 90
  { text: '挨了一顿训，回来不吭声，先把水喝了。' }, // 91
  { text: '有人给我送东西，我不收，让他拿回去。' }, // 92
  { text: '翻账本数一数这些天攒了几笔，一共多少。', probe: 'R4-recall' }, // 93
  { text: '去找陆可，问她当初给我那把摩托钥匙，到底是想救我还是要我做别的。', branch: { tones: ['情感'] } }, // 94
  { text: '把东宫和太女两边的人对照着数一遍，看谁的人在这院里走得最勤。' }, // 95
  { text: '去把那把铜钥匙取回来，看是不是原样。', probe: 'R5-recall' }, // 96
  { text: '一个人在院里坐到半夜，把七年前那个雨夜从头想了一遍。' }, // 97
  { text: '写一封短信，写给奶奶，写完不寄，压在枕头底下。' }, // 98
  { text: '有人夜里翻墙进来，我不喊，先退到门边。', branch: { tones: ['谨慎', '激进'] } }, // 99
  { text: '第二天一早照常出门，装作什么都没发生。' }, // 100
  { text: '把这几日见过的人、听过的话，用那支旧钢笔一条一条记下来。' }, // 101
  { text: '太女问我要什么，我说要那晚在场的所有人的名字，一个都不能少。', branch: { tones: ['激进', '智取'] } }, // 102
  { text: '拿到名单不急着看，先折好收进怀里，回去再看。' }, // 103
  { text: '一个人把名单摊在桌上，从第一个名字看到最后一个。' }, // 104
  { text: '去东宫门口站了一刻钟，什么也不说，然后回来。' }, // 105
  { text: '把玉佩解下来，放在桌上看了很久，再收回去。' }, // 106
  { text: '跟凌玥说：这条路我自己走，你帮到这儿就够了。', branch: { tones: ['情感', '日常'] } }, // 107
  { text: '收拾东西，能还的都还掉，只留一个包袱。' }, // 108
  { text: '临走前再去那口井边站一会儿，打一桶水浇在树根上。' }, // 109
  { text: '天亮出城，回头看了一眼那道墙，然后再也没回头。', branch: { tones: ['日常', '探索'] } }, // 110
];

if (PHASE3.length !== 45) {
  console.error(`第三阶段剧本必须是 45 拍（探针按拍号校验），当前 ${PHASE3.length} 拍`);
  process.exit(2);
}

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const log = (...a) => console.log(...a);

async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${(await res.text()).slice(0, 400)}`);
  return res.json();
}

/** 读 SSE 到结束；每帧 data: {json}。超时会 abort 并把超时标记抛回。 */
async function sse(p, body, onEvent, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error(`turn timeout ${timeoutMs}ms`)), timeoutMs);
  let timedOut = false;
  try {
    const res = await fetch(`${BASE}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`${p} → ${res.status} ${(await res.text()).slice(0, 400)}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let at;
      while ((at = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, at);
        buf = buf.slice(at + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          let evt;
          try { evt = JSON.parse(raw); } catch { continue; }
          onEvent(evt);
        }
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError' || ctl.signal.aborted) timedOut = true;
    throw err;
  } finally {
    clearTimeout(timer);
    if (timedOut) log('  ⚠ 本轮超时被中止（服务端会收到 close 并 abort）');
  }
}

/** 从上一拍给出的走向里按 tone 优先序挑一条；挑不到就随机取一条。 */
function pickBranch(branches, tones) {
  if (!Array.isArray(branches) || !branches.length) return null;
  for (const t of tones || []) {
    const hit = branches.find((b) => b.tone === t);
    if (hit) return hit;
  }
  return branches[Math.floor(Math.random() * branches.length)];
}

const jsonlPath = (sid) => path.join(__dirname, `tmp-longrun-${sid}.jsonl`);

async function oneTurn({ sessionId, isOpening, playerText, branchChoice, phase }) {
  const ctx = { when: '', place: '', sheet: '', plan: null, coverage: null, degraded: null };
  const branches = [];
  let narrative = '';
  let reasoningChars = 0;
  const errors = [];
  let done = false;
  const started = Date.now();
  log(`\n── ${phase}${playerText ? `｜${playerText.slice(0, 46)}…` : ''}`);
  try {
    await sse(
      isOpening ? `/api/sessions/${sessionId}/opening` : `/api/sessions/${sessionId}/turn`,
      isOpening ? {} : { playerText, branchChoice: branchChoice || null, generateBranches: true },
      (evt) => {
        switch (evt.type) {
          case 'context':
            ctx.sheet = evt.scene_sheet || '';
            ctx.when = (ctx.sheet.match(/时间[：: ]\s*([^\n｜]*)/) || [])[1]?.trim() || '';
            ctx.place = (ctx.sheet.match(/地点[：: ]\s*([^\n｜]*)/) || [])[1]?.trim() || '';
            ctx.plan = evt.meta?.plan || null;
            ctx.coverage = evt.meta?.coverage || null;
            ctx.degraded = evt.meta?.degraded || null;
            if (evt.budget) ctx.budget = evt.budget;
            break;
          case 'narrative': narrative += evt.delta || ''; break;
          case 'reasoning': reasoningChars += (evt.delta || '').length; break;
          case 'branches':
            for (const b of evt.branches || []) {
              branches.push({ title: b.title, description: b.description, tone: b.tone, tension_delta: b.tension_delta });
            }
            if (evt.error) errors.push(`branches: ${evt.error}`);
            break;
          case 'error': errors.push(evt.message || 'error'); break;
          case 'memory':
            if (evt.degraded) errors.push(`memory degraded: ${evt.stats?.error || ''}`);
            break;
          case 'done': done = true; break;
          default: break;
        }
      },
      TURN_TIMEOUT_MS,
    );
  } catch (err) {
    errors.push(String(err?.message || err));
  }
  const secs = Math.round((Date.now() - started) / 1000);
  const rec = {
    phase, session_id: sessionId, action: playerText || '(开场)',
    branch_choice: branchChoice || null,
    narrative, narrative_chars: narrative.length, reasoning_chars: reasoningChars,
    when: ctx.when, place: ctx.place,
    budget: ctx.budget || null, degraded: ctx.degraded || null, coverage: ctx.coverage || null,
    branches, errors, seconds: secs, done,
  };
  fs.appendFileSync(jsonlPath(sessionId), JSON.stringify(rec) + '\n');
  log(`  正文 ${narrative.length} 字｜${secs}s｜时间「${ctx.when || '?'}」地点「${ctx.place || '?'}」` +
    `｜走向 ${branches.length} 条 ${branches.map((b) => b.tone).join('/')}` +
    (ctx.degraded ? `｜⚠ degraded=${JSON.stringify(ctx.degraded)}` : ''));
  if (errors.length) log(`  ⚠ 错误：${errors.join(' / ')}`);
  return rec;
}

/* ────────────────────────── 会话准备 / 续跑定位 ────────────────────────── */

async function existingNarratorTurns(sessionId) {
  const snap = await api('GET', `/api/sessions/${sessionId}`);
  const turns = Array.isArray(snap.turns) ? snap.turns : [];
  const narr = new Set(turns.filter((t) => t.kind === 'narrator').map((t) => t.turn_no));
  const player = new Map(turns.filter((t) => t.kind === 'player').map((t) => [t.turn_no, t]));
  return { turns, narr, player, maxTurn: Math.max(0, ...turns.map((t) => t.turn_no)) };
}

/** 孤儿回合 = 写了玩家行动但没有旁白正文（上一轮失败留下的）。 */
function findOrphans({ narr, player }) {
  const out = [];
  for (const [no, row] of player) if (!narr.has(no)) out.push({ turn_no: no, content: row.content });
  return out.sort((a, b) => a.turn_no - b.turn_no);
}

// 库路径必须跟随 DB_PATH：A/B 双局长跑各用一个库，写死 data/roleplay.db 会删错库。
const REPAIR_SNIPPET = `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.DB_PATH || 'data/roleplay.db');
const [sessionId, ...nos] = process.argv.slice(2);
for (const no of nos.map(Number)) {
  const r = db.prepare("DELETE FROM turns WHERE session_id=? AND turn_no=? AND kind='player'").run(sessionId, no);
  console.log('deleted player rows', no, r.changes);
}
db.close();
`;

async function repairOrphans(sessionId, orphans) {
  if (!orphans.length) return;
  log(`  ⟲ 修复孤儿回合：${orphans.map((o) => 't' + o.turn_no).join(',')}`);
  const { spawnSync } = await import('node:child_process');
  const scriptPath = path.join(__dirname, `tmp-repair-${sessionId}.mjs`);
  fs.writeFileSync(scriptPath, REPAIR_SNIPPET.replace(/\\n/g, '\n'), 'utf8');
  const res = spawnSync(process.execPath, [scriptPath, sessionId, ...orphans.map((o) => String(o.turn_no))], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
  });
  log(String(res.stdout || '').trim() || String(res.stderr || '').trim());
  fs.unlinkSync(scriptPath);
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

// 第二阶段是**追加**观测，不是改第一阶段：默认只跑 45 拍，`--phase2` 才把剧本拉长到 65 拍。
// 第三阶段（`--phase3`）是再往后追加 45 拍 → 共 110 拍；它**包含**第二阶段，
// 因为剧本是一条连续的线，跳过中间 20 拍会让第三段的开场地点和人物对不上。
const PLAN = has('phase3')
  ? ACTIONS.concat(PHASE2, PHASE3)
  : (has('phase2') ? ACTIONS.concat(PHASE2) : ACTIONS);
// --limit 只截短本次要跑的行动数，PLAN 本身不变（探针拍号按 PLAN 下标，截短不影响已跑部分）。
const RUN_PLAN = LIMIT > 0 ? PLAN.slice(0, LIMIT) : PLAN;

let sessionId = opt('session', '');
const repair = has('repair');

if (!sessionId) {
  const created = await api('POST', '/api/sessions', {
    world_id: WORLD,
    title: `${TAG} ${stamp}｜${WORLD}`,
    anchor_id: ANCHOR || undefined,
    settings: SETTINGS || undefined,
  });
  sessionId = created.id;
  log(`新会话 ${sessionId}｜world=${WORLD}｜anchor=${ANCHOR}`
    + (SETTINGS ? `｜settings=${JSON.stringify(SETTINGS)}` : ''));
} else {
  log(`续跑会话 ${sessionId}`);
}

fs.appendFileSync(jsonlPath(sessionId), JSON.stringify({ meta: 'run-start', at: new Date().toISOString(), pid: process.pid }) + '\n');

let state = await existingNarratorTurns(sessionId);
if (!state.narr.size) {
  log('没有旁白回合 → 跑开场');
  await oneTurn({ sessionId, isOpening: true, phase: '开场' });
  state = await existingNarratorTurns(sessionId);
}

const orphans = findOrphans(state);
if (orphans.length) {
  if (repair) await repairOrphans(sessionId, orphans);
  else if (!has('allow-orphans')) {
    log(`\n⚠ 发现孤儿回合（只有玩家行动、没有旁白）：${orphans.map((o) => 't' + o.turn_no).join(',')}`);
    log('  续跑会把同一行动写两次，污染原文窗口。加 --repair 清掉后再跑，或手工检查。');
    process.exit(3);
  } else {
    // 第二阶段要**保留**孤儿当证据（t12 是第一阶段的一条 FAIL 发现）。
    // 清掉它等于篡改已冻结的观测对象，所以这里只放行、不修复。
    log(`\n⚠ 已知孤儿回合保留：${orphans.map((o) => 't' + o.turn_no).join(',')}（--allow-orphans）`);
  }
  state = await existingNarratorTurns(sessionId);
}

// 已消费的玩家行动数。不能只数 narrator 行：孤儿回合有玩家行、没有旁白行，
// 用 narrator 行数会把「已消费」算少一拍，续跑时把那拍的行动再发一遍。
// 也不能直接用 max(player)，否则尾部失败的那拍永远不会被重试。
const playerNos = [...state.player.keys()];
const maxPlayer = Math.max(0, ...playerNos);
const tailOrphan = maxPlayer > 0 && state.player.has(maxPlayer) && !state.narr.has(maxPlayer);
const doneActions = Math.max(0, maxPlayer - 1 - (tailOrphan ? 1 : 0));
log(`已完成 ${doneActions}/${RUN_PLAN.length} 拍玩家行动（孤儿 ${orphans.length} 个已保留）`);

const only = ONLY ? new Set(ONLY.split(',').map(Number)) : null;
const startedAt = Date.now();
let lastBranches = [];
// 从最近一条记录里恢复上一拍的走向，续跑时才能继续走选项路径
try {
  const lines = fs.readFileSync(jsonlPath(sessionId), 'utf8').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const r = JSON.parse(lines[i]);
    if (r && Array.isArray(r.branches) && r.branches.length) { lastBranches = r.branches; break; }
  }
} catch { /* 没有记录就是首次跑 */ }

for (let i = doneActions; i < RUN_PLAN.length; i++) {
  const idx = i + 1; // 第几拍玩家行动
  if (only && !only.has(idx)) continue;
  const plan = RUN_PLAN[i];
  const choice = plan.branch ? pickBranch(lastBranches, plan.branch.tones) : null;
  if (plan.branch && !choice) log(`  ⚠ t${idx} 想要分支但没有上拍走向，退化为自由行动`);
  const rec = await oneTurn({
    sessionId,
    isOpening: false,
    playerText: plan.text,
    branchChoice: choice,
    phase: `第 ${idx} 拍（turn_no=${idx + 1}）`,
  });
  lastBranches = rec.branches;
}

const totalSec = Math.round((Date.now() - startedAt) / 1000);
log('\n════════════ 本次驱动汇总 ════════════');
log(`会话   ${sessionId}`);
log(`用时   ${totalSec}s（${(totalSec / 3600).toFixed(2)}h）`);
log(`记录   ${jsonlPath(sessionId)}`);
log(`下一步 node _work/longrun-report.mjs ${sessionId} --json _work/tmp-longrun-${sessionId}.json`);
