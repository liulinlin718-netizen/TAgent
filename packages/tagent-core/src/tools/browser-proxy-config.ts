import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

let cached: { until: number; value: Promise<URL | undefined> } | undefined;

/** Operator-controlled network infrastructure only, never a URL supplied by an Agent or webpage. */
export function browserUpstreamProxy(): Promise<URL | undefined> {
  if (cached && cached.until > Date.now()) return cached.value;
  const value = resolveProxy();
  cached = { until: Date.now() + 30_000, value };
  return value;
}

async function resolveProxy(): Promise<URL | undefined> {
  let raw = process.env.TAGENT_BROWSER_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (raw === 'direct') return undefined;
  if (!raw && process.platform === 'win32') {
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; @{enabled=$p.ProxyEnable;server=$p.ProxyServer} | ConvertTo-Json -Compress"],
    { windowsHide: true, timeout: 5000, maxBuffer: 16384 });
    const config = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''));
    if (config.enabled && typeof config.server === 'string') {
      const pairs = new Map(config.server.split(';').filter((value: string) => value.includes('=')).map((value: string) => value.split('=')));
      raw = pairs.size ? String(pairs.get('https') || pairs.get('http') || '') : config.server;
    }
  }
  if (!raw) return undefined;
  if (!raw.includes('://')) raw = `http://${raw}`;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Browser upstream proxy must be an operator-configured HTTP(S) proxy endpoint');
  }
  return url;
}
