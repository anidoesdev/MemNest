import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(root, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const IMPORT = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
const ALLOWED = new Set(['@memnest/core', 'd3-force', 'd3-quadtree']);

describe('rule 2: ui-core imports no framework and touches no DOM', () => {
  it('imports only relative modules, core and the layout libraries', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
        const specifier = match[1] ?? match[2] ?? match[3]!;
        if (!specifier.startsWith('.') && !ALLOWED.has(specifier)) offenders.push(`${relative(root, file)} → ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('does not reach for DOM, framework or I/O globals', () => {
    // Global uses only: `document.x`, not a property or variable named document.
    const forbidden = /(?<![.\w$])(?:document|window|navigator|localStorage|sessionStorage|process|React)\s*\.|\b(?:HTMLElement|HTMLCanvasElement|requestAnimationFrame|XMLHttpRequest|Vue)\b|(?<![.\w$])fetch\s*\(/;
    const offenders = sourceFiles(srcDir)
      .filter((file) => !file.endsWith('.d.ts'))
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((line, i) => ({ line: line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, ''), at: `${relative(root, file)}:${i + 1}` }))
          .filter(({ line }) => forbidden.test(line))
          .map(({ at, line }) => `${at}: ${line.trim()}`),
      );
    expect(offenders).toEqual([]);
  });

  it('bundles its ESM-only layout libraries instead of depending on them at runtime', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies)).toEqual(['@memnest/core']);
  });
});
