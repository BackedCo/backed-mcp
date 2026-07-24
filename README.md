# backed-mcp

[![npm version](https://img.shields.io/npm/v/backed-mcp)](https://www.npmjs.com/package/backed-mcp)
[![CI](https://github.com/BackedCo/backed-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/BackedCo/backed-mcp/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-44F08C)](./LICENSE)

MCP server for [Backed](https://usebacked.ai), the trust registry for AI agents transacting over x402, AP2 and A2A.

Give any MCP-capable client (Claude Desktop, Claude Code, ChatGPT, agent frameworks) native tools to:

- **check_agent_trust**: look up any agent's on-chain trust score by wallet address, AP2 DID, or A2A id, before paying it
- **discover_trusted_agents**: find the top trusted agents for a task, ranked by verified on-chain settlement history
- **get_badge_snippet**: fetch the embed code for an agent's live trust badge

Scores come from first-party blockchain observation of x402 settlements. Nothing is self-reported. Methodology: [usebacked.ai/methodology](https://usebacked.ai/methodology).

## Remote server (no install)

The same tools are hosted at:

```
https://api.usebacked.ai/mcp
```

Add it to Claude Code:

```bash
claude mcp add --transport http backed https://api.usebacked.ai/mcp
```

Or in ChatGPT: Settings → Connectors → Add connector → `https://api.usebacked.ai/mcp`.

## Local (stdio) install

```bash
npx backed-mcp
```

Claude Desktop / Claude Code config:

```json
{
  "mcpServers": {
    "backed": {
      "command": "npx",
      "args": ["backed-mcp"]
    }
  }
}
```

## Verify agent ownership from the CLI

If your agent's AP2 private key lives server-side (no browser wallet), prove
ownership without any copy-paste. Create the challenge in the Backed
dashboard (Register agent → "Sign from your server"), then run this where
the key lives:

```bash
BACKED_AGENT_PRIVATE_KEY=0x... npx backed-mcp verify-agent --challenge <challenge-id>
```

The command fetches the challenge, signs it locally, and submits the
signature. The key never leaves your machine.

- `did:pkh:eip155:...` identities: the key is the wallet's secp256k1 private
  key (32-byte hex); the signature is EIP-191 `personal_sign`.
- `did:key:z6Mk...` identities: the key is the ed25519 seed (32-byte hex).

## Configuration (optional)

| Env var | Default | Purpose |
|---|---|---|
| `BACKED_API_URL` | `https://api.usebacked.ai` | API base override |
| `BACKED_API_KEY` | none | Free org API key for higher rate limits |
| `BACKED_AGENT_PRIVATE_KEY` | none | Agent key for `verify-agent` (signing only, never sent) |

Anonymous use is fine for evaluation (20 requests/min per IP). Register a free API key at [app.usebacked.ai](https://app.usebacked.ai) for production limits.

## Example

> "Before my agent pays 0xe903...1abf, is it trustworthy?"

The client calls `check_agent_trust` and gets back the agent's name, activity score and tier, provenance (observed / claimed / verified), settlement count, volume, counterparty diversity, and a link to its public profile.

## License

MIT
