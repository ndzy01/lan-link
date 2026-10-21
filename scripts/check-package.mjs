import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Verify the shipped archive from outside this repo and its workspace resolution.
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'lan-link-package-'));
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' });
try {
  const archive = join(temp, 'lan-link.tgz');
  run('pnpm', ['pack', '--out', archive], root);
  const consumer = join(temp, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({
    name: 'lan-link-package-consumer', version: '0.0.0', private: true, type: 'module',
    dependencies: { 'lan-link': `file:${archive}` },
  }));
  run('pnpm', ['install', '--ignore-scripts', '--ignore-workspace'], consumer);
  await writeFile(join(consumer, 'check.mjs'), `
    import assert from 'node:assert/strict';
    import { createHost, joinRoom } from 'lan-link';
    import { QrScanner, decodeQrImage } from 'lan-link/scanner';
    for (const value of [createHost, joinRoom, QrScanner, decodeQrImage]) {
      assert.equal(typeof value, 'function');
    }
  `);
  run(process.execPath, ['check.mjs'], consumer);
  await writeFile(join(consumer, 'check.ts'), `
    import { createHost, joinRoom, type LanRoom, type IncomingStream } from 'lan-link';
    import { QrScanner, decodeQrImage } from 'lan-link/scanner';
    const host: LanRoom = createHost();
    host.on('stream', (incoming: IncomingStream) => { void incoming.stream; });
    void [joinRoom, QrScanner, decodeQrImage];
    host.close();
  `);
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
    '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM,DOM.Iterable',
    'check.ts'], consumer);
  const pkg = JSON.parse(await readFile(join(consumer, 'node_modules/lan-link/package.json'), 'utf8'));
  assert.equal(pkg.name, 'lan-link');
  for (const entry of Object.values(pkg.exports)) {
    assert.match(entry.import, /^\.\/dist\/.*\.js$/);
    assert.match(entry.types, /^\.\/dist\/.*\.d\.ts$/);
  }
  console.log('Packed ESM and declaration entry points passed in an independent consumer.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
