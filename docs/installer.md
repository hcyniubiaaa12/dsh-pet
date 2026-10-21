# Windows 安装器：可依赖的约定

Windows 安装包由 `electron-builder.yml`（配置）+ `build/installer.nsh`（NSIS 片段）+
`scripts/dist.mjs`（构建入口）+ `scripts/build-msi.mjs`（MSI 外壳）+ `build/wix/`（WiX 项目）组成。
本文记录**读第三方源码才能确认、改错会静默出坏包**的约定，以及它们对应的 electron-builder 与 WiX 版本。

改动安装器前先读这里，不要去翻 `node_modules`。

## 版本前提

以下结论来自 **electron-builder 26.15.3 + WiX 4.0.0.5512.2 + NSIS 3.0.4.1**。
升级这三者中任何一个，都要重新核对本文。

## NSIS 片段的挂钩点

`build/installer.nsh` 通过 `nsis.include` 注入。electron-builder 提供这些宏，**只有定义了的才会被调用**：

| 宏 | 时机 | 本仓库用途 |
|---|---|---|
| `customCheckAppRunning` | 安装前发现实例在跑 | 提示并关闭，静默安装直接杀 |
| `customInstall` | 文件落盘、注册表写完 | 写开机自启项与初始化标记 |
| `customUnInstall` | 卸载段**开头**（删文件之前） | 清理 Run 项 |
| `customUnInit` | 卸载器 `un.onInit`（页面之前） | 未使用 |
| `customUninstallPage` | **`MUI_UNPAGE_INSTFILES` 之后** | 未使用 —— 见下方陷阱 |

**陷阱：`customUninstallPage` 插在卸载执行之后。** 想"先让用户勾选、再删"必须自己用
`MUI_UNPAGE_CUSTOM` 或覆盖欢迎页，插在进度页之前。`assistedInstaller.nsh` 的卸载分支顺序是
`UNPAGE_WELCOME → UNPAGE_INSTFILES → customUninstallPage → UNPAGE_FINISH`。

`MUI_UNPAGE_COMPONENTS` 也只在定义了 `customUnInstallSection` 时才启用（见 `installer.nsi` 顶部）。

## 静默模式下的行为

- 静默安装（`/S`）不显示任何页面，`customUnInstall` 里不能假设有 UI。
- `/D=<path>` 生效于静默安装：electron-builder 用 `StdUtils.GetAllParameters` 手工解析
  （`multiUser.nsh` 的 `GetDParameter` 宏），因为 NSIS 原生 `/D` 要求末位且不能带引号。
- 安装目录的解析顺序：注册表 `InstallLocation` → 默认（per-user 为 `$LOCALAPPDATA\Programs\<APP_FILENAME>`）
  → `/D=` 覆盖。因此**重装会沿用旧目录**，与 `allowToChangeInstallationDirectory` 无关。

## MSI（自维护 WiX 项目）

`win.target` 只有 `nsis`。MSI 由 `scripts/build-msi.mjs` 把 NSIS 产出的 exe 包进
`build/wix/dsh-pet.wxs` 编出来，是 `pnpm run dist` 的最后一步。

### 为什么不再用 msiwrapped

- `MsiWrappedOptions` 是 `additionalProperties: false`，没有任何 template 字段；
  唯一扩展点 `msiProjectCreated` 只在 wxs 写盘后、candle 前拿到临时文件，
  且外层模板没有 `<UI>`、没有 `INSTALLDIR` / `APPLICATIONFOLDER`。
- 因此**msiwrapped 本身无法让用户选安装目录**，只能整个替换。

### 项目本身

- 外层 MSI 仍不是真正的安装器：`Feature Level="0"` + 一个 dummy Component（KeyPath 是 HKCU
  注册表值，否则 ICE38 报「装在用户 profile 的组件不能用文件夹当 KeyPath」），
  不注册为已安装产品；「设置 → 应用」里只有内层 NSIS 注册的那一条。
- 内层 exe 以 `/S --force-run "/D=<目录>"` 执行，不出现第二层向导。
  `Impersonate="yes"` + `MSIINSTALLPERUSER` 保证内层以**当前用户**身份运行。
- 目录属性一律 `Secure="yes"`，否则 deferred 自定义动作读到空串。

### 编译参数（全部集中在 `scripts/build-msi.mjs` 的 `WIX_LIGHT_ARGS`）

- `-ext WixUIExtension`：`WixUI_InstallDir` 与各对话框的符号来自这里。
- `-sice:ICE64`：安装目录在用户 profile 下、而 MSI 自身不装文件时会误报「目录未列入 RemoveFile 表」。
  **写法必须是 `-sice:ICE64`**，`-sice=ICE64` 会先报 LGHT1098 再照样报 ICE64。
- `-cultures:zh-CN`：中文字符串的前提（只写 `Codepage="65001"` 仍会报 LGHT0311，NLS 走 1252）。
- `-spdb` / `-sw1076`：与 electron-builder 一致，压掉与 WiX 4 无关的老版本噪声。
- WiX 工具链复用 electron-builder 缓存（`getBinFromUrl` 走缓存、离线可用），不另外下载；
  解析不到时必须给人话（`app-builder-lib` 是 electron-builder 的依赖，包根 require 不到）。

### 实测发现的三条反直觉行为（2026-10-21，WiX 4.0.0.5512.2）

1. **不能靠「重定义同一行 Publish」改内置翻页条件。** `WixUI_InstallDir` 的
   `InstallDirDlg/Next/NewDialog/VerifyReadyDlg` 是 Order 4；再写一条同键的 Publish，
   WiX 会把**两条都写进** ControlEvent 表，内置那条没有自定义条件，用户照样翻页。
   正确做法：预检用 Order 3 先跑、提示用 Order 5 后弹（用户读完说明仍停在目录页），
   或者在 UI 里用完全不同的键另开一条路径 —— 不要指望覆盖。
2. **`CostFinalize` 后目录属性带尾反斜杠。** 直接拼 `"/D=[APPLICATIONFOLDER]"` 会变成
   `"/D=D:\Apps\X\"`，末尾 `\"` 被当转义引号，MSI 报 1721。
   必须先经 `NormalizeInstallDir` 去掉尾斜杠，再用 `/D=[DSHPET_INSTALL_DIR]`。
3. **`SetDirectory` 在这个 WiX 版本不产生任何表行**，不能用它把命令行属性灌进目录属性；
   改用 immediate JScript 在 `CostFinalize` 之前赋值。另外 msiexec 有时会把
   `INSTALLDIR="..."` 的引号一起塞进属性值，值里要剥掉引号，否则 CostFinalize 当网络位置（1606）。

### 安装目录的传递

- 目录页写 `APPLICATIONFOLDER`（`WIXUI_INSTALLDIR` 指向它），命令行写 `INSTALLDIR`；
  `ApplyCommandLineInstallDir` 在 `CostFinalize` 之前把后者灌进前者，两条入口指向同一目录。
- 传给内层 NSIS 有两条通道：`/D=`（主）与 `HKCU\Software\<APP_GUID>\InstallLocation`（退路）。
  `APP_GUID = UUID.v5("com.dsh.pet", ELECTRON_BUILDER_NS_UUID)`，当前值
  `D2D25ABD-F4E1-52F5-89B2-AA3F268CE518`；`multiUser.nsh` 的 `setInstallModePerUser` 优先读它。
- 两条通道都已真机验证：静默安装 `INSTALLDIR=...`，卸载项、DisplayIcon、桌面与开始菜单快捷方式
  全部指向指定目录；卸载后目录、`InstallLocation`、卸载项都被清掉。

### 手工验证清单

会改注册表、会真装一份应用的步骤不进 CI，见 `build/wix/README.md`。

## 自启标记路径

安装器写 `<DSH_HOME>\dsh-pet\autostart-initialized`，与 `src/host/autostart.ts` 同口径。
`DSH_HOME` 未设置时回落到 `%USERPROFILE%\.dsh`。安装器只能读到**安装那一刻**的环境变量；
用户之后才改 `DSH_HOME` 的情况不在支持范围内。

标记的语义是「安装器/应用是否初始化过自启」，不是用户偏好。用户关掉自启由系统登录项状态承载。

## 数据目录

| 位置 | 内容 | 卸载是否清理 |
|---|---|---|
| `<DSH_HOME>\dsh-pet\` | 配置、记忆、宠物包、素材 | 勾选时 |
| `<DSH_HOME>\dsh-pet\standalone-ai.json` | **明文** API 密钥 | 单独一项 |
| `<DSH_HOME>\electron\` | 内置 Electron 运行时，约 348MB | 勾选时 |
| `%APPDATA%\dsh-pet-electron-helper\` | 桌面壳 Chromium profile | 勾选时 |
| `%APPDATA%\DSH Pet\` | 安装版宿主 userData | 勾选时 |
| `%LOCALAPPDATA%\electron\Cache` | **多应用共享**的下载缓存 | 永不 |

## 检查覆盖

- `src/host/packaging.test.ts`：安装包接线契约（配置项、包内布局、构建链）。
- `src/host/autostart-wiring.test.ts`：NSIS 里的自启写入与清理。
- `.nsh` / `.wxs` **不进 prettier、不进制表**（prettier 不认识这些格式），
  所以契约测试是这两类文件唯一的自动防线。改完必须补断言。
