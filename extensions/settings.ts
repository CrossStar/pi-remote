import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Settings { url: string; topic: string; tokenFile?: string; enabled?: boolean; excerpt?: boolean }
export function configPath(env = process.env) {
  return join(env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(env.HOME || homedir(), '.config'), 'pi-remote', 'config.json');
}
export function validate(value: unknown): Settings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid configuration');
  const s = value as Settings;
  if (Object.keys(s).some(k => !['url', 'topic', 'tokenFile', 'enabled', 'excerpt'].includes(k))) throw Error('Unknown setting');
  if (typeof s.url !== 'string' || typeof s.topic !== 'string') throw Error('URL and topic required');
  let u: URL; try { u = new URL(s.url); } catch { throw Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || !/^[A-Za-z0-9_-]{1,64}$/.test(s.topic)) throw Error('Invalid URL or topic');
  if (s.tokenFile !== undefined && (typeof s.tokenFile !== 'string' || !isAbsolute(s.tokenFile))) throw Error('Token file must be absolute');
  for (const k of ['enabled', 'excerpt'] as const) if (s[k] !== undefined && typeof s[k] !== 'boolean') throw Error('Invalid boolean');
  return { ...s };
}
function privateFile(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077)) throw Error('File must be private and regular');
}
export function loadSettings(path = configPath()): Settings | undefined {
  try { privateFile(path); return validate(JSON.parse(readFileSync(path, 'utf8'))); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw Error('Cannot load push configuration'); }
}
export function readToken(path: string): string {
  privateFile(path);
  const token = readFileSync(path, 'utf8').trim();
  if (!/^[\x21-\x7e]{1,4096}$/.test(token)) throw Error('Invalid token file');
  return token;
}
export function saveSettings(value: Settings, path = configPath()) {
  const s = validate(value), dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw Error('Invalid config directory');
  chmodSync(dir, 0o700);
  const temp = join(dir, '.' + randomUUID() + '.tmp');
  try { writeFileSync(temp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temp, path); }
  finally { try { unlinkSync(temp); } catch {} }
}
