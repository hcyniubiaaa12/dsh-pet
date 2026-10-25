/**
 * 桌面 helper「窗口显隐状态机」纯模块测试（工单 03）。
 *
 * fullscreen-visibility.js 是零依赖纯函数：输入全屏目标态与每只宠物的纯数据
 * （归属屏结论 / 当前可见性 / 交互忙碌 / 唤回压制），输出「该显示还是该隐藏、
 * 恢复时是否重钉置顶」。它回答的是**决策**；怎么 hide/show、怎么淡入淡出、
 * 什么时候采样，全是 main.js 接线的事（由源码守卫钉住）。
 *
 * 规则来源 spec D 节与工单 03：
 *   - 归属：宠物按窗口中心点落在哪块显示器来归属，与 pointInRect 同一口径；
 *     中心点不在任何屏（fail-open）→ 按非全屏处理，绝不因此藏宠物。
 *   - 隐藏延后：交互忙碌（拖拽/菜单/对话）时**延后**隐藏，忙碌不挡恢复。
 *   - 唤回压制：显式唤回后暂停自动隐藏，直到全屏状态发生**切换**才回到自动行为。
 *   - 启动即全屏：hidden=true 且全屏中 → 持续隐藏（首帧兜底显示被守卫拦下）；
 *     退出全屏后必须由轮询补显示（决策给 reassertTopmost=true）。
 *   - fail-open：开关关闭 / 判定不可用 → 恒为显示，行为与改动前完全一致。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helper = '../../runtime/electron-helper/';
const { monitorIdForPoint, decideWindowVisibility } = require(helper + 'fullscreen-visibility.js');

/** 读包根下文件源码（守卫用） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 两块 1920×1080：左屏（主）在原点，右屏接在右侧 */
const MONITORS = [
  { id: 'left', left: 0, top: 0, right: 1920, bottom: 1080 },
  { id: 'right', left: 1920, top: 0, right: 3840, bottom: 1080 },
];

describe('monitorIdForPoint —— 中心点归属（复用「点落在哪块屏」口径）', () => {
  test('中心点在左屏 → left；在右屏 → right', () => {
    assert.equal(monitorIdForPoint(MONITORS, 960, 540), 'left');
    assert.equal(monitorIdForPoint(MONITORS, 2880, 540), 'right');
  });

  test('交界处的归属确定且稳定：左闭右开，x=1920 归右屏', () => {
    assert.equal(monitorIdForPoint(MONITORS, 1920, 540), 'right');
    assert.equal(monitorIdForPoint(MONITORS, 1919, 540), 'left');
  });

  test('骑缝（点不在任何屏内）→ null，不抛错', () => {
    // 两屏之间竖缝（假设摆放有洞）与完全出界都返回 null
    assert.equal(monitorIdForPoint(MONITORS, 5000, 540), null);
    assert.equal(monitorIdForPoint(MONITORS, 960, 2000), null);
  });

  test('fail-open：空 / 非法输入恒 null，不抛错', () => {
    assert.equal(monitorIdForPoint([], 0, 0), null);
    assert.equal(monitorIdForPoint(null, 0, 0), null);
    assert.equal(monitorIdForPoint(MONITORS, Number.NaN, 540), null);
  });
});

describe('decideWindowVisibility —— 显隐决策', () => {
  /** 便捷构造：默认 开关开、非全屏、当前可见、无忙碌、无压制、无切换 */
  const decide = (over: Record<string, unknown>) =>
    decideWindowVisibility({
      enabled: true,
      fullscreen: false,
      hidden: false,
      busy: false,
      recallHold: false,
      fullscreenChanged: false,
      ...over,
    });

  test('常态（无全屏、可见）→ 保持显示，不重钉', () => {
    assert.deepEqual(decide({}), { visible: true, reassertTopmost: false, nextRecallHold: false });
  });

  test('进入全屏 → 隐藏', () => {
    assert.deepEqual(decide({ fullscreen: true }), { visible: false, reassertTopmost: false, nextRecallHold: false });
  });

  test('退出全屏 → 恢复显示且重钉置顶（不等看门狗下一拍）', () => {
    assert.deepEqual(decide({ fullscreen: false, hidden: true }), {
      visible: true,
      reassertTopmost: true,
      nextRecallHold: false,
    });
  });

  test('交互忙碌 → 延后隐藏（保持显示），但不挡恢复', () => {
    assert.deepEqual(decide({ fullscreen: true, busy: true }).visible, true);
    // 忙碌期间退出全屏：照样恢复
    assert.equal(decide({ fullscreen: false, hidden: true, busy: true }).visible, true);
  });

  test('唤回压制 → 暂缓隐藏；全屏状态发生切换才解除压制', () => {
    // 被压制：全屏中仍保持显示，压制延续
    assert.deepEqual(decide({ fullscreen: true, recallHold: true }), {
      visible: true,
      reassertTopmost: false,
      nextRecallHold: true,
    });
    // 全屏状态切换（进或出）→ 压制解除，回到自动行为（这一轮即隐藏）
    assert.deepEqual(decide({ fullscreen: true, recallHold: true, fullscreenChanged: true }), {
      visible: false,
      reassertTopmost: false,
      nextRecallHold: false,
    });
    // 退出全屏同样清压制
    assert.equal(decide({ fullscreen: false, recallHold: true, fullscreenChanged: true }).nextRecallHold, false);
  });

  test('启动即全屏：已隐藏且全屏中 → 持续隐藏（不闪现）', () => {
    assert.deepEqual(decide({ fullscreen: true, hidden: true }), {
      visible: false,
      reassertTopmost: false,
      nextRecallHold: false,
    });
  });

  test('启动即全屏后退出全屏 → 必须恢复（不能因为「从没显示过」永远不出现）', () => {
    assert.deepEqual(decide({ fullscreen: false, hidden: true }), {
      visible: true,
      reassertTopmost: true,
      nextRecallHold: false,
    });
  });

  test('fail-open：开关关闭 → 恒显示且清掉一切隐藏原因（行为与改动前一致）', () => {
    assert.deepEqual(decide({ enabled: false, fullscreen: true, hidden: true, recallHold: true }), {
      visible: true,
      reassertTopmost: true,
      nextRecallHold: false,
    });
    // 一直可见时也不该多事去重钉（不干扰置顶看门狗节拍）
    assert.deepEqual(decide({ enabled: false }), { visible: true, reassertTopmost: false, nextRecallHold: false });
  });

  test('非法输入不抛错：按「开关关、无全屏」fail-open 处理', () => {
    // 全部传 null/缺省也应给出合法决策而非抛异常
    const r = decideWindowVisibility(null as unknown as Record<string, unknown>);
    assert.equal(r.visible, true);
    assert.equal(typeof r.reassertTopmost, 'boolean');
  });
});

describe('源码守卫 —— main.js 接线（工单 03 的既有约束）', () => {
  const main = readSource(helper + 'main.js');

  test('main.js 必须 require 显隐决策模块', () => {
    assert.match(main, /require\('\.\/fullscreen-visibility\.js'\)/);
  });

  test('指针兜底轮询必须有可见性守卫：窗口不可见时跳过（不翻点击穿透）', () => {
    // 守卫必须位于轮询回调内、getBounds 之前
    const poll = main.slice(main.indexOf('const pointerTimer = setInterval'));
    assert.match(poll, /if \(!win\.isVisible\(\)\) return;/, '指针轮询开头必须 isVisible 守卫');
  });

  test('首帧兜底显示必须尊重「当前应隐藏」状态（启动即全屏不闪现）', () => {
    // 两处无条件显示（ready-to-show 与 400ms 兜底）都必须过 visibleGate
    assert.match(main, /visibleGate/, '必须存在可见性闸门');
    assert.match(main, /win\.once\('ready-to-show'[^]*visibleGate/);
    assert.match(main, /did-finish-load[^]*visibleGate/);
    // 首帧被拦下的窗口必须由轮询补显示，否则退出全屏后永远不出现
    assert.match(main, /bootSuppressed/, '首帧被拦的窗口要单独记账，供轮询恢复');
  });

  test('开关关闭时把已隐藏的窗口放回来（不残留隐藏原因）', () => {
    // 关闭分支必须早于采样返回，且对已隐藏窗口（含首帧被拦的）走恢复路径
    const disabled = main.slice(main.indexOf('if (!hideOnFullscreenEnabled)'));
    assert.ok(disabled.length > 0, '轮询必须有「开关关闭」的早退分支');
    assert.match(disabled, /showFullscreenRestore\(win\)/, '关闭开关要把已隐藏的窗口恢复显示');
    assert.match(disabled, /\[fullscreen\] show/, '恢复要留日志');
  });

  test('开关是模块级状态：首帧闸门读得到它（关掉时启动不许被拦）', () => {
    assert.match(main, /let hideOnFullscreenEnabled = true/);
    const gate = main.slice(main.indexOf('function visibleGate'));
    assert.match(gate, /if \(!hideOnFullscreenEnabled\) return true;/, '闸门必须尊重开关');
  });

  test('恢复路径必须自带置顶重钉：showInactive → setAlwaysOnTop → moveTop', () => {
    assert.match(
      main,
      /showFullscreenRestore[\s\S]*showInactive\(\)[\s\S]*setAlwaysOnTop\(true, 'screen-saver'\)[\s\S]*moveTop\(\)/,
    );
  });

  test('隐藏走淡出，且淡出失败退化为直接 hide()（正确性优先于观感）', () => {
    assert.match(main, /fadeThenHide/, '必须存在淡出封装');
    const fade = main.slice(main.indexOf('function fadeThenHide'));
    assert.match(fade, /setOpacity/, '淡出要用 setOpacity');
    assert.match(fade, /catch/, '淡出路径必须有 catch 兜底');
    assert.match(fade, /hide\(\)/, '淡出终点（或 catch 兜底）是 hide()');
  });

  test('隐藏/恢复必须打 [fullscreen] 日志（00 号工单落盘可查）', () => {
    assert.match(main, /\[fullscreen\] hide/);
    assert.match(main, /\[fullscreen\] show/);
  });

  test('主进程 process.platform 用法不得再增加（守卫基线 4 处）', () => {
    const count = (main.match(/process\.platform/g) || []).length;
    assert.ok(count <= 4, `process.platform 用法不得增加（当前 ${count} 处）`);
  });
});

describe('源码守卫 —— main.js 唤回压制接线（工单 04）', () => {
  const main = readSource(helper + 'main.js');

  test('必须有 per-window 唤回压制状态（recallHoldByWin），且轮询不再恒传 recallHold:false', () => {
    assert.match(main, /const recallHoldByWin = new Map\(\)/, '压制状态必须按窗口记账');
    assert.ok(!/recallHold: false/.test(main), '轮询必须读真实压制状态，不得残留恒 false 的占位');
  });

  test('轮询必须把决策输出的压制状态喂回下一轮（nextRecallHold → recallHoldByWin）', () => {
    const poll = main.slice(main.indexOf('decideWindowVisibility('));
    assert.match(poll, /recallHold: recallHoldByWin\.get\(win\.id\) === true/, '压制输入必须来自真实 Map');
    assert.match(
      poll,
      /recallHoldByWin\.set\(win\.id, decision\.nextRecallHold\)/,
      '决策的 nextRecallHold 必须喂回下一轮',
    );
  });

  test('/control 显式唤回必须设压制并强制恢复已隐藏的窗口', () => {
    const control = main.slice(main.indexOf("'/control'"));
    assert.ok(control.length > 0, '必须有 /control 处理分支');
    assert.match(control, /recallHoldByWin\.set\(/, '唤回时要对该窗口开启压制');
    assert.match(control, /showFullscreenRestore\(/, '唤回要把因全屏隐藏的窗口恢复显示');
    assert.match(control, /hiddenByFullscreen\.set\(win\.id, false\)/, '恢复必须清掉隐藏标记（否则决策仍视为隐藏）');
  });

  test('压制状态的生命周期与其它 per-window 状态一致：开关关闭清空、窗口销毁清理', () => {
    const disabled = main.slice(main.indexOf('if (!hideOnFullscreenEnabled)'));
    assert.match(disabled, /recallHoldByWin\.clear\(\)/, '开关关闭时压制全部解除');
    const closed = main.slice(main.indexOf("win.on('closed'"));
    assert.match(closed, /recallHoldByWin\.delete\(win\.id\)/, '窗口销毁要清掉它的压制标记');
  });
});

describe('源码守卫 —— 显隐模块零依赖', () => {
  test('fullscreen-visibility.js 不 require 任何东西、不碰运行环境', () => {
    const src = readSource(helper + 'fullscreen-visibility.js');
    assert.ok(!/require\(/.test(src.replace(/\* [^\n]*\n/g, '')), '纯模块不得 require');
    assert.ok(
      !/process\.|electron|BrowserWindow/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')),
      '纯模块不得触碰运行环境',
    );
  });
});
