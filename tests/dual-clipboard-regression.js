'use strict';

const assert = require('assert');
const clipboard = require('../assets/dual-clipboard.js');

class Transfer {
  constructor() { this.values = new Map(); }
  setData(type, value) { this.values.set(type, String(value)); }
  getData(type) { return this.values.get(type) || ''; }
}

const payload = {
  nodes: [
    { id: 'a', kind: 'card', text: 'Heading', body: 'Body' },
    { id: 'b', kind: 'table', text: 'Numbers', body: '| A | B |' },
  ],
};
const token = clipboard.createToken();
assert.strictEqual(typeof token, 'string');
assert(token.length >= 16);
assert(clipboard.plainText(payload).includes('Heading'));
assert(clipboard.plainText(payload).includes('| A | B |'));

const direct = new Transfer();
clipboard.write(direct, token, clipboard.plainText(payload));
assert.strictEqual(direct.getData('text/plain').includes('Body'), true);
assert.strictEqual(clipboard.readToken(direct), token);

const htmlFallback = new Transfer();
htmlFallback.setData('text/html', direct.getData('text/html'));
assert.strictEqual(clipboard.readToken(htmlFallback), token);

const unrelated = new Transfer();
unrelated.setData('text/plain', 'ordinary text');
assert.strictEqual(clipboard.readToken(unrelated), '');

console.log('dual clipboard regression tests passed');
