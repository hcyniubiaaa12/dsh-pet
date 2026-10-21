# Windows 安装器：可依赖的约定

Windows 安装包由 `electron-builder.yml`（配置）+ `build/installer.nsh`（NSIS 片段）+
`scripts/dist.mjs`（构建入口）组成。本文记录**读第三方源码才能确认、改错会静默出坏包**的约定，
以及它们对应的 electron-builder 版本。

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

## MSI（msiwrapped）

- 外层 MSI **不是真正的安装器**：模板里 `Feature Level="0"`，不注册为已安装产品，不含任何文件。
  它只把 NSIS exe 作为二进制资源嵌入，用 deferred custom action 执行。
- 因此「设置 → 应用」里看到的是**内层 NSIS 注册的卸载项**，卸载走的也是它。
- **模板不可覆盖**：`MsiWrappedOptions` 是 `additionalProperties: false`，没有任何 template 字段；
  唯一扩展点是全局 hook `msiProjectCreated`（wxs 写盘后、candle 前）。
- 外层没有 `INSTALLDIR` / `APPLICATIONFOLDER`、没有 `<UI>`：**msiwrapped 本身不支持让用户选目录**。
  `msiWrapped.oneClick` 只影响 light 是否加 `WixUIExtension`，不产生 UI。
- exe 源文件名必须与 `nsis.artifactName` 完全一致，否则 `MsiWrappedTarget` 找不到内层包。

## 自建 WiX 工程时

若用自维护的 WiX 项目替代 `msiwrapped`（见 `.scratch/installer-customization/`）：

- `WixUI_InstallDir` 需要 `WIXUI_INSTALLDIR` 指向一个真实存在的 `Directory`，编译时加 `-ext WixUIExtension`。
- 安装目录位于用户 profile 下、而 MSI 自身不安装文件时，**ICE64 会误报**「目录未列入 RemoveFile 表」，
  必须加 `-sice:ICE64`。这条参数不能靠调用者记得加。
- `ExeCommand` 里的 `[APPLICATIONFOLDER]` 能否在 deferred custom action 中展开**尚未实测**。
  不成立时的退路：MSI 先写注册表，内层 NSIS 读。注意 `INSTALL_REGISTRY_KEY` 在卸载时会被清理。

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
