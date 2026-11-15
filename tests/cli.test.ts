import { afterEach, beforeEach, expect, test } from 'bun:test';
import { appendFile, mkdir, mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const cli = fileURLToPath(new URL('../bin/webpify.ts', import.meta.url));
let directory: string;
let watcher: ReturnType<typeof Bun.spawn> | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'webpify-test-'));
});

afterEach(async () => {
  if (watcher) {
    watcher.kill();
    await watcher.exited;
    watcher = undefined;
  }
  await rm(directory, { recursive: true, force: true });
});

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for watch-mode output');
    await Bun.sleep(50);
  }
}

async function startWatcher(...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, '--watch', '--force', ...args], {
    cwd: directory,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  watcher = child;
  let stdout = '';
  let stderr = '';
  const readStdout = (async () => {
    for await (const chunk of child.stdout) stdout += new TextDecoder().decode(chunk);
  })();
  const readStderr = (async () => {
    for await (const chunk of child.stderr) stderr += new TextDecoder().decode(chunk);
  })();
  await waitFor(async () => stdout.includes('Watching'));
  // The CLI logs before Chokidar is ready. Observe a real conversion instead of
  // assuming the initial scan completes within a fixed startup delay.
  const deadline = Date.now() + 5000;
  while (!(await Bun.file(join(directory, 'probe.webp')).exists())) {
    if (Date.now() >= deadline) throw new Error('Watcher did not become ready');
    await createImage('probe.png');
    await Bun.sleep(500);
  }
  return {
    output: () => stdout,
    async stop() {
      child.kill();
      await child.exited;
      await Promise.all([readStdout, readStderr]);
      watcher = undefined;
      expect(stderr).toBe('');
    },
  };
}

async function createImage(name = 'image.png', width = 40, height = 20) {
  await sharp({
    create: { width, height, channels: 3, background: '#4267ac' },
  }).toFile(join(directory, name));
}

async function runCli(...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: directory,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function expectWebp(name: string, width: number, height: number) {
  // Read fresh bytes so libvips cannot reuse cached data after a watched rewrite.
  const output = sharp(await Bun.file(join(directory, name)).bytes());
  expect(await output.metadata()).toMatchObject({ format: 'webp', width, height });
  // Decode the pixels too: a readable header alone does not prove valid output.
  await output.raw().toBuffer();
}

test('converts PNG and JPEG images without enlarging small inputs', async () => {
  await createImage();
  await createImage('photo.JPG');
  const result = await runCli();
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe('');
  await expectWebp('image.webp', 40, 20);
  await expectWebp('photo.webp', 40, 20);
  expect(await Bun.file(join(directory, 'image.png')).exists()).toBe(true);
});

test('resizes within the requested bounds while preserving aspect ratio', async () => {
  await createImage();
  expect((await runCli('--max-res', '10x10')).stderr).toBe('');
  await expectWebp('image.webp', 10, 5);
});

test('--no-resize preserves dimensions despite a smaller size limit', async () => {
  await createImage();
  expect((await runCli('--max-res', '10x10', '--no-resize')).stderr).toBe('');
  await expectWebp('image.webp', 40, 20);
});

test('--delete removes the original after producing valid output', async () => {
  await createImage();
  expect((await runCli('--delete')).stderr).toBe('');
  await expectWebp('image.webp', 40, 20);
  expect(await Bun.file(join(directory, 'image.png')).exists()).toBe(false);
});

test('--delete preserves an original when conversion fails', async () => {
  const original = 'This is not an image';
  await Bun.write(join(directory, 'broken.png'), original);
  const result = await runCli('--delete');
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('broken.png');
  expect(await Bun.file(join(directory, 'broken.png')).text()).toBe(original);
  expect(await Bun.file(join(directory, 'broken.webp')).exists()).toBe(false);
});

test('skips newer output and replaces it when --force is supplied', async () => {
  await createImage();
  const destination = join(directory, 'image.webp');
  await sharp({
    create: { width: 1, height: 1, channels: 3, background: '#ffffff' },
  }).webp().toFile(destination);
  // Explicit timestamps avoid sleeps and filesystem clock-resolution races.
  await utimes(join(directory, 'image.png'), 1_600_000_000, 1_600_000_000);
  await utimes(destination, 1_600_000_100, 1_600_000_100);
  const before = await Bun.file(destination).bytes();
  const modified = (await stat(destination)).mtimeMs;

  expect((await runCli()).stderr).toBe('');
  expect(await Bun.file(destination).bytes()).toEqual(before);
  expect((await stat(destination)).mtimeMs).toBe(modified);

  expect((await runCli('--force')).stderr).toBe('');
  await expectWebp('image.webp', 40, 20);
});

test('reconverts when the source is newer than the output', async () => {
  await createImage();
  await runCli();
  const destination = join(directory, 'image.webp');
  await utimes(destination, 1_600_000_000, 1_600_000_000);
  await createImage('image.png', 60, 30);
  expect((await runCli()).stderr).toBe('');
  await expectWebp('image.webp', 60, 30);
});

test('only processes nested images with --recursive', async () => {
  await mkdir(join(directory, 'nested'));
  await createImage();
  await createImage('nested/photo.jpeg');
  await Bun.write(join(directory, 'notes.txt'), 'Keep me');

  expect((await runCli()).stderr).toBe('');
  await expectWebp('image.webp', 40, 20);
  expect(await Bun.file(join(directory, 'nested/photo.webp')).exists()).toBe(false);

  expect((await runCli('--recursive')).stderr).toBe('');
  await expectWebp('nested/photo.webp', 40, 20);
  expect(await Bun.file(join(directory, 'notes.txt')).text()).toBe('Keep me');
  expect(await Bun.file(join(directory, 'notes.webp')).exists()).toBe(false);
});

test.each([false, true])('watch mode respects recursive=%s for newly created directories', async (recursive) => {
  const running = await startWatcher(...(recursive ? ['--recursive'] : []));
  await mkdir(join(directory, 'nested'));
  await createImage('nested/photo.jpeg');
  await createImage('top.png');
  await waitFor(async () => running.output().includes('✓ top.png'));
  await expectWebp('top.webp', 40, 20);
  if (recursive) {
    await waitFor(async () => running.output().includes('✓ nested/photo.jpeg'));
    await expectWebp('nested/photo.webp', 40, 20);
  } else {
    await Bun.sleep(700);
    expect(await Bun.file(join(directory, 'nested/photo.webp')).exists()).toBe(false);
  }
  await running.stop();
}, 15000);

test('watch mode handles additions, changes, recreation and chunked writes without output loops', async () => {
  const running = await startWatcher();
  await createImage();
  await waitFor(async () => running.output().includes('✓ image.png'));
  await expectWebp('image.webp', 40, 20);

  await createImage('image.png', 60, 30);
  await waitFor(async () => running.output().split('✓ image.png').length - 1 >= 2);
  await expectWebp('image.webp', 60, 30);

  await rm(join(directory, 'image.png'));
  await Bun.sleep(400);
  await createImage('image.png', 80, 40);
  await waitFor(async () => running.output().split('✓ image.png').length - 1 >= 3);
  await expectWebp('image.webp', 80, 40);

  const image = await sharp({
    create: { width: 40, height: 20, channels: 3, background: '#4267ac' },
  }).png().toBuffer();
  const path = join(directory, 'chunked.png');
  const partSize = Math.ceil(image.length / 8);
  for (let offset = 0; offset < image.length; offset += partSize) {
    await appendFile(path, image.subarray(offset, offset + partSize));
    expect(await Bun.file(join(directory, 'chunked.webp')).exists()).toBe(false);
    await Bun.sleep(100);
  }
  await waitFor(async () => running.output().includes('✓ chunked.png'));
  await expectWebp('chunked.webp', 40, 20);
  const output = running.output();
  await Bun.sleep(700);
  expect(running.output()).toBe(output);
  await running.stop();
}, 15000);

test.each([
  [1, 0],
  [100, 6],
])('accepts quality %i and effort %i at the supported bounds', async (quality, effort) => {
  await createImage();
  const result = await runCli('--quality', String(quality), '--effort', String(effort));
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe('');
  await expectWebp('image.webp', 40, 20);
});

test.each([
  ['--quality', '0'],
  ['--quality', '101'],
  ['--quality', 'abc'],
  ['--quality', '1.5'],
  ['--quality', 'Infinity'],
  ['--effort', '-1'],
  ['--effort', '7'],
  ['--effort', '9'],
  ['--effort', '10'],
  ['--effort', 'abc'],
  ['--effort', '1.5'],
  ['--max-res', 'invalid'],
  ['--max-res', '0x10'],
  ['--max-res', '10x20x30'],
  ['--max-res', '1.5x20'],
  ['--max-res', 'Infinityx20'],
  ['--max-res', '9007199254740992x20'],
])('rejects %s %s before processing files', async (option, value) => {
  await createImage();
  const original = await Bun.file(join(directory, 'image.png')).bytes();
  const result = await runCli(option, value, '--delete');
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(option);
  expect(await readdir(directory)).toEqual(['image.png']);
  expect(await Bun.file(join(directory, 'image.png')).bytes()).toEqual(original);
});

test('--help never converts or deletes images, even with processing flags', async () => {
  await createImage();
  const result = await runCli('--help', '--delete', '--force');
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('Usage:');
  expect(await readdir(directory)).toEqual(['image.png']);
});

test.each([{ args: ['image.png'] }, { args: ['--qualty', '90'] }, { args: ['--quality'] }])(
  'rejects unsupported arguments before touching files: %j',
  async ({ args }) => {
    await createImage();
    const result = await runCli(...args, '--delete');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Error:');
    expect(await readdir(directory)).toEqual(['image.png']);
  },
);

test('rejects colliding destinations without overwriting output or deleting sources', async () => {
  await createImage('photo.png');
  await createImage('photo.jpg');
  await Bun.write(join(directory, 'photo.webp'), 'existing output');
  const result = await runCli('--delete', '--force');
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('collision');
  expect(await Bun.file(join(directory, 'photo.webp')).text()).toBe('existing output');
  expect(await Bun.file(join(directory, 'photo.png')).exists()).toBe(true);
  expect(await Bun.file(join(directory, 'photo.jpg')).exists()).toBe(true);
});

test('applies EXIF orientation before resizing and stripping metadata', async () => {
  await sharp({
    create: { width: 40, height: 20, channels: 3, background: '#4267ac' },
  }).withMetadata({ orientation: 6 }).jpeg().toFile(join(directory, 'portrait.jpg'));
  expect((await runCli('--max-res', '10x30')).exitCode).toBe(0);
  await expectWebp('portrait.webp', 10, 20);
  expect((await sharp(join(directory, 'portrait.webp')).metadata()).orientation).toBeUndefined();
});

test('finishes valid conversions but exits unsuccessfully for a partial failure', async () => {
  await createImage();
  await Bun.write(join(directory, 'broken.png'), 'not an image');
  const result = await runCli();
  expect(result.exitCode).toBe(1);
  await expectWebp('image.webp', 40, 20);
  expect(result.stderr).toContain('broken.png');
});

test('case-only basenames follow the actual filesystem case sensitivity', async () => {
  await createImage('photo.png');
  await createImage('PHOTO.jpg');
  const caseInsensitive = await Bun.file(join(directory, 'PHOTO.png')).exists();
  const result = await runCli('--force', '--delete');
  if (caseInsensitive) {
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('collision');
    expect(await Bun.file(join(directory, 'photo.png')).exists()).toBe(true);
    expect(await Bun.file(join(directory, 'PHOTO.jpg')).exists()).toBe(true);
    expect(await Bun.file(join(directory, 'photo.webp')).exists()).toBe(false);
  } else {
    expect(result.exitCode).toBe(0);
    await expectWebp('photo.webp', 40, 20);
    await expectWebp('PHOTO.webp', 40, 20);
  }
});

test('a source arriving during encoding preserves both originals and existing output', async () => {
  await createImage('photo.png');
  await Bun.write(join(directory, 'photo.webp'), 'existing output');
  // Pause after the real encoder finishes, before the CLI can publish or delete.
  // This makes the filesystem race deterministic without timing a large image.
  const preload = join(directory, 'pause-encoder.ts');
  await Bun.write(preload, `
    import sharp from ${JSON.stringify(import.meta.resolve('sharp'))};
    const original = sharp.prototype.toFile;
    sharp.prototype.toFile = async function (...args) {
      const result = await original.apply(this, args);
      await Bun.write('encoded', 'ready');
      while (!(await Bun.file('release').exists())) await Bun.sleep(10);
      return result;
    };
  `);
  const child = Bun.spawn([process.execPath, '--preload', preload, cli, '--force', '--delete'], {
    cwd: directory, stdout: 'pipe', stderr: 'pipe',
  });
  watcher = child;
  await waitFor(() => Bun.file(join(directory, 'encoded')).exists());
  await createImage('photo.jpg');
  await Bun.write(join(directory, 'release'), 'go');
  expect(await child.exited).toBe(1);
  watcher = undefined;
  expect(await new Response(child.stderr).text()).toContain('collision');
  expect(await Bun.file(join(directory, 'photo.webp')).text()).toBe('existing output');
  expect(await Bun.file(join(directory, 'photo.png')).exists()).toBe(true);
  expect(await Bun.file(join(directory, 'photo.jpg')).exists()).toBe(true);
  expect((await readdir(directory)).some((name) => name.startsWith('.webpify-'))).toBe(false);
});

test('case-insensitive lookup detects collisions before writing or deleting', async () => {
  await createImage('photo.png');
  await createImage('PHOTO.jpg');
  await Bun.write(join(directory, 'photo.webp'), 'existing output');
  const preload = join(directory, 'case-insensitive.ts');
  // Emulate only read-side path lookup. A correct preflight never reaches writes.
  await Bun.write(preload, `
    import { mock } from 'bun:test';
    import * as fs from 'node:fs/promises';
    import { dirname, basename, join } from 'node:path';
    const original = { ...fs };
    async function lookup(path) {
      const names = await original.readdir(dirname(path));
      const name = names.find(name => name.toLowerCase() === basename(path).toLowerCase());
      return name ? join(dirname(path), name) : path;
    }
    mock.module('node:fs/promises', () => ({
      ...original,
      stat: async path => original.stat(await lookup(path)),
      realpath: async path => original.realpath(await lookup(path)),
    }));
  `);
  const child = Bun.spawn([process.execPath, '--preload', preload, cli, '--force', '--delete'], {
    cwd: directory, stdout: 'pipe', stderr: 'pipe',
  });
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toContain('collision');
  expect(await Bun.file(join(directory, 'photo.webp')).text()).toBe('existing output');
  expect(await Bun.file(join(directory, 'photo.png')).exists()).toBe(true);
  expect(await Bun.file(join(directory, 'PHOTO.jpg')).exists()).toBe(true);
});
