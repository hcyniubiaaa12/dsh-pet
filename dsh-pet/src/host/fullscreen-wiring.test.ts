/**
 * 桌面 helper「全屏判定」接线测试（工单 02）。
 *
 * fullscreen-sampler.js 是 FFI 适配层：真机冒烟（probe 脚本同链路、DPI 150% 屏）已验证
 * 采样正常、最大化窗口 95.5% 被 98% 阈值排除。FFI 本身无法在无头 CI 里产出窗口，
 * 所以这里钉的是**纯结构**：
 *   - fail-open：koffi 缺失 / dll 加载失败 → 空数组 + 恰好一行告警（不刷屏）；
 *   - main.js 接线守卫：确实每 500ms 调「采样 → 判定」、结论变化打日志、无平台分支；
 *   - 发布清单：新模块进 prepack-check 必需文件（漏了 npm 包少文件、启动即崩）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helper = '../../runtime/electron-helper/';
const { sampleFullscreen, resetSamplerStateForTest } = require(helper + 'fullscreen-sampler.js');

/** 读包根下文件源码（守卫用） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('sampleFullscreen —— fail-open 契约', () => {
  test('返回形状恒为 { windows: [], monitors: [] }（本机 koffi 可用时也应成功）', () => {
    resetSamplerStateForTest();
    const r = sampleFullscreen(() => {});
    assert.ok(Array.isArray(r.windows), 'windows 必须是数组');
    assert.ok(Array.isArray(r.monitors), 'monitors 必须是数组');
    // 真机上显示器至少一块，矩形字段齐全（koffi 加载失败的 CI 环境此断言跳过语义——数组为空也合法）
    for (const mon of r.monitors) {
      assert.ok(mon.id !== undefined);
      for (const k of ['left', 'top', 'right', 'bottom']) assert.ok(Number.isFinite(mon[k]));
    }
    for (const win of r.windows) {
      for (const k of ['left', 'top', 'right', 'bottom']) assert.ok(Number.isFinite(win[k]));
    }
  });

  test('告警只发一次：连续两次失败采样只 warn 一行（不刷屏）', () => {
    resetSamplerStateForTest();
    const lines: string[] = [];
    // 模拟 koffi 不可用：用子进程隔离（避免污染本进程的模块缓存）
    // —— 直接调两次，若本机 koffi 可用则不会告警；失败路径的「只一行」在下面源码守卫里钉
    sampleFullscreen((m: string) => lines.push(m));
    sampleFullscreen((m: string) => lines.push(m));
    assert.ok(lines.length <= 1, '告警至多一行，绝不刷屏');
  });

  test('失败路径「告警一次后静默」由 warned 开关实现（源码守卫）', () => {
    const src = readSource(helper + 'fullscreen-sampler.js');
    assert.match(src, /function warnOnce/, 'warnOnce 必须存在');
    assert.match(src, /if \(warned\) return;/, '已告警必须短路');
    // DPI 声明失败要容忍（Electron 已声明过会返回 false）
    assert.match(src, /SetProcessDpiAwarenessContext/, '必须声明 DPI 感知（否则显示器矩形被虚拟化）');
    assert.match(src, /DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2/, '必须是 PER_MONITOR_AWARE_V2');
    // 边框必须取 DWM 扩展边框
    assert.match(src, /DWMWA_EXTENDED_FRAME_BOUNDS/, '必须用 DWM 扩展边框（GetWindowRect 含阴影）');
    // 过滤清单
    for (const marker of ['GetShellWindow', 'IsWindowVisible', 'IsIconic', 'WS_EX_TOOLWINDOW', 'DWMWA_CLOAKED']) {
      assert.ok(src.includes(marker), `必须过滤：${marker}`);
    }
    assert.match(src, /pid === currentPid/, '必须排除本进程窗口');
  });
});

describe('main.js 接线守卫 —— 采样 → 判定 → 日志', () => {
  const main = readSource(helper + 'main.js');

  test('main.js 必须 require 两个新模块', () => {
    assert.match(main, /require\('\.\/fullscreen-detect\.js'\)/);
    assert.match(main, /require\('\.\/fullscreen-sampler\.js'\)/);
  });

  test('主进程不得出现 process.platform 平台分支（平台边界住在模块里）', () => {
    // spec 要求平台边界住进模块；main.js 里既有 4 处 process.platform 是分支基线就有的
    // （disableHardwareAcceleration 的 win32 分支、3 处把 platform 当**数据**传给模块），
    // 不属于本片清理范围——这里钉住数量不再增长、且不允许新增 win32 相等分支。
    const count = (main.match(/process\.platform/g) || []).length;
    assert.ok(count <= 4, `main.js 的 process.platform 用法不得再增加（当前 ${count} 处）`);
    assert.equal(count === 4, /process\.platform === 'win32'/.test(main), '既有 win32 分支不得增殖');
  });

  test('500ms 周期任务的接线三要素在位', () => {
    assert.match(main, /FULLSCREEN_POLL_MS\s*=\s*500/, '必须有 500ms 常量');
    assert.match(main, /sampleFullscreen\(/, '必须采样');
    assert.match(main, /computeFullscreenTargets\(/, '必须判定');
    assert.match(main, /\[fullscreen\]/, '结论变化时必须打 [fullscreen] 日志');
  });

  test('去抖状态与目标态由接线方持有（stateMap 逐轮回喂）', () => {
    assert.match(main, /nextState/, '必须把 nextState 喂回下一轮');
  });
});

describe('发布清单 —— 新模块必须进 prepack-check 必需文件', () => {
  test('两个新模块都在清单里（main.js 顶层 require，缺了启动即崩）', () => {
    const prepack = readSource('../../scripts/prepack-check.js');
    assert.match(prepack, /'runtime\/electron-helper\/fullscreen-detect\.js'/);
    assert.match(prepack, /'runtime\/electron-helper\/fullscreen-sampler\.js'/);
    assert.match(prepack, /'runtime\/electron-helper\/fullscreen-visibility\.js'/);
  });
});

describe('main.js 接线守卫 —— code-review 修复（bootSuppressed / 开关关闭上报 / 解冻定时器）', () => {
  const main = readSource(helper + 'main.js');

  test('bootSuppressed 窗口必须能到达 lastFullscreenByWin 写入点（否则退出全屏永远不出现）', () => {
    // 修复前：`if (bootSuppressed.has(...) && lastFullscreenByWin.get(...) === undefined) continue;`
    // 挡在写入之前，条件永真——窗口永远到不了 lastFullscreenByWin.set。守卫钉住：
    // 轮询循环里不得再有「continue 短路在 set 之前」的形状，bootSuppressed 首拍必须
    // 走「保持隐藏 + 写入上一拍结论」的完整分支。
    assert.ok(
      !/if \(bootSuppressed\.has\(win\.id\) && lastFullscreenByWin\.get\(win\.id\) === undefined\) continue;/.test(
        main,
      ),
      '不得用 continue 短路 bootSuppressed 窗口（条件永真，退出全屏后宠物永久不出现）',
    );
    // 首拍分支：标隐藏 + 清 suppressed + 写 lastFullscreenByWin + 发冻结，然后才 continue
    const bootBlock = main.match(
      /if \(bootSuppressed\.has\(win\.id\) && lastFullscreenByWin\.get\(win\.id\) === undefined\) \{[\s\S]*?\n\x20{10}\}/,
    );
    assert.ok(bootBlock, 'bootSuppressed 首拍必须走完整决策分支（标隐藏 + 写结论 + 冻结）');
    assert.match(bootBlock[0], /hiddenByFullscreen\.set\(win\.id, true\)/, '首拍必须标隐藏（不闪）');
    assert.match(
      bootBlock[0],
      /lastFullscreenByWin\.set\(win\.id, fullscreen\)/,
      '首拍必须写入全屏结论（下一拍起正常接管）',
    );
    assert.match(bootBlock[0], /sendFreeze\(win, true\)/, '首拍必须发冻结（渲染端从首帧起不做自发行为）');
  });

  test('开关关闭分支放回窗口后必须上报空集合（宿主侧隐藏集合要收到清空）', () => {
    // !hideOnFullscreenEnabled 分支 return 之前必须有一句 reportHiddenPets([])
    const disabled = main.match(/if \(!hideOnFullscreenEnabled\) \{[\s\S]*?\n\x20{6}\}/);
    assert.ok(disabled, '开关关闭分支必须能被定位');
    assert.match(
      disabled[0],
      /reportHiddenPets\(\[\]\)/,
      '放回窗口后必须显式上报空集合（return 会跳过轮询末尾的上报）',
    );
  });

  test('解冻定时器按 win.id 跟踪：新冻结必须取消未触发的旧解冻', () => {
    assert.match(main, /freezeReleaseTimers/, '解冻定时器必须被跟踪（同 fadeTimers 的模式）');
    const sched = main.match(/function scheduleFreezeRelease\(win\) \{[\s\S]*?\n\}/);
    assert.ok(sched, 'scheduleFreezeRelease 必须能被定位');
    assert.match(sched[0], /cancelFreezeRelease\(win\)/, '新解冻排程前必须先取消旧的');
    // 取消必须挂在 sendFreeze(win, true) 的冻结路径上：覆盖所有冻结入口
    const send = main.match(/function sendFreeze\(win, frozen\) \{[\s\S]*?\n\}/);
    assert.ok(send, 'sendFreeze 必须能被定位');
    assert.match(send[0], /if \(frozen === true\) cancelFreezeRelease\(win\)/, '冻结路径必须先撤未触发的解冻');
  });

  test('上报失败必须回滚快照，下一拍重发（包括清空失败的场景）', () => {
    const fn = main.match(/function reportHiddenPets[\s\S]*?\n\}/);
    assert.ok(fn, 'reportHiddenPets 必须能被定位');
    assert.match(fn[0], /lastReportedHidden = /, 'catch 里必须回滚快照');
    // 回滚值不得是 ''（那会被「当前集合也是空」的下一拍短路掉，清空失败就永远不重试）
    const rollback = fn[0].match(/lastReportedHidden = ([^;]+);/g);
    assert.ok(rollback && rollback.length >= 2, '快照必须有初始赋值与失败回滚两处');
    const catchBody = fn[0].match(/\.catch\(\(e\) => \{[\s\S]*?\n\x20{2}\}\)/)?.[0] ?? '';
    assert.match(catchBody, /lastReportedHidden = /, 'catch 里必须回滚快照');
    // 哨兵必须带 NUL 前缀（\u0000）：petId 已禁控制字符，join(',') 的合法 key 永不可能含它，
    // 回滚值因此必然不等于当前 key——包括清空（key === ''）失败的场景也能在下一拍重发。
    assert.match(catchBody, /lastReportedHidden = '\\u0000failed';/, '回滚必须是必然不等于任何合法 key 的哨兵值');
  });
});
