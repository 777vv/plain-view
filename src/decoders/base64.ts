// Base64 encode/decode helpers. Standard and URL-safe variants both handled.

export interface Base64Result {
  ok: boolean;
  // Whether the input was identified as already-base64 (decoded shown)
  decoded: string | null;
  // The other direction (input → base64)
  encoded: string;
  error?: string;
}

const STD_RE = /^[A-Za-z0-9+/=\s]+$/;

function tryDecode(text: string): string | null {
  // Normalize url-safe variant
  let t = text.trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  // Add padding if missing
  while (t.length % 4 !== 0) t += '=';
  try {
    const bytes = atob(t);
    // Try to interpret as UTF-8
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(arr);
  } catch {
    return null;
  }
}

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function processBase64(text: string): Base64Result {
  const decoded = tryDecode(text);
  return {
    ok: true,
    decoded,
    encoded: encodeBase64(text),
  };
}
