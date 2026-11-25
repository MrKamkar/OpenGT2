import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');

const ALLOWED_XML_NAMESPACE_URLS: readonly string[] = [
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/xml/1998/namespace',
  'http://www.w3.org/2000/xmlns/',
  'http://www.w3.org/1998/math/mathml',
];

const EXTERNAL_URL_PATTERN = /https?:\/\/[^\s"'`<>)}\]]+/gi;

function stripJsComments(source: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'single' | 'double' | 'template' | 'lineComment' | 'blockComment' = 'code';

  while (i < source.length) {
    const ch = source[i] ?? '';
    const next = source[i + 1] ?? '';

    if (mode === 'code') {
      if (ch === '/' && next === '/') {
        mode = 'lineComment';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        mode = 'blockComment';
        i += 2;
        continue;
      }
      if (ch === "'") {
        mode = 'single';
      } else if (ch === '"') {
        mode = 'double';
      } else if (ch === '`') {
        mode = 'template';
      }
      out += ch;
      i += 1;
      continue;
    }

    if (mode === 'lineComment') {
      if (ch === '\n' || ch === '\r') {
        mode = 'code';
        out += ch;
      }
      i += 1;
      continue;
    }

    if (mode === 'blockComment') {
      if (ch === '*' && next === '/') {
        mode = 'code';
        out += ' ';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === '\\' && i + 1 < source.length) {
      out += ch + next;
      i += 2;
      continue;
    }

    if (
      (mode === 'single' && ch === "'") ||
      (mode === 'double' && ch === '"') ||
      (mode === 'template' && ch === '`')
    ) {
      mode = 'code';
    }
    out += ch;
    i += 1;
  }

  return out;
}

function stripCssComments(source: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'single' | 'double' | 'blockComment' = 'code';

  while (i < source.length) {
    const ch = source[i] ?? '';
    const next = source[i + 1] ?? '';

    if (mode === 'code') {
      if (ch === '/' && next === '*') {
        mode = 'blockComment';
        i += 2;
        continue;
      }
      if (ch === "'") {
        mode = 'single';
      } else if (ch === '"') {
        mode = 'double';
      }
      out += ch;
      i += 1;
      continue;
    }

    if (mode === 'blockComment') {
      if (ch === '*' && next === '/') {
        mode = 'code';
        out += ' ';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === '\\' && i + 1 < source.length) {
      out += ch + next;
      i += 2;
      continue;
    }

    if ((mode === 'single' && ch === "'") || (mode === 'double' && ch === '"')) {
      mode = 'code';
    }
    out += ch;
    i += 1;
  }

  return out;
}

function stripCommentsByExtension(source: string, extension: string): string {
  const ext = extension.toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return stripJsComments(source);
  }
  if (ext === '.css') {
    return stripCssComments(source);
  }
  if (ext === '.html' || ext === '.htm' || ext === '.svg' || ext === '.xml') {
    return source.replace(/<!--[\s\S]*?-->/g, ' ');
  }
  return source;
}

function isAllowedXmlNamespace(url: string): boolean {
  const normalized = url.toLowerCase();
  return ALLOWED_XML_NAMESPACE_URLS.includes(normalized);
}

export function findExternalUrls(source: string, extension: string): string[] {
  const cleaned = stripCommentsByExtension(source, extension);
  const matches = cleaned.match(EXTERNAL_URL_PATTERN) ?? [];
  return matches.filter((url) => !isAllowedXmlNamespace(url));
}

async function collectFilesRecursively(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFilesRecursively(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

describe('noindex policy and zero external resources in dist/ (M0.10)', () => {
  beforeAll(async () => {
    await build({
      root: PROJECT_ROOT,
      logLevel: 'silent',
    });
  });

  it('includes <meta name="robots" content="noindex,nofollow"> in dist/index.html', async () => {
    const html = await readFile(path.join(DIST_DIR, 'index.html'), 'utf8');
    expect(html).toMatch(
      /<meta\s+name=["']robots["']\s+content=["']noindex,nofollow["']\s*\/?>/i,
    );
  });

  it('copies public/robots.txt with Disallow: / into dist/robots.txt', async () => {
    const robots = await readFile(path.join(DIST_DIR, 'robots.txt'), 'utf8');
    expect(robots).toMatch(/^User-agent:\s*\*\s*$/m);
    expect(robots).toMatch(/^Disallow:\s*\/\s*$/m);
  });

  it('contains zero external http(s):// URLs in built dist/ assets', async () => {
    const distFiles = await collectFilesRecursively(DIST_DIR);
    expect(distFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const filePath of distFiles) {
      const content = await readFile(filePath, 'utf8');
      const urls = findExternalUrls(content, path.extname(filePath));
      for (const url of urls) {
        const relativePath = path.relative(PROJECT_ROOT, filePath);
        violations.push(`${relativePath}: ${url}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('scanner detects real external URLs while ignoring comments and XML namespaces', () => {
    expect(
      findExternalUrls('const url = "https://cdn.example.com/app.js";', '.js'),
    ).toEqual(['https://cdn.example.com/app.js']);

    expect(
      findExternalUrls(
        '// https://comment.example.com\n/* http://block.example.com */\nconst ns = "http://www.w3.org/2000/svg";',
        '.js',
      ),
    ).toEqual([]);

    expect(
      findExternalUrls(
        '/* https://fonts.example.com/a.css */ body { background: url("https://cdn.example.com/bg.png"); }',
        '.css',
      ),
    ).toEqual(['https://cdn.example.com/bg.png']);

    expect(
      findExternalUrls(
        '<!-- https://comment.example.com --><svg xmlns="http://www.w3.org/2000/svg"></svg><script src="https://evil.example.com/x.js"></script>',
        '.html',
      ),
    ).toEqual(['https://evil.example.com/x.js']);
  });
});
