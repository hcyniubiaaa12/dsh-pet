/**
 * 数据目录跟随 DSH_HOME 的契约（ticket 03）。
 *
 * 安装侧（customInstall）与卸载侧（customUnInstall）必须共用同一个
 * dshPetDataDir 宏计算 <DSH_HOME>，与应用侧 src/host/storage-paths.ts 同口径；
 * 脚本里不允许再有写死的 $PROFILE\.dsh（宏体内部那处回落除外）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const nsh = readFileSync(new URL('../../build/installer.nsh', import.meta.url), 'utf8');

/** 取某个 !macro 的宏体（到下一个 !macroend 为止） */
function macroBody(name: string): string {
  const start = nsh.indexOf(`!macro ${name}`);
  assert.ok(start >= 0, `缺少 !macro ${name}`);
  const end = nsh.indexOf('!macroend', start);
  assert.ok(end > start, `!macro ${name} 没有结尾`);
  return nsh.slice(start, end);
}

describe('数据目录 —— 安装侧与卸载侧同走 dshPetDataDir', () => {
  test('customInstall 也走 dshPetDataDir 宏', () => {
    const install = macroBody('customInstall');
    assert.match(install, /!insertmacro\s+dshPetDataDir/, '安装段必须复用数据目录宏');
  });

  test('DSH_HOME 的读取发生在回落默认路径之前（宏体内顺序）', () => {
    const macro = macroBody('dshPetDataDir');
    const readAt = macro.search(/ReadEnvStr\s+\S+\s+"DSH_HOME"/);
    const fallbackAt = macro.indexOf('$PROFILE\\.dsh');
    assert.ok(readAt >= 0, '宏体必须先读 DSH_HOME');
    assert.ok(fallbackAt > 0, '宏体必须有回落默认路径');
    assert.ok(readAt < fallbackAt, 'ReadEnvStr 必须出现在回落之前：先认自定义目录，才谈默认');
  });

  test('除 dshPetDataDir 宏体外，脚本代码里不再有写死的 $PROFILE\\.dsh', () => {
    const macro = macroBody('dshPetDataDir');
    // 注释里的提法不算「写死的路径」——钉的是代码行，不钉文档措辞
    const code = nsh
      .split('\n')
      .filter((line) => !line.trimStart().startsWith(';'))
      .join('\n')
      .replace(macro, '');
    assert.ok(!code.includes('$PROFILE\\.dsh'), '宏体之外的代码不得出现写死的 $PROFILE\\.dsh，两侧路径算法只维护一处');
  });
});
