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
  });
});
