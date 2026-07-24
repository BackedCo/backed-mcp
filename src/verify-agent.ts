/**
 * `npx backed-mcp verify-agent --challenge <id>`
 *
 * Completes a Backed agent-ownership proof from the machine that holds the
 * agent's AP2 private key: fetches the challenge from the public API, signs
 * it locally, and submits the signature. No copy-paste. For operators whose
 * key lives server-side; the dashboard's wallet flow covers browser keys.
 *
 * The key is read from the BACKED_AGENT_PRIVATE_KEY env var (32-byte hex,
 * 0x-prefix optional) and never leaves the process: only the signature is
 * sent.
 *
 *   - did:pkh:eip155 identities: secp256k1, EIP-191 personal_sign
 *   - did:key identities: raw ed25519 over the message (the env var holds
 *     the 32-byte seed)
 */

import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { base58 } from '@scure/base';

const DEFAULT_API_URL = 'https://api.usebacked.ai';

export const VERIFY_AGENT_USAGE = `Usage: backed-mcp verify-agent --challenge <challenge-id>

Proves ownership of a Backed registry agent by signing the pending challenge
with the agent's AP2 private key and submitting it. Create the challenge in
the Backed dashboard (Register agent → "Sign from your server"), then run
this command where the key lives.

Options:
  --challenge <id>   The challenge id shown in the dashboard (required)
  --api-url <url>    API base override (default ${DEFAULT_API_URL})

Environment:
  BACKED_AGENT_PRIVATE_KEY   The agent's private key as 32-byte hex
                             (0x-prefix optional). secp256k1 key for
                             did:pkh:eip155 identities, ed25519 seed for
                             did:key. Never sent anywhere.
  BACKED_API_URL             API base override (same as --api-url)
`;

class CliError extends Error {}

type ChallengeResponse = {
  challengeId: string;
  ap2Did: string;
  message: string;
  status: string;
  expiresAt: string;
};

function parseVerifyAgentArgs(argv: string[]): {
  challengeId: string;
  apiUrl: string;
} {
  let challengeId: string | undefined;
  let apiUrl = process.env.BACKED_API_URL ?? DEFAULT_API_URL;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--challenge') {
      challengeId = argv[++i];
    } else if (arg === '--api-url') {
      apiUrl = argv[++i] ?? apiUrl;
    } else if (arg === '--help' || arg === '-h') {
      console.log(VERIFY_AGENT_USAGE);
      process.exit(0);
    } else {
      throw new CliError(`Unknown option: ${arg}\n\n${VERIFY_AGENT_USAGE}`);
    }
  }

  if (!challengeId) {
    throw new CliError(`Missing --challenge <id>.\n\n${VERIFY_AGENT_USAGE}`);
  }
  return { challengeId, apiUrl: apiUrl.replace(/\/$/, '') };
}

function parsePrivateKey(): Uint8Array {
  const raw = process.env.BACKED_AGENT_PRIVATE_KEY;
  if (!raw) {
    throw new CliError(
      'BACKED_AGENT_PRIVATE_KEY is not set. Export the agent’s private key ' +
        'as 32-byte hex (0x-prefix optional) and re-run. The key is only used ' +
        'to sign locally; it is never sent anywhere.'
    );
  }
  const hex = raw.trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new CliError(
      'BACKED_AGENT_PRIVATE_KEY must be 32 bytes of hex (64 hex characters, 0x-prefix optional).'
    );
  }
  return hexToBytes(hex.toLowerCase());
}

function evmAddressFromKey(privateKey: Uint8Array): string {
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  return `0x${bytesToHex(keccak_256(publicKey.slice(1)).slice(-20))}`;
}

/** EIP-191 personal_sign: 65-byte r||s||v (v = 27/28) hex signature. */
function signEip191(message: string, privateKey: Uint8Array): string {
  const messageBytes = utf8ToBytes(message);
  const prefix = utf8ToBytes(
    `\x19Ethereum Signed Message:\n${messageBytes.length}`
  );
  const digest = keccak_256(Uint8Array.from([...prefix, ...messageBytes]));
  const signature = secp256k1.sign(digest, privateKey);
  const bytes = new Uint8Array(65);
  bytes.set(signature.toCompactRawBytes(), 0);
  bytes[64] = signature.recovery + 27;
  return `0x${bytesToHex(bytes)}`;
}

function ed25519DidFromKey(privateKey: Uint8Array): string {
  // multicodec ed25519-pub (0xed 0x01) + raw key, base58btc multibase.
  const publicKey = ed25519.getPublicKey(privateKey);
  const prefixed = new Uint8Array(2 + publicKey.length);
  prefixed.set([0xed, 0x01], 0);
  prefixed.set(publicKey, 2);
  return `did:key:z${base58.encode(prefixed)}`;
}

/**
 * Signs the challenge message with the scheme the identity requires, after
 * checking the key actually belongs to the identity so a wrong key fails
 * here with a clear message instead of a server-side rejection.
 */
function signChallenge(
  ap2Did: string,
  message: string,
  privateKey: Uint8Array
): string {
  if (ap2Did.startsWith('did:pkh:eip155:')) {
    const didAddress = (ap2Did.split(':').pop() ?? '').toLowerCase();
    const keyAddress = evmAddressFromKey(privateKey);
    if (keyAddress !== didAddress) {
      throw new CliError(
        `Key mismatch: BACKED_AGENT_PRIVATE_KEY controls ${keyAddress}, but ` +
          `the challenge is for ${didAddress}. Use the key behind the ` +
          `agent’s AP2 identity.`
      );
    }
    return signEip191(message, privateKey);
  }
  if (ap2Did.startsWith('did:key:z')) {
    const keyDid = ed25519DidFromKey(privateKey);
    if (keyDid !== ap2Did) {
      throw new CliError(
        `Key mismatch: BACKED_AGENT_PRIVATE_KEY derives ${keyDid}, but the ` +
          `challenge is for ${ap2Did}. Use the ed25519 seed behind the ` +
          `agent’s AP2 identity.`
      );
    }
    return bytesToHex(ed25519.sign(utf8ToBytes(message), privateKey));
  }
  throw new CliError(
    `Unsupported identity ${ap2Did}. This command signs for did:pkh:eip155 ` +
      `(EVM) and did:key (ed25519) identities.`
  );
}

async function fetchChallenge(
  apiUrl: string,
  challengeId: string
): Promise<ChallengeResponse> {
  const response = await fetch(
    `${apiUrl}/agents/challenges/${encodeURIComponent(challengeId)}`,
    { headers: { Accept: 'application/json' } }
  );
  if (response.status === 404) {
    throw new CliError(
      'Challenge not found. Check the id, or create a new challenge from the dashboard.'
    );
  }
  if (!response.ok) {
    throw new CliError(
      `Backed API responded ${response.status} while fetching the challenge.`
    );
  }
  return (await response.json()) as ChallengeResponse;
}

export async function runVerifyAgent(argv: string[]): Promise<void> {
  try {
    const { challengeId, apiUrl } = parseVerifyAgentArgs(argv);
    const privateKey = parsePrivateKey();

    const challenge = await fetchChallenge(apiUrl, challengeId);
    if (challenge.status !== 'PENDING') {
      throw new CliError(
        `Challenge is ${challenge.status}, not PENDING. Create a new challenge from the dashboard.`
      );
    }
    if (new Date(challenge.expiresAt).getTime() < Date.now()) {
      throw new CliError(
        'Challenge has expired. Create a new challenge from the dashboard and re-run within 15 minutes.'
      );
    }

    console.log(`Challenge for ${challenge.ap2Did}`);
    const signature = signChallenge(
      challenge.ap2Did,
      challenge.message,
      privateKey
    );
    console.log('Signed locally. Submitting…');

    const response = await fetch(
      `${apiUrl}/agents/challenges/${encodeURIComponent(challengeId)}/verify`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ signature })
      }
    );
    const body = (await response.json().catch(() => ({}))) as {
      verified?: boolean;
      agentId?: string;
      error?: string;
    };
    if (!response.ok || !body.verified) {
      throw new CliError(
        body.error ?? `Backed API responded ${response.status} on submit.`
      );
    }

    console.log(`Ownership verified. Agent id: ${body.agentId}`);
    console.log(
      'The agent now shows as verified in your dashboard and on its public profile.'
    );
  } catch (e) {
    if (e instanceof CliError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}
