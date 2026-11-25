import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

const ANY_REASON_PATTERN = /^\s*any:\s*\S+/i;

const opengt2Plugin = {
  rules: {
    'no-uncommented-any': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Disallow explicit `any` unless justified with a `// any: <reason>` comment.',
        },
        schema: [],
        messages: {
          uncommentedAny:
            'Explicit `any` is forbidden without a justification comment (`// any: <reason>`).',
        },
      },
      create(context) {
        const sourceCode = context.sourceCode;
        return {
          TSAnyKeyword(node) {
            const nodeLine = node.loc.start.line;
            const hasReasonComment = sourceCode.getAllComments().some((comment) => {
              if (comment.type !== 'Line') {
                return false;
              }
              const commentLine = comment.loc.end.line;
              if (commentLine !== nodeLine && commentLine !== nodeLine - 1) {
                return false;
              }
              return ANY_REASON_PATTERN.test(comment.value);
            });

            if (!hasReasonComment) {
              context.report({
                node,
                messageId: 'uncommentedAny',
              });
            }
          },
        };
      },
    },
  },
};

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'local_assets/**', 'dumps/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: {
      opengt2: opengt2Plugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'opengt2/no-uncommented-any': 'error',
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(^|/)tests(/|$)',
              message: 'Production code in src/ must never import from tests/.',
            },
          ],
        },
      ],
    },
  },
  prettierConfig,
);
