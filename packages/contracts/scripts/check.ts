import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { GENERATED_ARTIFACTS, PACKAGE_ROOT } from './generate.js';

const problems: string[] = [];

for (const artifact of GENERATED_ARTIFACTS) {
  const path = resolve(PACKAGE_ROOT, artifact.file);
  let committed: string;
  try {
    committed = await readFile(path, 'utf8');
  } catch {
    problems.push(`${artifact.file} is missing`);
    continue;
  }
  if (committed !== artifact.render()) {
    problems.push(`${artifact.file} is out of date`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`contract check: ${problem}`);
  }
  console.error('Run `pnpm --filter @idpn/contracts generate` and commit the result.');
  process.exit(1);
}

console.log(`Contract check passed for ${GENERATED_ARTIFACTS.length} artifacts.`);
