import spawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { MCPServerConfig } from '../mcp-config.js';

/** SDK framing with bounded output and invocation-owned process-tree cleanup. */
export class OwnedMCPStdioTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  private process?: ChildProcess;
  private closed?: Promise<void>;
  private closing?: Promise<void>;
  private readonly buffer = new ReadBuffer();
  private bytes = 0;
  constructor(private readonly config: MCPServerConfig) {}

  async start(): Promise<void> {
    if (this.process || this.closing) throw new Error('MCP transport already started or closed');
    const child = spawn(this.config.command!, this.config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...getDefaultEnvironment(), ...this.config.env },
    });
    this.process = child;
    this.closed = new Promise(resolve => child.once('close', () => { this.buffer.clear(); this.onclose?.(); resolve(); }));
    const collect = (chunk: Buffer, stdout: boolean) => {
      this.bytes += chunk.length;
      if (this.bytes > 256 * 1024) { this.onerror?.(new Error('MCP 返回内容超过大小限制。')); void this.close(); return; }
      if (!stdout) return;
      try {
        this.buffer.append(chunk);
        while (true) { const message = this.buffer.readMessage(); if (message === null) break; this.onmessage?.(message); }
      } catch { this.onerror?.(new Error('MCP 返回了无效的协议消息。')); void this.close(); }
    };
    child.stdout!.on('data', chunk => collect(chunk, true));
    // Never inherit stderr or expose subprocess logs containing credentials.
    child.stderr!.on('data', chunk => collect(chunk, false));
    child.stdin!.on('error', () => {});
    child.on('error', () => this.onerror?.(new Error('MCP 进程启动失败，请核对可执行文件和参数。')));
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new Error('MCP 进程启动失败，请核对可执行文件和参数。'))); });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.process?.stdin || this.closing) throw new Error('MCP transport is closed');
    const text = serializeMessage(message);
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error('MCP 请求内容超过大小限制。');
    await new Promise<void>((resolve, reject) => this.process!.stdin!.write(text, error => error ? reject(new Error('MCP 请求写入失败。')) : resolve()));
  }

  close(): Promise<void> {
    if (!this.closing) this.closing = (async () => {
      const child = this.process;
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        // Kill descendants before waiting for pipe EOF; a grandchild may hold the pipes open.
        if (process.platform === 'win32') {
          await new Promise<void>(resolve => {
            const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
            killer.once('error', () => { child.kill(); resolve(); });
            killer.once('close', () => resolve());
          });
        } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      }
      await this.closed;
    })();
    return this.closing;
  }
}
