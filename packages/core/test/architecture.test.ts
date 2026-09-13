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

describe('rule 1: core imports nothing that touches a socket or a disk', () => {
  it('has zero runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });

  it('only imports relative modules', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(IMPORT)) {
        const specifier = match[1] ?? match[2] ?? match[3]!;
        if (!specifier.startsWith('.')) offenders.push(`${relative(root, file)} → ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('does not reach for I/O globals', () => {
    const forbidden = /\b(fetch|XMLHttpRequest|WebSocket|process\.|Buffer\.|require\(|Date\.now\(\))/;
    const offenders = sourceFiles(srcDir)
      .filter((file) => !file.endsWith('.d.ts'))
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((line, i) => ({ line: line.replace(/\/\/.*$/, ''), at: `${relative(root, file)}:${i + 1}` }))
          .filter(({ line }) => forbidden.test(line))
          .map(({ at, line }) => `${at}: ${line.trim()}`),
      );
    expect(offenders).toEqual([]);
  });
});
