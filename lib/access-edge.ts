// Edge-runtime HMAC used by middleware.ts. Web Crypto is available in the edge
// runtime; Node's `crypto` module is not, so this lives apart from any Node
// import.

import { ACCESS_SECRET, TOKEN_MESSAGE } from "./access";

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function keyFrom(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret || ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signUnlockToken(secret: string): Promise<string> {
  const key = await keyFrom(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(TOKEN_MESSAGE)
  );
  return bytesToHex(sig);
}

// The token the middleware expects for the server-configured promo code.
export async function expectedToken(): Promise<string> {
  return signUnlockToken(ACCESS_SECRET);
}

// Constant-time comparison of the presented cookie against the expected token.
export async function isUnlocked(presented: string | undefined): Promise<boolean> {
  if (!presented || !ACCESS_SECRET) return false;
  const expected = await expectedToken();
  if (presented.length !== expected.length) return false;
  // Hex strings; compare with XOR to keep it constant-time.
  let diff = 0;
  const a = presented.toLowerCase();
  const b = expected.toLowerCase();
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
