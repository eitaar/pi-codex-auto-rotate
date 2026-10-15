import { readFileSync, writeFileSync } from 'node:fs';
export class AuthStorage {
  constructor(path) { this.path = path; }
  static create(path) { return new AuthStorage(path); }
  async read(provider) { return JSON.parse(readFileSync(this.path, 'utf8'))[provider]; }
  async modify(provider, fn) {
    const value = JSON.parse(readFileSync(this.path, 'utf8'));
    value[provider] = await fn(value[provider]);
    writeFileSync(this.path, JSON.stringify(value));
    return value[provider];
  }
}
