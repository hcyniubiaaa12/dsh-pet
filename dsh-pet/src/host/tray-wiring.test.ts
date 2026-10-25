/**
 * 应用托盘的跨进程接线契约（ticket 06）。
 *
 * 托盘是系统 UI，node:test 点不到；这里钉住的是两条「接线不能错」的事实：
 *   - 打包形态只有宿主建托盘（壳里跳过），插件形态壳仍建托盘（唯一入口）；
 *   - Electron 调用集中在 desktop/tray.mjs，菜单文案/动作语义仍来自纯函数，
 *     退出必须走独立模式的 shutdown（不是裸 app.exit）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** 读包根下的文件（本测试位于 src/host/，包根是两级之上） */
function readPackageFile(relative: string): string {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
}

describe('桌面壳 —— 打包形态不再自建托盘', () => {
  const source = readPackageFile('runtime/electron-helper/main.js');

  test('插件形态仍建托盘；打包形态（DSH_PET_PACKAGED=1）跳过，避免第二个图标', () => {
    assert.match(source, /async function startTray\(/);
    assert.match(source, /if \(process\.env\.DSH_PET_PACKAGED !== '1'\) void startTray\(\);/);
  });

  test('壳仍用纯函数模板（不在壳里另拼菜单文案）', () => {
    assert.match(source, /buildTrayMenuTemplate\(\{ pets, hideOnFullscreen \}\)/);
  });

  test('全屏隐藏开关接线：POST /hide-on-fullscreen + 本地乐观翻勾，绝不请求 /reload（ticket 09）', () => {
    assert.match(source, /toggle-hide-on-fullscreen/);
    assert.match(source, /\/hide-on-fullscreen/);
    // 点击处理器只写配置 + 重建菜单：不得触发任何重启壳的路径
    const clickAt = source.indexOf("action === 'toggle-hide-on-fullscreen'");
    assert.ok(clickAt > 0, '壳托盘必须有该动作的接线分支');
    const clickBlock = source.slice(clickAt, source.indexOf('});', clickAt));
    assert.match(clickBlock, /traySetHideOnFullscreen\(/);
    assert.match(clickBlock, /rebuildTrayMenu\(\)/);
    assert.ok(!/\/reload|syncDesktop/.test(clickBlock), '开关点击绝不请求 /reload（不重启桌面壳）');
  });
});

describe('desktop/tray.mjs —— 宿主托盘接线', () => {
  const source = readPackageFile('desktop/tray.mjs');

  test('菜单模板复用 runtime/electron-helper/tray-menu.js，动作分发复用 lib/tray-actions.js', () => {
    assert.match(source, /require\('\.\.\/runtime\/electron-helper\/tray-menu\.js'\)/);
    assert.match(source, /buildTrayMenuTemplate\(/);
    assert.match(source, /\.\.\/lib\/tray-actions\.js/);
    assert.match(source, /dispatchTrayAction/);
    // 菜单文案住在模板里；这里不得再手写应用菜单项
    assert.ok(!/label:\s*'退出'/.test(source), '退出项文案必须来自模板');
    assert.ok(!/label:\s*'打开 AI 设置…'/.test(source), 'AI 设置项文案必须来自模板');
  });

  test('宠物勾选与配置读取走本机 HTTP + token，不直连 apply 内部', () => {
    assert.match(source, /x-dsh-pet-token/);
    assert.match(source, /\/dsh-pet-7340\/pet-display/);
    assert.match(source, /\/dsh-pet-7340\/config/);
    assert.match(source, /handle\.token/);
  });

  test('自启读写走 autostart 适配层（参数恒含 --autostart，状态以系统为准）', () => {
    assert.match(source, /\.\.\/lib\/autostart\.js/);
    assert.match(source, /createLoginItemAdapter\(app\)/);
    assert.match(source, /loginItem\.isEnabled\(\)/);
    assert.match(source, /loginItem\.setEnabled\(/);
  });

  test('全屏隐藏开关：写配置必须读响应体，ok===false 时不乐观翻勾', () => {
    const at = source.indexOf("case 'set-hide-on-fullscreen'");
    assert.ok(at > 0, '必须处理 set-hide-on-fullscreen 动作');
    const branch = source.slice(at, source.indexOf("case 'open-data-dir'", at));
    assert.match(branch, /resp\.json\(\)/, '必须读响应体（宿主业务失败回 200 + {ok:false}）');
    assert.match(branch, /body\.ok === false/, 'ok===false 时不得翻勾');
    assert.match(branch, /if \(ok\) state\.hideOnFullscreen = effect\.enabled;/, '只有业务成功才本地翻勾');
  });

  test('hideOnFullscreen 首次配置加载前是未知态（null），顺着缺省按 true 的既有语义走', () => {
    assert.match(source, /hideOnFullscreen: null,/, 'state 初值必须是 null（未知），不能硬编码 true');
  });

  test('退出：先销毁托盘，再走 handle.shutdown，完成后 app.exit(0)', () => {
    const quitAt = source.indexOf("case 'quit'");
    assert.ok(quitAt > 0, '必须处理 quit 动作');
    const quitBranch = source.slice(quitAt, source.indexOf('default:', quitAt));
    assert.match(quitBranch, /quit\(/);
    assert.match(source, /tray\.destroy\(\)/);
    assert.match(source, /await handle\.shutdown\('tray-quit'\)/);
    assert.match(source, /app\.exit\(0\)/);
  });

  test('数据目录用 <DSH_HOME>/dsh-pet；设置 URL 是能力令牌，不得写日志', () => {
    assert.match(source, /petDataDir\(home\)/);
    assert.ok(!/console\.(?:log|info|warn|error)\([^)]*settingsUrl/i.test(source));
    assert.ok(!/console\.[a-z]+\([^)]*effect\.url/i.test(source));
  });

  test('只创建一个 Tray（单一图标），并暴露仅测试用的钩子', () => {
    assert.equal((source.match(/new Tray\(/g) ?? []).length, 1, '重复创建会得到多个托盘图标');
    assert.match(source, /globalThis\.__dshPetTray/);
  });

  test('全屏隐藏开关：读 main 条目配置、走 /hide-on-fullscreen 写盘、乐观翻勾（ticket 09）', () => {
    assert.match(source, /set-hide-on-fullscreen/);
    assert.match(source, /\/dsh-pet-7340\/hide-on-fullscreen/);
    assert.match(source, /state\.hideOnFullscreen = effect\.enabled/);
    // 1s 轮询会从盘上自然对齐，这里不得有额外的重启/重载调用
    const at = source.indexOf("case 'set-hide-on-fullscreen'");
    const block = source.slice(at, source.indexOf('case ', at + 10));
    assert.ok(!/syncDesktop|\/reload/.test(block), '宿主托盘开关同样不重启桌面壳');
  });
});

describe('desktop/main.mjs —— 宿主启动后接托盘', () => {
  const source = readPackageFile('desktop/main.mjs');

  test('仅在打包形态、startStandalone 之后创建托盘；失败不拖垮宿主', () => {
    const startAt = source.indexOf('await startStandalone(');
    const trayAt = source.indexOf("import('./tray.mjs')");
    assert.ok(startAt > 0, '宿主角色必须调用 startStandalone');
    assert.ok(trayAt > startAt, '托盘必须在宿主服务启动后创建（要用端口与 token 读配置）');
    assert.match(source, /process\.env\.DSH_PET_PACKAGED === '1'/);
    assert.match(source, /startAppTray/);
    assert.match(source, /托盘创建失败/);
  });

  test('托盘创建不得阻塞入口模块求值（否则与 app.whenReady() 死锁）', () => {
    assert.match(source, /void import\('\.\/tray\.mjs'\)/);
    assert.ok(!/await import\('\.\/tray\.mjs'\)/.test(source), 'top-level await 会让 Electron 永远不触发 ready');
    assert.ok(!/await startAppTray\(/.test(source), 'startAppTray 内部等 app.whenReady()，不能在入口里 await');
  });
});

describe('构建与发布 —— 新入口随包发行', () => {
  test('tsdown 产出 lib/tray-actions.js（desktop/tray.mjs 直接 import）', () => {
    assert.match(readPackageFile('tsdown.config.mjs'), /'tray-actions'/);
  });

  test('electron-builder 的 desktop/**/* 白名单覆盖 tray.mjs', () => {
    assert.match(readPackageFile('electron-builder.yml'), /desktop\/\*\*\/\*/);
  });
});

describe('startStandalone 句柄 —— 暴露托盘请求所需的能力令牌', () => {
  test('app.ts 返回 token（与 settingsUrl 同一份，不在 HTTP 响应/日志里泄漏）', () => {
    assert.match(readPackageFile('src/standalone/app.ts'), /token:\s*security\.token/);
  });
});
