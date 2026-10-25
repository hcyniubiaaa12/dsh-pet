/**
 * 隐藏宠物集合（工单 06）：宿主侧的**瞬时内存态**——当前因全屏而被桌面壳隐藏的宠物 id 集合。
 *
 * 【为什么在宿主】自动碎碎念的调度住在宿主，宿主并不知道桌面窗口是否被全屏藏起。
 * 桌面壳在隐藏 / 恢复时经既有 bridge（POST /hidden-pets）把**全量集合**上报到这里；
 * 调度拍对集合内的宠物跳过——不生成（省一次 AI 调用）、也不推进计时戳（与占用锁同手法，
 * 恢复后下一拍照常，不推迟首次碎碎念）。
 *
 * 【为什么不落盘】显隐是瞬时状态：桌面壳启动先上报一次空集合清残留，宿主进程重启自然清空。
 * 上报失败只由壳侧记日志，不回滚显隐——这里因此只提供最简单的内存语义，没有任何持久化。
 */

/** 集合内的宠物这一拍要不要生成自动碎碎念（与占用锁同一套判定词汇） */
export interface WhisperSkipDecision {
  /** true = 生成一句（并推进计时戳）；false = 跳过这一拍 */
  generate: boolean;
  /** true = 把计时戳推进到本拍时刻；false = 保持不动（hidden/locked 跳过都是 false） */
  advance: boolean;
}

export interface WhisperSkipInput {
  /** 上次生成的时刻（毫秒）；没生成过为 undefined */
  lastAt: number | undefined;
  /** 本拍时刻（毫秒） */
  now: number;
  /** 该宠物的碎碎念周期（秒）；非法（≤0 / 非有限数）按「没到点」处理 */
  periodSec: number;
  /** 该宠物是否在隐藏集合内 */
  hidden: boolean;
  /** 该宠物是否被占用锁占住 */
  locked: boolean;
}

/**
 * 这一拍的跳过判定。顺序与宿主调度一致：周期/到点先判（照旧不生成不推进），
 * 然后 hidden 与 locked 同权——都跳过且**都不推进计时戳**。
 */
export function whisperSkipDecision(input: WhisperSkipInput): WhisperSkipDecision {
  const sec = Number(input.periodSec);
  if (!Number.isFinite(sec) || sec <= 0) return { generate: false, advance: false };
  const last = input.lastAt ?? 0;
  if (input.now - last < sec * 1000) return { generate: false, advance: false };
  if (input.hidden || input.locked) return { generate: false, advance: false };
  return { generate: true, advance: true };
}

export interface HiddenPetRegistry {
  /** 全量替换集合内容；返回清洗后留下的条数（坏元素剔除，不进集合） */
  replace(ids: unknown[]): number;
  has(petId: string): boolean;
  /** 只读快照（顺序不保证），给日志 / 调试用 */
  snapshot(): string[];
}

/**
 * 建一个隐藏集合。全量替换语义：桌面壳每次上报完整集合（不是增量），
 * 空数组即清空——桌面壳启动时先上报一次空集合，清掉上一进程的残留。
 */
export function createHiddenPetRegistry(): HiddenPetRegistry {
  const set = new Set<string>();
  return {
    replace(ids: unknown[]): number {
      set.clear();
      for (const id of Array.isArray(ids) ? ids : []) {
        if (typeof id !== 'string') continue;
        const trimmed = id.trim();
        if (trimmed) set.add(trimmed);
      }
      return set.size;
    },
    has: (petId: string) => set.has(petId),
    snapshot: () => [...set],
  };
}
