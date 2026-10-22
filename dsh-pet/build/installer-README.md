# 安装包手工验证清单

自动化（`pnpm test`）只能钉住安装器**源码契约**；装一遍会改注册表和用户目录，
CI 里做不了。本文件只放「必须手工跑」的步骤与最近一次实测结论。
安装器改动涉及的既有约定（挂钩点、MSI 结构、路径解析顺序）见 `docs/installer.md`，此处不重复。

## 环境

- 构建产物：`dsh-pet/` 下 `pnpm run dist`，取 `dist/dsh-pet-Setup-<版本>.exe`。
- 静默安装到临时目录：`dsh-pet-Setup-<版本>.exe /S /D=<临时目录>`（`/D=` 必须是末位参数）。
- 静默卸载：`<安装目录>\Uninstall DSH Pet.exe /S`（1-2 秒退出，之后再看文件系统）。
- 每轮验证后清干净：卸载程序 + 删临时安装目录 + 删下述四处伪造数据。

## 伪造用户数据（安装后、卸载前放置）

| 位置                                 | 文件                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `%USERPROFILE%\.dsh\dsh-pet\`        | `main-config.jsonc`、`memory.json`、`standalone-ai.json`、`autostart-initialized` |
| `%USERPROFILE%\.dsh\electron\`       | 任意假文件                                                                        |
| `%APPDATA%\dsh-pet-electron-helper\` | 任意假文件                                                                        |
| `%APPDATA%\DSH Pet\`                 | 任意假文件                                                                        |

## 验证 A：静默卸载默认保留

`Uninstall DSH Pet.exe /S`（不带 /PURGE）后：

- [ ] 四个位置全部仍在，文件时间戳未变（保留语义，不只是删了内容）；
- [ ] `%USERPROFILE%\.dsh\dsh-pet\autostart-initialized` 被删（与勾选无关，重装才能恢复默认自启）。

## 验证 B：静默卸载 /PURGE 全删

重装 + 重造数据后 `Uninstall DSH Pet.exe /S /PURGE` 后：

- [ ] 四个位置全部不存在。

## 验证 C：交互式卸载勾选页

交互式运行 `Uninstall DSH Pet.exe`（不带 /S）：

- [ ] 欢迎页之后、进度页之前出现「选择要删除的用户数据」页，四项默认全不勾；
- [ ] 每项文案写清路径与后果，运行时约 348 MB、桌面壳缓存约 65 MB；
- [ ] 点取消后程序与数据都还在；
- [ ] 只勾「桌面壳缓存」时，其余三个目录的内容与时间戳完全未变。

## 验证 D：升级 / 同版本覆盖安装

在已安装同版本的状态下再次运行安装器（触发旧版卸载器、`${isUpdated}` 为真）：

- [ ] 卸载阶段不删除任何用户数据，自启标记也保留。

## 验证 E：数据目录跟随 DSH_HOME（ticket 03）

安装与卸载两侧的数据目录都按 `<DSH_HOME>`（未设置回落 `%USERPROFILE%\.dsh`）解析。

`cmd /c "set DSH_HOME=D:\dsh-home-test && DSH Pet Setup.exe /S"` 安装后：

- [ ] 标记落在 `D:\dsh-home-test\dsh-pet\autostart-initialized`，`%USERPROFILE%\.dsh\dsh-pet\` 不因此产生标记；
- [ ] 同一环境下 `Uninstall DSH Pet.exe /S` 卸载，该标记被删除。

不设 `DSH_HOME` 再装卸一遍：

- [ ] 行为与旧行为一致：标记落在 `%USERPROFILE%\.dsh\dsh-pet\autostart-initialized`，卸载后删除。

注意 `DSH_HOME` 要在**起安装器的那个进程**里可见（上面 set 的写法即可；
`setx` 只对之后新开的进程生效）。安装器只认安装那一刻的环境变量。

## 实测结论

- 2026-10-21，NSIS exe（electron-builder 26.15.3，分支 `ticket/ic-02-uninstall-options`）：
  验证 A、B 通过；C 的「页面存在、四项默认不勾」由源码契约测试
  （`src/host/installer-uninstall-options.test.ts`）与 `/S` 下 create 回调 Abort 的行为间接覆盖，
  未做截图级确认。
