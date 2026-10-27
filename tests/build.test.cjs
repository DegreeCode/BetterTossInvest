const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const builder = import(pathToFileURL(path.join(root, 'scripts/build.mjs')).href);

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'better-toss-build-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('release assets share metadata, update URLs and the runtime version', async (t) => {
  const { build, readVersion } = await builder;
  const outputDirectory = await temporaryDirectory(t);
  const metadata = (await fs.readFile(path.join(root, 'src/metadata.txt'), 'utf8')).trimEnd() + '\n';
  const version = readVersion(metadata);
  await build({ outputDirectory, tag: `v${version}` });
  const user = await fs.readFile(path.join(outputDirectory, 'BetterTossInvest.user.js'), 'utf8');
  const meta = await fs.readFile(path.join(outputDirectory, 'BetterTossInvest.meta.js'), 'utf8');
  assert.equal(meta, metadata);
  assert.ok(user.startsWith(meta));
  assert.ok(user.includes(`const VERSION = ${JSON.stringify(version)};`));
  assert.match(meta, /^\/\/ @updateURL\s+https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/latest\/download\/BetterTossInvest\.meta\.js$/m);
  assert.match(meta, /^\/\/ @downloadURL\s+https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/latest\/download\/BetterTossInvest\.user\.js$/m);
  assert.deepEqual((await fs.readdir(outputDirectory)).sort(), ['BetterTossInvest.meta.js', 'BetterTossInvest.user.js']);
});

test('build verification rejects missing and stale assets and builds deterministically', async (t) => {
  const { build } = await builder;
  const outputDirectory = await temporaryDirectory(t);
  await assert.rejects(build({ outputDirectory, check: true }), /missing or out of date/);
  await build({ outputDirectory });
  const target = path.join(outputDirectory, 'BetterTossInvest.user.js');
  const first = await fs.readFile(target, 'utf8');
  await build({ outputDirectory });
  assert.equal(await fs.readFile(target, 'utf8'), first);
  await build({ outputDirectory, check: true });
  await fs.appendFile(target, '// edited\n');
  await assert.rejects(build({ outputDirectory, check: true }), /user\.js is missing or out of date/);
  await build({ outputDirectory });
  await fs.appendFile(path.join(outputDirectory, 'BetterTossInvest.meta.js'), '// edited\n');
  await assert.rejects(build({ outputDirectory, check: true }), /meta\.js is missing or out of date/);
});

test('release validation rejects mismatched tags before producing assets', async (t) => {
  const { build, validateReleaseTag } = await builder;
  const directory = await temporaryDirectory(t);
  const outputDirectory = path.join(directory, 'dist');
  validateReleaseTag('v1.2.3', '1.2.3');
  for (const tag of ['1.2.3', 'v1.2.4', 'v1.2.3-beta.1', 'v01.2.3', 'latest', '']) {
    assert.throws(() => validateReleaseTag(tag, '1.2.3'), /does not match/);
  }
  await assert.rejects(build({ outputDirectory, tag: 'invalid' }), /does not match/);
  await assert.rejects(fs.access(outputDirectory), { code: 'ENOENT' });
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/check.mjs'), '--tag', 'invalid'], {
    cwd: directory, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match @version/);
});

test('metadata requires a single canonical stable release version', async () => {
  const { readVersion } = await builder;
  assert.equal(readVersion('// @version 1.2.3\n'), '1.2.3');
  for (const value of ['', '1.2', 'v1.2.3', '01.2.3', '1.2.3-beta.1']) {
    assert.throws(() => readVersion(`// @version ${value}\n`), /one @version/);
  }
  assert.throws(() => readVersion('// @version 1.2.3\n// @version 1.2.4\n'), /one @version/);
});
