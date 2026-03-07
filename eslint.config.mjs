import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    // Base recommended rules
    eslint.configs.recommended,

    // TypeScript recommended rules (type-aware)
    ...tseslint.configs.recommendedTypeChecked,

    // TypeScript project config
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },

    // Custom rule overrides
    {
        rules: {
            // Allow unused vars with _ prefix (common pattern for intentionally ignored params)
            '@typescript-eslint/no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
            }],

            // Allow require() — needed for minecraft-data dynamic loading
            '@typescript-eslint/no-require-imports': 'off',

            // Allow floating promises with void — we use this pattern extensively
            '@typescript-eslint/no-floating-promises': ['error', {
                ignoreVoid: true,
            }],

            // Don't force awaiting everything — some fire-and-forget is intentional
            '@typescript-eslint/no-misused-promises': ['error', {
                checksVoidReturn: false,
            }],

            // Allow explicit any in specific cases (mineflayer types aren't always available)
            '@typescript-eslint/no-explicit-any': 'warn',

            // Allow unsafe member access — mineflayer & minecraft-data use dynamic objects
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-return': 'off',

            // Allow empty catch blocks (we use them for "best effort" patterns)
            'no-empty': ['error', { allowEmptyCatch: true }],
            '@typescript-eslint/no-empty-function': 'off',

            // Restrict console to warn/error in renderer, allow in main process
            'no-console': 'off',
        },
    },

    // Ignore output directories
    {
        ignores: [
            'out/**',
            'dist/**',
            'release/**',
            'node_modules/**',
            '*.config.js',
            '*.config.ts',
        ],
    },
);
