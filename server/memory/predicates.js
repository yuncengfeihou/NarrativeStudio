/**
 * server/memory/predicates.js — 断言谓词的受控词表与基数
 *
 * cardinality 决定「同主同谓、对象不同」是否构成矛盾：
 *   one  —— 同一时刻只能有一个对象（位于、是、曾经是），冲突时旧断言失效；
 *   many —— 可以并存（知道、拥有、想要、害怕…），对象不同不是矛盾。
 *
 * 这份表是史官提示词、确定性校验与冲突检测的唯一来源；新增谓词必须同时改这里、
 * 史官提示词与测试。
 */

export const PREDICATES = [
  '知道', '不知道', '相信', '想要', '害怕', '拥有', '位于', '属于',
  '敌对', '效忠', '隐瞒', '承诺', '欠', '伤害', '救下', '是', '曾经是',
];

export const PREDICATE_CARDINALITY = Object.freeze({
  位于: 'one',
  是: 'one',
  曾经是: 'one',
  知道: 'many',
  不知道: 'many',
  相信: 'many',
  想要: 'many',
  害怕: 'many',
  拥有: 'many',
  属于: 'many',
  敌对: 'many',
  效忠: 'many',
  隐瞒: 'many',
  承诺: 'many',
  欠: 'many',
  伤害: 'many',
  救下: 'many',
});

/** 只有单值谓词才参与「同主同谓不同对象」的冲突失效。 */
export function isFunctionalPredicate(predicate) {
  return PREDICATE_CARDINALITY[String(predicate || '').trim()] === 'one';
}
