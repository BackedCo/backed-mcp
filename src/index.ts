#!/usr/bin/env node
/**
 * backed-mcp: stdio MCP server for the Backed agent trust registry.
 *
 * Wraps the public Backed API (https://api.usebacked.ai) so any MCP client
 * (Claude Desktop, Claude Code, ChatGPT, agent frameworks) can check an AI
 * agent's on-chain trust score before paying it, discover trusted agents,
 * and fetch badge embed code.
 *
 * Config (env):
 *   BACKED_API_URL  override the API base (default https://api.usebacked.ai)
 *   BACKED_API_KEY  optional org API key for higher rate limits
 *
 * Prefer no install at all? The same tools are served remotely at
 * https://api.usebacked.ai/mcp (streamable HTTP).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_URL = process.env.BACKED_API_URL ?? 'https://api.usebacked.ai';
const API_KEY = process.env.BACKED_API_KEY;

async function api(path: string): Promise<string> {
  const response = await fetch(`${API_URL}${path}`, {
    headers: {
      Accept: 'application/json',
      ...(API_KEY ? { 'X-API-Key': API_KEY } : {})
    }
  });
  const text = await response.text();
  if (!response.ok && response.status !== 404) {
    throw new Error(`Backed API responded ${response.status}: ${text.slice(0, 300)}`);
  }
  return text;
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

const server = new McpServer({
  name: 'backed',
  title: 'Backed Agent Trust Registry',
  version: '0.1.0'
});

server.registerTool(
  'check_agent_trust',
  {
    title: 'Check an AI agent’s trust score',
    description:
      'Look up an AI agent in the Backed registry by 0x wallet address, AP2 DID, or A2A id. Returns its activity score (0-100, from first-party observed on-chain x402 settlements), reputation score, tier, provenance, and settlement metrics. Use before paying or hiring an agent. A 404 means the agent has no observed on-chain history: treat with caution.',
    inputSchema: {
      id: z
        .string()
        .describe('The agent’s 0x wallet address, AP2 DID (did:pkh:...), or A2A id.')
    }
  },
  async ({ id }) => textResult(await api(`/scores/${encodeURIComponent(id)}`))
);

server.registerTool(
  'discover_trusted_agents',
  {
    title: 'Discover trusted AI agents',
    description:
      'Find the top trusted AI agents on the x402 network, ranked by verified on-chain activity (never self-reported). Filter by service category, marketplace, or free-text query. Use to pick a counterparty for a task.',
    inputSchema: {
      category: z
        .enum(['SERVICES', 'GOODS', 'DATA', 'COMPUTE', 'FINANCIAL', 'OTHER'])
        .optional()
        .describe('Service category to filter by.'),
      q: z
        .string()
        .optional()
        .describe('Free-text search over name, DID, and wallet address.'),
      marketplace: z
        .string()
        .optional()
        .describe('Only agents present in this marketplace (e.g. "Coinbase Bazaar").'),
      limit: z.number().int().min(1).max(25).optional().describe('Max results (default 10).')
    }
  },
  async ({ category, q, marketplace, limit }) => {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (q) params.set('q', q);
    if (marketplace) params.set('marketplace', marketplace);
    params.set('limit', String(limit ?? 10));
    return textResult(await api(`/discovery/agents?${params.toString()}`));
  }
);

server.registerTool(
  'get_badge_snippet',
  {
    title: 'Get an agent’s badge embed code',
    description:
      'Returns the HTML and Markdown snippets that embed an agent’s live Backed trust badge (auto-updating SVG) plus its public profile URL.',
    inputSchema: {
      id: z
        .string()
        .describe('Registry id (UUID), 0x wallet address, AP2 DID, or A2A id.'),
      theme: z.enum(['dark', 'light']).optional().describe('Badge theme (default dark).')
    }
  },
  async ({ id, theme }) => {
    // Confirm the agent exists so we never hand out a dead badge.
    const raw = await api(`/scores/${encodeURIComponent(id)}`);
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      if (parsed.error) {
        return textResult(
          JSON.stringify({ found: false, message: 'Agent not found in the Backed registry.' })
        );
      }
    } catch {
      // Non-JSON response: fall through with the caller-provided id.
    }
    const badgeUrl = `${API_URL}/badge/${encodeURIComponent(id)}${theme === 'light' ? '?theme=light' : ''}`;
    const profileUrl = `https://usebacked.ai/registry?q=${encodeURIComponent(id)}`;
    return textResult(
      JSON.stringify({
        found: true,
        badgeUrl,
        profileSearchUrl: profileUrl,
        html: `<a href="${profileUrl}" target="_blank" rel="noopener">\n  <img src="${badgeUrl}" alt="Backed trust badge" height="28" />\n</a>`,
        markdown: `[![Backed trust badge](${badgeUrl})](${profileUrl})`,
        note: 'The badge endpoint accepts a wallet address, AP2 DID, A2A id, or registry UUID. Verified owners can copy an exact snippet with the canonical profile link from their dashboard.'
      })
    );
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
