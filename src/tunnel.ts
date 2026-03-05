import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export class Tunnel extends EventEmitter {
  #process: ChildProcess | null = null;

  start(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('cloudflared', [
        'tunnel', '--url', `http://localhost:${port}`,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.#process = proc;
      let resolved = false;

      const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

      const handleOutput = (data: Buffer): void => {
        const text = data.toString();
        const match = text.match(urlRegex);
        if (match && !resolved) {
          resolved = true;
          resolve(match[0]);
        }
      };

      proc.stdout!.on('data', handleOutput);
      proc.stderr!.on('data', handleOutput);

      proc.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`cloudflared failed to start: ${err.message}`));
        }
        this.emit('error', err);
      });

      proc.on('close', (code: number | null) => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`cloudflared exited with code ${code}`));
        }
        this.emit('close', code);
      });

      // Timeout after 30s
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Timed out waiting for cloudflared tunnel URL'));
        }
      }, 30000);
    });
  }

  stop(): void {
    if (this.#process) {
      this.#process.kill('SIGTERM');
      this.#process = null;
    }
  }
}
