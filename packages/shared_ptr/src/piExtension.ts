/**
 * Pi extension: the same team-memory tools the MCP server serves, registered
 * as Pi tools, plus a /shared_ptr command for the human (who can accept).
 * Install: ln -sf <shared_ptr>/dist/piExtension.js ~/.pi/extensions/shared_ptr.js
 */
import { z } from 'zod';
import { openBackend, type MemoryBackend } from './backend.js';
import { SERVER_INSTRUCTIONS, TOOLS, type ToolContext } from './tools.js';

/** The slice of Pi's ExtensionAPI this extension uses (no dependency on Pi's package). */
interface PiApi {
  registerTool?(tool: {
    name: string; label: string; description: string; promptSnippet: string; promptGuidelines: string;
    parameters: unknown;
    execute(id: string, params: unknown): Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown }>;
  }): void;
  registerCommand(name: string, spec: {
    description: string;
    handler(args: string, ctx: { ui: { notify(msg: string, level: 'info' | 'error'): void } }): Promise<void>;
  }): void;
}

export default function sharedPtrExtension(pi: PiApi): void {
  let backend: Promise<MemoryBackend> | null = null;
  const ctx = async (): Promise<ToolContext> => ({
    backend: await (backend ??= openBackend({ provider: 'pi' })),
    defaultWorkspace: process.env.SHARED_PTR_WORKSPACE?.trim() || null,
  });

  if (typeof pi.registerTool === 'function') {
    for (const tool of TOOLS) {
      pi.registerTool({
        name: tool.name,
        label: tool.name.replace(/^sptr_/, 'shared_ptr ').replace(/_/g, ' '),
        description: tool.description,
        promptSnippet: `${tool.name}: ${tool.description.split('. ')[0]}`,
        promptGuidelines: SERVER_INSTRUCTIONS,
        parameters: z.toJSONSchema(z.object(tool.input)),
        async execute(_id, params) {
          try {
            const args = z.object(tool.input).parse(params);
            const r = await (tool.run as (c: ToolContext, a: unknown) => Promise<{ text: string; data: unknown }>)(await ctx(), args);
            return { content: [{ type: 'text', text: r.text }], details: r.data };
          } catch (e) {
            const text = e instanceof Error ? e.message : String(e);
            return { content: [{ type: 'text', text: `error: ${text}` }], details: { error: text } };
          }
        },
      });
    }
  }

  // The human's command: review and accept (agents only propose).
  pi.registerCommand('shared_ptr', {
    description: 'team memory: /shared_ptr review [workspace] | accept <id> <revision> [workspace]',
    async handler(args, pctx) {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        const c = await ctx();
        const wsOf = (given?: string) => given ?? c.defaultWorkspace ?? (() => { throw new Error('set SHARED_PTR_WORKSPACE or pass a workspace'); })();
        if (sub === 'review') {
          const items = await c.backend.review(wsOf(rest[0]));
          pctx.ui.notify(items.length ? items.map((m) => `${m.id} rev ${m.revision}: ${m.text.slice(0, 120)}`).join('\n') : 'Nothing waiting for review.', 'info');
        } else if (sub === 'accept' && rest[0] && rest[1]) {
          const m = await c.backend.accept(wsOf(rest[2]), rest[0], Number(rest[1]));
          pctx.ui.notify(`Accepted ${m.id} (rev ${m.revision}).`, 'info');
        } else {
          pctx.ui.notify('Usage: /shared_ptr review [workspace] | /shared_ptr accept <id> <revision> [workspace]', 'info');
        }
      } catch (e) {
        pctx.ui.notify(e instanceof Error ? e.message : String(e), 'error');
      }
    },
  });
}
