#!/usr/bin/env bun

import sharp from 'sharp';
import { watch as chokidarWatch } from 'chokidar';
import { mkdtemp, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import { Glob } from 'bun';
import { dirname, join, resolve } from 'node:path';
import { cac } from 'cac';
import prettyBytes from 'pretty-bytes';


// ── Types ────────────────────────────────────────────────────────────────────

interface Opts {
  quality: number;
  effort: number;
  maxW: number;
  maxH: number;
  resize: boolean;
  del: boolean;
  recursive: boolean;
  watch: boolean;
  force: boolean;
}

// ── CLI parsing ──────────────────────────────────────────────────────────────

function parseOpts(): Opts {
  const cli = cac('webpify');

  cli
    .option('-q, --quality <num>', 'WebP quality 1–100', { default: 80 })
    .option('-e, --effort <num>', 'Compression effort 0–6', { default: 6 })
    .option('-m, --max-res <WxH>', 'Max resolution', { default: '1920x1080' })
    .option('--no-resize', 'Preserve original dimensions')
    .option('-d, --delete', 'Delete originals after conversion')
    .option('-r, --recursive', 'Also process subdirectories')
    .option('-w, --watch', 'Watch for new/changed files')
    .option('-f, --force', 'Re-convert even if output is newer (use after changing settings)');

  cli.usage('[options]');
  cli.help((sections) => [
    { body: 'Convert PNG/JPEG files in the current directory to sibling .webp files.\nOriginals are kept unless --delete is supplied. By default, images fit within 1920x1080 without enlargement.' },
    ...sections,
    { title: 'Examples', body: '  webpify\n  webpify --recursive\n  webpify --quality 90 --force\n  webpify --no-resize' },
  ]);

  const parsed = cli.parse();
  const options = parsed.options;
  // CAC prints help but does not terminate execution.
  if (options.help) process.exit(0);
  // Validation: Quality & Effort
  if (!Number.isInteger(options.quality) || options.quality < 1 || options.quality > 100) {
    console.error('Error: --quality must be an integer from 1–100');
    process.exit(1);
  }
  if (!Number.isInteger(options.effort) || options.effort < 0 || options.effort > 6) {
    console.error('Error: --effort must be an integer from 0–6');
    process.exit(1);
  }

  // Validation: Max Resolution (WxH)
  const resolution = String(options.maxRes);
  const [w, h] = resolution.split(/x/i).map(Number);
  if (
    !/^\d+x\d+$/i.test(resolution) || !w || !h ||
    !Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w <= 0 || h <= 0
  ) {
    console.error('Error: --max-res expects WxH, e.g. 1920x1080');
    process.exit(1);
  }

  try {
    cli.globalCommand.checkUnknownOptions();
    cli.globalCommand.checkOptionValue();
    if (parsed.args.length > 0) {
      throw new Error('File and directory arguments are not supported. Run webpify inside the target directory.');
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  return {
    quality: options.quality,
    effort: options.effort,
    maxW: w,
    maxH: h,
    resize: options.resize, // cac sets this to false if --no-resize is passed
    del: Boolean(options.delete),
    recursive: Boolean(options.recursive),
    watch: Boolean(options.watch),
    force: Boolean(options.force),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDestPath(src: string): string {
  return src.replace(/\.(png|jpe?g)$/i, '.webp');
}

async function isUpToDate(src: string, dest: string): Promise<boolean> {
  const destFile = Bun.file(dest);
  if (!(await destFile.exists())) return false;
  return destFile.lastModified >= Bun.file(src).lastModified;
}

// Probe supported extension spellings through the filesystem itself. This respects
// case-insensitive volumes without rejecting distinct names on case-sensitive ones.
const extensions = ['png', 'jpg', 'jpeg'].flatMap((extension) =>
  [...extension].reduce<string[]>((variants, letter) =>
    variants.flatMap((prefix) => [prefix + letter, prefix + letter.toUpperCase()]), ['']));

async function assertUnambiguous(src: string): Promise<void> {
  const stem = src.replace(/\.(png|jpe?g)$/i, '');
  const matches = await Promise.all(extensions.map(async (extension) => {
    const candidate = `${stem}.${extension}`;
    try {
      if (!(await stat(candidate)).isFile()) return undefined;
      return await realpath(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }));
  if (new Set(matches.filter((path) => path !== undefined)).size > 1) {
    throw new Error(`Output collision for ${getDestPath(src)}. Rename the sources first.`);
  }
}

// Lowercasing here only serializes work; collision decisions still use the
// filesystem. Distinct case-sensitive destinations remain supported.
const pending = new Map<string, Promise<void>>();

async function convert(src: string, opts: Opts, preflightChecked = false): Promise<void> {
  const key = resolve(getDestPath(src)).toLowerCase();
  const previous = pending.get(key) ?? Promise.resolve();
  const current = previous.then(() => convertOne(src, opts, preflightChecked));
  pending.set(key, current);
  try {
    await current;
  } finally {
    if (pending.get(key) === current) pending.delete(key);
  }
}

// ── Convert a single file ────────────────────────────────────────────────────

async function convertOne(src: string, opts: Opts, preflightChecked: boolean): Promise<void> {
  const dest = getDestPath(src);

  let temporary: string | undefined;
  try {
    if (!preflightChecked) await assertUnambiguous(src);
    if (!opts.force && (await isUpToDate(src, dest))) return;

    let pipeline = sharp(src).autoOrient();

    if (opts.resize) {
      pipeline = pipeline.resize({
        width: opts.maxW,
        height: opts.maxH,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    temporary = await mkdtemp(join(dirname(src), '.webpify-'));
    const output = join(temporary, 'output.webp');
    const info = await pipeline
      .webp({ quality: opts.quality, effort: opts.effort, smartSubsample: true })
      .toFile(output);

    await assertUnambiguous(src);
    await rename(output, dest);

    const srcSize = Bun.file(src).size;
    const pct     = Math.round((1 - info.size / srcSize) * 100);

    console.log(
      `  ✓ ${src}  ${prettyBytes(srcSize)} → ${prettyBytes(info.size)}  (${Math.abs(pct)}% ${pct < 0 ? 'larger' : 'smaller'})`,
    );

    if (opts.del) await unlink(src);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${src}  ${msg}`);
    process.exitCode = 1;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

// ── Utils ─────────────────────────────────────────────────────────────────────

const imageGlob = new Glob('**/*.{png,jpg,jpeg,PNG,JPG,JPEG}');

// ── Batch: process existing files ────────────────────────────────────────────

async function collectFiles(recursive: boolean): Promise<string[]> {
  if (recursive) {
    const files: string[] = [];
    for await (const entry of imageGlob.scan(".")) {
      files.push(entry);
    }
    return files;
  }

  const entries = await readdir('.', { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && imageGlob.match(e.name))
    .map((e) => e.name);
}

async function batch(opts: Opts): Promise<void> {
  const allFiles = await collectFiles(opts.recursive);

  try {
    await Promise.all(allFiles.map(assertUnambiguous));
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  if (allFiles.length === 0) {
    console.log('No PNG/JPG images found.');
    return;
  }

  const files = opts.force
    ? allFiles
    : (
        await Promise.all(
          allFiles.map(async (f) => ({
            file: f,
            needed: !(await isUpToDate(f, getDestPath(f))),
          })),
        )
      )
        .filter((item) => item.needed)
        .map((item) => item.file);

  if (files.length === 0) {
    console.log(`Found ${allFiles.length} image(s) (all up-to-date by timestamp). Settings are not compared; use --force to apply changed settings. Skipped originals are kept.`);
    return;
  }

  console.log(
    `Found ${files.length} image(s) to convert${
      files.length < allFiles.length ? ` (${allFiles.length - files.length} already up-to-date)` : ''
    }.\n`,
  );
  await Promise.all(files.map((f) => convert(f, opts, true)));
}

// ── Watch mode ───────────────────────────────────────────────────────────────

function watchDir(opts: Opts): void {
  console.log('Watching… (Ctrl-C to stop)\n');

  chokidarWatch('.', {
    ignored: /\.webp$/,
    depth: opts.recursive ? undefined : 0,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  })
    .on('add',    (p: string) => { if (imageGlob.match(p)) void convert(p, opts); })
    .on('change', (p: string) => { if (imageGlob.match(p)) void convert(p, opts); });
}

// ── Main ─────────────────────────────────────────────────────────────────────

const opts = parseOpts();
await batch(opts);
if (opts.watch) watchDir(opts);
