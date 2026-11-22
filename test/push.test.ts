import { test } from 'node:test';
import assert from 'node:assert/strict';
import push, { Queue, config } from '../extensions/pi-remote.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
const cfg = { url: 'https://example.test/topic', token: 'secret', excerpt: false };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
test('retry transient errors; permanent denial is not retried; exceptions are contained', async () => {
  for (const status of [503, 401, 200, 429, 0]) {
    let calls = 0;
    const q = new Queue(cfg, (async () => { calls++; if (!status) throw Error('secret'); return new Response(null, { status }); }) as typeof fetch);
    assert.equal(q.enqueue('hello'), true);
    await tick();
    assert.equal(calls, [503, 429, 0].includes(status) ? 3 : 1);
    assert.equal(q.sent, status === 200 ? 1 : 0);
    assert.equal(q.failed, status === 200 ? 0 : 1);
    q.close();
  }
});
test('hung requests do not block enqueue; queue is bounded and shutdown aborts', async () => {
  let aborted = false;
  const q = new Queue(cfg, (async (_url, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); });
  })) as typeof fetch);
  for (let i = 0; i < 16; i++) assert.equal(q.enqueue('x'), true);
  assert.equal(q.enqueue('overflow'), false);
  assert.equal(q.pending, 16);
  q.close(); await tick();
  assert.equal(aborted, true); assert.equal(q.pending, 0); assert.equal(q.enqueue('x'), false);
});
test('timeout retries are bounded', async () => {
  let calls = 0;
  const q = new Queue(cfg, (async (_url, options) => new Promise((_resolve, reject) => {
    calls++; options!.signal!.addEventListener('abort', () => reject(Error('timeout')));
  })) as typeof fetch, 2);
  q.enqueue('x');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(calls, 3); assert.equal(q.failed, 1); q.close();
});
test('config rejects embedded secrets and unsafe topic paths', () => {
  assert.equal(config({ PI_PUSH_URL: 'https://user:secret@example.test', PI_PUSH_TOPIC: 'ok' }), undefined);
  assert.equal(config({ PI_PUSH_URL: 'https://example.test', PI_PUSH_TOPIC: '../bad' }), undefined);
  assert.equal(config({ PI_PUSH_URL: 'https://example.test', PI_PUSH_TOPIC: 'ok' })?.excerpt, false);
});
test('low-level retries preserve span; settled emits once without success claim or excerpt', async () => {
  const original = globalThis.fetch;
  const oldEnv = { ...process.env };
  process.env.PI_PUSH_URL = 'https://example.test'; process.env.PI_PUSH_TOPIC = 'topic';
  delete process.env.PI_PUSH_EXCERPT; delete process.env.PI_PUSH_ENABLED;
  const bodies: string[] = [];
  globalThis.fetch = (async (_url, options) => { bodies.push(String(options?.body)); return new Response(null); }) as typeof fetch;
  const handlers: Record<string, Function> = {};
  try {
    push({ on: (name: string, handler: Function) => { handlers[name] = handler; }, registerCommand() {} } as unknown as ExtensionAPI);
    handlers.agent_start(); handlers.agent_start();
    handlers.message_end({ message: { role: 'assistant', content: [{ type: 'text', text: 'private' }] } });
    assert.equal(bodies.length, 0);
    handlers.agent_settled({ aborted: false }); handlers.agent_settled({ aborted: false });
    await tick(); assert.equal(bodies.length, 1); assert.match(bodies[0], /不代表任务成功/); assert.ok(!bodies[0].includes('private'));
    handlers.ui_prompt_start(); handlers.ui_prompt_end();
    handlers.session_shutdown();
  } finally { globalThis.fetch = original; process.env = oldEnv; }
});
