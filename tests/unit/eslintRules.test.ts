import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

const eslint = new ESLint();

async function lintRuleIds(code: string, filePath: string): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath });
  return results.flatMap((result) =>
    result.messages.map((message) => message.ruleId ?? 'unknown'),
  );
}

describe('ESLint project rules (M0.3)', () => {
  it('blocks imports from tests/** inside src/**', async () => {
    const relativeFixture = await lintRuleIds(
      "import { helper } from '../tests/fixtures/helper';\nexport const v = helper;\n",
      'src/app/sample.ts',
    );
    expect(relativeFixture).toContain('no-restricted-imports');

    const nestedTypeImport = await lintRuleIds(
      "import type { Fixture } from '../../../tests/fixtures/types';\nexport type T = Fixture;\n",
      'src/formats/vol/sample.ts',
    );
    expect(nestedTypeImport).toContain('no-restricted-imports');
  });

  it('allows normal imports in src/** and importing src/** from tests/**', async () => {
    const srcImport = await lintRuleIds(
      "import { createHealthWorker } from './workers/createHealthWorker';\nexport const fn = createHealthWorker;\n",
      'src/sample.ts',
    );
    expect(srcImport).toEqual([]);

    const testImport = await lintRuleIds(
      "import { createHealthPong } from '../../src/workers/health.worker';\nexport const fn = createHealthPong;\n",
      'tests/unit/sample.test.ts',
    );
    expect(testImport).toEqual([]);
  });

  it('blocks explicit any without a `// any: <reason>` comment', async () => {
    const bareAny = await lintRuleIds('export const value: any = 1;\n', 'src/sample.ts');
    expect(bareAny).toContain('opengt2/no-uncommented-any');

    const emptyReason = await lintRuleIds(
      'export const value: any = 1; // any:\n',
      'src/sample.ts',
    );
    expect(emptyReason).toContain('opengt2/no-uncommented-any');
  });

  it('allows explicit any when accompanied by a `// any: <reason>` comment', async () => {
    const sameLine = await lintRuleIds(
      'export const value: any = 1; // any: justified interop shim\n',
      'src/sample.ts',
    );
    expect(sameLine).toEqual([]);

    const previousLine = await lintRuleIds(
      '// any: justified interop shim\nexport const value: any = 1;\n',
      'src/sample.ts',
    );
    expect(previousLine).toEqual([]);
  });
});
