// ESLint 扁平配置（ESLint 9 flat config）
// 规则基调：js recommended + typescript-eslint recommended（未使用变量/类型相关规则）
//           + react-hooks 钩子规则（client 半侧是 React 代码）
// 忽略：构建产物 lib/dist、素材 assets、桌面壳的**生成物** shared-core.js
//       （其余桌面壳源码必须检查——它是纯 JS，tsc 覆盖不到，漏检就是零静态保护）
// scripts/ 不忽略：dist.mjs 是安装包的构建入口，改错这里会产出坏包，必须有检查。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/** Node 全局（ESM 脚本用；手写而非引 globals 包，避免为一个列表加依赖） */
const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  structuredClone: 'readonly',
  // Node 22+ 内置（桌面壳主进程的 bridge 应答与托盘拉配置都用到）
  fetch: 'readonly',
  Response: 'readonly',
  // CJS 模块作用域里的两个名字（ESLint 不把它们算作 Node 全局）
  __dirname: 'readonly',
  __filename: 'readonly',
};

/** 浏览器全局：只有测试里 page.evaluate() 的回调真正在浏览器里跑 */
const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  location: 'readonly',
  innerWidth: 'readonly',
  innerHeight: 'readonly',
  // settings.test.mjs 的 addInitScript 回调在浏览器里改写 navigator.platform
  navigator: 'readonly',
  // 桌面壳的经典 script 顶层 const（runtime/electron-helper/constants.js），
  // page.evaluate() 里可直接引用——这是渲染页的真实全局，不是测试笔误。
  CONFIG: 'readonly',
};

export default tseslint.config(
  // shared-core.js 是 scripts/build-desktop-core.mjs 从 src/shared 生成的产物（.gitignore 已忽略），
  // 不要手改，也不该被 lint 检查。
  { ignores: ['lib/**', 'dist/**', 'assets/**', 'runtime/electron-helper/shared-core.js', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // TS 文件：类型正确性由 tsc 负责，关闭 no-undef（避免 window/fetch 等全局误报）
    files: ['**/*.ts'],
    rules: {
      'no-undef': 'off',
    },
  },
  {
    // client 半侧是 React 代码（hooks + 手写 h() 元素）：
    // rules-of-hooks 强制 hook 调用顺序稳定；exhaustive-deps 提醒 useEffect 依赖遗漏
    files: ['src/client/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // 配置文件本身用的 ESM import，无浏览器代码，no-undef 放开
    files: ['eslint.config.js'],
    rules: {
      'no-undef': 'off',
    },
  },
  {
    // 打包后的 Electron 主进程：Node 环境（process/console 由 Electron 提供），没有浏览器全局。
    // fetch / 定时器是 Node 22+ 的运行时全局（托盘轮询配置、调用本机 HTTP 服务、自启延迟）。
    files: ['desktop/**/*.mjs'],
    languageOptions: {
      globals: {
        ...nodeGlobals,
        fetch: 'readonly',
      },
    },
  },
  {
    // 桌面壳（runtime/electron-helper）：纯 CJS，**不走 tsc**，这里是它唯一的静态检查。
    // 同一个目录里混着两种执行环境，按文件名分开给全局：
    //   主进程（main.js 及其 require 的纯模块）—— Node 侧，另有 __dirname/module/require
    //   渲染进程（constants/renderer/events/sprite）—— 页面里跑，有 window/document
    files: ['runtime/electron-helper/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...nodeGlobals,
        __dirname: 'readonly',
        module: 'writable',
        exports: 'writable',
        require: 'readonly',
      },
    },
    rules: {
      // 这一层就是 CJS（Electron 主进程直接 require），不是待迁移的 ESM
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // 渲染进程侧：经典 script 顺序加载（index.html:192-196），**顶层 const/function 进全局
    // 词法环境供后续文件引用**——所以 constants.js 里的名字对别的文件「未使用」是设计，不是笔误。
    // 同理 sprite.js 定义的 PetSprite 由 renderer.js 使用。关掉 no-unused-vars，只留 no-undef 抓真错。
    files: [
      'runtime/electron-helper/constants.js',
      'runtime/electron-helper/renderer.js',
      'runtime/electron-helper/events.js',
      'runtime/electron-helper/sprite.js',
    ],
    languageOptions: {
      globals: browserGlobals,
    },
    rules: {
      // 跨文件共享的全局（S / VIEW / AREAS / toScreen / PetSprite …）见上面的脚本加载顺序
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      // 本文件顶层的 CONFIG 与 browserGlobals 里的 CONFIG（测试夹具用）是两个东西，同名不是笔误
      'no-redeclare': 'off',
    },
  },
  {
    // 构建/维护脚本：Node ESM，无浏览器全局
    files: ['scripts/**/*.{mjs,js}'],
    languageOptions: {
      globals: nodeGlobals,
    },
    rules: {
      // 发布检查脚本大量使用 `cond ? ok() : fail()` 作语句：这是它的表达方式，不是笔误
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
  {
    // Playwright 测试：page.evaluate() 的回调在浏览器里执行，同时文件自身跑在 Node 里
    files: ['scripts/tests/**/*.{mjs,js}'],
    languageOptions: {
      globals: { ...nodeGlobals, ...browserGlobals },
    },
  },
  {
    // 诊断脚本：独立 CJS 工具（全屏判定探测），Node 环境，不进 npm test
    files: ['tools/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...nodeGlobals, require: 'readonly', module: 'writable', exports: 'writable' },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
