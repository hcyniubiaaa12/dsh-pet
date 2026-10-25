/**
 * 桌面 helper「全屏隐藏期间冻结渲染端自发行为」接线测试（工单 05）。
 *
 * 冻结是主进程 → 渲染端的一条显式通知：窗口因全屏而隐藏时发冻结、恢复后延时解冻（静置一秒）。
 * 渲染端背景节流已被关闭（webPreferences setBackgroundThrottling: false）、「窗口藏了动画自己会停」
 * 不成立，所以渲染端必须订阅这条通道。三个半边的源码（main.js / preload.js / sprite.js + renderer.js）
 * 是纯 CJS 脚本，无法在 node:test 里实例化，沿用仓库既有的源码正则守卫范式钉住接线结构。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 读包根下文件源码（守卫用） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const helper = '../../runtime/electron-helper/';

describe('工单 05 —— 全屏隐藏期间冻结渲染端自发行为', () => {
  const main = readSource(helper + 'main.js');
  const preload = readSource(helper + 'preload.js');
  const renderer = readSource(helper + 'renderer.js');
  const sprite = readSource(helper + 'sprite.js');

  test('主进程隐藏时向渲染端发冻结消息（pet:fullscreen-freeze）', () => {
    assert.match(main, /pet:fullscreen-freeze/, '通道名必须出现');
    assert.match(main, /webContents\.send\('pet:fullscreen-freeze'/, '隐藏路径必须经 webContents.send 下发冻结');
    assert.match(main, /sendFreeze/, '冻结下发必须收口在一个函数里（隐藏/恢复两处共用）');
  });

  test('恢复路径延时解冻：静置一秒后才解除冻结', () => {
    assert.match(main, /FREEZE_RELEASE_DELAY_MS\s*=\s*1000/, '必须有 1000ms 静置常量');
    // 解冻走「延时下发」封装：scheduleFreezeRelease 内部 setTimeout 到点才 sendFreeze(false)，
    // 渲染端只认通道消息，静置计时完全由主进程恢复路径持有
    const sched = main.match(/function scheduleFreezeRelease\(win\) \{[\s\S]*?\n\}/);
    assert.ok(sched, 'scheduleFreezeRelease 封装必须存在');
    assert.match(sched[0], /setTimeout\(/, '解冻必须经 setTimeout 延时');
    assert.match(sched[0], /sendFreeze\(win, false\)/, '到点发解冻消息');
    assert.match(main, /scheduleFreezeRelease\(win\)/, '恢复路径必须实际调用延时解冻');
  });

  test('preload 暴露接收口 onFullscreenFreeze', () => {
    assert.match(preload, /onFullscreenFreeze/, 'preload 必须暴露回调注册口');
    assert.match(preload, /ipcRenderer\.on\('pet:fullscreen-freeze'/, '必须订阅 pet:fullscreen-freeze 通道');
  });

  test('渲染端订阅冻结消息并接入 PetSprite 冻结开关', () => {
    assert.match(renderer, /onFullscreenFreeze/, 'renderer.js 必须注册冻结接收回调');
    // 冻结作用于 sprite 的自发行为：playIdle（随机链唯一入口）必须被门禁拦住
    assert.match(sprite, /deskFrozen/, 'PetSprite 必须有全屏冻结状态字段');
    assert.match(sprite, /applyDeskFreeze/, 'PetSprite 必须有冻结应用方法（停漫游/抛掷/随机链，不动命中判定）');
  });

  test('冻结只拦自发行为：playIdle（随机链唯一入口）被 deskFrozen 门禁', () => {
    // 随机链的唯一入口是 playIdle（只有动画播完才会走到），一句判断停住随机动画/转向/自主走位。
    // 占用锁（this.frozen）与全屏冻结（this.deskFrozen）两道门禁都必须在 playIdle 函数体内。
    const fn = sprite.match(/playIdle\(\)\x20\{[\s\S]*?\n\x20\x20\}/);
    assert.ok(fn, 'playIdle 函数必须存在');
    assert.match(fn[0], /if \(this\.frozen\) return;/, '占用锁门禁必须仍在');
    assert.match(fn[0], /if \(this\.deskFrozen\) return;/, '全屏冻结门禁必须在位');
  });
  test('冻结不改变点击穿透与命中判定：冻结代码不触碰 setInteractive/inputBusy', () => {
    // applyDeskFreeze 函数体内不得出现穿透/输入忙碌相关调用（命中判定与点击穿透状态不动）
    const fn = sprite.match(/applyDeskFreeze\(next\)\x20\{[\s\S]*?\n\x20\x20\}/);
    assert.ok(fn, 'applyDeskFreeze 函数必须存在');
    assert.doesNotMatch(fn[0], /setInteractive|inputBusy|setInputRegions/, '冻结绝不改点击穿透状态');
  });
});

describe('工单 05 code-review 修复 —— 冻结/解冻的三个边界', () => {
  const sprite = readSource(helper + 'sprite.js');

  test('解冻不顶掉正在播的命令动画：playback 非空时不 playOnce idle', () => {
    // spec：/anim、/whisper 气泡动画在冻结期间照常，恢复后要能看到——applyDeskFreeze(false)
    // 若无条件 playOnce(idle) 会把它们换源顶掉。前台有 playback 时必须让位，播完由
    // handleEnded 自然接回随机链。
    const fn = sprite.match(/applyDeskFreeze\(next\)\x20\{[\s\S]*?\n\x20\x20\}/);
    assert.ok(fn, 'applyDeskFreeze 函数必须存在');
    const unfreeze = fn[0].slice(fn[0].indexOf('全屏冻结解除'));
    assert.match(unfreeze, /if \(this\.playback\) return;/, '解冻路径必须先让位给正在播的 playback');
  });

  test('冻结定格时正在飞的 pos 必须写回 customPos（否则恢复后瞬移回旧位置）', () => {
    const fn = sprite.match(/applyDeskFreeze\(next\)\x20\{[\s\S]*?\n\x20\x20\}/);
    assert.ok(fn, 'applyDeskFreeze 函数必须存在');
    const block = fn[0].slice(fn[0].indexOf('if (next) {'), fn[0].indexOf('全屏冻结生效'));
    assert.match(block, /if \(this\.throwState\)/, '冻结时必须检查是否正在飞');
    assert.match(
      block,
      /customPos = \{ rx: \(this\.pos\.x \+ this\.halfW\) \/ VIEW\.w, ry: \(this\.pos\.y \+ this\.halfH\) \/ VIEW\.h \}/,
      '定格点必须写回 customPos（与 startThrow 落定分支同一写法）',
    );
  });

  test('隐藏期间动画链不推进：handleEnded 与 resumeWorkStatusAnim 都有 deskFrozen 门禁', () => {
    // 回执照报（reportPlayback）在门禁之前是现状、必须保持——门禁只拦「换源推进」。
    const ended = sprite.match(/handleEnded\(\)\x20\{[\s\S]*?\n\x20\x20\}/);
    assert.ok(ended, 'handleEnded 必须存在');
    const endedGuardAt = ended[0].indexOf('if (this.deskFrozen) return;');
    const reportAt = ended[0].indexOf("reportPlayback(done, 'ended')");
    assert.ok(endedGuardAt > reportAt, 'handleEnded 的 deskFrozen 门禁必须在回执照报之后');
    const resume = sprite.match(/resumeWorkStatusAnim\(\)\x20\{[\s\S]*?\n\x20\x20\}/);
    assert.ok(resume, 'resumeWorkStatusAnim 必须存在');
    assert.match(resume[0], /if \(this\.deskFrozen\) return false;/, 'resumeWorkStatusAnim 必须有 deskFrozen 门禁');
  });
});
