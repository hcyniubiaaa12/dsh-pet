/**
 * 桌面 helper「全屏判定」纯模块测试（工单 02，只算不藏）。
 *
 * fullscreen-detect.js 是零依赖纯函数：候选窗口矩形 × 显示器矩形 → 哪几块屏全屏中。
 * 判定规则来自工单 01 的实测结论（tools/probe-fullscreen.cjs）：
 *   - 重叠面积 / 显示器整块面积 ≥ 98% → 全屏（最大化窗口含 DWM 阴影约 95.5%，被排除）；
 *   - 去抖：「全屏」需连续 2 轮成立才进目标态（接线方把上一轮输出原样喂回 prevStable），
 *     「无全屏」是 fail-open 缺省、单轮即恢复——拿不准时宁可让宠物显示；
 *   - fail-open：空输入 / 非法数据 → 恒为「没有全屏」。
 *
 * 本文件钉规则本身；接线守卫（main.js 调用模块、无平台分支）也在最后一段。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helper = '../../runtime/electron-helper/';
const {
  FULLSCREEN_COVER_RATIO,
  FULLSCREEN_DEBOUNCE_COUNT,
  snapshotCoverage,
  stepFullscreenDebounce,
  computeFullscreenTargets,
} = require(helper + 'fullscreen-detect.js');

/** 读包根下文件源码（守卫用） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 一块 1920×1080、位于原点的显示器 */
const MON_A = { id: 'a', left: 0, top: 0, right: 1920, bottom: 1080 };
/** 副屏：-1920 起的另一块 1920×1080（负坐标） */
const MON_B = { id: 'b', left: -1920, top: 0, right: 0, bottom: 1080 };
/** 完整盖住 MON_A 的窗口矩形 */
const FULL_A = { left: 0, top: 0, right: 1920, bottom: 1080 };

describe('常量 —— 阈值与去抖来自 01 的实测结论', () => {
  test('覆盖阈值是 0.98（网页全屏 100%，最大化窗口 95.5%）', () => {
    assert.equal(FULLSCREEN_COVER_RATIO, 0.98);
  });
  test('去抖次数是 2', () => {
    assert.equal(FULLSCREEN_DEBOUNCE_COUNT, 2);
  });
});

describe('snapshotCoverage —— 即时覆盖判定（单轮、不含去抖）', () => {
  test('窗口完整覆盖显示器 → 该屏全屏', () => {
    assert.deepEqual(snapshotCoverage([FULL_A], [MON_A]), { a: true });
  });

  test('恰好 98% 覆盖 → 全屏（边界含端）', () => {
    // 构造精确 98%：显示器 100×100，窗口 100×98
    const mon = { id: 'm', left: 0, top: 0, right: 100, bottom: 100 };
    const win = { left: 0, top: 0, right: 100, bottom: 98 };
    assert.equal((100 * 98) / (100 * 100), 0.98);
    assert.deepEqual(snapshotCoverage([win], [mon]), { m: true });
  });

  test('97.9% 覆盖 → 不是全屏（阈值以下）', () => {
    const mon = { id: 'm', left: 0, top: 0, right: 1000, bottom: 1000 };
    const win = { left: 0, top: 0, right: 1000, bottom: 979 };
    assert.deepEqual(snapshotCoverage([win], [mon]), { m: false });
  });

  test('最大化普通窗口（含阴影约 95.5%）→ 不是全屏', () => {
    const win = { left: 0, top: 0, right: 1920, bottom: 1032 }; // 95.55%
    assert.deepEqual(snapshotCoverage([win], [MON_A]), { a: false });
  });

  test('负坐标越界的窗口：重叠面积只算落在显示器内的部分', () => {
    // 窗口向左越界 1920，但覆盖 MON_B 的部分是完整的 → B 全屏、A 不算
    const win = { left: -1920, top: 0, right: 0, bottom: 1080 };
    assert.deepEqual(snapshotCoverage([win], [MON_B, MON_A]), { b: true, a: false });
  });

  test('多显示器：只命中被覆盖的那块屏', () => {
    assert.deepEqual(snapshotCoverage([FULL_A], [MON_B, MON_A]), { b: false, a: true });
  });

  test('两块屏同时被盖 → 都为 true', () => {
    const fullB = { left: -1920, top: 0, right: 0, bottom: 1080 };
    assert.deepEqual(snapshotCoverage([FULL_A, fullB], [MON_B, MON_A]), { b: true, a: true });
  });

  test('一个窗口骑缝两块屏 → 每块屏都只有一半覆盖，都不算', () => {
    const straddle = { left: -960, top: 0, right: 960, bottom: 1080 };
    assert.deepEqual(snapshotCoverage([straddle], [MON_B, MON_A]), { b: false, a: false });
  });

  test('fail-open：空 / 非法输入不抛错，恒无全屏', () => {
    assert.deepEqual(snapshotCoverage([], [MON_A]), { a: false });
    assert.deepEqual(snapshotCoverage([FULL_A], []), {});
    assert.deepEqual(snapshotCoverage([], []), {});
    assert.deepEqual(snapshotCoverage(null, [MON_A]), { a: false });
    assert.deepEqual(snapshotCoverage([FULL_A], null), {});
    // 窗口缺字段 / 非对象 → 按「不存在」处理，合法窗口照常判定
    assert.deepEqual(snapshotCoverage([null, { left: 0 }, FULL_A], [MON_A]), { a: true });
    // 显示器缺 id / 零面积 → 跳过该屏，不连累别的屏
    assert.deepEqual(snapshotCoverage([FULL_A], [{ left: 0, top: 0, right: 0, bottom: 0 }, MON_A]), { a: true });
  });
});

describe('computeFullscreenTargets —— 去抖（接线方持有 stateMap 回喂）', () => {
  const FULL_A2 = FULL_A;

  /** 把 {targets,nextState} 拆开循环喂的便捷函数 */
  const step = (
    wins: Array<{ left: number; top: number; right: number; bottom: number }> | null | undefined,
    mons: Array<{ id: string; left: number; top: number; right: number; bottom: number }> | null | undefined,
    state: Record<string, { value: boolean; run: number }> | null | undefined,
  ) => computeFullscreenTargets(wins, mons, state);

  test('首轮（stateMap 空）→ 恒无全屏，即便此刻已被盖满', () => {
    assert.deepEqual(step([FULL_A2], [MON_A], {}).targets, { a: false });
  });

  test('连续两轮全屏 → 第二轮生效（进入去抖）', () => {
    const r1 = step([FULL_A2], [MON_A], {});
    const r2 = step([FULL_A2], [MON_A], r1.nextState);
    assert.deepEqual(r1.targets, { a: false });
    assert.deepEqual(r2.targets, { a: true });
  });

  test('单帧抖动不翻转：进入去抖期间出现一轮未盖满 → 计数清零、重新累计', () => {
    const r1 = step([FULL_A2], [MON_A], {}); // 第 1 轮盖满（方向计数 1）
    const r2 = step([], [MON_A], r1.nextState); // 抖动：未盖满，value 仍 false、计数清零
    const r3 = step([FULL_A2], [MON_A], r2.nextState); // 再盖满：重新计 1
    const r4 = step([FULL_A2], [MON_A], r3.nextState); // 连续第 2 轮 → 翻转
    assert.deepEqual(r2.targets, { a: false });
    assert.deepEqual(r3.targets, { a: false });
    assert.deepEqual(r4.targets, { a: true });
  });

  test('退出全屏同样去抖：盖满两轮后消失一轮 → 仍是全屏，连续两轮消失才退出', () => {
    let r = step([FULL_A2], [MON_A], {});
    r = step([FULL_A2], [MON_A], r.nextState); // 进入全屏
    assert.deepEqual(r.targets, { a: true });
    r = step([], [MON_A], r.nextState); // 消失第 1 轮
    assert.deepEqual(r.targets, { a: true });
    r = step([], [MON_A], r.nextState); // 消失第 2 轮
    assert.deepEqual(r.targets, { a: false });
  });

  test('新显示器第一次出现 → 无全屏（也要等下一拍确认）', () => {
    // 上一轮 a 已全屏、b 是新屏（无 state）：b 从 fail-open 起算
    const prev = { a: { value: true, run: 0 } };
    const r = step([FULL_A], [MON_B, MON_A], prev);
    assert.deepEqual(r.targets, { b: false, a: true });
  });

  test('fail-open：空 / 非法输入不抛错，恒无全屏（state 被覆盖为空态）', () => {
    // 空窗口列表：即时结论 false 连续 2 轮 → 翻回 false（即便 state 说 true）
    assert.deepEqual(step([], [MON_A], { a: { value: true, run: 0 } }).targets, { a: true }); // 第 1 轮 false 维持
    assert.deepEqual(step(null, [MON_A], null).targets, { a: false });
    assert.deepEqual(step([FULL_A], null, {}).targets, {});
    assert.deepEqual(step(undefined, undefined, undefined).targets, {});
  });

  test('屏拔了就不再占位；插回时按 fail-open 重新起算', () => {
    const r1 = step([FULL_A], [MON_A], {});
    // 显示器消失：targets / nextState 都没有它的键
    const r2 = step([], [], r1.nextState);
    assert.deepEqual(r2.targets, {});
    assert.deepEqual(r2.nextState, {});
    // 插回且被盖满：state 已被清 → 重新从首轮起算
    const r3 = step([FULL_A], [MON_A], r2.nextState);
    assert.deepEqual(r3.targets, { a: false });
  });
});

describe('源码守卫 —— 平台边界住在模块里', () => {
  test('fullscreen-detect.js 零依赖：不 require electron / koffi / fs，不碰系统调用', () => {
    const src = readSource(helper + 'fullscreen-detect.js');
    assert.ok(!/require\(/.test(src.replace(/\* [^\n]*\n/g, '')), '纯模块不得 require 任何东西');
    assert.ok(
      !/process\.|electron|koffi|EnumWindows/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')),
      '纯模块不得触碰运行环境',
    );
  });

  test('FULLSCREEN_DEBOUNCE_COUNT 语义：翻转需连续 2 轮（经 stepFullscreenDebounce 直接钉住）', () => {
    const r = (instant: boolean, state: { value: boolean; run: number } | null) =>
      stepFullscreenDebounce(instant, state);
    // 从 false 起：true 第 1 轮只记方向（run=1），第 2 轮翻转（value=true, run 归零）
    assert.deepEqual(r(true, null), { value: false, run: 1 });
    assert.deepEqual(r(true, { value: false, run: 1 }), { value: true, run: 0 });
    // 稳定后保持（与 value 一致 → run 归零）
    assert.deepEqual(r(true, { value: true, run: 0 }), { value: true, run: 0 });
    // 退出也对称：false 第 1 轮维持 true（run=1），第 2 轮才翻转
    assert.deepEqual(r(false, { value: true, run: 0 }), { value: true, run: 1 });
    assert.deepEqual(r(false, { value: true, run: 1 }), { value: false, run: 0 });
    // 中途抖回：true→false→true，计数清零重数
    assert.deepEqual(r(true, { value: false, run: 1 }), { value: true, run: 0 });
  });
});
