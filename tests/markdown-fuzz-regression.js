const assert = require('assert');
const path = require('path');
const childProcess = require('child_process');

const worker = path.join(__dirname, 'markdown-fuzz-worker.js');
const result = childProcess.spawnSync(process.execPath, [worker], {
  encoding: 'utf8',
  timeout: 5000,
  maxBuffer: 1024 * 1024,
});

assert.strictEqual(result.error && result.error.code, undefined, result.error && result.error.message);
assert.strictEqual(result.signal, null, `fuzz worker terminated by ${result.signal}`);
assert.strictEqual(result.status, 0, result.stderr || result.stdout);
assert(result.stdout.includes('markdown fuzz worker: ok'));

console.log('markdown fuzz regression: ok');
