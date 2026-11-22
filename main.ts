// Driver for the swift-site-forge entry. The harness runs `node main.ts`:
// it reads every case from /input/cases.json, answers each one with run()
// from solve.js, and writes /output/answers.json with the answers in the
// cases' order. MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for
// /input and /output outside a container.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Turn V8's incremental marking off before solve.js is imported, so all of
// its work runs under that flag (the house baseline runs the same way).
setFlagsFromString('--no-incremental-marking');

const solve = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as { id: string; input: unknown }[];

const answers: unknown[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  answers[i] = solve.run(cases[i]!.input);
}

writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
