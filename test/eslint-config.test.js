'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ESLint } = require('eslint');

const cwd = path.resolve(__dirname, '..');
const filePath = path.join(cwd, 'src/shared/jsdoc-regression.js');

test('ESLint disables the Unicorn rule that removes JSDoc asterisk prefixes', async () => {
    const eslint = new ESLint({ cwd });
    const config = await eslint.calculateConfigForFile(filePath);

    assert.equal(config.rules['unicorn/no-asterisk-prefix-in-documentation-comments'][0], 0);
});

test('ESLint autofix preserves representative starred multiline JSDoc', async () => {
    const eslint = new ESLint({ cwd, fix: true });
    const documentation = [
        '/**',
        ' * Return the supplied value.',
        ' *',
        ' * @param {string} value - Value to return.',
        ' * @returns {string} The supplied value.',
        ' */',
    ].join('\n');
    const source = `${documentation}\nmodule.exports = function identity(value) {\n    return value;\n};\n`;
    const [result] = await eslint.lintText(source, { filePath });

    assert.equal(result.errorCount, 0);
    assert.equal(result.warningCount, 0);
    assert.ok((result.output ?? source).includes(documentation));
});
