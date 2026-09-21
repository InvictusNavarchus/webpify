#!/usr/bin/env bun

import sharp from 'sharp';
import { watch as chokidarWatch } from 'chokidar';
import { readdir, unlink } from 'node:fs/promises';
import { Glob } from 'bun';
import { cac } from 'cac';


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
}

// ── CLI parsing ──────────────────────────────────────────────────────────────

function parseOpts(): Opts {
  const cli = cac('webpify');

  cli
    .option('-q, --quality <num>', 'WebP quality 1–100', { default: 80 })
    .option('-e, --effort <num>', 'Compression effort 0–9', { default: 6 })
    .option('-m, --max-res <WxH>', 'Max resolution', { default: '1920x1080' })
    .option('--no-resize', 'Disable automatic resizing')
    .option('-d, --delete', 'Delete originals after conversion')
    .option('-r, --recursive', 'Also process subdirectories')
    .option('-w, --watch', 'Watch for new/changed files');

  cli.help();

  // Parses process.argv; handles -h/--help automatically
  const parsed = cli.parse();

  // If user passed -h or --help, cac exits cleanly before reaching here.
  const options = parsed.options;

  // Validation: Quality & Effort
  if (options.quality < 1 || options.quality > 100) {
    console.error('Error: --quality must be 1–100');
    process.exit(1);
  }
  if (options.effort < 0 || options.effort > 9) {
    console.error('Error: --effort must be 0–9');
    process.exit(1);
  }

  // Validation: Max Resolution (WxH)
  const [w, h] = String(options.maxRes).split(/x/i).map(Number);
  if (!w || !h || w <= 0 || h <= 0) {
    console.error('Error: --max-res expects WxH, e.g. 1920x1080');
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
  };
}

// ── Convert a single file ────────────────────────────────────────────────────

async function convert(src: string, opts: Opts): Promise<void> {
  const dest = src.replace(/\.(png|jpe?g)$/i, '.webp');

  try {
    let pipeline = sharp(src);

    if (opts.resize) {
      pipeline = pipeline.resize({
        width: opts.maxW,
        height: opts.maxH,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    const info = await pipeline
      .webp({ quality: opts.quality, effort: opts.effort, smartSubsample: true })
      .toFile(dest);

    const srcSize = Bun.file(src).size;
    const pct     = Math.round((1 - info.size / srcSize) * 100);

    console.log(
      `  ✓ ${src}  ${fmt(srcSize)} → ${fmt(info.size)}  (${pct}% smaller)`,
    );

    if (opts.del) await unlink(src);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${src}  ${msg}`);
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
  const files = await collectFiles(opts.recursive);

  if (files.length === 0) {
    console.log('No PNG/JPG images found.');
    return;
  }

  console.log(`Found ${files.length} image(s).\n`);
  await Promise.all(files.map((f) => convert(f, opts)));
}

// ── Watch mode ───────────────────────────────────────────────────────────────

function watchDir(opts: Opts): void {
  console.log('Watching… (Ctrl-C to stop)\n');

  chokidarWatch('.', {
    ignored: /\.webp$/,
    depth: opts.recursive ? undefined : 0,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  })
    .on('add',    (p: string) => { if (imageGlob.match(p)) void convert(p, opts); })
    .on('change', (p: string) => { if (imageGlob.match(p)) void convert(p, opts); });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  const units = ['KiB', 'MiB', 'GiB'] as const;
  let val = bytes;
  let i   = 0;

  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }

  return `${val.toFixed(1)} ${units[i] ?? `${val} B`}`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const opts = parseOpts();
await batch(opts);
if (opts.watch) watchDir(opts);