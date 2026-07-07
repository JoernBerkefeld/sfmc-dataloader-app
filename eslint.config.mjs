import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import jsdoc from 'eslint-plugin-jsdoc';
import js from '@eslint/js';

/** Flat ESLint config — aligned with `.cursor/rules/new-subproject-setup.mdc`. */
export default [
    {
        ignores: [
            '**/node_modules/**',
            '**/dist/**',
            '**/out/**',
            '**/release/**',
            '**/coverage/**',
        ],
    },
    js.configs.recommended,
    eslintPluginPrettierRecommended,
    jsdoc.configs['flat/recommended'],
    eslintPluginUnicorn.configs['recommended'],
    {
        languageOptions: {
            globals: {
                ...globals.nodeBuiltin,
                Atomics: 'readonly',
                SharedArrayBuffer: 'readonly',
            },
            ecmaVersion: 2024,
            sourceType: 'module',
        },
        settings: {
            jsdoc: {
                mode: 'typescript',
                preferredTypes: {
                    array: 'Array',
                    'array.<>': '[]',
                    'Array.<>': '[]',
                    'array<>': '[]',
                    'Array<>': '[]',
                    Object: 'object',
                    'object.<>': 'Object.<>',
                    'object<>': 'Object.<>',
                    'Object<>': 'Object.<>',
                    set: 'Set',
                    'set.<>': 'Set.<>',
                    'set<>': 'Set.<>',
                    'Set<>': 'Set.<>',
                    promise: 'Promise',
                    'promise.<>': 'Promise.<>',
                    'promise<>': 'Promise.<>',
                    'Promise<>': 'Promise.<>',
                },
            },
        },
        rules: {
            'logical-assignment-operators': ['error', 'always'],
            'unicorn/catch-error-name': ['error', { name: 'ex' }],
            'no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
            'arrow-body-style': ['error', 'as-needed'],
            curly: 'error',
            'no-console': 'off',
            'jsdoc/check-line-alignment': 2,
            'jsdoc/require-jsdoc': 'off',
            'jsdoc/require-param-type': 'off',
            'jsdoc/tag-lines': ['warn', 'any', { startLines: 1 }],
            'jsdoc/no-undefined-types': 'off',
            'jsdoc/valid-types': 'off',
            'jsdoc/require-param-description': 'off',
            'jsdoc/require-returns': 'off',
            'jsdoc/require-returns-description': 'off',
            'jsdoc/require-property-description': 'off',
            'jsdoc/reject-any-type': 'off',
            'jsdoc/reject-function-type': 'off',
            'spaced-comment': [
                'warn',
                'always',
                {
                    block: {
                        exceptions: ['*'],
                        balanced: true,
                    },
                },
            ],
            'no-var': 'error',
            'prefer-const': 'error',
            'prettier/prettier': 'warn',
            'prefer-arrow-callback': 'warn',
        },
    },
    {
        // Electron main + preload + shared constants + tests run in a CommonJS Node context.
        files: ['src/main/**/*.js', 'src/preload/**/*.js', 'src/shared/**/*.js', 'test/**/*.js'],
        languageOptions: {
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
        rules: {
            // CommonJS entry points cannot use top-level await.
            'unicorn/prefer-top-level-await': 'off',
            // These files run as CommonJS (package.json "type": "commonjs"); require/module are intentional.
            'unicorn/prefer-module': 'off',
        },
    },
    {
        // Renderer runs in the browser (sandboxed), talking to the exposed bridge only.
        files: ['src/renderer/**/*.js'],
        languageOptions: {
            sourceType: 'script',
            globals: { ...globals.browser },
        },
        rules: {
            'unicorn/prefer-top-level-await': 'off',
            // Sandboxed classic browser scripts — no ESM module system available.
            'unicorn/prefer-module': 'off',
        },
    },
];
