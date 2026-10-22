/**
 * installer 契约测试的共享 helper（installer-*.test.ts 共用，不是测试文件）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** 读包根下的文件（调用方位于 src/host/，包根是两级之上） */
export function readPackageFile(relative: string): string {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
}

/** 取 installer.nsh 里某个 !macro 的宏体（到下一个 !macroend 为止） */
export function macroBody(nsh: string, name: string): string {
  const start = nsh.indexOf(`!macro ${name}`);
  assert.ok(start >= 0, `缺少 !macro ${name}`);
  const end = nsh.indexOf('!macroend', start);
  assert.ok(end > start, `!macro ${name} 没有结尾`);
  return nsh.slice(start, end);
}

/** 取 installer.nsh 里某个 Function 的函数体 */
export function functionBody(nsh: string, name: string): string {
  const start = nsh.indexOf(`Function ${name}`);
  assert.ok(start >= 0, `缺少 Function ${name}`);
  const end = nsh.indexOf('FunctionEnd', start);
  assert.ok(end > start, `Function ${name} 没有结尾`);
  return nsh.slice(start, end);
}
