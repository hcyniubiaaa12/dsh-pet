#!/usr/bin/env node
/**
 * 全屏判定探测脚本（工单 01）——独立诊断工具，不属于运行时代码，也不进 npm test。
 *
 * 用途：在真实桌面上验证 spec B/C 节的判定规则能否可靠识别全屏：
 *   EnumWindows 枚举顶层窗口 → DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)
 *   取真实边框（GetWindowRect 含不可见阴影，不用）→ 与各显示器矩形（bounds，非工作区）
 *   比对，重叠面积 / 显示器面积 ≥ 98% 即判该屏全屏中。
 *
 * 用法：在 dsh-pet/ 包根下 `node tools/probe-fullscreen.cjs`，然后由人逐一操作五种场景
 * （见 .scratch/fullscreen-hide/issues/01-fullscreen-detection-probe.md），观察控制台输出。
 * 输出同时写入 `<DSH_HOME>/dsh-pet/logs/probe-<时间戳>.log`（DSH_HOME 取环境变量，缺省
 * ~/.dsh；目录不存在则创建；写失败静默退化为只打印），供安装版无终端场景取文件。
 * Ctrl+C 干净退出。
 *
 * 实现手段：koffi（FFI，预编译二进制，devDependency）直接调 Win32。所有 Windows API 都是
 * 物理像素，显示器矩形与 DWM 边框天然同口径；DPI ≠ 100% 时脚本照打原始矩形供人工核对。
 *
 * koffi 备注（3.3.3 实测）：
 *   - 回调：koffi.proto 定义类型，koffi.pointer() 包一层，register 时 (func, proto)。
 *   - 输出参数：koffi.alloc(type, n) 返回原始地址（BigInt），用 koffi.encode 写、
 *     koffi.decode 读，不能当数组用。
 *   - 函数声明用 C 风格字符串 `bool __stdcall Foo(...)` 最可靠。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let koffi;
try {
  koffi = require('koffi');
} catch (err) {
  console.error('[probe] 无法加载 koffi（先在 dsh-pet/ 下 pnpm install）：', err.message);
  process.exit(1);
}

const user32 = koffi.load('user32.dll');
const dwmapi = koffi.load('dwmapi.dll');
const kernel32 = koffi.load('kernel32.dll');

// DPI 声明：必须让本进程 DPI-aware，否则系统会把 EnumDisplayMonitors 的显示器矩形
// 按 DPI 虚拟化（150% 缩放时 2560x1528 的屏会报成 1707x1067），与 DWM 边框（永远物理像素）
// 口径不一致，重叠比全部失真。实测本机 DPI 150% 时两边确实不一致，故此调用是必需的。
const SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr value)');
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;
SetProcessDpiAwarenessContext(BigInt(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2));

// ---- 类型 ----

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const MONITORINFO = koffi.struct('MONITORINFO', {
  cbSize: 'uint32',
  rcMonitor: RECT,
  rcWork: RECT,
  dwFlags: 'uint32',
});
const WNDPROC = koffi.proto('bool wndproc(intptr hwnd, intptr lparam)');
const WNDPROC_P = koffi.pointer('WNDPROC_P', WNDPROC);
const MONITORENUMPROC = koffi.proto('bool monproc(intptr hmon, intptr hdc, intptr rect, intptr lparam)');
const MONITORENUMPROC_P = koffi.pointer('MONITORENUMPROC_P', MONITORENUMPROC);

// ---- API ----

const fn = (lib, sig) => lib.func(sig);
const EnumWindows = fn(user32, 'bool __stdcall EnumWindows(WNDPROC_P cb, intptr lparam)');
const EnumDisplayMonitors = fn(
  user32,
  'bool __stdcall EnumDisplayMonitors(intptr hdc, intptr clip, MONITORENUMPROC_P cb, intptr lparam)',
);
const IsWindowVisible = fn(user32, 'bool __stdcall IsWindowVisible(intptr hwnd)');
const IsIconic = fn(user32, 'bool __stdcall IsIconic(intptr hwnd)');
const GetWindowTextW = fn(user32, 'int __stdcall GetWindowTextW(intptr hwnd, uint16 *buf, int max)');
const GetClassNameW = fn(user32, 'int __stdcall GetClassNameW(intptr hwnd, uint16 *buf, int max)');
const GetWindowLongW = fn(user32, 'int __stdcall GetWindowLongW(intptr hwnd, int index)');
const MonitorFromWindow = fn(user32, 'intptr __stdcall MonitorFromWindow(intptr hwnd, uint32 flags)');
const GetMonitorInfoW = fn(user32, 'bool __stdcall GetMonitorInfoW(intptr hmon, _Out_ MONITORINFO *info)');
const GetShellWindow = fn(user32, 'intptr __stdcall GetShellWindow()');
const GetWindowThreadProcessId = fn(
  user32,
  'uint32 __stdcall GetWindowThreadProcessId(intptr hwnd, _Out_ uint32 *pid)',
);
const DwmGetWindowAttribute = fn(
  dwmapi,
  'int __stdcall DwmGetWindowAttribute(intptr hwnd, uint32 attr, _Out_ void *buf, uint32 cb)',
);
const OpenProcess = fn(kernel32, 'intptr __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
const CloseHandle = fn(kernel32, 'bool __stdcall CloseHandle(intptr handle)');
const QueryFullProcessImageNameW = fn(
  kernel32,
  'bool __stdcall QueryFullProcessImageNameW(intptr proc, uint32 flags, uint16 *buf, _Inout_ uint32 *size)',
);

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const MONITOR_DEFAULTTONEAREST = 2;
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x80;
const THRESHOLD = 0.98;

// ---- Win32 小工具 ----

/** 读一块 uint16 输出缓冲，按实际长度转 JS 字符串 */
function readU16(addr, count) {
  const u16 = koffi.decode(addr, 'uint16', count);
  let s = '';
  for (let i = 0; i < count && u16[i]; i++) s += String.fromCharCode(u16[i]);
  return s;
}

function allocU32(value) {
  const addr = koffi.alloc('uint32', 1);
  koffi.encode(addr, 'uint32', value);
  return addr;
}

function collectMonitors() {
  const monitors = new Map();
  const infoAddr = koffi.alloc(MONITORINFO, 1);
  const infoSize = koffi.sizeof(MONITORINFO);
  const cb = koffi.register((hmon) => {
    koffi.encode(infoAddr, MONITORINFO, {
      cbSize: infoSize,
      rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 },
      rcWork: { left: 0, top: 0, right: 0, bottom: 0 },
      dwFlags: 0,
    });
    if (GetMonitorInfoW(hmon, infoAddr)) {
      const info = koffi.decode(infoAddr, MONITORINFO);
      const r = info.rcMonitor;
      monitors.set(String(hmon), {
        id: hmon,
        left: Number(r.left),
        top: Number(r.top),
        right: Number(r.right),
        bottom: Number(r.bottom),
      });
    }
    return true;
  }, MONITORENUMPROC_P);
  EnumDisplayMonitors(0, 0, cb, 0);
  koffi.unregister(cb);
  return monitors;
}

function dwmRect(hwnd, attr) {
  const addr = koffi.alloc(RECT, 1);
  const hr = DwmGetWindowAttribute(hwnd, attr, addr, koffi.sizeof(RECT));
  if (Number(hr) !== 0) return null;
  const r = koffi.decode(addr, RECT);
  return { left: Number(r.left), top: Number(r.top), right: Number(r.right), bottom: Number(r.bottom) };
}

function readText(fnRead, hwnd) {
  const buf = koffi.alloc('uint16', 256);
  const n = Number(fnRead(hwnd, buf, 256));
  return n > 0 ? readU16(buf, n) : '';
}

const procNameCache = new Map();
function processName(pid) {
  if (!pid) return '?';
  if (procNameCache.has(pid)) return procNameCache.get(pid);
  let name = `pid ${pid}`;
  const proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (proc) {
    try {
      const buf = koffi.alloc('uint16', 512);
      const sizeAddr = allocU32(512);
      if (QueryFullProcessImageNameW(proc, 0, buf, sizeAddr)) {
        const full = readU16(buf, Number(koffi.decode(sizeAddr, 'uint32', 1)[0]));
        name = full.split('\\').pop() || full;
      }
    } finally {
      CloseHandle(proc);
    }
  }
  procNameCache.set(pid, name);
  return name;
}

function cloaked(hwnd) {
  // DWMWA_CLOAKED：读取成功且值非 0 即被 DWM 隐身（UWP 挂起壳等）
  const addr = koffi.alloc('uint32', 1);
  const hr = Number(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, addr, 4));
  return hr === 0 && Number(koffi.decode(addr, 'uint32', 1)[0]) !== 0;
}

function overlapRatio(win, mon) {
  const ox = Math.max(0, Math.min(win.right, mon.right) - Math.max(win.left, mon.left));
  const oy = Math.max(0, Math.min(win.bottom, mon.bottom) - Math.max(win.top, mon.top));
  const monArea = Math.max(1, (mon.right - mon.left) * (mon.bottom - mon.top));
  return (ox * oy) / monArea;
}

// ---- 输出：控制台 + 文件 ----

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const logDir = path.join(dshHome, 'dsh-pet', 'logs');
let logPath = null;
let logFd = null;
try {
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  logPath = path.join(logDir, `probe-${stamp}.log`);
  logFd = fs.openSync(logPath, 'a');
} catch {
  // 目录/文件打不开：静默退化为只打印
}

function out(line) {
  console.log(line);
  if (logFd !== null) {
    try {
      fs.writeSync(logFd, line + '\n');
    } catch {
      // 写失败就不再试
      try {
        fs.closeSync(logFd);
      } catch {
        /* 忽略 */
      }
      logFd = null;
    }
  }
}

// ---- 主循环 ----

const monitors = collectMonitors();
let lastState = '';

function snapshot() {
  const shell = GetShellWindow();
  const pidAddr = allocU32(0);
  const found = [];

  const cb = koffi.register((hwnd) => {
    try {
      if (hwnd === shell) return true; // 桌面窗口本身
      if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return true;
      if (cloaked(hwnd)) return true;
      const exStyle = Number(GetWindowLongW(hwnd, GWL_EXSTYLE));
      if (exStyle & WS_EX_TOOLWINDOW) return true; // 工具窗（含多数任务栏/浮窗）
      const rect = dwmRect(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS);
      if (!rect) return true;
      const w = rect.right - rect.left;
      const h = rect.bottom - rect.top;
      if (w <= 0 || h <= 0) return true;

      const hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
      const mon = monitors.get(String(hmon));
      if (!mon) return true;
      const ratio = overlapRatio(rect, mon);
      if (ratio <= 0.01) return true; // 跟该屏基本无关的小窗不刷出来
      GetWindowThreadProcessId(hwnd, pidAddr);
      const pid = Number(koffi.decode(pidAddr, 'uint32', 1)[0]);
      const cls = readText(GetClassNameW, hwnd);
      const title = readText(GetWindowTextW, hwnd) || cls || '(无标题)';
      found.push({ hwnd, title, cls, pid, mon, rect, ratio, fullscreen: ratio >= THRESHOLD });
    } catch {
      // 单个窗口失败不影响整轮
    }
    return true;
  }, WNDPROC_P);

  EnumWindows(cb, 0);
  koffi.unregister(cb);

  // 按显示器分组，每块屏报占比最高的几个窗口
  const byMon = new Map();
  for (const f of found) {
    if (!byMon.has(f.mon.id)) byMon.set(f.mon.id, []);
    byMon.get(f.mon.id).push(f);
  }

  const lines = [];
  for (const [, mon] of monitors) {
    const wins = (byMon.get(mon.id) || []).sort((a, b) => b.ratio - a.ratio);
    const top = wins[0];
    const verdict = top && top.fullscreen ? '【全屏】' : '（不满足）';
    lines.push(`显示器 0x${mon.id.toString(16)} (${mon.left},${mon.top})-(${mon.right},${mon.bottom}) => ${verdict}`);
    for (const f of wins.slice(0, 5)) {
      lines.push(
        `  ratio=${(f.ratio * 100).toFixed(2)}% ${f.fullscreen ? '[FULL]' : '     '} hwnd=0x${f.hwnd.toString(16)} ` +
          `dwm=(${f.rect.left},${f.rect.top})-(${f.rect.right},${f.rect.bottom}) ` +
          `"${f.title}" cls=${f.cls} proc=${processName(f.pid)}`,
      );
    }
    if (!wins.length) lines.push('  （该屏无候选窗口）');
  }
  // 状态比较键：不含标题/类名等易变字段（如终端 spinner 每秒都在变），
  // 否则「状态变化才打印」会退化成每轮都打印。
  const stable = [];
  for (const [, mon] of monitors) {
    const wins = (byMon.get(mon.id) || []).sort((a, b) => b.ratio - a.ratio);
    stable.push(
      mon.id,
      ...wins
        .slice(0, 5)
        .map((f) => `${f.hwnd}:${f.rect.left},${f.rect.top},${f.rect.right},${f.rect.bottom}:${f.ratio.toFixed(4)}`),
    );
  }
  return { lines: lines.join('\n'), state: stable.join('|') };
}

out(`[probe] 全屏判定探测  阈值=${THRESHOLD * 100}%  PID=${process.pid}`);
out(`[probe] 日志文件：${logFd !== null ? logPath : '(写文件失败，仅控制台输出)'}`);
for (const [, mon] of monitors) {
  out(
    `[probe] 显示器 0x${mon.id.toString(16)}: (${mon.left},${mon.top})-(${mon.right},${mon.bottom}) ` +
      `${mon.right - mon.left}x${mon.bottom - mon.top}`,
  );
}
out('[probe] 开始轮询，每 500ms 一轮，状态变化才打印……Ctrl+C 退出\n');

const timer = setInterval(() => {
  try {
    const { lines, state } = snapshot();
    if (state !== lastState) {
      lastState = state;
      out(`---- ${new Date().toLocaleTimeString()} ----`);
      out(lines);
      out('');
    }
  } catch (err) {
    out(`[probe] 轮询出错（继续）：${err && err.message}`);
  }
}, 500);

function shutdown() {
  clearInterval(timer);
  if (logFd !== null) {
    try {
      fs.closeSync(logFd);
    } catch {
      /* 忽略 */
    }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
