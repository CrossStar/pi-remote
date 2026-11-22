import { test } from 'node:test';
import assert from 'node:assert/strict';
import push, { isQuestionTool } from '../extensions/pi-remote.ts';
import type { ExtensionAPI, ToolExecutionStartEvent, ToolExecutionEndEvent } from '@earendil-works/pi-coding-agent';

test('question tool names require an exact leaf name', () => {
  for (const leaf of ['ask_user_question', 'ask_user_question_async', 'request_user_input', 'request_user_input_async']) {
    for (const prefix of ['', 'functions.', 'namespace:', 'namespace/', 'mcp__server__']) assert.ok(isQuestionTool(prefix + leaf));
  }
  for (const name of ['bash', 'ask_user_question_extra', 'fake_ask_user_question', 'ask_user_question.run']) assert.equal(isQuestionTool(name), false);
});

test('tool decisions debounce, coalesce with UI, reset and keep payloads private', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = { ...process.env };
  Object.assign(process.env, { PI_PUSH_URL: 'https://example.test', PI_PUSH_TOPIC: 'test', PI_PUSH_ENABLED: '1' });
  const bodies: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { bodies.push(String(init.body)); return new Response(null); });
  const handlers: Record<string, Function> = {};
  let command!: Function;
  const start = (id: string, name = 'functions.ask_user_question') => handlers.tool_execution_start({ type: 'tool_execution_start', toolCallId: id, toolName: name, args: { questions: ['SECRET'], choices: ['SECRET'] }, parentToolCallId: 'parent' } satisfies ToolExecutionStartEvent);
  const end = (id: string, isError = false) => handlers.tool_execution_end({ type: 'tool_execution_end', toolCallId: id, toolName: 'functions.ask_user_question', result: { content: [{ type: 'text', text: 'SECRET' }] }, isError } satisfies ToolExecutionEndEvent);
  const ui = (phase: 'start' | 'end') => handlers[`ui_prompt_${phase}`]({ type: `ui_prompt_${phase}`, reason: 'ui_prompt', kind: 'custom', title: 'SECRET' });
  const tick = async (ms = 1500) => { t.mock.timers.tick(ms); for (let i = 0; i < 8; i++) await Promise.resolve(); };
  try {
    push({ on: (n: string, fn: Function) => { handlers[n] = fn; }, registerCommand: (_n: string, def: { handler: Function }) => { command = def.handler; } } as unknown as ExtensionAPI);
    start('quick'); end('quick', true); await tick(); assert.equal(bodies.length, 0);
    start('ordinary', 'bash'); await tick(); assert.equal(bodies.length, 0);
    start('a'); await tick(1000); ui('start'); await tick(500); assert.equal(bodies.length, 1);
    ui('end'); ui('start'); start('b', 'mcp__server__request_user_input_async'); end('a'); await tick(); assert.equal(bodies.length, 1);
    end('b'); await tick(); assert.equal(bodies.length, 1); ui('end');
    ui('start'); await tick(); assert.equal(bodies.length, 2); start('c'); ui('end'); await tick(); assert.equal(bodies.length, 2); end('c');
    start('repeat'); await tick(); assert.equal(bodies.length, 3); end('repeat');
    for (const aborted of [true, false]) {
      start('settled'); handlers.agent_settled({ type: 'agent_settled', aborted }); await tick(); assert.equal(bodies.length, 3);
    }
    const ctx = { hasUI: false };
    start('off'); await command('off', ctx); await command('on', ctx); await tick(); assert.equal(bodies.length, 3);
    end('off'); start('new'); await tick(); assert.equal(bodies.length, 4); end('new');
    start('shutdown'); handlers.session_shutdown({ type: 'session_shutdown', reason: 'quit' }); await tick(); assert.equal(bodies.length, 4);
    assert.ok(bodies.every(body => body === 'Pi 正在等待你的交互输入，请返回终端查看。'));
  } finally { handlers.session_shutdown?.(); process.env = env; }
});
