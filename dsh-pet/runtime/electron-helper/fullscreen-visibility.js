/**
 * dsh-pet desktop helper —— 窗口显隐状态机的纯决策（工单 03）。
 *
 * 【现场】工单 02 已能算出「哪几块屏全屏中」（fullscreen-detect.js，只算不藏）。
 * 本模块回答下一个问题：给定目标态与每只宠物的纯数据，这只宠物**此刻该显示还是该隐藏、
 * 恢复时要不要重钉置顶**。怎么 hide/show、怎么淡入淡出、何时采样，全是 main.js 接线的事
 * （由 src/host/fullscreen-visibility.test.ts 的源码守卫钉住）。
 *
 * 【规则】来自 spec D 节与工单 03：
 *   - 归属：宠物按**窗口中心点**落在哪块显示器来归属。判定用「点落在矩形内」的既有几何口径
 *     （pointInRect 同语义：左闭右开），骑缝/出界/非法输入 fail-open 为 null → 调用方按非全屏处理，
 *     绝不因为算不出归属把宠物藏起来。
 *   - 交互忙碌延后隐藏：拖拽中 / 菜单开着 / 对话窗开着（含未发送文本）时**延后**隐藏判定，
 *     保持显示；忙碌不挡恢复——用户在全屏里没碰宠物、退出全屏时宠物该回来就回来。
 *   - 唤回压制：显式唤回（focus）后暂停自动隐藏，直到全屏状态发生**切换**才解除。
 *     切换的判定由接线方比较前后目标态得出，这里只消费布尔。
 *   - 启动即全屏：hidden=true 且全屏中 → 持续隐藏。首帧兜底显示由接线方闸门拦下。
 *   - fail-open：开关关闭 / 输入非法 → 恒为显示；恢复路径照给重钉（等价于改动前的常态行为）。
 *
 * 本文件零依赖：不 require electron、不碰 fs/env/系统调用，可被 node:test 直接加载
 * （同 fullscreen-detect.js / pointer-target.js）。平台边界不住这里——判定只认数据，
 * 非 Windows 环境采样器返回空 → 目标态恒无全屏 → 本模块自然输出「显示」。
 */

'use strict';

/**
 * 中心点归属：点落在哪块显示器的整块矩形内（左闭右开，与 pointInRect 同口径）。
 *
 * @param {Array<{id: string|number, left: number, top: number, right: number, bottom: number}>|null|undefined} monitors
 * @param {number} x 窗口中心点 x（物理像素）
 * @param {number} y 窗口中心点 y
 * @returns {string|null} 显示器 id；点不在任何屏 / 输入非法 → null（调用方按非全屏处理）
 */
function monitorIdForPoint(monitors, x, y) {
  if (!Array.isArray(monitors) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  for (const mon of monitors) {
    if (!mon || !Number.isFinite(mon.left) || !Number.isFinite(mon.top)) continue;
    if (!Number.isFinite(mon.right) || !Number.isFinite(mon.bottom)) continue;
    if (mon.id === undefined || mon.id === null || mon.id === '') continue;
    if (x >= mon.left && x < mon.right && y >= mon.top && y < mon.bottom) {
      return String(mon.id);
    }
  }
  return null;
}

/**
 * 一只宠物的显隐决策（纯函数）。
 *
 * @param {object} input
 * @param {boolean} [input.enabled] 「全屏应用时隐藏桌宠」开关；false / 缺失 = 恒显示
 * @param {boolean} [input.fullscreen] 该宠物归属屏当前是否全屏中
 * @param {boolean} [input.hidden] 该宠物窗口当前是否处于隐藏态
 * @param {boolean} [input.busy] 交互忙碌（拖拽中 / 菜单开着 / 对话窗开着）
 * @param {boolean} [input.recallHold] 唤回压制中（显式唤回后、全屏状态切换前）
 * @param {boolean} [input.fullscreenChanged] 本轮全屏目标态相对上一轮发生了切换
 * @returns {{visible: boolean, reassertTopmost: boolean, nextRecallHold: boolean}}
 *   visible = 该显示还是该隐藏；reassertTopmost = 恢复显示时应重钉置顶；
 *   nextRecallHold = 喂回下一轮的压制状态。
 */
function decideWindowVisibility(input) {
  const o = input && typeof input === 'object' ? input : {};
  const enabled = o.enabled === true;
  const fullscreen = o.fullscreen === true;
  const hidden = o.hidden === true;
  const busy = o.busy === true;
  const recallHold = o.recallHold === true;
  const fullscreenChanged = o.fullscreenChanged === true;
  // 压制的解除只发生在「全屏状态切换」这一拍；其余情况延续既有压制。
  const nextRecallHold = enabled && recallHold && !fullscreenChanged;
  // 开关关 = 行为与改动前完全一致：恒显示；已隐藏的窗口要被放回来（重钉只在「从隐藏中恢复」时需要）。
  if (!enabled) return { visible: true, reassertTopmost: hidden, nextRecallHold: false };
  // 该隐藏吗：归属屏全屏中，且没有被交互/唤回暂缓。忙碌只延后隐藏，不挡恢复。
  const wantHide = fullscreen && !busy && !nextRecallHold;
  if (!wantHide) {
    // 恢复（或维持显示）。只有从隐藏态回来才需要重钉；一直可见时不动（不干扰看门狗节拍）。
    return { visible: true, reassertTopmost: hidden, nextRecallHold };
  }
  return { visible: false, reassertTopmost: false, nextRecallHold };
}

module.exports = { monitorIdForPoint, decideWindowVisibility };
