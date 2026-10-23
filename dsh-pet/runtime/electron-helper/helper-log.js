/**
 * dsh-pet desktop helper —— 日志落盘的纯逻辑（工单 00）。
 *
 * 【现场】插件形态下本进程的 stdout 被宿主读走后走 logger.debug（默认不显示）；打包/独立形态
 * 启动后**没有任何日志文件**。「判定模块算出了什么」「隐藏为什么没触发」「托盘点击有没有写
 * 成功」只能靠重跑进程复现——日志落盘就是为了让这些事后能读到。
 *
 * 本文件只放**纯逻辑**（不 require('electron')，可被 node:test 直接单测，同 host-liveness.js）：
 *   - 目录/文件名口径：`<DSH_HOME>/dsh-pet/logs/helper-<YYYYMMDD>.log`；
 *   - 滚动：只保留最近 LOG_KEEP 个按日期命名的文件，更早的删除；
 *   - 打码：URL 查询串里的 token 类参数与调用方注入的字面量（DSH_PET_SITE_URL 等）一律 ***；
 *   - 写入器：mkdir/appendFile/readdir/unlink 任何一步失败都**静默放弃**（可选永不重试），
 *     日志绝不能成为新的崩溃源——console 原输出永远照旧。
 *
 * main.js 只负责接线：接管 console、装 ipcMain 转发通道（见 helper-log.test.ts 的源码守卫）。
 *
 * DSH_HOME 解析说明：壳是独立 CJS，不能 import src/host 的 helper-process.ts /
 * runtime-settings.ts；这里按**同一口径**单独实现（DSH_HOME → USERPROFILE → HOME → '.dsh'），
 * helper-log.test.ts 钉住两边不漂移。这与 runtime-settings.ts 头注释里「单独实现是为了不把
 * 整个模块图拖进运行时」是同一个理由。
 */

'use strict';

const path = require('node:path');

/** 日志目录里保留的文件数（含当天；更早的按日期删除） */
const LOG_KEEP = 3;

/** 我们写的日志文件名：helper-YYYYMMDD.log（滚动清理只认这个形状） */
const LOG_NAME_RE = /^helper-(\d{8})\.log$/;

/** URL 查询串里这些参数名（不区分大小写）的值可能是凭据，一律打码 */
const SECRET_QUERY_KEYS = ['token', 'access_token', 'api_key', 'apikey', 'key', 'secret', 'password'];

/**
 * 解析 DSH 主目录。与 src/host/helper-process.ts 的 dshHomeDir() / runtime-settings.ts 的
 * resolveDshHome() 同一口径（壳不能 import 它们，单独实现、测试钉住不漂移）。
 * @param {Record<string, string|undefined>} env 可注入，便于单测（生产传 process.env）
 * @returns {string}
 */
function resolveDshHome(env = process.env) {
  const userProfile = env.USERPROFILE || env.HOME || '';
  return env.DSH_HOME || path.join(userProfile, '.dsh');
}

/** 日志目录：`<DSH_HOME>/dsh-pet/logs`（数据目录与独立模式、插件形态共用） */
function logDirOf(dshHome) {
  return path.join(dshHome, 'dsh-pet', 'logs');
}

/** 当天（本地时区）的日志文件名：helper-YYYYMMDD.log */
function logFileNameOf(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `helper-${y}${m}${d}.log`;
}

/**
 * 从给出的文件名清单里挑出**应当删除**的滚动目标：认得出是我们日志的按日期排序，
 * 只保留 keep 个最新；认不出的（别的文件、别的名字）一律不动。
 * @param {string[]} names 目录里的文件名（顺序不保证）
 * @param {string[]} [keepCount] 保留数（默认 LOG_KEEP）
 * @returns {string[]} 要删除的文件名
 */
function staleLogNames(names, keepCount = LOG_KEEP) {
  const dated = names
    .map((name) => {
      const m = LOG_NAME_RE.exec(name);
      return m ? { name, date: m[1] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return dated.slice(0, Math.max(0, dated.length - keepCount)).map((e) => e.name);
}

/**
 * 敏感信息打码（一行文本 → 安全文本）：
 *   - URL 查询串里凭据类参数（token / key / secret…）的值 → `***`——configUrl 与
 *     standalone-runtime.json 的 settingsUrl 都带一次性 token，落盘前必须打掉；
 *   - 调用方注入的字面量（DSH_PET_SITE_URL 的值等）整串替换 → `***`，大小写不敏感
 *     （URL 协议/主机在日志里可能被任意大小写）。
 * 非法输入（undefined/null/非字符串）原样返回空串或原值，绝不抛错——本函数在写日志路径上。
 * @param {string} text 原始文本
 * @param {string[]} [hideLiterals] 额外要整串隐藏的字面量
 * @returns {string}
 */
function redact(text, hideLiterals = []) {
  if (typeof text !== 'string') return '';
  let out = text;
  // ① 查询串凭据：token=xxx → token=***（值吃到 & 或行尾）
  for (const key of SECRET_QUERY_KEYS) {
    out = out.replace(new RegExp(`([?&]${key}=)[^&\\s]*`, 'gi'), '$1***');
  }
  // ② 注入字面量：整串替换（先转义再按字面量匹配，正则元字符不误伤）
  for (const literal of hideLiterals) {
    if (typeof literal !== 'string' || literal === '') continue;
    const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'gi'), '***');
  }
  return out;
}

/**
 * 行格式化：`[ISO 时间] [level] 文本`（时间取本地，token 在此一并打码）。
 * @param {{now?: () => Date, hide?: string[]}} opts now 可注入（单测用固定时间）
 */
function makeLineFormatter(opts = {}) {
  const now = opts.now || (() => new Date());
  return (level, text) => `[${now().toISOString()}] [${level}] ${redact(text, opts.hide)}`;
}

/**
 * 创建追加写入器。任何一步失败都**静默**（绝不 console.*、绝不上抛——console 本身正在被
 * 接管，回打就是递归+刷屏），磁盘满/权限不足只意味着放弃写文件，console 照旧。
 *
 * @param {{dir: string, fs?: object, now?: () => Date, hide?: string[]}} opts
 *   fs 可注入（单测）；now 可注入（跨天滚动单测）。
 * @returns {{write: (level: string, text: string) => Promise<void>, disabled: boolean}}
 *   write 返回的 promise 永不 reject；disabled 表示已整体放弃（目录建不出/写失败后不再重试，
 *   「不刷屏」靠的就是放弃后不再每行都踩同一个错误）。
 */
function createFileAppender(opts) {
  const dir = opts.dir;
  const fs = opts.fs || require('node:fs/promises');
  const fmt = makeLineFormatter(opts);
  let disabled = false;
  /** 已写入的日期（YYYYMMDD）；跨天才触发滚动清理，避免每行 readdir */
  let currentDate = '';
  /** 已尝试删除过的文件名：不重复 unlink（启动多天积压时同名只删一次，ENOENT 也不反复踩） */
  const swept = new Set();
  /** 已清理过的日期（今天名）：同一天只 readdir 一次 */
  let cleanedDate = '';

  async function sweep(todayName) {
    if (cleanedDate === todayName) return;
    cleanedDate = todayName;
    try {
      const names = await fs.readdir(dir);
      for (const name of staleLogNames(Array.isArray(names) ? names : [])) {
        if (swept.has(name)) continue;
        swept.add(name);
        try {
          await fs.unlink(path.join(dir, name));
        } catch {
          /* 单个文件删不掉（被占用/权限）就留给下一次启动，不连累写日志 */
        }
      }
    } catch {
      /* readdir 失败：清理只是尽力而为 */
    }
  }

  async function write(level, text) {
    if (disabled) return;
    try {
      const name = logFileNameOf(opts.now ? opts.now() : new Date());
      const date = LOG_NAME_RE.exec(name)?.[1] || '';
      if (date !== currentDate) {
        currentDate = date;
        await fs.mkdir(dir, { recursive: true });
      }
      await fs.appendFile(path.join(dir, name), fmt(level, text) + '\n', 'utf8');
      await sweep(name);
    } catch {
      // 任何失败（目录建不出/磁盘满/权限）→ 整体放弃写文件，console 照旧
      disabled = true;
    }
  }

  return {
    write,
    get disabled() {
      return disabled;
    },
  };
}

module.exports = {
  LOG_KEEP,
  LOG_NAME_RE,
  resolveDshHome,
  logDirOf,
  logFileNameOf,
  staleLogNames,
  redact,
  makeLineFormatter,
  createFileAppender,
};
