/**
 * Production build script
 *
 * Uses esbuild to bundle the CLI entrypoint into a single file.
 * Also runs tsc --noEmit for type checking.
 *
 * Usage:
 *   npx tsx scripts/build.ts          — full build (typecheck + bundle)
 *   npx tsx scripts/build.ts --fast   — skip typecheck, just bundle
 */

import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const TSC = join(ROOT, 'node_modules', '.bin', 'tsc');

const args = process.argv.slice(2);
const fast = args.includes('--fast');
const verbose = args.includes('--verbose');

async function main(): Promise<void> {
  const startTime = Date.now();
  console.log('🔨 Building Project CC...\n');

  // ── Step 1: Type-check ────────────────────────────
  if (!fast) {
    console.log('  [1/3] Type-checking...');
    try {
      execSync(`"${TSC}" --noEmit`, {
        cwd: ROOT,
        stdio: verbose ? 'inherit' : 'pipe',
        shell: true,
      });
      console.log('  ✓ Type-check passed\n');
    } catch (error) {
      console.error('  ✗ Type-check failed\n');
      if (!verbose) {
        try {
          execSync(`"${TSC}" --noEmit --pretty`, {
            cwd: ROOT,
            stdio: 'inherit',
            shell: true,
          });
        } catch {
          // Already shown
        }
      }
      process.exit(1);
    }
  }

  // ── Step 2: TSC emit (for dist/ structure) ────────
  console.log(`  [${fast ? '1/2' : '2/3'}] Compiling TypeScript...`);
  try {
    execSync(`"${TSC}"`, {
      cwd: ROOT,
      stdio: verbose ? 'inherit' : 'pipe',
      shell: true,
    });
    console.log('  ✓ TypeScript compiled to dist/\n');
  } catch (error) {
    console.error('  ✗ Compilation failed\n');
    if (!verbose) {
      try {
        execSync(`"${TSC}" --pretty`, { cwd: ROOT, stdio: 'inherit', shell: true });
      } catch {
        // Already shown
      }
    }
    process.exit(1);
  }

  // ── Step 3: esbuild bundle (single-file CLI) ─────
  console.log(`  [${fast ? '2/2' : '3/3'}] Bundling with esbuild...`);
  try {
    const result = await build({
      entryPoints: [join(SRC, 'entrypoints', 'cli.ts')],
      outfile: join(DIST, 'pcc.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      sourcemap: true,
      minify: false,
      treeShaking: true,
      banner: {
        js: '#!/usr/bin/env node\n',
      },
      external: [
        'node:*',
        'react',
        'react/jsx-runtime',
        'ink',
        'ink-text-input',
        'yoga-wasm-web',
        'yaml',
      ],
      define: {
        'process.env.PCC_VERSION': '"0.2.0"',
      },
      logLevel: verbose ? 'info' : 'warning',
    });

    if (result.errors.length > 0) {
      console.error('  ✗ Bundle failed with errors');
      process.exit(1);
    }

    console.log('  ✓ Bundle created: dist/pcc.mjs\n');
  } catch (error) {
    console.error('  ✗ esbuild failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // ── Step 4: Plugin child entry bundle ────────────
  console.log('  [extra] Bundling plugin child entry...');
  try {
    await build({
      entryPoints: [join(SRC, 'plugins', 'child-entry.ts')],
      outfile: join(DIST, 'plugin-child.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      sourcemap: true,
      minify: false,
      external: ['node:*'],
      logLevel: verbose ? 'info' : 'warning',
    });
    console.log('  ✓ Plugin child entry: dist/plugin-child.mjs\n');
  } catch (error) {
    console.error('  ✗ Plugin child bundle failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // ── Summary ───────────────────────────────────────
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  const bundleStats = statSync(join(DIST, 'pcc.mjs'));
  const bundleSizeKb = (bundleStats.size / 1024).toFixed(0);

  console.log('━'.repeat(50));
  console.log(`✓ Build complete in ${duration}s`);
  console.log(`  dist/pcc.mjs     ${bundleSizeKb} KB (bundled CLI)`);
  console.log(`  dist/             TSC output (for import resolution)`);
  console.log(`  bin/pcc.mjs       Shim entry point`);
  console.log('');
  console.log('Run with:');
  console.log('  node dist/pcc.mjs "Hello"           — single query');
  console.log('  node dist/pcc.mjs                   — interactive REPL');
  console.log('  npm link && pcc "Hello"              — after global install');
  console.log('━'.repeat(50));
}

main().catch((error) => {
  console.error('Build error:', error);
  process.exit(1);
});
