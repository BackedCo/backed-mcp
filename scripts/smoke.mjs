/**
 * Stdio smoke test: boots the built server, runs initialize + tools/list,
 * and asserts the expected tools are registered. No network calls.
 */
import { spawn } from 'node:child_process';

const server = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'inherit']
});

const requests = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0.0.0' }
    }
  },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' }
];

for (const request of requests) {
  server.stdin.write(JSON.stringify(request) + '\n');
}

let buffer = '';
const failTimer = setTimeout(() => {
  console.error('smoke: timed out waiting for tools/list response');
  server.kill();
  process.exit(1);
}, 10_000);

server.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  for (const line of buffer.split('\n')) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === 1 && message.result?.serverInfo?.name !== 'backed') {
      console.error('smoke: unexpected serverInfo', message.result?.serverInfo);
      process.exit(1);
    }
    if (message.id === 2) {
      const names = (message.result?.tools ?? []).map((t) => t.name).sort();
      const expected = [
        'check_agent_trust',
        'discover_trusted_agents',
        'get_badge_snippet'
      ];
      if (JSON.stringify(names) !== JSON.stringify(expected)) {
        console.error('smoke: unexpected tools', names);
        process.exit(1);
      }
      clearTimeout(failTimer);
      console.log('smoke: ok (initialize + 3 tools)');
      server.kill();
      process.exit(0);
    }
  }
});
