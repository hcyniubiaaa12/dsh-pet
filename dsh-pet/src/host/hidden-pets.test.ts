/**
 * 隐藏宠物集合（工单 06）：宿主侧的瞬时内存态——当前因全屏而被桌面壳隐藏的宠物 id 集合。
 *
 * 语义（与 spec F 节对齐）：
 *   - 集合是**全量替换**语义（桌面壳每次上报完整集合，不是增量）；
 *   - 不落盘、进程内存活，宿主重启自然清空（这里只测内存语义，落盘根本不存在）；
 *   - 自动碎碎念调度对集合内的宠物**跳过这一拍且不推进计时戳**（与占用锁同手法）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createHiddenPetRegistry, whisperSkipDecision } from './hidden-pets.ts';

describe('createHiddenPetRegistry —— 全量替换的瞬时集合', () => {
  test('初始为空：任何宠物都不在集合内', () => {
    const reg = createHiddenPetRegistry();
    assert.equal(reg.has('main'), false);
    assert.deepEqual(reg.snapshot(), []);
  });

  test('replace 全量替换：上一轮的 id 不残留', () => {
    const reg = createHiddenPetRegistry();
    reg.replace(['a', 'b']);
    assert.deepEqual(reg.snapshot().sort(), ['a', 'b']);
    reg.replace(['b']);
    assert.equal(reg.has('a'), false);
    assert.equal(reg.has('b'), true);
  });

  test('replace([]) 清空：桌面壳启动时上报空集合即可清残留', () => {
    const reg = createHiddenPetRegistry();
    reg.replace(['a']);
    reg.replace([]);
    assert.deepEqual(reg.snapshot(), []);
  });

  test('replace 对非字符串元素过滤、空串剔除（坏报文别把集合弄脏）', () => {
    const reg = createHiddenPetRegistry();
    const n = reg.replace(['a', 42, null, '', 'b']);
    assert.equal(n, 2);
    assert.deepEqual(reg.snapshot().sort(), ['a', 'b']);
  });
});

describe('whisperSkipDecision —— 这一拍要不要给这只宠物生成自动碎碎念', () => {
  const base = { lastAt: undefined as number | undefined, now: 1_000_000, periodSec: 300 };

  test('到点、既不隐藏也没被占用 → 生成并推进计时戳', () => {
    const d = whisperSkipDecision({ ...base, hidden: false, locked: false });
    assert.deepEqual(d, { generate: true, advance: true });
  });

  test('在隐藏集合内 → 跳过且**不推进**计时戳（恢复后下一拍照常，不推迟首次碎碎念）', () => {
    const d = whisperSkipDecision({ ...base, hidden: true, locked: false });
    assert.deepEqual(d, { generate: false, advance: false });
  });

  test('被占用锁占住 → 与隐藏同手法：跳过且不推进', () => {
    const d = whisperSkipDecision({ ...base, hidden: false, locked: true });
    assert.deepEqual(d, { generate: false, advance: false });
  });

  test('没到点 → 不生成也不推进（periodSec 非法时按「没到点」处理，绝不生成）', () => {
    const d = whisperSkipDecision({ ...base, hidden: false, locked: false, lastAt: base.now - 1000 });
    assert.deepEqual(d, { generate: false, advance: false });
    const bad = whisperSkipDecision({ ...base, hidden: false, locked: false, periodSec: 0 });
    assert.equal(bad.generate, false);
  });

  test('集合清空后恢复：同一只宠物从 hidden:true 转 false，到点即生成', () => {
    const d = whisperSkipDecision({ ...base, hidden: false, locked: false, lastAt: base.now - 300_001 });
    assert.deepEqual(d, { generate: true, advance: true });
  });
});
