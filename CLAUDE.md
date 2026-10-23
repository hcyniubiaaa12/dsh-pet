# dsh-pet

桌面宠物：DSH（DeepSeek Harness）的 Cordis 插件，同时可作为独立应用在桌面上运行。

## 架构导航

同一个 npm 包里有三层，改动前先确认自己在哪一层：

- **宿主半边**（`dsh-pet/src/host/`）—— 挂在 DSH 进程里，注册 `/dsh-pet-7340` 路由，负责拉起桌面壳
- **桌面壳**（`dsh-pet/runtime/electron-helper/`）—— 一个被 `electron.exe main.js` 直接拉起的裸脚本，每只宠物一个透明置顶小窗，经 bridge 管道与宿主通信。**纯 CJS，不走 tsc 也不受 lint 规则约束**（只过 `js.recommended`）；它的行为契约由 `src/host/*.test.ts` 里读源码做正则断言的守卫钉住——改 `main.js` 前先扫一眼那些测试
- **独立模式**（`dsh-pet/src/standalone/`）—— 用伪 Cordis ctx 直接跑宿主外边，起本机 HTTP 服务，不需要 DSH

浏览器半边（`src/client/`）只在前两层都存在时才工作。

## 构建与验证

所有命令都在 `dsh-pet/` 目录下执行（包根在那里，不在仓库根）。

依赖用 **pnpm** 安装（有 `pnpm-lock.yaml`）。**先装依赖再跑任何检查**，否则 `npm test` 会因 `ERR_MODULE_NOT_FOUND` 全红、`typecheck` 找不到 `tsc`。

验证命令见 `dsh-pet/package.json` 的 `scripts`；CI 在 `.github/workflows/check.yml` 里跑同样的四项（typecheck / test / lint / format:check）。

本地提交前跑快检查（typecheck / lint / format:check，不含 test）：已配置 `git config core.hooksPath .githooks`，脚本在 `.githooks/pre-commit`。CI 只对 `dsh-pet/**` 的改动触发——改仓库根的文件（README、`docs/`）不会被 CI 检查，这类改动要自己跑 `pnpm run format:check`。

## 安装器

改 `electron-builder.yml`、`build/installer.nsh`、`scripts/dist.mjs` 或任何 MSI/NSIS 行为之前，先读 **`docs/installer.md`** —— 那里记着「读第三方源码才能确认、改错会静默出坏包」的约定（msiwrapped 模板不可覆盖、`customUninstallPage` 插在执行之后、ICE64 抑制、数据目录清单），以及结论对应的 electron-builder 版本。

## Agent skills

### Issue tracker

本仓库用**本地 Markdown** 追踪 issue 与 spec，文件放在 `.scratch/<feature>/` 下，不依赖 `gh` / `glab`。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用五个规范化标签，标签字符串与角色名一致：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。详见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文（single-context）布局：仓库根 `GLOSSARY.md` + `docs/adr/`，**两者都可能尚不存在**——不存在时静默跳过，不要建议先创建。详见 `docs/agents/domain.md`。
