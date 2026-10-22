# MSI 外壳（自维护 WiX 项目）

`dsh-pet.wxs` 在这里，编译入口是 `scripts/build-msi.mjs`（`pnpm run dist` 的最后一步）。
它把 electron-builder 产出的 `dist/dsh-pet-Setup-<version>.exe` 包进一个带目录页的 MSI。

约定与陷阱（为什么不能覆盖内置 Publish 行、ICE64、`-cultures:zh-CN` 等）记在仓库根
`docs/installer.md`；这里只放手**手工验证清单** —— 这些步骤会改注册表、会真的装一份应用，
不适合进 CI 或 `pnpm test`。

## 手工验证清单

准备：先 `pnpm run dist`，产物是 `dist/dsh-pet-Setup-<version>.msi`。每次验证前后都用
「设置 → 应用」或 `Uninstall DSH Pet.exe /S` 把上一轮卸干净，并确认
`HKCU\Software\D2D25ABD-F4E1-52F5-89B2-AA3F268CE518\InstallLocation` 已消失。

1. **默认目录**：双击 `.msi`，向导里出现「选择安装文件夹」页，路径框默认
   `%LOCALAPPDATA%\Programs\DSH Pet`。直接下一步装完，程序在默认位置。
2. **改目录生效**：改到 `D:\Apps\DSH Pet` 装完，检查四件事都指向新位置：
   - `D:\Apps\DSH Pet\DSH Pet.exe` 存在；
   - 桌面快捷方式与开始菜单项的「目标」是新路径；
   - `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 的 `electron.app.DSH Pet` 是新路径；
   - 「设置 → 应用」的卸载项指向 `D:\Apps\DSH Pet\Uninstall DSH Pet.exe`。
3. **拒绝盘根**：目录页填 `D:\`，点下一步 → 弹出说明「不能直接装到磁盘根目录…」，留在目录页。
4. **拒绝不可写**：填 `C:\Windows\System32\DSH Pet`，点下一步 → 弹出「无法写入该目录…」，留在目录页，
   且**没有** UAC 提权弹窗。
5. **拒绝敏感字符与超长路径**：分别填 `D:\Apps\$DSH`、`D:\Apps\DSH "Pet"`、以及一条超过 180 字符的路径，
   都应被拒绝并留在目录页。
6. **拒绝另一份安装**：已装在默认位置时，把目录页指到一个装着另一份 `DSH Pet.exe` 的目录 → 被拒绝。
7. **命令行安装**：
   `msiexec /i dsh-pet-Setup-<version>.msi INSTALLDIR="D:\Apps\DSH Pet" /qn`
   → 装到 `D:\Apps\DSH Pet`（验证 `/D=` 主通道；若失败，看 `InstallLocation` 退路是否兜住）。
8. **没有第二层向导**：以上任何一次安装过程中都不出现 NSIS 的进度/目录页面。
   装完应用会自动启动（`--force-run`）。
9. **不登记为已安装产品**：装完后「设置 → 应用」里只有一条（内层 NSIS 注册的），没有第二条 MSI 产品。
10. **卸载**：走内层卸载器，确认安装目录被删、Run 项被清、`InstallLocation` 被清。

## 已实测的结论（2026-10-21，WiX 4.0.0.5512.2）

- **不能用「重定义同一行 Publish」改内置翻页条件**：WiX 4 会把两条 Order 相同的
  `InstallDirDlg/Next/NewDialog/VerifyReadyDlg` **并存**写进 ControlEvent 表，内置那条
  没有自定义条件，用户照样翻页。因此这里的做法是：预检用 Order 3 先跑，提示用 Order 5 后弹，
  用户读完说明仍停在同一个目录页。
- `<Publish>` 与 `<Dialog>` 必须放在 `<UI>` 里；直接挂 `<Product>` 下是 CNDL0005。
- `SetDirectory` 在这个 WiX 版本里不产生任何表行，不能用来实现「命令行属性 → 目录属性」的转换；
  改用 immediate JScript 自定义动作（`ApplyCommandLineInstallDir`）在 `CostFinalize` 之前赋值。
- 组件的 KeyPath 不能是用户目录下的文件夹/文件（ICE38），要用 HKCU 注册表值（`EmptyComponent`）。
- `-sice:ICE64` 与 `-cultures:zh-CN` 缺一不可：前者抑制「用户目录未列入 RemoveFile 表」的误报，
  后者是中文文案能通过 LGHT0311 的前提。
