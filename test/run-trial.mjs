// test/run-trial.mjs: run one practice trial on this machine, the way the env does, and score it.
//
// The kit's `grade-local --driver process` cannot start the env on Windows (its forwarder path check
// rejects a backslash), so this script runs the same three pieces itself: the kit's env, this entry, and
// the kit's scorer. The env is copied and given one extra trigger, a file named `finish` in its state
// directory, because Windows never delivers the SIGTERM its export hangs on. Nothing else about the env
// changes, and the score it prints is the scorer's own.
//
//   node test/run-trial.mjs [--kit <kit dir>] [--trial 0] [--keep]
//
// Defaults: the kit at ../free-model-aggregator-01-kit relative to this repository's parent, trial 0.

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bot = resolve(here, '..');

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const kit = resolve(arg('kit', join(bot, '..', 'free-model-aggregator-01-kit')));
const trial = arg('trial', '0');
const keep = process.argv.includes('--keep');
const trialDir = join(kit, 'practice', `trial-${trial}`);
const work = join(kit, '.run', `trial-${trial}`);

for (const path of [join(kit, 'program', 'env', 'server.mjs'), join(trialDir, 'input', 'prompt.txt')]) {
  if (!existsSync(path)) {
    console.error(`missing ${path}: pass --kit <the unpacked kit>`);
    process.exit(2);
  }
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const stateDir = join(work, 'state');
const exportDir = join(stateDir, 'export');
const scoresDir = join(work, 'scores');
mkdirSync(stateDir, { recursive: true });
mkdirSync(exportDir, { recursive: true });
mkdirSync(scoresDir, { recursive: true });

// The env's own copy, with a file trigger in place of the SIGTERM handler Windows never delivers.
const patched = join(work, 'env.mjs');
const source = readFileSync(join(kit, 'program', 'env', 'server.mjs'), 'utf8');
const trigger = `  const finishFile = join(stateDir, "finish");
  const finish = () => {
    if (!existsSync2(finishFile)) return;
    driver.abort();
    const dir = join(stateDir, "export");
    mkdirSync(dir, { recursive: true });
    writeAtomic2(join(dir, STATE_FILE), jsonText(buildTrialState({ manifest: workload.manifest, observations: driver.observations(), catalog })));
    server.close();
    process.exit(0);
  };
  setInterval(finish, 100);
`;
if (!source.includes('  process.on("SIGTERM", () => {')) {
  console.error('the env source has moved on: no SIGTERM handler to hook');
  process.exit(2);
}
const writeAtomic2 = `function writeAtomic2(file, text) { writeFileSync(file, text); }
function existsSync2(file) { try { readFileSync(file); return true; } catch { return false; } }
function rmSync2(file) { try { rmSync(file); } catch {} }
`;
const patchedSource = writeAtomic2 + source.replace('  process.on("SIGTERM", () => {', `${trigger}  process.on("SIGTERM", () => {`);
writeFileSync(patched, patchedSource);

const env = spawn(process.execPath, [patched], {
  env: { ...process.env, MAKEFUN_ENV_PORT: '8580', MAKEFUN_STATE_DIR: stateDir, MAKEFUN_ENV_DATA_DIR: join(trialDir, 'input', 'env') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let envOut = '';
env.stdout.on('data', (chunk) => {
  envOut += chunk.toString();
});
env.stderr.on('data', (chunk) => {
  envOut += chunk.toString();
});

function waitFor(check, ms) {
  const until = Date.now() + ms;
  return new Promise((done, fail) => {
    const tick = () => {
      if (check()) return done();
      if (Date.now() > until) return fail(new Error('timed out'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

let failed = false;
try {
  await waitFor(() => existsSync(join(stateDir, 'ready')), 15000);
  console.log('env ready on 8580');
  const child = spawn(process.execPath, [join(bot, 'main.ts')], {
    cwd: bot,
    env: { ...process.env, MAKEFUN_ENV_URL: 'http://127.0.0.1:8580', MAKEFUN_PROMPT_FILE: join(trialDir, 'input', 'prompt.txt'), MAKEFUN_TRIAL_SEED: readFileSync(join(trialDir, 'input', 'prompt.txt'), 'utf8').length ? 'practice' : 'practice' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let botOut = '';
  child.stdout.on('data', (chunk) => {
    botOut += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    botOut += chunk.toString();
  });
  const code = await new Promise((done) => child.on('exit', done));
  console.log(`the entry exited ${code}`);
  console.log(botOut.split('\n').filter((line) => line.startsWith('aggregator:')).join('\n'));
  if (code !== 0) failed = true;
  writeFileSync(join(stateDir, 'finish'), 'go\n');
  await waitFor(() => !env.killed && env.exitCode !== null, 15000).catch(() => undefined);
} catch (err) {
  console.error(`the trial did not finish: ${err.message}`);
  failed = true;
  env.kill();
}

console.log(envOut.trim());
if (!existsSync(join(exportDir, 'state.json'))) {
  console.error('the env wrote no state.json');
  process.exit(1);
}

const score = spawn(process.execPath, [join(kit, 'program', 'scorer', 'score.mjs')], {
  env: { ...process.env, MAKEFUN_OUTPUT_DIR: exportDir, MAKEFUN_REFERENCE_DIR: join(trialDir, 'reference'), MAKEFUN_SCORES_DIR: scoresDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let scoreOut = '';
score.stdout.on('data', (chunk) => {
  scoreOut += chunk.toString();
});
score.stderr.on('data', (chunk) => {
  scoreOut += chunk.toString();
});
await new Promise((done) => score.on('exit', done));
console.log(scoreOut.trim());

const state = JSON.parse(readFileSync(join(exportDir, 'state.json'), 'utf8'));
for (const request of state.requests) {
  const bad = request.checks.filter((c) => !c.pass);
  console.log(`${request.id} ${request.valid ? 'valid  ' : 'INVALID'} ${request.provider ?? '-'}/${request.model ?? '-'} calls ${request.upstream_calls}${bad.length > 0 ? ` :: ${bad.map((c) => `${c.name}: ${c.detail}`).join(' | ')}` : ''}`);
}
console.log(`totals ${JSON.stringify(state.totals)}`);
console.log(`kept ${work}${keep ? '' : ' (pass --keep to keep nothing extra: it is kept either way)'}`);
if (failed) process.exit(1);
