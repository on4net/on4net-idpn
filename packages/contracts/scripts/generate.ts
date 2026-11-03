import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  renderMfeConfigJsonSchema,
  renderMfeEventJsonSchema,
  renderOpenApiDocument,
} from '../src/index.js';

export const GENERATED_ARTIFACTS = [
  { file: 'openapi.json', render: renderOpenApiDocument },
  { file: 'mfe-config.schema.json', render: renderMfeConfigJsonSchema },
  { file: 'mfe-event.schema.json', render: renderMfeEventJsonSchema },
] as const;

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function writeArtifacts(): Promise<string[]> {
  for (const artifact of GENERATED_ARTIFACTS) {
    await writeFile(resolve(PACKAGE_ROOT, artifact.file), artifact.render(), 'utf8');
  }
  return GENERATED_ARTIFACTS.map((artifact) => artifact.file);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await writeArtifacts();
  console.log(`Generated ${files.join(', ')}`);
}
