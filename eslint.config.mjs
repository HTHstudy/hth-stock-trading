import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import checkFile from 'eslint-plugin-check-file';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

const layers = ['app', 'pages', 'widgets', 'features', 'entities', 'shared'];
const basePatterns = [
  ...['pages', 'widgets', 'features', 'entities'].map((layer) => ({
    group: [`@${layer}/*/*`],
    message: 'Slice의 공개 entrypoint를 사용하세요.',
  })),
  {
    group: ['@shared/api/*/*', '@shared/api/*/*/**', '!@shared/api/*/browser', '!@shared/api/*/server'],
    message: 'API 공개 entrypoint를 사용하세요.',
  },
  {
    group: layers.map((layer) => `../**/${layer}/**`),
    message: '다른 레이어는 레이어별 alias로 접근하세요.',
  },
  { group: ['@hth/*/src/**', '@hth/*/dist/**'], message: '패키지 공개 export를 사용하세요.' },
];

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/*.tsbuildinfo'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    plugins: { import: importPlugin, 'check-file': checkFile },
    settings: {
      'import/resolver': {
        typescript: { project: ['apps/*/tsconfig.json', 'packages/*/tsconfig.json'] },
      },
      'import/parsers': { '@typescript-eslint/parser': ['.ts', '.tsx'] },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      'import/no-default-export': 'error',
      'import/no-cycle': ['error', { maxDepth: Infinity }],
      'check-file/filename-naming-convention': [
        'error',
        { '**/*.{ts,tsx,js,jsx,mjs}': 'KEBAB_CASE' },
        { ignoreMiddleExtensions: true },
      ],
      'no-restricted-imports': ['error', { patterns: basePatterns }],
    },
  },
  {
    files: ['**/*.config.{ts,mjs}', 'eslint.config.mjs'],
    rules: { 'import/no-default-export': 'off' },
  },
  {
    files: ['packages/trading/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...basePatterns,
            {
              group: ['@hth/broker', '@hth/broker/*', '@hth/database', '@hth/database/*', 'node:*'],
              message: '순수 trading 도메인은 broker·DB·Node I/O에 의존하지 않습니다.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...basePatterns,
            {
              group: [
                '@hth/broker',
                '@hth/broker/*',
                '@hth/database',
                '@hth/database/*',
                '@hth/trading',
                '@hth/trading/*',
                'node:*',
              ],
              message: '서버 전용 모듈입니다.',
            },
          ],
        },
      ],
    },
  },
  ...layers.map((layer, index) => ({
    files: [`apps/web/src/${layer}/**/*.{ts,tsx}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...basePatterns,
            {
              group: [
                '@hth/broker',
                '@hth/broker/*',
                '@hth/database',
                '@hth/database/*',
                '@hth/trading',
                '@hth/trading/*',
                'node:*',
              ],
              message: '서버 전용 모듈입니다.',
            },
            ...layers.slice(0, layer === 'shared' ? index : index + 1).map((blocked) => ({
              group: [`@${blocked}`, `@${blocked}/*`],
              message: '레이어 import 방향을 지키고 같은 slice 내부는 상대경로를 사용하세요.',
            })),
          ],
        },
      ],
    },
  })),
  {
    files: ['packages/trading/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...basePatterns,
            {
              group: ['@hth/broker', '@hth/broker/*', '@hth/database', '@hth/database/*'],
              message: '도메인은 I/O와 분리합니다.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
