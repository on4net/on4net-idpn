import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Minimal argument parser for the onboarding scripts.
 *
 * Flags are boolean; `--name value` and `--name=value` both bind a value. A repeated flag
 * accumulates (used for `--client`).
 */
export interface CliArgs {
  command: string;
  positionals: string[];
  values: Map<string, string[]>;
}

export function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf('=');
    if (equals !== -1) {
      const name = body.slice(0, equals);
      const value = body.slice(equals + 1);
      values.set(name, [...(values.get(name) ?? []), value]);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(body, [...(values.get(body) ?? []), next]);
      index += 1;
      continue;
    }
    values.set(body, [...(values.get(body) ?? []), 'true']);
  }
  const [command = 'help', ...rest] = positionals;
  return { command, positionals: rest, values };
}

export const hasFlag = (args: CliArgs, name: string): boolean =>
  (args.values.get(name) ?? []).some((value) => value === 'true' || value === '1');

export const flagValue = (args: CliArgs, name: string): string | undefined => {
  const entries = args.values.get(name);
  if (entries === undefined) {
    return undefined;
  }
  return entries.find((value) => value !== 'true' && value !== '1');
};

export const flagValues = (args: CliArgs, name: string): string[] =>
  (args.values.get(name) ?? []).filter((value) => value !== 'true' && value !== '1');

export function requiredFlag(args: CliArgs, name: string, hint: string): string {
  const value = flagValue(args, name);
  if (value === undefined || value.trim() === '') {
    throw new Error(`--${name} is required (${hint})`);
  }
  return value;
}

export async function readJsonFile(path: string): Promise<unknown> {
  const content = await readFile(path, 'utf8');
  return JSON.parse(content) as unknown;
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}
