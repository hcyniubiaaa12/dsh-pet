/**
 * MSI 安装目录页的构建契约（ticket 01）。
 *
 * 为什么需要这层测试：`.nsh` / `.wxs` 都不进 prettier（`.mjs` 构建脚本进 eslint，
 * 但构建行为没法用 lint 拦），而 `electron-builder.yml` 里删错一行只会让**构建产物**出问题（MSI 没有目录页、
 * 或干脆退回 msiwrapped），`pnpm test` 是唯一能在构建前拦住的地方。
 *
 * 断言粒度停在「行为存在」：不逐字比对 WiX 源码，只钉住用户可见能力与
 * 拼装这些能力的接线（target 列表、构建步骤、编译参数、页面绑定）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { load } from 'js-yaml';

/** 读包根下的文件（本测试位于 src/host/，包根是两级之上） */
function readPackageFile(relative: string): string {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
}

function packageFileExists(relative: string): boolean {
  return existsSync(new URL(`../../${relative}`, import.meta.url));
}

/** win.target 归一化成纯名字列表（配置允许 `'nsis'` 与 `{ target: 'nsis' }` 两种写法） */
function targetNames(yml: string): string[] {
  const config = load(yml) as { win?: { target?: Array<string | { target?: string }> } };
  return (config.win?.target ?? []).map((entry) =>
    (typeof entry === 'string' ? entry : (entry.target ?? '')).toLowerCase().trim(),
  );
}

describe('electron-builder 配置 —— MSI 不再由 msiwrapped 产出', () => {
  const yml = readPackageFile('electron-builder.yml');

  test('win.target 只留 nsis（MSI 改由自维护的 WiX 项目单独构建）', () => {
    const targets = targetNames(yml);
    assert.ok(targets.includes('nsis'), 'NSIS 仍是内层安装包，必须保留');
    assert.ok(
      !targets.includes('msiwrapped'),
      'msiwrapped 没有 UI 也没有目录变量，无法让用户选安装目录；留着会产出两套 MSI',
    );
    assert.deepEqual(targets, ['nsis'], 'MSI 只能由 build/wix/ 那一步产出，不能有第二个 MSI 来源');
  });
});

describe('build/wix —— 自维护的 WiX 项目（受版本控制，换机器可复现）', () => {
  const WIX_SOURCE = 'build/wix/dsh-pet.wxs';

  test('WiX 源文件在仓库里（不靠 electron-builder 生成，msiwrapped 的模板改不了）', () => {
    assert.ok(packageFileExists(WIX_SOURCE), `${WIX_SOURCE} 必须入库`);
  });

  test('安装目录页绑到 APPLICATIONFOLDER，默认 %LOCALAPPDATA%\\Programs\\DSH Pet', () => {
    const wxs = readPackageFile(WIX_SOURCE);
    assert.match(wxs, /<UIRef\s+Id="WixUI_InstallDir"/, '需要 WixUI_InstallDir 才出现「安装位置」页');
    assert.match(wxs, /WIXUI_INSTALLDIR"\s+Value="APPLICATIONFOLDER"/, '目录页的输入框绑到 APPLICATIONFOLDER');
    // 默认值来自目录树：LocalAppDataFolder\Programs\<产品名>，per-user，不提权
    assert.match(wxs, /<Directory\s+Id="LocalAppDataFolder">/);
    assert.match(wxs, /<Directory\s+Id="APPLICATIONFOLDER"\s+Name="DSH Pet"/);
  });
});

describe('scripts/build-msi.mjs —— 把内层 NSIS 包封进 WiX 项目', () => {
  const SCRIPT = 'scripts/build-msi.mjs';

  test('构建脚本在仓库里，且被 dist 流程调用（否则 .msi 根本不会产出）', () => {
    assert.ok(packageFileExists(SCRIPT), `${SCRIPT} 必须入库`);
    const pkg = JSON.parse(readPackageFile('package.json')) as { scripts?: Record<string, string> };
    const dist = pkg.scripts?.dist ?? '';
    assert.match(dist, /scripts\/dist\.mjs/, 'dist 仍先走 electron-builder 产出内层 NSIS');
    assert.match(dist, /scripts\/build-msi\.mjs/, 'dist 必须在 NSIS 之后接着编 MSI');
    const distAt = dist.indexOf('scripts/dist.mjs');
    const msiAt = dist.indexOf('scripts/build-msi.mjs');
    assert.ok(distAt >= 0 && msiAt > distAt, 'MSI 封装必须在 NSIS 产出之后（它要嵌入那个 exe）');
  });

  test('WiX 编译参数集中一处：WixUIExtension 与 -sice:ICE64 不许靠调用者记得加', () => {
    const source = readPackageFile(SCRIPT);
    assert.match(source, /WixUIExtension/, 'WixUI_InstallDir 的对话框符号来自这个扩展');
    // ICE64 会误报「用户目录未列入 RemoveFile 表」；写法必须是 -sice:ICE64（= 号会报 LGHT1098）
    assert.match(source, /'-sice:ICE64'/, '必须自带 ICE64 抑制，且用冒号写法');
    assert.ok(!/sice[=:]ICE64'?[\s\S]{0,40}sice=/.test(source), '不要写成 -sice=ICE64');
    assert.match(source, /zh-CN/, '中文文案需要 -cultures:zh-CN，否则 light 报 LGHT0311');
    assert.match(source, /wix-4\.0\.0\.5512\.2/, '复用 electron-builder 已缓存的 WiX，不另外下载');
  });
});

describe('内层 NSIS —— 静默执行，安装目录由外层 MSI 传入', () => {
  const wxs = readPackageFile('build/wix/dsh-pet.wxs');

  test('内层安装包以 /S --force-run 静默执行，不出现第二层向导', () => {
    assert.match(wxs, /ExeCommand="[^"]*\/S/, '不加 /S 会弹出第二层 NSIS 向导');
    assert.match(wxs, /--force-run/, '装完要启动应用（与原先 msiwrapped 的体验一致）');
  });

  test('用户选的目录经 [APPLICATIONFOLDER] 传给 /D=，属性必须 Secure', () => {
    // deferred 动作里 [APPLICATIONFOLDER] 会展开成用户实际选的路径（实测）；
    // /D= 是 electron-builder 的 multiUser.nsh 认的覆盖开关。
    assert.match(wxs, /\/D=\[?APPLICATIONFOLDER\]?/, '选定的安装目录必须传给内层 NSIS');
    assert.match(wxs, /<Property\s+Id="APPLICATIONFOLDER"\s+Secure="yes"/, 'deferred 动作读不到非 Secure 的属性');
  });

  test('deferred 动作以当前用户身份执行（不落到 SYSTEM 的 profile）', () => {
    // per-user 安装 + Impersonate="yes"：实测内层进程的 USER 是当前用户。
    assert.match(wxs, /Execute="deferred"/);
    assert.match(wxs, /Impersonate="yes"/);
  });
});

describe('目录页预检 —— 在离开当前页之前拦住不合格的路径', () => {
  const wxs = readPackageFile('build/wix/dsh-pet.wxs');

  /** 取出预检那个 JScript 自定义动作的脚本体 */
  function validatorScript(): string {
    const start = wxs.indexOf('Id="DSHPetValidateInstallDir"');
    assert.ok(start > 0, '必须有目录页预检的自定义动作');
    const end = wxs.indexOf('</CustomAction>', start);
    return wxs.slice(start, end);
  }

  test('五类拒绝都实现：根目录 / 不可写 / 敏感字符 / 过长 / 另一份安装', () => {
    const script = validatorScript();
    assert.match(script, /不能直接装到磁盘根目录/, '选了 D:\\ 必须拒绝（用户故事 4）');
    assert.match(script, /无法写入该目录/, '不可写要就地报错，不提权（用户故事 3）');
    assert.match(script, /特殊字符/, '含 $ / " / 换行等字符要拒绝（会被 WiX/NSIS 误解析）');
    assert.match(script, /安装路径太长/, '过长路径提前拒绝，而不是解压到一半失败（用户故事 5）');
    assert.match(script, /已有一份 DSH Pet|另一份/, '指向另一份正在使用的安装要拒绝（用户故事 6）');
    // 试写用临时文件，不能碰用户已有内容
    assert.match(script, /CreateTextFile/, '可写性必须真的试写，不能靠猜');
    assert.match(script, /DeleteFile/, '试写完要删掉探针文件');
  });

  test('失败时把可读说明交给 UI（不翻页），不静默继续', () => {
    assert.match(wxs, /DSHPET_DIR_ERROR/, '预检结果要通过属性传给对话框');
    assert.match(wxs, /Id="DSHPetInvalidDirDlg"/, '要有自有说明对话框');
    // 内置的 InvalidDirDlg 属于 WixUIExtension，重定义会 LGHT0091，所以必须用自有 Id
    assert.ok(!/<Dialog\s+Id="InvalidDirDlg"/.test(wxs), 'InvalidDirDlg 是 WixUIExtension 的符号，重定义会 LGHT0091');
  });

  test('预检排在翻页之前（Order 3），提示排在翻页之后（Order 5）', () => {
    const orderOf = (marker: string): number => {
      const at = wxs.indexOf(marker);
      assert.ok(at > 0, `找不到 ${marker}`);
      const block = wxs.slice(at, wxs.indexOf('</Publish>', at));
      return Number(/Order="(\d+)"/.exec(block)?.[1]);
    };
    const validate = orderOf('Value="DSHPetValidateInstallDir"');
    const prompt = orderOf('Value="DSHPetInvalidDirDlg"');
    assert.ok(validate > 0 && validate < 4, '预检必须在 WixUI 的 NewDialog VerifyReadyDlg(Order 4) 之前');
    assert.ok(prompt > 4, '提示必须在翻页之后，否则用户看不到说明');
  });
});

describe('命令行 INSTALLDIR —— 静默部署也能指定目录', () => {
  const wxs = readPackageFile('build/wix/dsh-pet.wxs');

  test('msiexec INSTALLDIR=... 会被灌进目录页用的 APPLICATIONFOLDER', () => {
    assert.match(wxs, /<Property\s+Id="INSTALLDIR"\s+Secure="yes"/, '命令行属性必须 Secure 才能在 deferred 里读到');
    assert.match(wxs, /Id="ApplyCommandLineInstallDir"/, '需要一步显式转换');
    const action = wxs.slice(wxs.indexOf('Id="ApplyCommandLineInstallDir"'));
    assert.match(action, /Session\.Property\("INSTALLDIR"\)/);
    assert.match(action, /Session\.Property\("APPLICATIONFOLDER"\)\s*=/, '转换的目标是目录页绑定的那个属性');
  });

  test('转换在 CostFinalize 之前执行，UI 与静默（无 UI）两条路都覆盖', () => {
    const uiSeq = wxs.slice(wxs.indexOf('<InstallUISequence>'), wxs.indexOf('</InstallUISequence>'));
    const execSeq = wxs.slice(wxs.indexOf('<InstallExecuteSequence>'), wxs.indexOf('</InstallExecuteSequence>'));
    assert.match(uiSeq, /ApplyCommandLineInstallDir"[^>]*Before="CostFinalize"/, '有界面时在 CostFinalize 前转换');
    assert.match(
      execSeq,
      /ApplyCommandLineInstallDir"[^>]*Before="CostFinalize"/,
      '静默安装没有 UI 序列，execute 序列必须同样转换',
    );
  });

  test('/D= 走主通道，注册表 InstallLocation 是退路，两条都要在', () => {
    // 主通道：/D= 直接传给内层 NSIS。必须用去尾斜杠的属性 —— CostFinalize 后的
    // APPLICATIONFOLDER 带尾反斜杠，拼进 "/D=..." 会把结束引号转义掉（实测 1721）。
    assert.match(wxs, /ExeCommand="[^"]*\/D=\[DSHPET_INSTALL_DIR\]/, '主通道：/D= 传给内层 NSIS');
    assert.match(
      wxs,
      /Id="NormalizeInstallDir"[\s\S]*?APPLICATIONFOLDER[\s\S]*?DSHPET_INSTALL_DIR/,
      '传给 /D= 的值必须先去掉尾斜杠',
    );
    assert.match(wxs, /Id="SetInstallLocation"/, '退路：写 NSIS 会优先读取的 InstallLocation');
    // APP_GUID 由 candle -dAppGuid 注入（build-msi.mjs 单点定义），wxs 里不许再写死
    assert.match(wxs, /\$\(var\.AppGuid\)/, '注册表键必须经 $(var.AppGuid) 引用');
    assert.ok(
      !/D2D25ABD-F4E1-52F5-89B2-AA3F268CE518/.test(wxs),
      'APP_GUID 不许写死在 wxs 里，只能由 build-msi.mjs 注入',
    );
    const script = readPackageFile('scripts/build-msi.mjs');
    assert.match(script, /D2D25ABD-F4E1-52F5-89B2-AA3F268CE518/, 'APP_GUID 单点定义在 build-msi.mjs');
    assert.match(script, /-dAppGuid=/, '编译时必须把 APP_GUID 传给 candle');
    assert.match(wxs, /InstallLocation/, 'NSIS 的 multiUser.nsh 读的就是这个值名');
  });
});
