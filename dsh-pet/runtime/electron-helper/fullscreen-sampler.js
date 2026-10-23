/**
 * 桌面 helper —— 全屏判定的 FFI 采样器（工单 02）。
 *
 * 职责：把 Win32 的窗口/显示器数据规范化成**纯数据**交给 fullscreen-detect.js 判定。
 * 参考实现是 tools/probe-fullscreen.cjs（工单 01 真机验证过的探测脚本），API 用法
 * （koffi 回调包装、C 字符串声明、RECT 结构体）直接照抄它。
 *
 * 【为什么必须 DPI 声明】Node 侧枚举窗口若不做 DPI 感知声明，EnumDisplayMonitors 的
 * 显示器矩形会被系统按 DPI 虚拟化（150% 时 2560×1528 报成 1707×1067），而 DWM 边框
 * 永远是物理像素——两边口径不一致，重叠比全部失真（probe 脚本头注释有实测记录）。
 * 所以采样前先 SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)；**失败要容忍**：
 * 进程已声明过（Electron 主进程自己管理 DPI 感知）会返回 false，那不是错误。
 *
 * 【fail-open】koffi 加载失败 / 任何调用抛错 → 返回空数组 + 一行告警，**不重复刷屏**
 * （告警只发一次，之后静默返回空）。空数组喂给判定模块走 fail-open → 恒无全屏。
 *
 * 【过滤】与 probe 脚本同口径：本进程窗口、桌面窗口（GetShellWindow）、不可见、
 * 最小化、DWM cloaked、工具窗（WS_EX_TOOLWINDOW，含多数任务栏/浮层）、零面积窗口
 * 全部排除；边框取 DWMWA_EXTENDED_FRAME_BOUNDS（GetWindowRect 含不可见阴影，不用）。
 *
 * 本模块可 require koffi，但不 require electron；main.js 每 500ms 调一次 sampleFullscreen()。
 */

'use strict';

/** 采样告警只发一次的开关（「不刷屏」靠它；导出仅供测试重置） */
let warned = false;

/** 上一轮的 DPI 声明结果（声明只需成功一次；重复声明无害但没必要） */
let dpiDeclared = false;

/** 重置告警与 DPI 声明状态（测试用） */
function resetSamplerStateForTest() {
  warned = false;
  dpiDeclared = false;
}

/** 已发过告警就不再发（一行告警不刷屏） */
function warnOnce(warn) {
  if (warned) return;
  warned = true;
  warn('[dsh-pet-desktop-helper] fullscreen sampler unavailable: ffi load failed (fail-open, no fullscreen)');
}

/**
 * 加载 koffi 并声明全部 Win32 API。任何一步失败返回 null（fail-open 的入口）。
 * 返回 { koffi, user32, dwmapi, kernel32, api, structs, consts }。
 */
function loadFfi() {
  let koffi;
  try {
    koffi = require('koffi');
  } catch {
    return null;
  }
  try {
    const user32 = koffi.load('user32.dll');
    const dwmapi = koffi.load('dwmapi.dll');
    const kernel32 = koffi.load('kernel32.dll');

    const RECT = koffi.struct('dshFfsRECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    const MONITORINFO = koffi.struct('dshFfsMONITORINFO', {
      cbSize: 'uint32',
      rcMonitor: RECT,
      rcWork: RECT,
      dwFlags: 'uint32',
    });
    const WNDPROC = koffi.proto('bool dshFfsWndproc(intptr hwnd, intptr lparam)');
    const WNDPROC_P = koffi.pointer('dshFfsWNDPROC_P', WNDPROC);
    const MONITORENUMPROC = koffi.proto('bool dshFfsMonproc(intptr hmon, intptr hdc, intptr rect, intptr lparam)');
    const MONITORENUMPROC_P = koffi.pointer('dshFfsMONITORENUMPROC_P', MONITORENUMPROC);

    const fn = (lib, sig) => lib.func(sig);
    const api = {
      SetProcessDpiAwarenessContext: fn(user32, 'bool __stdcall SetProcessDpiAwarenessContext(intptr value)'),
      EnumWindows: fn(user32, 'bool __stdcall EnumWindows(dshFfsWNDPROC_P cb, intptr lparam)'),
      EnumDisplayMonitors: fn(
        user32,
        'bool __stdcall EnumDisplayMonitors(intptr hdc, intptr clip, dshFfsMONITORENUMPROC_P cb, intptr lparam)',
      ),
      IsWindowVisible: fn(user32, 'bool __stdcall IsWindowVisible(intptr hwnd)'),
      IsIconic: fn(user32, 'bool __stdcall IsIconic(intptr hwnd)'),
      GetWindowLongW: fn(user32, 'int __stdcall GetWindowLongW(intptr hwnd, int index)'),
      MonitorFromWindow: fn(user32, 'intptr __stdcall MonitorFromWindow(intptr hwnd, uint32 flags)'),
      GetMonitorInfoW: fn(user32, 'bool __stdcall GetMonitorInfoW(intptr hmon, _Out_ dshFfsMONITORINFO *info)'),
      GetShellWindow: fn(user32, 'intptr __stdcall GetShellWindow()'),
      GetWindowThreadProcessId: fn(user32, 'uint32 __stdcall GetWindowThreadProcessId(intptr hwnd, _Out_ uint32 *pid)'),
      DwmGetWindowAttribute: fn(
        dwmapi,
        'int __stdcall DwmGetWindowAttribute(intptr hwnd, uint32 attr, _Out_ void *buf, uint32 cb)',
      ),
    };
    const structs = { RECT, MONITORINFO, WNDPROC_P, MONITORENUMPROC_P };
    const consts = {
      DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2: -4,
      DWMWA_EXTENDED_FRAME_BOUNDS: 9,
      DWMWA_CLOAKED: 14,
      MONITOR_DEFAULTTONEAREST: 2,
      GWL_EXSTYLE: -20,
      WS_EX_TOOLWINDOW: 0x80,
    };
    return { koffi, user32, dwmapi, kernel32, api, structs, consts };
  } catch {
    return null;
  }
}

/** 惰性单例：进程内只 load 一次（dll 句柄与 koffi 类型注册都是进程级的） */
let ffi = null;
let ffiTried = false;

function getFfi() {
  if (!ffiTried) {
    ffiTried = true;
    ffi = loadFfi();
  }
  return ffi;
}

function allocU32(koffi, value) {
  const addr = koffi.alloc('uint32', 1);
  koffi.encode(addr, 'uint32', value);
  return addr;
}

/**
 * 声明本进程 DPI-aware（PER_MONITOR_AWARE_V2）。返回是否成功；
 * 已声明过（Electron 自己管理 DPI）会返回 false——容忍，不算失败。
 */
function declareDpiAware(ffiCtx) {
  if (dpiDeclared) return true;
  const ok =
    Number(
      ffiCtx.api.SetProcessDpiAwarenessContext(BigInt(ffiCtx.consts.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)),
    ) !== 0;
  if (ok) dpiDeclared = true;
  return ok;
}

/**
 * 枚举显示器整块矩形（rcMonitor，含任务栏区——判定规则明说不用工作区）。
 * 返回 [{id, left, top, right, bottom}]，id 是 HMONITOR 的十进制字符串。
 */
function collectMonitors(ffiCtx) {
  const { koffi, api, structs } = ffiCtx;
  const monitors = [];
  const infoAddr = koffi.alloc(structs.MONITORINFO, 1);
  const infoSize = koffi.sizeof(structs.MONITORINFO);
  const cb = koffi.register((hmon) => {
    try {
      koffi.encode(infoAddr, structs.MONITORINFO, {
        cbSize: infoSize,
        rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 },
        rcWork: { left: 0, top: 0, right: 0, bottom: 0 },
        dwFlags: 0,
      });
      if (api.GetMonitorInfoW(hmon, infoAddr)) {
        const info = koffi.decode(infoAddr, structs.MONITORINFO);
        const r = info.rcMonitor;
        monitors.push({
          id: String(hmon),
          left: Number(r.left),
          top: Number(r.top),
          right: Number(r.right),
          bottom: Number(r.bottom),
        });
      }
    } catch {
      /* 单块屏失败不影响其它屏 */
    }
    return true;
  }, structs.MONITORENUMPROC_P);
  try {
    api.EnumDisplayMonitors(0, 0, cb, 0);
  } finally {
    koffi.unregister(cb);
  }
  return monitors;
}

/** DWM 扩展边框（物理像素、不含阴影）；读取失败返回 null */
function dwmFrameBounds(ffiCtx, hwnd) {
  const { koffi, api, structs, consts } = ffiCtx;
  const addr = koffi.alloc(structs.RECT, 1);
  const hr = Number(
    api.DwmGetWindowAttribute(hwnd, consts.DWMWA_EXTENDED_FRAME_BOUNDS, addr, koffi.sizeof(structs.RECT)),
  );
  if (hr !== 0) return null;
  const r = koffi.decode(addr, structs.RECT);
  return { left: Number(r.left), top: Number(r.top), right: Number(r.right), bottom: Number(r.bottom) };
}

/** 窗口是否被 DWM 隐身（UWP 挂起壳等；读取失败按未隐身处理） */
function isCloaked(ffiCtx, hwnd) {
  const { koffi, api, consts } = ffiCtx;
  const addr = koffi.alloc('uint32', 1);
  const hr = Number(api.DwmGetWindowAttribute(hwnd, consts.DWMWA_CLOAKED, addr, 4));
  return hr === 0 && Number(koffi.decode(addr, 'uint32', 1)[0]) !== 0;
}

/**
 * 枚举候选窗口矩形（过滤规则见文件头）。返回 [{left, top, right, bottom}]。
 * @param {number} currentPid 本进程 PID（排除自己的窗口）
 */
function collectWindows(ffiCtx, currentPid) {
  const { koffi, api, structs, consts } = ffiCtx;
  const wins = [];
  const shell = Number(api.GetShellWindow());
  const pidAddr = allocU32(koffi, 0);
  const cb = koffi.register((hwnd) => {
    try {
      if (Number(hwnd) === shell) return true; // 桌面窗口本身
      if (!api.IsWindowVisible(hwnd) || api.IsIconic(hwnd)) return true; // 不可见 / 最小化
      if (isCloaked(ffiCtx, hwnd)) return true; // DWM 隐身
      const exStyle = Number(api.GetWindowLongW(hwnd, consts.GWL_EXSTYLE));
      if (exStyle & consts.WS_EX_TOOLWINDOW) return true; // 工具窗（含多数任务栏/浮层）
      api.GetWindowThreadProcessId(hwnd, pidAddr);
      const pid = Number(koffi.decode(pidAddr, 'uint32', 1)[0]);
      if (pid === currentPid) return true; // 本进程自己的窗口（宠物窗）
      const rect = dwmFrameBounds(ffiCtx, hwnd);
      if (!rect) return true; // 没有 DWM 边框（层窗/无 DWM 的老窗口）：不参与判定
      if (rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0) return true; // 零面积
      wins.push(rect);
    } catch {
      /* 单个窗口失败不影响整轮 */
    }
    return true;
  }, structs.WNDPROC_P);
  try {
    api.EnumWindows(cb, 0);
  } finally {
    koffi.unregister(cb);
  }
  return wins;
}

/**
 * 采样一轮：候选窗口矩形 + 显示器矩形（纯数据）。
 * 任何失败（koffi 缺失 / dll 加载失败 / 调用抛错）→ 空数组 + 至多一行告警。
 * @param {(msg: string) => void} [warn] 告警出口（main.js 传 console.error）
 * @returns {{ windows: Array, monitors: Array }}
 */
function sampleFullscreen(warn) {
  try {
    const ffiCtx = getFfi();
    if (!ffiCtx) {
      warnOnce(warn || (() => {}));
      return { windows: [], monitors: [] };
    }
    declareDpiAware(ffiCtx);
    const monitors = collectMonitors(ffiCtx);
    const windows = collectWindows(ffiCtx, Number(process.pid));
    return { windows, monitors };
  } catch {
    warnOnce(warn || (() => {}));
    return { windows: [], monitors: [] };
  }
}

module.exports = { sampleFullscreen, resetSamplerStateForTest };
