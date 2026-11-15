import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const cli = fileURLToPath(new URL('../bin/webpify.ts', import.meta.url));
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'webpify-test-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

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
  const output = sharp(join(directory, name));
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

test.each([
  ['--quality', '0'],
  ['--quality', '101'],
  ['--quality', 'abc'],
  ['--effort', '-1'],
  ['--effort', '10'],
  ['--effort', 'abc'],
  ['--max-res', 'invalid'],
  ['--max-res', '0x10'],
  ['--max-res', '10x20x30'],
])('rejects %s %s before processing files', async (option, value) => {
  await createImage();
  const original = await Bun.file(join(directory, 'image.png')).bytes();
  const result = await runCli(option, value, '--delete');
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(option);
  expect(await readdir(directory)).toEqual(['image.png']);
  expect(await Bun.file(join(directory, 'image.png')).bytes()).toEqual(original);
});
