import eslint from '@eslint/js';
import security from 'eslint-plugin-security';
import tseslint from 'typescript-eslint';

const typedFiles = ['src/**/*.ts', 'tests/**/*.ts'];
const strictFiles = ['src/runtime/shift-left-validation.ts', 'tests/runtime-shift-left.test.ts'];
const securityRules = {
  'security/detect-eval-with-expression': 'error',
  'security/detect-new-buffer': 'error',
  'no-eval': 'error',
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.tmp/**',
      '**/.worktrees/**',
      '**/_codex_worktrees/**',
      '**/_codex_tmp/**',
      '**/coverage/**',
      'tests/fixtures/**/*.mjs',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: typedFiles })),
  {
    files: typedFiles,
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin, security },
    rules: {
      ...securityRules,
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-constant-condition': 'off',
      'no-control-regex': 'off',
      'no-unsafe-finally': 'off',
      'no-useless-escape': 'off',
    },
  },
  ...tseslint.configs.strictTypeChecked.map((config) => ({ ...config, files: strictFiles })),
  {
    files: strictFiles,
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin, security },
    rules: {
      ...securityRules,
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-deprecated': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
);
