/**
 * 卸载数据清理选项的契约（ticket 02）。
 *
 * 安装器没法在 CI 里真装一遍（改注册表、写用户目录），这一层用「源码契约」钉住
 * 用户可见行为：页序、默认值、删除范围、静默语义、升级保护。断言粒度停在
 * 「行为存在且相对顺序正确」，不逐字比对整段脚本 —— 文案与控件坐标会变，行为不该变。
 *
 * 与之配套的手工验证清单见 build/installer-README.md。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { functionBody, macroBody, readPackageFile } from './installer-test-utils.ts';

const nsh = readPackageFile('build/installer.nsh');

describe('卸载勾选页 —— 插在欢迎页与进度页之间', () => {
  test('自定义页在卸载器里声明，且先于进度页出现', () => {
    // MUI 的默认卸载欢迎页由模板写死，只有定义这个宏才能让出位置给自定义页
    assert.match(nsh, /!define\s+removeDefaultUninstallWelcomePage/, '必须覆盖默认欢迎页，否则勾选页只能在欢迎页之后');
    assert.match(nsh, /UninstPage\s+custom\s+un\.\w+\s+un\.\w+/, '卸载向导必须注册自定义页（create + leave 回调）');
    // 主脚本编译两遍：自定义页只能挂在卸载器那一遍，否则交互式安装会凭空多出一页
    const customPageAt = nsh.indexOf('UninstPage custom');
    const guardAt = nsh.lastIndexOf('!ifdef BUILD_UNINSTALLER', customPageAt);
    assert.ok(guardAt >= 0, '自定义页必须包在 !ifdef BUILD_UNINSTALLER 里');
    // electron-builder 的钩子插在进度页之后，问了也来不及
    assert.ok(!/!macro\s+customUninstallPage/.test(nsh), 'customUninstallPage 在卸载执行之后，不能用它做勾选页');
  });

  test('四项默认都不勾（不勾 = 一个字节都不碰）', () => {
    assert.equal((nsh.match(/\$\{NSD_CreateCheckBox\}/g) ?? []).length, 4, '卸载页必须恰好有四个勾选项');
    assert.match(nsh, /\$\{NSD_SetState\}\s+\$\w+\s+\$\{BST_UNCHECKED\}/, '勾选状态必须显式初始化为未勾选');
    assert.ok(!/\$\{NSD_SetState\}[^\n]*\$\{BST_CHECKED\}/.test(nsh), '任何一项都不得默认勾选');
  });

  test('每一项都写清路径与后果（用户要知道删的是哪个目录）', () => {
    const create = functionBody(nsh, 'un.dshPetPurgePageCreate');
    for (const [label, pattern] of [
      ['对话记忆与配置', /\\dsh-pet\\/],
      ['AI 密钥', /standalone-ai\.json/],
      ['Electron 运行时', /\\electron\\/],
      ['桌面壳缓存', /dsh-pet-electron-helper/],
    ] as const) {
      assert.match(create, pattern, `${label} 的说明文字里必须出现实际路径`);
    }
    // 文案会变（体积数字随 Electron 版本漂移），只钉「每项都标了体积」这件事
    assert.match(create, /\d+\s?MB/, '运行时体积要写在选项上，否则「约 400MB」说服不了用户');
    assert.ok((create.match(/\d+\s?MB/g) ?? []).length >= 2, '运行时与桌面壳缓存两项都要标体积');
  });

  test('页面在进度页之前，取消时卸载段从未执行', () => {
    const leave = functionBody(nsh, 'un.dshPetPurgePageLeave');
    assert.match(leave, /\$\{NSD_GetState\}/, 'leave 回调必须读取用户的勾选结果');
    // 静默模式没有页面可点：create 里必须 Abort 跳过，勾选值由命令行决定
    const create = functionBody(nsh, 'un.dshPetPurgePageCreate');
    assert.match(create, /\$\{Silent\}/, '静默卸载必须单独处理，不能假设有 UI');
    assert.match(create, /\bAbort\b/, '静默模式跳过页面');
  });
});

describe('卸载清理 —— 只删勾选的精确路径', () => {
  test('四个删除目标各自被引用，且都是精确路径（不删共享缓存）', () => {
    const uninstall = macroBody(nsh, 'customUnInstall');
    assert.match(uninstall, /\$dshPetHome\\dsh-pet\b/, '对话记忆与配置');
    assert.match(uninstall, /standalone-ai\.json/, 'AI 设置与 API 密钥单独一项');
    assert.match(uninstall, /\$dshPetHome\\electron\b/, '内置 Electron 运行时');
    assert.match(uninstall, /\$APPDATA\\dsh-pet-electron-helper/, '桌面壳缓存（Chromium profile）');
    assert.match(uninstall, /\$APPDATA\\DSH Pet\b/, '安装版宿主 userData');
    // 多应用共享的下载缓存，删了会影响同机其它 Electron 应用
    assert.ok(!/electron[\\/]Cache/i.test(uninstall), '不得清理 %LOCALAPPDATA%\\electron\\Cache');
  });

  test('不勾选时一个字节都不碰：每个删除都挂在对应的勾选变量下', () => {
    const uninstall = macroBody(nsh, 'customUnInstall');
    for (const flag of ['dshPetPurgeData', 'dshPetPurgeAi', 'dshPetPurgeRuntime', 'dshPetPurgeCache']) {
      assert.match(
        uninstall,
        new RegExp(`\\$\\{If\\}\\s+\\$${flag}\\s*==\\s*\\$\\{BST_CHECKED\\}`),
        `缺少 $${flag} 的判断`,
      );
    }
    // 静默卸载默认保留：勾选变量先归零，命令行解析只负责置「全删」
    const initAt = uninstall.indexOf('StrCpy $dshPetPurgeData 0');
    const deleteAt = uninstall.indexOf('RMDir');
    assert.ok(initAt >= 0, '/S 默认保留数据');
    assert.ok(initAt < deleteAt, '默认值必须在删除之前写入');
  });

  test('单项失败不阻断其余项，也不阻断卸载', () => {
    const uninstall = macroBody(nsh, 'customUnInstall');
    // RMDir /r 对不存在/被占用的路径不致命，关键是不得用 Abort/Quit 中断卸载段
    assert.ok(!/\bAbort\b|\bQuit\b/.test(uninstall), '卸载清理不得中断整个卸载');
    assert.match(uninstall, /ClearErrors/, '删除前清错误标志，避免上一项失败影响下一项');
  });

  test('静默 /PURGE 全删；--delete-app-data 视为同一开关', () => {
    const uninstall = macroBody(nsh, 'customUnInstall');
    assert.match(uninstall, /\$\{GetOptions\}\s+\$R0\s+"\/PURGE"/, '/PURGE 必须被解析（GetOptions 不区分大小写）');
    assert.match(uninstall, /--delete-app-data/, '沿用 electron-builder 已注册的开关，不留两套语义');
    assert.match(uninstall, /StrCpy\s+\$dshPetPurge\w+\s+\$\{BST_CHECKED\}/, '/PURGE 时四项置为全删');
  });

  test('升级安装绝不清理任何数据，且保护必须在清理之前', () => {
    const uninstall = macroBody(nsh, 'customUnInstall');
    const guardAt = uninstall.search(/\$\{IfNot\}\s+\$\{isUpdated\}/);
    const purgeAt = uninstall.indexOf('/PURGE');
    const deleteAt = uninstall.indexOf('RMDir');
    assert.ok(guardAt >= 0, '新增清理必须复用现有的 !isUpdated 保护');
    assert.ok(guardAt < deleteAt, '保护必须在删除之前');
    assert.ok(guardAt < purgeAt, '保护必须覆盖命令行解析（升级时连开关都不看）');
  });

  test('自启标记独立于勾选：非升级卸载总是删掉，重装才能恢复默认开启', () => {
    const uninstall = macroBody(nsh, 'customUnInstall');
    const markerAt = uninstall.indexOf('autostart-initialized');
    assert.ok(markerAt > 0, '卸载必须删除自启初始化标记');
    const preceding = uninstall.slice(0, markerAt);
    const lastIf = preceding.lastIndexOf('${If} $dshPetPurge');
    const lastEndIf = preceding.lastIndexOf('${EndIf}');
    assert.ok(lastIf < lastEndIf, '标记的删除不能挂在任何勾选判断里');
  });

  test('只勾「对话记忆与配置」时，standalone-ai.json 与 autostart-initialized 不被 RMDir /r 连带删掉', () => {
    const uninstall = macroBody(nsh, 'customUnInstall');
    // 删除目录前必须先把两个文件 Rename 到目录外（$dshPetHome 下）保护起来，
    // RMDir /r 之后再放回 —— NSIS 没有「目录排除删除」原语，不做保护就是整目录递归删
    const item1At = uninstall.indexOf('$dshPetPurgeData == ${BST_CHECKED}');
    const item1 = uninstall.slice(item1At, uninstall.indexOf('RMDir /r "$dshPetHome\\electron"', item1At));
    assert.ok(item1At > 0, '第 1 项的勾选判断必须存在');
    for (const name of ['standalone-ai.json', 'autostart-initialized']) {
      const protectAt = item1.indexOf(`Rename "$dshPetHome\\dsh-pet\\${name}"`);
      const dirAt = item1.indexOf('RMDir /r "$dshPetHome\\dsh-pet"');
      assert.ok(protectAt > 0, `${name} 必须在第 1 项里有显式的 Rename 保护`);
      assert.ok(protectAt < dirAt, `${name} 的保护必须发生在 RMDir /r 之前`);
      // 保护路径在目录外（$dshPetHome\ 下），同目录改名会被递归删连坐
      const renameLine = item1.slice(protectAt, item1.indexOf('\n', protectAt));
      assert.match(renameLine, /"\$dshPetHome\\[\w.-]+\.__dsh_keep__"/, `${name} 必须改名到 dsh-pet 目录之外`);
      assert.match(
        item1,
        new RegExp(`Rename "\\$dshPetHome\\\\${name}\\.__dsh_keep__"`),
        `删完目录后 ${name} 要被放回`,
      );
    }
  });
});

describe('数据目录 —— 与 DSH_HOME 同口径', () => {
  test('读取 DSH_HOME，未设置时回落 $PROFILE\\.dsh（唯一算法，供 ticket 03 复用）', () => {
    const macro = macroBody(nsh, 'dshPetDataDir');
    assert.match(macro, /ReadEnvStr\s+(\$\w+|\$\{OUT\})\s+"DSH_HOME"/);
    assert.match(macro, /\$PROFILE\\\.dsh/);
    // 卸载段必须走这个宏，而不是再写一遍字面量
    const uninstall = macroBody(nsh, 'customUnInstall');
    assert.match(uninstall, /!insertmacro\s+dshPetDataDir\s+\$dshPetHome/);
  });
});
