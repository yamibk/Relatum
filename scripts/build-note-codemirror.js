'use strict';

// Maintenance-only offline vendor build. Downloads exactly the existing lock,
// verifies every archive, and runs esbuild in a disposable external directory.
// No npm installation, application dependency tree or package hooks are used.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), zlib = require('node:zlib');
const repo = path.resolve(__dirname, '..');
const vendor = path.join(repo, 'assets/vendor/codemirror');
const lock = JSON.parse(fs.readFileSync(path.join(vendor, 'dependency-lock.json'), 'utf8')).packages;

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-codemirror-build-'));
  const installed = new Map();
  async function install(name) {
    if (installed.has(name)) return installed.get(name);
    const work = (async () => {
      const record = lock['node_modules/' + name];
      if (!record?.resolved || !record.integrity) throw new Error('Missing pinned package: ' + name);
      const response = await fetch(record.resolved);
      if (!response.ok) throw new Error('Download failed: ' + name + ' ' + response.status);
      const archive = Buffer.from(await response.arrayBuffer());
      const [algorithm, expected] = record.integrity.split('-');
      if (crypto.createHash(algorithm).update(archive).digest('base64') !== expected) throw new Error('Integrity mismatch: ' + name);
      const target = path.join(root, 'node_modules', name), tar = zlib.gunzipSync(archive);
      fs.mkdirSync(target, { recursive: true });
      for (let offset = 0; offset + 512 <= tar.length;) {
        const read = (from, length) => tar.toString('utf8', offset + from, offset + from + length).replace(/\0.*$/s, '');
        const file = read(0, 100); if (!file) break;
        const size = parseInt(read(124, 12).trim(), 8) || 0, type = read(156, 1);
        const prefix = read(345, 155), relative = (prefix ? prefix + '/' : '') + file;
        const destination = path.resolve(target, relative.replace(/^package\//, ''));
        if ((type === '0' || !type) && destination.startsWith(target + path.sep)) {
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.writeFileSync(destination, tar.subarray(offset + 512, offset + 512 + size));
        }
        offset += 512 + Math.ceil(size / 512) * 512;
      }
      await Promise.all(Object.keys(record.dependencies || {}).map(install));
    })();
    installed.set(name, work); return work;
  }
  const packages = Object.keys(lock[''].dependencies).filter(name => /^(?:@codemirror\/|@lezer\/|esbuild$)/.test(name));
  const binary = '@esbuild/' + process.platform + '-' + process.arch;
  await Promise.all(packages.concat(binary).map(install));
  const executable = path.join(root, 'node_modules', binary, process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild');
  if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
  process.env.ESBUILD_BINARY_PATH = executable;
  const esbuild = require(path.join(root, 'node_modules/esbuild'));
  let selectionPatched = false;
  await esbuild.build({
    entryPoints: [path.join(vendor, 'relatum-entry.js')],
    outfile: path.join(vendor, 'relatum-codemirror.min.js'),
    bundle: true, minify: true, format: 'iife', globalName: 'RelatumCodeMirror', target: 'es2020',
    nodePaths: [path.join(root, 'node_modules')], legalComments: 'none',
    plugins: [{ name: 'relatum-callout-selection', setup(build) {
      build.onLoad({ filter: /@codemirror[\\/]view[\\/]dist[\\/]index\.js$/ }, args => {
        const original = fs.readFileSync(args.path, 'utf8');
        const needle = 'content.querySelector(".cm-line")';
        if (original.split(needle).length !== 2) throw new Error('Pinned selection patch no longer matches');
        selectionPatched = true;
        return { contents: original.replace(needle, 'content.querySelector(".cm-line:not(.note-live-callout-line)")'), loader: 'js' };
      });
    } }],
  });
  if (!selectionPatched) throw new Error('Selection patch was not applied');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(vendor, 'relatum-codemirror.min.js'))).digest('hex').toUpperCase();
  console.log(JSON.stringify({ sha256: hash, packages: installed.size, buildDirectory: root }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
