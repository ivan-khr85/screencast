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

      // Timeout after 30s
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          proc.kill('SIGTERM');
          if (this.#process === proc) this.#process = null;
          reject(new Error('Timed out waiting for cloudflared tunnel URL'));
        }
      }, 30000);

      const handleOutput = (data: Buffer): void => {
        const text = data.toString();
        const match = text.match(urlRegex);
        if (match && !resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(match[0]);
        }
      };

      proc.stdout!.on('data', handleOutput);
      proc.stderr!.on('data', handleOutput);

      proc.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(new Error(`cloudflared failed to start: ${err.message}`));
        }
        // emit('error') with no listener throws — only forward when subscribed
        if (this.listenerCount('error') > 0) this.emit('error', err);
      });

      proc.on('close', (code: number | null) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(new Error(`cloudflared exited with code ${code}`));
        }
        this.emit('close', code);
      });
    });
  }

  stop(): void {
    if (this.#process) {
      this.#process.kill('SIGTERM');
      this.#process = null;
    }
  }
}
