// ESLint 扁平配置（ESLint 9 flat config）
// 规则基调：js recommended + typescript-eslint recommended（未使用变量/类型相关规则）
//           + react-hooks 钩子规则（client 半侧是 React 代码）
// 忽略：构建产物 lib/dist、素材 assets、桌面壳 runtime（类型正确性交给 tsc，
//       因此 TS 文件关闭 no-undef，避免 window/fetch 等全局误报）
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
};

/** 浏览器全局：只有测试里 page.evaluate() 的回调真正在浏览器里跑 */
const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  location: 'readonly',
  innerWidth: 'readonly',
  innerHeight: 'readonly',
  // 桌面壳的经典 script 顶层 const（runtime/electron-helper/constants.js），
  // page.evaluate() 里可直接引用——这是渲染页的真实全局，不是测试笔误。
  CONFIG: 'readonly',
};

export default tseslint.config(
  { ignores: ['lib/**', 'dist/**', 'assets/**', 'runtime/**', 'node_modules/**'] },
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
);
