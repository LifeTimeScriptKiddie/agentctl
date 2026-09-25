/**
 * `shared_ptr mcp --caller <agent>`: the team-memory tools over MCP stdio for
 * Claude Code, Codex and Cursor. Uses the gatekeeper when SHARED_PTR_SERVER is
 * set (team), else this machine's store (personal).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { MemoryBackend } from './backend.js';
import { openBackend } from './backend.js';
import { SERVER_INSTRUCTIONS, TOOLS, type ToolContext } from './tools.js';

export function createSharedPtrMcpServer(opts: { backend: () => Promise<MemoryBackend>; defaultWorkspace?: string | null }): McpServer {
  const server = new McpServer({ name: 'shared_ptr', version: '1' }, { instructions: SERVER_INSTRUCTIONS });
  let backend: Promise<MemoryBackend> | null = null;
  const ctx = async (): Promise<ToolContext> => ({
    backend: await (backend ??= opts.backend()),
    defaultWorkspace: opts.defaultWorkspace ?? null,
  });
  for (const tool of TOOLS) {
    // TOOLS is a heterogeneous list; the SDK validates args against tool.input before calling.
    const handler = async (args: unknown) => {
      try {
        const r = await (tool.run as (c: ToolContext, a: unknown) => Promise<{ text: string }>)(await ctx(), args);
        return { content: [{ type: 'text' as const, text: r.text }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] };
      }
    };
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.input,
      annotations: { readOnlyHint: tool.readOnly, openWorldHint: false },
    }, handler as never);
  }
  return server;
}

export async function startSharedPtrMcpStdio(opts: { caller: string; server?: string | null }): Promise<void> {
  const mcp = createSharedPtrMcpServer({
    backend: () => openBackend({ server: opts.server ?? null, provider: opts.caller }),
    defaultWorkspace: process.env.SHARED_PTR_WORKSPACE?.trim() || null,
  });
  await mcp.connect(new StdioServerTransport());
}
