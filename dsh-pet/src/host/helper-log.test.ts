/**
 * 桌面 helper「日志落盘」的纯逻辑 + 源码守卫（工单 00）。
 *
 * 背景：插件形态下 helper 的 stdout 被宿主读走走 logger.debug（默认不显示）；打包/独立形态
 * 启动后没有任何日志文件——「判定模块算出了什么」「隐藏为什么没触发」「托盘点击有没有写成功」
 * 只能靠重跑进程复现。落盘位置 = `<DSH_HOME>/dsh-pet/logs/helper-<YYYYMMDD>.log`。
 *
 * 本文件钉四件事：
 *   ① 文件名/目录口径：helper-YYYYMMDD.log，目录 = DSH_HOME/dsh-pet/logs；
 *      DSH_HOME 解析必须与 src/host 的 dshHomeDir()/resolveDshHome() 同口径（两边各自实现，
 *      靠本测试钉住不漂移）；
 *   ② 滚动：只保留最近 3 个按日期命名的文件，更早的删除；
 *   ③ 敏感信息：URL 查询串里的 token 类参数一律打码（configUrl / settingsUrl 都带一次性
 *      token），调用方还可注入要隐藏的字面量（如 DSH_PET_SITE_URL 的值）；
 *   ④ 源码守卫：main.js / preload.js 必须真的接线（Electron 起不来，只能读源码断言）——
 *      主进程 console 接管、渲染端经 preload 一次转发、DPI_PROBE 短命子进程不写日志、
 *      失败静默（写盘错误吞掉、绝不 console.error 刷屏）。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helper = '../../runtime/electron-helper/';
const {
  LOG_KEEP,
  resolveDshHome,
  logDirOf,
  logFileNameOf,
  LOG_NAME_RE,
  staleLogNames,
  redact,
  makeLineFormatter,
  createFileAppender,
} = require(helper + 'helper-log.js');

/** 包内文件源码（守卫用；相对 src/host/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('resolveDshHome / logDirOf —— 与宿主侧同一口径', () => {
  test('DSH_HOME 优先；否则 USERPROFILE（Windows）/ HOME（类 Unix）下的 .dsh', () => {
    assert.equal(resolveDshHome({ DSH_HOME: '/data/dsh' }), '/data/dsh');
    assert.match(resolveDshHome({ USERPROFILE: 'C:\\Users\\u' }), /Users[\\/]u[\\/]\.dsh$/);
    assert.match(
      resolveDshHome({ HOME: '/home/u' }),
      /home[\\/]u[\\/]\.dsh$/,
      '类 Unix 同口径（path.join 在 win32 上产 \\）',
    );
    assert.match(resolveDshHome({}), /\.dsh$/, '什么都没有时也不能抛错');
    assert.equal(resolveDshHome({ DSH_HOME: '/a', HOME: '/b' }), '/a', 'DSH_HOME 压过 HOME');
  });

  test('目录 = <DSH_HOME>/dsh-pet/logs（与 petDataDir 同口径）', () => {
    assert.match(logDirOf('/data/dsh'), /dsh-pet[\\/]logs$/, '按平台分隔符拼 dsh-pet/logs');
  });
});

describe('logFileNameOf / LOG_NAME_RE —— 按日期命名', () => {
  test('YYYYMMDD 补零；单数月/日补到两位', () => {
    assert.equal(logFileNameOf(new Date(2026, 0, 2)), 'helper-20260102.log');
    assert.equal(logFileNameOf(new Date(2026, 11, 31)), 'helper-20261231.log');
  });

  test('名字能被自己的正则解析回来（滚动靠它比对日期）', () => {
    const name = logFileNameOf(new Date(2026, 9, 23));
    const m = LOG_NAME_RE.exec(name);
    assert.ok(m, '本模块生成的文件名必须能被 LOG_NAME_RE 解析');
    assert.equal(m?.[1], '20261023');
    assert.equal(LOG_NAME_RE.exec('helper-2026102.log'), null, '位数不对不是我们的文件');
    assert.equal(LOG_NAME_RE.exec('other-20261023.log'), null);
  });
});

describe('staleLogNames —— 只保留最近 3 个日志文件', () => {
  test('保留含当天在内的最新 3 个，删除更早的', () => {
    const names = ['helper-20261019.log', 'helper-20261020.log', 'helper-20261021.log', 'helper-20261022.log'];
    assert.deepEqual(staleLogNames(names), ['helper-20261019.log']);
  });

  test('不足 3 个时一个都不删', () => {
    const names = ['helper-20261021.log', 'helper-20261022.log'];
    assert.deepEqual(staleLogNames(names), []);
  });

  test('不认识的文件名一律不动（只清自己写的），乱序输入也能按日期排', () => {
    const names = ['helper-20261001.log', 'other.log', 'helper-20261003.log', 'helper-20261002.log'];
    assert.deepEqual(
      staleLogNames(names, 2),
      ['helper-20261001.log'],
      'keep=2：20261001 落到窗口外；other.log 不归我们管',
    );
  });

  test('常量：默认保留 3 个', () => {
    assert.equal(LOG_KEEP, 3);
  });
});

describe('redact —— 敏感信息打码', () => {
  test('URL 查询串里的 token 类参数一律 ***（configUrl / settingsUrl 都带一次性 token）', () => {
    assert.equal(
      redact('config http://127.0.0.1:3080/dsh-pet-7340/config?token=abc123 done'),
      'config http://127.0.0.1:3080/dsh-pet-7340/config?token=*** done',
    );
    assert.equal(
      redact('http://127.0.0.1:3210/standalone-ai/?token=x'.replace(/x$/, 'A'.repeat(43))),
      'http://127.0.0.1:3210/standalone-ai/?token=***',
    );
    assert.equal(redact('a?access_token=t1&b=2&api_key=k3'), 'a?access_token=***&b=2&api_key=***');
  });

  test('注入的字面量（DSH_PET_SITE_URL 的值等）整串替换，大小写不敏感', () => {
    const hide = redact('site=https://dsh.example.com/u?token=1 ok', ['https://dsh.example.com']);
    assert.equal(hide, 'site=***/u?token=*** ok');
    assert.equal(redact('SEE HTTPS://DSH.EXAMPLE.COM/x', ['https://dsh.example.com']), 'SEE ***/x');
  });

  test('普通日志原样保留；空值/非法输入不抛错', () => {
    assert.equal(redact('displays: {"x":1,"y":2}'), 'displays: {"x":1,"y":2}');
    assert.equal(redact(''), '');
    assert.doesNotThrow(() => redact(undefined));
  });
});

describe('makeLineFormatter —— 行格式：时间戳 + 等级 + 打码文本', () => {
  const fmt = makeLineFormatter({ now: () => new Date(2026, 9, 23, 8, 9, 10) });
  test('格式为 [ISO 时间] [level] 文本，token 已打码（时间按 UTC ISO，本地 8 点 = 00:09Z）', () => {
    assert.equal(fmt('error', 'boom ?token=secret'), '[2026-10-23T00:09:10.000Z] [error] boom ?token=***');
  });
});

describe('createFileAppender —— 失败静默：写盘绝不能成为新的崩溃源', () => {
  /** 可记录调用的假 fs（只实现 appender 用到的 appendFile / mkdir / readdir / unlink） */
  function fakeFs(overrides: Record<string, unknown> = {}) {
    const calls: { op: string; args: unknown[] }[] = [];
    const base: Record<string, unknown> = {
      mkdir: async (p: unknown, o: unknown) => {
        calls.push({ op: 'mkdir', args: [p, o] });
      },
      appendFile: async (p: unknown, d: unknown) => {
        calls.push({ op: 'appendFile', args: [p, d] });
      },
      readdir: async () => [] as string[],
      unlink: async (p: unknown) => {
        calls.push({ op: 'unlink', args: [p] });
      },
    };
    return { calls, fs: Object.assign(base, overrides) };
  }

  test('第一次写入时建目录并追加文件；写成功就静默', async () => {
    const { calls, fs } = fakeFs();
    const appender = createFileAppender({ dir: '/d/logs', fs });
    await appender.write('log', 'hello');
    assert.ok(calls.some((c) => c.op === 'mkdir' && c.args[0] === '/d/logs'));
    const w = calls.find((c) => c.op === 'appendFile');
    assert.ok(w, '必须真的 appendFile');
    assert.ok(String(w?.args[0]).includes('helper-'), '追加的是当天日志文件');
    assert.match(String(w?.args[1]), /\[log\] hello/);
  });

  test('目录建不出来 → 丢弃写入、console 照旧、后续写不再重试（不刷屏）', async () => {
    const { fs } = fakeFs({
      mkdir: async () => {
        const e = new Error('EACCES') as Error & { code: string };
        e.code = 'EACCES';
        throw e;
      },
    });
    const appender = createFileAppender({ dir: '/nope', fs });
    await appender.write('log', 'a');
    await appender.write('log', 'b');
    // 静默分支只要求不抛错、不再反复重试；这里用 disabled 状态可观察
    assert.equal(appender.disabled, true, '目录建不出来必须整体放弃写文件');
  });

  test('appendFile 中途失败（磁盘满/权限）同样放弃，绝不上抛', async () => {
    const { fs } = fakeFs({
      appendFile: async () => {
        const e = new Error('ENOSPC') as Error & { code: string };
        e.code = 'ENOSPC';
        throw e;
      },
    });
    const appender = createFileAppender({ dir: '/d', fs });
    await appender.write('log', 'a');
    assert.equal(appender.disabled, true);
  });

  test('滚动：跨天写新文件，并把窗口外的旧文件删掉', async () => {
    const { calls, fs } = fakeFs({
      readdir: async () => ['helper-20261020.log', 'helper-20261021.log', 'helper-20261022.log', 'helper-20261023.log'],
    });
    let day = 23;
    const now = () => new Date(2026, 9, day, 23, 0, 0);
    const appender = createFileAppender({ dir: '/d/logs', fs, now });
    await appender.write('log', 'd1');
    day = 24; // 跨天
    await appender.write('log', 'd2');
    const unlinks = calls.filter((c) => c.op === 'unlink').map((c) => c.args[0]);
    assert.deepEqual(
      [...new Set(unlinks.map((u) => String(u).replace(/\\/g, '/')))],
      ['/d/logs/helper-20261020.log'],
      '保留最近 3 个，删最旧的（同一天只尝试删一次）',
    );
    const appends = calls.filter((c) => c.op === 'appendFile').map((c) => c.args[0]);
    assert.ok(String(appends[0]).includes('20261023'), '第一天写当天的文件');
    assert.ok(String(appends[1]).includes('20261024'), '第二天写新文件');
  });

  test('readdir/unlink 失败不影响本次写入（清理失败只放弃清理）', async () => {
    const { calls, fs } = fakeFs({
      readdir: async () => {
        throw new Error('EIO');
      },
    });
    const appender = createFileAppender({ dir: '/d', fs });
    await appender.write('log', 'x');
    assert.ok(
      calls.some((c) => c.op === 'appendFile'),
      '清理失败不能连累写日志',
    );
    assert.notEqual(appender.disabled, true);
  });
});

describe('源码守卫 —— main.js / preload.js 必须真的接线', () => {
  const main = readSource(helper + 'main.js');
  const preload = readSource(helper + 'preload.js');
  const renderer = readSource(helper + 'renderer.js');

  test('main.js 引入 helper-log 并接管 console（写盘与 console 原输出并存）', () => {
    assert.ok(/require\('\.\/helper-log\.js'\)/.test(main), '落盘逻辑必须复用纯模块');
    assert.ok(/origConsole\s*=\s*\{/.test(main), 'console 接管必须保留原实现（写盘是追加，不能替换掉 console 本身）');
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      assert.ok(
        /for \(const level of \['log', 'info', 'warn', 'error', 'debug'\]\)/.test(main),
        `console.${level} 必须被接管（五个等级一起）`,
      );
      assert.ok(/void appender\.write\(level/.test(main), '每次接管都要追加写盘');
    }
  });

  test('DPI_PROBE 短命子进程不写日志：createHelperLogger 内部先短路', () => {
    const fn = /function createHelperLogger\(\) \{([\s\S]*?)\n\}/.exec(main);
    assert.ok(fn, 'console 接管必须收在 createHelperLogger 里');
    assert.match(
      fn![1],
      /if \(DPI_PROBE\) return null;/,
      '探测子进程在接管 console 前短路（不建日志文件、不改 stdout）',
    );
  });

  test('渲染端 console 经 preload 一次转发（pet:renderer-log → ipcMain）', () => {
    assert.ok(/pet:renderer-log/.test(preload), 'preload 必须有渲染端 console 转发通道');
    assert.ok(/pet:renderer-log/.test(main), 'main.js 必须接住渲染端转发');
    assert.ok(/executeJavaScript/.test(preload), 'contextIsolation 下 preload 必须经 main world 接管页面 console');
    assert.ok(/\[renderer\]/.test(main), '渲染端文本必须带 [renderer] 来源标记进主进程日志');
  });

  test('写盘失败静默：appender 不得把错误再打回 console（防递归/刷屏）', () => {
    assert.ok(!/console\.(error|warn)\([^)]*\)\s*;?\s*\/\*\s*appender/.test(main));
    // appender 的内部错误在 helper-log.js 里吞掉；main.js 不准在写日志路径上打 console
    assert.ok(!/logger\.write[\s\S]{0,80}catch[\s\S]{0,80}console\./.test(main), '写日志路径上吞错，不许回打 console');
  });

  test('渲染端业务代码里没有逐处埋点（events.js / sprite.js 不出现 forwardLog）', () => {
    for (const src of [readSource(helper + 'events.js'), readSource(helper + 'sprite.js')]) {
      assert.ok(!src.includes('forwardLog'), '转发必须集中在 preload 接管，不许业务代码埋点');
    }
    assert.ok(!renderer.includes('forwardLog'), 'renderer.js 也不埋点（console 由 preload 侧接管）');
  });
});
