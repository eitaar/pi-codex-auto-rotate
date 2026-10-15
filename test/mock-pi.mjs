import { readFileSync } from 'node:fs';
export function readStoredCredential(provider, path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))[provider];
  } catch {
    return undefined;
  }
}
