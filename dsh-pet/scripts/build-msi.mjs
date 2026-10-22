#!/usr/bin/env node
/**
 * build-msi.mjs —— 把 electron-builder 产出的内层 NSIS 安装包封进 MSI（ticket 01）。
 *
 * 为什么不用 electron-builder 的 msiwrapped：它的模板不可覆盖（`MsiWrappedOptions` 是
 * `additionalProperties: false`），外层 WiX 项目既没有 `<UI>` 也没有安装目录变量，
 * 用户无法选安装目录。这里改用自维护的 `build/wix/dsh-pet.wxs`（受版本控制）。
 *
 * 为什么复用 electron-builder 的 WiX 缓存：electron-builder 已经把 WiX 4.0.0.5512.2
 * 下载并解压到 `%LOCALAPPDATA%\electron-builder\Cache`，再下一份等于凭空多 40MB 与一次联网。
 * `app-builder-lib` 不在本包依赖里，只能经 electron-builder 自己的 require 解析（见 docs/installer.md）。
 *
 * 编译参数集中在本文件的 WIX_LIGHT_ARGS：ICE64 的抑制、中文本地化、UI 扩展都必须写死，
 * 不能指望调用者记得加。
 *
 * 用法：node scripts/build-msi.mjs [--exe <内层安装包>] [--out <输出 .msi>]
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(ROOT, 'dist');
const WIX_SOURCE = join(ROOT, 'build', 'wix', 'dsh-pet.wxs');
const BUILD_DIR = join(ROOT, 'build', 'wix', '.out');

/** electron-builder 自己缓存的那份 WiX（版本号与 docs/installer.md 记录的版本前提一致） */
const WIX_VERSION = 'wix-4.0.0.5512.2';
const WIX_ARCHIVE = 'wix-4.0.0.5512.2.7z';
const WIX_SHA512 = 'fe677fcd837b18c9b912985d91636bbd8a1e800c3b3a6a841b6f96e89624e839';

/**
 * 内层 NSIS 识别的 APP_GUID：electron-builder 的 UUID.v5("com.dsh.pet")，
 * wxs 经 $(var.AppGuid) 引用（multiUser.nsh 读 HKCU\Software\<AppGuid>\InstallLocation）。
 */
const APP_GUID = 'D2D25ABD-F4E1-52F5-89B2-AA3F268CE518';

/**
 * light.exe 的固定参数 —— 只在这里出现一次。
 *  - `-ext WixUIExtension`：WixUI_InstallDir 与各对话框的符号来自这个扩展。
 *  - `-sice:ICE64`：APPLICATIONFOLDER 位于用户 profile 下而 MSI 自身不装文件时，
 *    ICE64 会误报「目录未列入 RemoveFile 表」。写法必须是 `-sice:ICE64`（`=` 会报 LGHT1098）。
 *  - `-spdb` / `-sw1076`：与 electron-builder 一致，抑制与 WiX 4 无关的老版本噪声。
 *  - `-cultures:zh-CN`：中文字符串（对话框与错误说明）走 zh-CN 本地化；缺它 light 报 LGHT0311。
 */
const WIX_LIGHT_ARGS = ['-nologo', '-ext', 'WixUIExtension', '-sice:ICE64', '-spdb', '-sw1076', '-cultures:zh-CN'];

function fail(message) {
  console.error(`[msi] ${message}`);
  process.exit(1);
}

/**
 * 定位 electron-builder 缓存里的 WiX 工具目录。
 * `getBinFromUrl` 走缓存、离线可用，解压目录就是 candle/light/WixUIExtension.dll 所在处。
 * 解析失败时必须给人话：`app-builder-lib` 是 electron-builder 的依赖，本包 require 不到它。
 */
async function resolveWixToolset() {
  let getBinFromUrl;
  try {
    const electronBuilderPkg = require.resolve('electron-builder/package.json');
    const fromElectronBuilder = createRequire(electronBuilderPkg);
    ({ getBinFromUrl } = fromElectronBuilder('app-builder-lib/out/binDownload'));
  } catch (error) {
    fail(
      '找不到 electron-builder 的 WiX 工具链（app-builder-lib 未安装）。' +
        '先在 dsh-pet/ 下执行 pnpm install；若只用 --exe 复用现成安装包，MSI 仍需这一步。' +
        `\n  原因：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return await getBinFromUrl(WIX_VERSION, WIX_ARCHIVE, WIX_SHA512);
  } catch (error) {
    fail(
      `无法取得 WiX 工具链 ${WIX_VERSION}（缓存缺失且下载失败）。` +
        'electron-builder 在本机首次构建安装包时会把它下载到 ' +
        '%LOCALAPPDATA%\\electron-builder\\Cache；先跑一次 pnpm run dist 即可。' +
        `\n  原因：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 包版本（写入 MSI 的 ProductVersion；MSI 只接受 x.y.z） */
function packageVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const version = String(pkg.version ?? '').split('-')[0];
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`package.json 的 version 不像 x.y.z：${String(pkg.version)}`);
  return version;
}

/** 内层 NSIS 安装包：dist/ 下唯一的 dsh-pet-Setup-<version>.exe */
function findWrappedExe(version) {
  const expected = `dsh-pet-Setup-${version}.exe`;
  const candidates = existsSync(DIST) ? readdirSync(DIST).filter((name) => /^dsh-pet-Setup-.*\.exe$/i.test(name)) : [];
  if (candidates.includes(expected)) return join(DIST, expected);
  if (candidates.length === 1) return join(DIST, candidates[0]);
  fail(
    candidates.length === 0
      ? `${DIST} 下没有内层 NSIS 安装包，先跑 node scripts/dist.mjs`
      : `${DIST} 下有多个安装包（${candidates.join('、')}），无法判断该包哪一个`,
  );
}

/** 解析 `--flag value` 形式的参数 */
function argValue(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) fail(`${command} 启动失败：${result.error.message}`);
  if (result.status !== 0) fail(`${command} 退出码 ${String(result.status ?? result.signal)}`);
}

const version = packageVersion();
const wrappedExe = resolve(argValue('--exe') ?? findWrappedExe(version));
if (!existsSync(wrappedExe)) fail(`内层安装包不存在：${wrappedExe}`);

const output = resolve(argValue('--out') ?? join(DIST, `dsh-pet-Setup-${version}.msi`));
mkdirSync(DIST, { recursive: true });

const wix = await resolveWixToolset();
const candle = join(wix, 'candle.exe');
const light = join(wix, 'light.exe');
for (const tool of [candle, light]) {
  if (!existsSync(tool)) fail(`WiX 工具缺失：${tool}（缓存目录不完整，删掉 Cache 里的 ${WIX_VERSION} 重跑）`);
}

// 中间产物放 build/wix/.out（已被 .gitignore 忽略），不污染 dist/ 与源码目录。
rmSync(BUILD_DIR, { recursive: true, force: true });
mkdirSync(BUILD_DIR, { recursive: true });
const objectFile = join(BUILD_DIR, 'dsh-pet.wixobj');

console.log(`[msi] 内层安装包：${wrappedExe}（${(statSync(wrappedExe).size / 1024 / 1024).toFixed(1)} MB）`);
console.log(`[msi] WiX 工具链：${wix}`);

run(candle, [
  '-nologo',
  '-arch',
  'x64',
  `-dWrappedExe=${wrappedExe}`,
  `-dProductVersion=${version}`,
  `-dAppGuid=${APP_GUID}`,
  '-out',
  objectFile,
  WIX_SOURCE,
]);

run(light, [...WIX_LIGHT_ARGS, '-out', output, objectFile]);

if (!existsSync(output)) fail(`light.exe 结束但 ${output} 不存在`);
console.log(`[msi] 产物：${output}（${(statSync(output).size / 1024 / 1024).toFixed(1)} MB）`);
