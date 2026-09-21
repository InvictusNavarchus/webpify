#!/usr/bin/env node
// webpify — Compress PNG/JPG → WebP

import sharp from 'sharp';
import chokidar from 'chokidar';
import { parseArgs } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

// ── CLI args ────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    quality:    { short: 'q', type: 'string',  default: '80' },
    effort:     { short: 'e', type: 'string',  default: '6' },
    'max-res':  { short: 'm', type: 'string',  default: '1920x1080' },
    'no-resize':{ type: 'boolean', default: false },
    delete:     { short: 'd', type: 'boolean', default: false },
    recursive:  { short: 'r', type: 'boolean', default: false },
    watch:      { short: 'w', type: 'boolean', default: false },
    help:       { short: 'h', type: 'boolean', default: false },
  },
});

const QUALITY = Number(args.quality);
const EFFORT  = Number(args.effort);
const [MAX_W, MAX_H] = args['max-res'].split(/x/i).map(Number);
const RESIZE  = !args['no-resize'];
const DEL     = args.delete;

// ── Convert one file ────────────────────────────────────────────────────────
async function convert(src) {
  const dest = src.replace(/\.(png|jpe?g)$/i, '.webp');

  try {
    let pipeline = sharp(src);

    if (RESIZE) {
      pipeline = pipeline.resize({
        width: MAX_W,
        height: MAX_H,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    const info = await pipeline
      .webp({ quality: QUALITY, effort: EFFORT, smartSubsample: true })
      .toFile(dest);

    const srcSize = (await fs.stat(src)).size;
    const pct = Math.round((1 - info.size / srcSize) * 100);
    console.log(`  ✓ ${src}  ${fmt(srcSize)} → ${fmt(info.size)}  (${pct}% smaller)`);

    if (DEL) await fs.unlink(src);
  } catch (err) {
    console.error(`  ✗ ${src}  ${err.message}`);
  }
}

// ── Batch: glob existing files ──────────────────────────────────────────────
async function batch() {
  const exts = /\.(png|jpe?g)$/i;
  const walk = args.recursive
    ? await glob('./**/*', { nodir: true })   // e.g. tiny-glob, or fs.glob in Node 22
    : await fs.readdir('.');

  const files = walk.filter(f => exts.test(f));
  if (!files.length) return console.log('No PNG/JPG images found.');

  console.log(`Found ${files.length} image(s).\n`);
  await Promise.all(files.map(convert));
}

// ── Watch mode ──────────────────────────────────────────────────────────────
function watch() {
  console.log('Watching… (Ctrl-C to stop)\n');

  chokidar.watch('.', {
    ignored: /\.webp$/,          // don't react to our own output
    depth: args.recursive ? undefined : 0,
    awaitWriteFinish: {          // wait for the file to actually be done
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  })
  .on('add',       p => /\.(png|jpe?g)$/i.test(p) && convert(p))
  .on('change',    p => /\.(png|jpe?g)$/i.test(p) && convert(p));
}

// ── Main ────────────────────────────────────────────────────────────────────
await batch();
if (args.watch) watch();

// ── Tiny helper ─────────────────────────────────────────────────────────────
function fmt(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let i = -1;
  do { bytes /= 1024; i++; } while (bytes >= 1024 && i < units.length - 1);
  return `${bytes.toFixed(1)} ${units[i]}`;
}