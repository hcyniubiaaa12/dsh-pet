/**
 * dsh-pet desktop helper —— 全屏判定的纯逻辑（工单 02，只算不藏）。
 *
 * 【现场】spec 的目标态是「宠物在全屏应用前隐藏」，第一步（本片）只负责**算**：
 * 现在哪几块显示器处于全屏中，并让结论能从日志看到；窗口显隐一行代码都不动。
 *
 * 【判定规则】来自工单 01 的实测结论（tools/probe-fullscreen.cjs，五种场景真机验证）：
 *   - 候选窗口的 DWM 扩展边框与显示器**整块矩形**（含任务栏区，不用工作区）的重叠面积
 *     ÷ 显示器面积 ≥ 98% → 该屏全屏中。网页全屏/F11 实测 100%，普通最大化窗口
 *     稳定 95.5%（DWM 阴影贡献了不可见边），98% 阈值正好把两者分开。
 *   - 去抖：接线方为每块屏持有 {value, run} 状态、每轮喂给 stepFullscreenDebounce——
 *     同一即时结论需连续 FULLSCREEN_DEBOUNCE_COUNT 轮才真正翻转目标态，单帧抖动
 *     （窗口过渡动画、DWM 边框瞬时取值）不会改判。采样有抖动空间，全屏的进出
 *     都不该被单帧触发；state 为空（fail-open）时按「无全屏」处理。
 *   - fail-open：空输入 / 非法数据 → 目标态恒为「没有全屏」。宁可让宠物多待一会，
 *     也绝不因为判定模块的意外输入把宠物藏起来。
 *
 * 本文件零依赖：不 require electron、不碰 fs/env/系统调用，可被 node:test 直接加载
 * （同 pointer-target.js / topmost-watchdog.js）。平台边界住在这里：非 Windows 环境
 * 没有采样器，喂进来的自然是空窗口列表 → 走 fail-open，调用方无需任何平台分支。
 */

'use strict';

/** 全屏覆盖阈值：重叠面积 / 显示器整块面积 ≥ 此值即判全屏（01 实测 98% 分开网页全屏与最大化窗） */
const FULLSCREEN_COVER_RATIO = 0.98;

/** 去抖次数：结论翻转需要连续出现这么多次才生效 */
const FULLSCREEN_DEBOUNCE_COUNT = 2;

/** 计算两块矩形的重叠面积（不重叠或形状非法为 0） */
function overlapArea(a, b) {
  const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (!(ox > 0) || !(oy > 0)) return 0;
  return ox * oy;
}

/** 矩形是否四边都是有限数（非法矩形按「不存在」处理，不抛错） */
function isRect(r) {
  return !!r && [r.left, r.top, r.right, r.bottom].every((v) => Number.isFinite(v));
}

/**
 * 本轮即时覆盖判定（不含去抖）：显示器 → 此刻是否被候选窗口盖满。
 *
 * @param {Array<{left:number,top:number,right:number,bottom:number}>} windows 候选窗口矩形
 * @param {Array<{id:string|number,left:number,top:number,right:number,bottom:number}>} monitors 显示器整块矩形
 * @returns {Record<string, boolean>} monitor.id → 该屏此刻是否被盖满
 */
function snapshotCoverage(windows, monitors) {
  const result = {};
  const wins = Array.isArray(windows) ? windows.filter(isRect) : [];
  const mons = Array.isArray(monitors) ? monitors : [];
  for (const mon of mons) {
    const id = mon && mon.id !== undefined && mon.id !== null ? String(mon.id) : '';
    if (!id || !isRect(mon)) continue; // 无法标识或形状非法的屏：跳过（不产生结论）
    const monArea = (mon.right - mon.left) * (mon.bottom - mon.top);
    if (!(monArea > 0)) continue; // 零面积 / 翻转矩形：同上
    let covered = false;
    for (const win of wins) {
      if (overlapArea(win, mon) / monArea >= FULLSCREEN_COVER_RATIO) {
        covered = true;
        break;
      }
    }
    result[id] = covered;
  }
  return result;
}

/**
 * 去抖单步状态机（纯函数）：一块屏的一轮即时结论 → 新的稳定结论。
 *
 * 接线方为**每块屏**持有一份 {value, run}（value = 当前稳定结论，run = 当前结论已连续的
 * 轮数），每 500ms 把本轮即时结论喂进来一次：
 *   - 即时结论与稳定结论相同 → run 加一（结论不变）；
 *   - 不同 → 也要再等 FULLSCREEN_DEBOUNCE_COUNT 轮才翻转（进入与退出全屏对称去抖），
 *     期间稳定结论维持原值。state 非法 / 缺失（fail-open）按「无全屏、run=0」起算。
 *
 * @param {boolean} instant 本轮即时结论
 * @param {{value?: boolean, run?: number}|null|undefined} state 上一步状态
 * @returns {{value: boolean, run: number}} 新状态
 */
function stepFullscreenDebounce(instant, state) {
  const value = state && typeof state.value === 'boolean' ? state.value : false;
  const run = state && Number.isFinite(state.run) && state.run >= 0 ? state.run : 0;
  // run 的语义：即时结论**与 value 相反**已连续的轮数（value 翻转的那一刻归零）。
  // 翻转条件：即时结论连续 FULLSCREEN_DEBOUNCE_COUNT 轮都与 value 不同。
  const nextRun = instant === value ? 0 : run + 1;
  return nextRun >= FULLSCREEN_DEBOUNCE_COUNT ? { value: instant, run: 0 } : { value, run: nextRun };
}

/**
 * 一轮全屏判定（接线用的便捷入口）：即时覆盖 × 去抖 × fail-open → 目标态。
 *
 * state 的形状：monitor.id → {value, run}（接线方持有、逐轮传回）。输出只包含
 * 本轮仍在场的显示器（屏拔了就不再占位；它的 state 留给接线方自行清理，重新插回
 * 时按 fail-open 重新起算即可）；无法标识 / 零面积的屏同样不出现。
 * prevStable 为 null / undefined / 非对象 → 全部按首轮处理（输出恒无全屏）。
 *
 * @param {Array<{left:number,top:number,right:number,bottom:number}>} windows
 * @param {Array<{id:string|number,left:number,top:number,right:number,bottom:number}>} monitors
 * @param {Record<string, {value:boolean, run:number}>|null|undefined} stateMap 接线方持有的去抖状态
 * @returns {{ targets: Record<string, boolean>, nextState: Record<string, {value:boolean, run:number}> }}
 *   targets 是目标态（id → 是否全屏中）；nextState 是喂回下一轮的 stateMap。
 */
function computeFullscreenTargets(windows, monitors, stateMap) {
  const states = stateMap && typeof stateMap === 'object' ? stateMap : {};
  const now = snapshotCoverage(windows, monitors);
  const targets = {};
  const nextState = {};
  for (const id of Object.keys(now)) {
    const next = stepFullscreenDebounce(now[id], states[id]);
    nextState[id] = next;
    targets[id] = next.value;
  }
  return { targets, nextState };
}

module.exports = {
  FULLSCREEN_COVER_RATIO,
  FULLSCREEN_DEBOUNCE_COUNT,
  snapshotCoverage,
  stepFullscreenDebounce,
  computeFullscreenTargets,
};
