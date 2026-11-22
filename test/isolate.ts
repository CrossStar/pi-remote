import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'pi-remote-test-'));
process.env.HOME = root;
process.env.XDG_CONFIG_HOME = join(root, 'config');
for (const key of Object.keys(process.env)) if (key.startsWith('PI_PUSH_')) delete process.env[key];
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
