import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import Mp4Frag from 'mp4frag';
import { createAuthHandler } from './auth.js';
import { DEFAULTS, Config } from './constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class StreamServer {
  #httpServer: http.Server;
  #wss: WebSocketServer;
  #mp4frag: Mp4Frag;
  #authenticate: (ws: WebSocket) => Promise<void>;
  #viewers = new Set<WebSocket>();
  #config: Config;
  #viewerCountCallback?: (count: number) => void;
  #mime: string | null = null;

  constructor(password: string, config: Partial<Config> = {}) {
    this.#config = { ...DEFAULTS, ...config };
    this.#authenticate = createAuthHandler(password);

    this.#mp4frag = new Mp4Frag();

    this.#mp4frag.on('initialized', ({ mime }) => {
      this.#mime = mime;
    });

    this.#mp4frag.on('segment', ({ segment }) => {
      this.#broadcast(segment);
    });

    this.#httpServer = http.createServer((req, res) => {
      this.#handleHttp(req, res);
    });

    this.#wss = new WebSocketServer({ server: this.#httpServer });
    this.#wss.on('connection', (ws) => this.#handleConnection(ws));
  }

  get viewerCount(): number {
    return this.#viewers.size;
  }

  onViewerCountChange(callback: (count: number) => void): void {
    this.#viewerCountCallback = callback;
  }

  #notifyViewerCount(): void {
    this.#viewerCountCallback?.(this.#viewers.size);
  }

  pushData(chunk: Buffer): void {
    this.#mp4frag.write(chunk);
  }

  resetParser(): void {
    // On FFmpeg restart, create a new mp4frag instance
    const oldFrag = this.#mp4frag;
    this.#mp4frag = new Mp4Frag();

    this.#mp4frag.on('initialized', ({ mime }) => {
      this.#mime = mime;
    });

    this.#mp4frag.on('segment', ({ segment }) => {
      this.#broadcast(segment);
    });

    // Disconnect all viewers — they'll reconnect and get the new init segment
    for (const viewer of this.#viewers) {
      viewer.close(4010, 'Stream restarting');
    }
    this.#viewers.clear();
    this.#notifyViewerCount();

    oldFrag.destroy();
  }

  async #handleConnection(ws: WebSocket): Promise<void> {
    if (this.#viewers.size >= this.#config.maxViewers) {
      ws.close(4005, 'Max viewers reached');
      return;
    }

    try {
      await this.#authenticate(ws);
    } catch {
      return;
    }

    this.#viewers.add(ws);
    this.#notifyViewerCount();

    // Send mime + init segment for late joiners
    const init = this.#mp4frag.initialization;
    if (init) {
      if (this.#mime) {
        ws.send(JSON.stringify({ type: 'mime', mime: this.#mime }));
      }
      ws.send(init, { binary: true });
    }

    ws.on('close', () => {
      this.#viewers.delete(ws);
      this.#notifyViewerCount();
    });

    ws.on('error', () => {
      this.#viewers.delete(ws);
      this.#notifyViewerCount();
    });
  }

  #broadcast(segment: Buffer): void {
    for (const ws of this.#viewers) {
      if (ws.readyState !== WebSocket.OPEN) {
        this.#viewers.delete(ws);
        this.#notifyViewerCount();
        continue;
      }

      // Backpressure check
      if (ws.bufferedAmount > this.#config.backpressureLimit) {
        ws.close(4006, 'Too slow');
        this.#viewers.delete(ws);
        this.#notifyViewerCount();
        continue;
      }

      ws.send(segment, { binary: true });
    }
  }

  #handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url === '/' || req.url === '/index.html') {
      const viewerPath = path.join(__dirname, 'viewer.html');
      fs.readFile(viewerPath, (err, data) => {
        if (err) {
          res.writeHead(500);
          res.end('Server error');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.#httpServer.listen(port, () => resolve());
    });
  }

  close(): void {
    for (const ws of this.#viewers) {
      ws.close(1001, 'Server shutting down');
    }
    this.#viewers.clear();
    this.#wss.close();
    this.#httpServer.close();
    this.#mp4frag.destroy();
  }
}
