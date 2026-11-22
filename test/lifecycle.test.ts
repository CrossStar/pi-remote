import { test } from 'node:test';
import assert from 'node:assert/strict';
import push from '../extensions/pi-remote.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
test('prompt debounce, compaction privacy, commands and shutdown', async () => {
  const original = fetch;
  const env = { ...process.env };
  Object.assign(process.env, { PI_PUSH_URL: 'https://example.test', PI_PUSH_TOPIC: 'test', PI_PUSH_ENABLED: '1' });
  const bodies: string[] = [], ui: string[] = [];
  const handlers: Record<string, Function> = {};
  let command: Function;
  const wait = () => new Promise(resolve => setTimeout(resolve, 1600));
  globalThis.fetch = (async (_url, init) => { bodies.push(String(init?.body)); return new Response(null); }) as typeof fetch;
  try {
    push({ on: (n: string, fn: Function) => { handlers[n] = fn; }, registerCommand: (_n: string, def: { handler: Function }) => { command = def.handler; } } as unknown as ExtensionAPI);
    handlers.ui_prompt_start(); handlers.ui_prompt_end(); await wait(); assert.equal(bodies.length, 0);
    handlers.ui_prompt_start(); await wait(); assert.equal(bodies.length, 1);
    handlers.ui_prompt_end();
    handlers.session_compact_failed({ aborted: false, errorMessage: 'secret' });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(bodies[1], /压缩失败/); assert.ok(!bodies[1].includes('secret'));
    const ctx = { hasUI: true, ui: { notify: (s: string) => ui.push(s) } };
    await command!('off', ctx); await command!('test', ctx); assert.match(ui.at(-1)!, /未入队/);
    await command!('on', ctx); await command!('test', ctx); assert.match(ui.at(-1)!, /不代表送达/);
    handlers.ui_prompt_start(); handlers.session_shutdown();
    const count = bodies.length; await wait(); assert.equal(bodies.length, count);
  } finally { globalThis.fetch = original; process.env = env; }
});
