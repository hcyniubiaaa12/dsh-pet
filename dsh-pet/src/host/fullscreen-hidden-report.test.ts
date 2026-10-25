/**
 * 桌面壳「隐藏集合上报」接线测试（工单 06）。
 *
 * 上报通道复用既有 hostRequest（bridge 管道 / HTTP 退回），宿主侧路由 POST /hidden-pets
 * 收全量集合。与 fullscreen-wiring.test.ts 同一处境：真实显隐要真机窗口，无头 CI 里钉的
 * 是**源码结构**——启动时先报空集合清残留、隐藏集合变化才上报全量、失败只记日志不回滚显隐。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 读包根下文件源码（守卫用） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('main.js 接线守卫 —— 隐藏集合上报（ticket 06）', () => {
  const main = readSource('../../runtime/electron-helper/main.js');

  test('存在「把当前隐藏集合全量上报宿主」的函数，走 POST /hidden-pets', () => {
    assert.match(main, /POST['"],\s*PET_ROUTE\s*\+\s*'\/hidden-pets'/, '必须 POST 到 /hidden-pets 路由');
    assert.match(main, /reportHiddenPets|hiddenReport/, '必须有命名清晰的上报函数/节流态');
  });

  test('body 是全量集合 { petIds: [...] }，不是增量', () => {
    assert.match(main, /petIds:/, 'body 必须带 petIds 字段');
  });

  test('启动时上报一次空集合：清掉上一进程残留的隐藏状态（不会永久静音）', () => {
    // 空数组字面量必须出现在上报调用附近（启动即清残留的唯一来源）
    assert.match(main, /reportHiddenPets\s*\(\s*\[\s*\]\s*\)/, '启动必须显式上报空集合');
  });

  test('结论变化才上报（有上次快照比对），不是每 500ms 刷一次', () => {
    assert.match(main, /lastReportedHidden/, '必须持有上次已上报的集合快照做比对');
  });

  test('上报失败只记日志：catch 里 console.error，绝不触碰显隐状态（不回滚 hiddenByFullscreen）', () => {
    const fn = main.match(/function reportHiddenPets[\s\S]*?\n\}/);
    assert.ok(fn, 'reportHiddenPets 函数体必须能被定位');
    assert.match(fn[0], /\.catch\(/, '必须接 .catch 兜住失败');
    assert.match(fn[0], /console\.error/, '失败必须留日志');
    // 显隐状态机变量绝不出现在上报函数体里（失败不回滚显隐）
    assert.doesNotMatch(fn[0], /hiddenByFullscreen|fadeThenHide|showFullscreenRestore/);
  });
});
