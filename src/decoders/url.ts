// URL encode/decode + structured URL inspection.

export interface UrlResult {
  decoded: string;
  encoded: string;
  parts: UrlParts | null;
}

export interface UrlParts {
  scheme: string;
  host: string;
  port: string;
  pathname: string;
  query: { key: string; value: string }[];
  hash: string;
}

function looksLikeFullUrl(text: string): boolean {
  return /^[a-z][a-z0-9+.\-]*:\/\//i.test(text.trim());
}

export function processUrl(text: string): UrlResult {
  const t = text.trim();
  let decoded = t;
  try { decoded = decodeURIComponent(t); } catch { /* malformed */ }
  const encoded = encodeURIComponent(t);
  const parts = looksLikeFullUrl(t) ? parseUrl(t) : null;
  return { decoded, encoded, parts };
}

function parseUrl(raw: string): UrlParts | null {
  try {
    const u = new URL(raw);
    const query: { key: string; value: string }[] = [];
    u.searchParams.forEach((v, k) => query.push({ key: k, value: v }));
    return {
      scheme:   u.protocol.replace(/:$/, ''),
      host:     u.hostname,
      port:     u.port,
      pathname: u.pathname,
      query,
      hash:     u.hash.replace(/^#/, ''),
    };
  } catch {
    return null;
  }
}
