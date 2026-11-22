import { loadSettings, readToken, saveSettings, validate } from './settings.ts';
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function config(env = process.env) {
  try {
    const url = new URL(env.PI_PUSH_URL ?? "");
    const topic = env.PI_PUSH_TOPIC ?? "";
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !/^[A-Za-z0-9_-]{1,64}$/.test(topic)) return undefined;
    return { url: url.toString().replace(/\/$/, '') + '/' + topic, token: env.PI_PUSH_TOKEN, excerpt: env.PI_PUSH_EXCERPT === '1' };
  } catch { return undefined; }
}

type Config = NonNullable<ReturnType<typeof config>>;
export class Queue {
  private items: string[] = [];
  private active = false;
  private closed = false;
  private controller?: AbortController;
  sent = 0;
  failed = 0;
  dropped = 0;
  constructor(private cfg: Config, private request: typeof fetch = fetch, private timeout = 5000) {}
  get pending() { return this.items.length + Number(this.active); }
  enqueue(body: string) {
    if (this.closed) return false;
    if (this.pending >= 16) { this.dropped++; return false; }
    this.items.push(body.slice(0, 800));
    void this.drain();
    return true;
  }
  close() { this.closed = true; this.items = []; this.controller?.abort(); }
  private async drain() {
    if (this.active || this.closed) return;
    this.active = true;
    try {
      while (this.items.length && !this.closed) {
        const body = this.items.shift()!;
        let ok = false;
        for (let attempt = 0; attempt < 3 && !this.closed; attempt++) {
          const controller = this.controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), this.timeout);
          timer.unref?.();
          let retry = true;
          try {
            const response = await this.request(this.cfg.url, {
              method: 'POST', redirect: 'error', signal: controller.signal,
              headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: 'Pi', ...(this.cfg.token ? { Authorization: `Bearer ${this.cfg.token}` } : {}) }, body,
            });
            ok = response.ok;
            retry = response.status === 429 || response.status >= 500;
            await response.body?.cancel();
          } catch { /* Never expose URLs, credentials, response bodies or exception text. */ }
          finally { clearTimeout(timer); this.controller = undefined; }
          if (ok || !retry) break;
        }
        if (!this.closed) { if (ok) this.sent++; else this.failed++; }
      }
    } finally { this.active = false; }
  }
}

const QUESTION_TOOLS = new Set(['ask_user_question', 'ask_user_question_async', 'request_user_input', 'request_user_input_async']);

export function isQuestionTool(name: string) {
  // Namespace separators: functions.name, namespace:name, namespace/name, mcp__server__name.
  // Single underscores remain part of the name; never match arbitrary suffixes.
  return QUESTION_TOOLS.has(name.split(/__|[.:/]/).at(-1) ?? '');
}

export default function (pi: ExtensionAPI) {
  let cfg: ReturnType<typeof config>;
  let savedEnabled = true;
  try {
    const saved = loadSettings();
    savedEnabled = saved?.enabled !== false;
    cfg = config({ ...process.env,
      PI_PUSH_URL: process.env.PI_PUSH_URL ?? saved?.url,
      PI_PUSH_TOPIC: process.env.PI_PUSH_TOPIC ?? saved?.topic,
      PI_PUSH_TOKEN: process.env.PI_PUSH_TOKEN ?? (saved?.tokenFile ? readToken(saved.tokenFile) : undefined),
      PI_PUSH_EXCERPT: process.env.PI_PUSH_EXCERPT ?? (saved?.excerpt ? '1' : '0'),
    });
  } catch { cfg = undefined; }
  let enabled = !!cfg && (process.env.PI_PUSH_ENABLED === undefined ? savedEnabled : process.env.PI_PUSH_ENABLED !== '0');
  let queue = cfg ? new Queue(cfg) : undefined;
  let started: number | undefined;
  let excerpt = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let uiPending = false;
  const questionCalls = new Set<string>();
  let notified = false;
  const clear = () => {
    clearTimeout(timer); timer = undefined;
    uiPending = false; questionCalls.clear(); notified = false;
  };
  const send = (text: string) => enabled && !!queue?.enqueue(text);
  const updatePrompt = () => {
    if (!uiPending && questionCalls.size === 0) { clear(); return; }
    if (!enabled || notified || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      notified = true;
      send('Pi 正在等待你的交互输入，请返回终端查看。');
    }, 1500);
    timer.unref?.();
  };
  pi.on('agent_start', () => { if (started === undefined) { started = Date.now(); excerpt = ''; } });
  pi.on('message_end', (event) => {
    if (started !== undefined && cfg?.excerpt && event.message.role === 'assistant') {
      excerpt = event.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 400);
    }
  });
  pi.on('agent_settled', (event) => {
    clear();
    if (started === undefined) return;
    send(`${event.aborted ? '运行已中止' : '已就绪，可继续输入'}（${Math.round((Date.now() - started) / 1000)} 秒）。这不代表任务成功。${excerpt ? '\n' + excerpt : ''}`);
    started = undefined; excerpt = '';
  });
  // UI events describe one coalesced span; tool events have independent call IDs.
  // Keep one notification until every overlapping source has ended.
  pi.on('ui_prompt_start', () => { if (enabled) { uiPending = true; updatePrompt(); } });
  pi.on('ui_prompt_end', () => { uiPending = false; updatePrompt(); });
  pi.on('tool_execution_start', event => {
    if (enabled && isQuestionTool(event.toolName)) {
      questionCalls.add(event.toolCallId);
      updatePrompt();
    }
  });
  pi.on('tool_execution_end', event => {
    if (questionCalls.delete(event.toolCallId)) updatePrompt();
  });
  pi.on('session_compact_failed', event => { send(event.aborted ? '上下文压缩已取消。' : '上下文压缩失败，请返回终端检查。'); });
  pi.on('session_shutdown', () => { enabled = false; clear(); queue?.close(); started = undefined; excerpt = ''; });
  pi.registerCommand('push', {
    description: '通知：setup / on / off / status / test',
    handler: async (args, ctx) => {
      const action = args.trim() || 'status';
      if (action === 'setup') {
        if (!ctx.hasUI) return;
        const url = await ctx.ui.input('ntfy 服务 URL（例如 https://ntfy.sh）');
        if (url === undefined) return;
        const topic = await ctx.ui.input('主题（字母、数字、下划线、短横线）');
        if (topic === undefined) return;
        const tokenFile = await ctx.ui.input('Token 文件绝对路径（0600；留空表示无需认证；不要粘贴 token）');
        if (tokenFile === undefined) return;
        try {
          const next = validate({ url, topic, ...(tokenFile ? { tokenFile } : {}), enabled: true, excerpt: false });
          if (tokenFile) readToken(tokenFile);
          saveSettings(next);
          ctx.ui.notify('配置已保存；执行 /reload 生效。环境变量仍优先。', 'info');
        } catch { ctx.ui.notify('设置失败：检查 URL、主题和 token 文件路径及权限。', 'error'); }
        return;
      }
      let message: string;
      if (action === 'off') { enabled = false; clear(); queue?.close(); message = '推送已关闭，待发队列已清空。'; }
      else if (action === 'on') { if (!enabled && cfg) queue = new Queue(cfg); enabled = !!cfg; message = enabled ? '推送已开启。' : '配置缺失或无效。'; }
      else if (action === 'test') message = send('Pi 测试通知。') ? '测试已入队；不代表送达。' : '未入队：已关闭、配置无效或队列已满。';
      else if (action === 'status') message = `push ${enabled ? 'on' : 'off'}; configured=${!!cfg}; pending=${queue?.pending ?? 0}; accepted=${queue?.sent ?? 0}; failed=${queue?.failed ?? 0}; dropped=${queue?.dropped ?? 0}`;
      else message = '用法：/push setup|on|off|status|test';
      if (ctx.hasUI) ctx.ui.notify(message, 'info');
    },
  });
}
