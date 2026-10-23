module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ['dist', 'node_modules', '*.js', '*.cjs'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    // Playwright fixtures are destructured as `({}, use) => ...` when a
    // fixture doesn't depend on any other fixture - this is the documented
    // pattern, not a mistake.
    'no-empty-pattern': 'off',
    // Hard waits are banned: every Playwright action and web-first assertion
    // already waits for what it needs. A fixed sleep is either too short
    // (flaky) or too long (slow) - use an assertion or an auto-waiting action.
    'no-restricted-properties': [
      'error',
      {
        property: 'waitForTimeout',
        message: 'Hard waits are banned - use a web-first assertion (assertions.*) or an auto-waiting action instead.',
      },
    ],
    // 'networkidle' is discouraged by Playwright itself (it never settles on pages that poll or stream).
    'no-restricted-syntax': [
      'error',
      {
        selector: "Literal[value='networkidle']",
        message: "Don't wait for 'networkidle' - wait for the specific element/state you need instead.",
      },
    ],
  },
  overrides: [],
};
