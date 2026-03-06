import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import Mp4Frag from "mp4frag";
import { createAuthHandler } from "./auth.js";
import { DEFAULTS, Config } from "./constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class StreamServer {
  #httpServer: http.Server;
  #wss: WebSocketServer;
  #mp4frag: Mp4Frag;
  #authenticate: (ws: WebSocket) => Promise<void>;
  #viewers = new Set<WebSocket>();
  #viewerNames = new Map<WebSocket, string>();
  #waitingForInit = new Set<WebSocket>();
  #config: Config;
  #viewerCountCallback?: (count: number) => void;
  #chatCallback?: (sender: string, message: string) => void;
  #chatEnabled = true;
  #mime: string | null = null;
  #takenNames = new Set<string>();
  #hasAudio = false;

  constructor(password: string, config: Partial<Config> = {}) {
    this.#config = { ...DEFAULTS, ...config };
    this.#authenticate = createAuthHandler(password);

    this.#mp4frag = new Mp4Frag();
    this.#setupMp4Frag();

    this.#httpServer = http.createServer((req, res) => {
      this.#handleHttp(req, res);
    });

    this.#wss = new WebSocketServer({ server: this.#httpServer });
    this.#wss.on("connection", (ws, req) => {
      // Disable Nagle's algorithm for lower latency
      req.socket.setNoDelay(true);
      this.#handleConnection(ws);
    });
    this.#wss.on("error", () => {
      // Handled by the HTTP server's error listener in listen()
    });
  }

  setHasAudio(hasAudio: boolean): void {
    this.#hasAudio = hasAudio;
  }

  #setupMp4Frag(): void {
    this.#mp4frag.on("error", (err: Error) => {
      console.error(`  [server] mp4frag error: ${err.message}`);
    });

    this.#mp4frag.on("initialized", ({ mime }) => {
      this.#mime = mime;

      // Send init segment to viewers that connected before ffmpeg was ready
      const init = this.#mp4frag.initialization;
      if (init && this.#waitingForInit.size > 0) {
        const tagged = this.#tagVideo(init);
        for (const ws of this.#waitingForInit) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "mime", mime: this.#mime }));
            ws.send(tagged, { binary: true });
          }
        }
        this.#waitingForInit.clear();
      }
    });

    this.#mp4frag.on("segment", ({ segment }) => {
      this.#broadcast(this.#tagVideo(segment));
    });
  }

  #tagVideo(buf: Buffer): Buffer {
    const tagged = Buffer.allocUnsafe(1 + buf.length);
    tagged[0] = 0x00;
    buf.copy(tagged, 1);
    return tagged;
  }

  get viewerCount(): number {
    return this.#viewers.size;
  }

  onViewerCountChange(callback: (count: number) => void): void {
    this.#viewerCountCallback = callback;
  }

  onChat(callback: (sender: string, message: string) => void): void {
    this.#chatCallback = callback;
  }

  setChatEnabled(enabled: boolean): void {
    this.#chatEnabled = enabled;
    const msg = JSON.stringify({ type: "chat_enabled", enabled });
    for (const ws of this.#viewers) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  #notifyViewerCount(): void {
    const count = this.#viewers.size;
    this.#viewerCountCallback?.(count);
    const msg = JSON.stringify({ type: "viewer_count", count });
    for (const ws of this.#viewers) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  pushData(chunk: Buffer): void {
    this.#mp4frag.write(chunk);
  }

  pushAudio(chunk: Buffer): void {
    const tagged = Buffer.allocUnsafe(1 + chunk.length);
    tagged[0] = 0x01;
    chunk.copy(tagged, 1);
    this.#broadcast(tagged);
  }

  resetParser(): void {
    const oldFrag = this.#mp4frag;
    this.#mp4frag = new Mp4Frag();
    this.#mime = null;
    this.#setupMp4Frag();

    // Disconnect all viewers — they'll reconnect and get the new init segment
    for (const viewer of this.#viewers) {
      viewer.close(4010, "Stream restarting");
    }
    this.#viewers.clear();
    this.#viewerNames.clear();
    this.#takenNames.clear();
    this.#waitingForInit.clear();
    this.#notifyViewerCount();

    oldFrag.destroy();
  }

  async #handleConnection(ws: WebSocket): Promise<void> {
    if (this.#viewers.size >= this.#config.maxViewers) {
      ws.close(4005, "Max viewers reached");
      return;
    }

    try {
      await this.#authenticate(ws);
    } catch {
      return;
    }

    this.#viewers.add(ws);
    this.#notifyViewerCount();

    // Send stream info + latency settings for the viewer
    ws.send(
      JSON.stringify({
        type: "stream_info",
        fps: this.#config.fps,
        bitrate: this.#config.bitrate,
        hasAudio: this.#hasAudio,
        audioSampleRate: this.#config.audioSampleRate,
        audioChannels: this.#config.audioChannels,
        liveEdgeThreshold: this.#config.liveEdgeThreshold,
        bufferEvictionSeconds: this.#config.bufferEvictionSeconds,
      }),
    );

    // Send mime + init segment for late joiners
    const init = this.#mp4frag.initialization;
    if (init) {
      if (this.#mime) {
        ws.send(JSON.stringify({ type: "mime", mime: this.#mime }));
      }
      ws.send(this.#tagVideo(init), { binary: true });
    } else {
      this.#waitingForInit.add(ws);
    }

    // Tell viewer whether chat is enabled
    ws.send(JSON.stringify({ type: "chat_enabled", enabled: this.#chatEnabled }));

    ws.on("message", (raw) => {
      let str: string;
      if (typeof raw === "string") {
        str = raw;
      } else {
        try { str = raw.toString(); } catch { return; }
      }
      try {
        const msg = JSON.parse(str);
        if (msg.type === "set_name" && typeof msg.name === "string") {
          const name = msg.name.trim().slice(0, 30);
          if (!name) {
            ws.send(JSON.stringify({ type: "name_result", success: false, error: "Name cannot be empty" }));
            return;
          }
          const lower = name.toLowerCase();
          // Check if another viewer already has this name
          for (const [other, existing] of this.#viewerNames) {
            if (other !== ws && existing.toLowerCase() === lower) {
              ws.send(JSON.stringify({ type: "name_result", success: false, error: "Name already taken" }));
              return;
            }
          }
          // Remove old name from taken set
          const oldName = this.#viewerNames.get(ws);
          if (oldName) this.#takenNames.delete(oldName.toLowerCase());
          this.#viewerNames.set(ws, name);
          this.#takenNames.add(lower);
          ws.send(JSON.stringify({ type: "name_result", success: true, name }));
          return;
        }
        if (msg.type === "chat" && typeof msg.message === "string") {
          if (!this.#chatEnabled) return;
          const sender = this.#viewerNames.get(ws);
          if (!sender) return; // Must set name first
          const text = msg.message.trim().slice(0, 500);
          if (!text) return;
          this.#broadcastChat(sender, text);
          this.#chatCallback?.(sender, text);
        }
      } catch {}
    });

    const removeViewer = () => {
      const name = this.#viewerNames.get(ws);
      if (name) this.#takenNames.delete(name.toLowerCase());
      this.#viewers.delete(ws);
      this.#viewerNames.delete(ws);
      this.#waitingForInit.delete(ws);
      this.#notifyViewerCount();
    };

    ws.on("close", removeViewer);
    ws.on("error", removeViewer);
  }

  #broadcastChat(sender: string, message: string): void {
    const payload = JSON.stringify({ type: "chat", sender, message });
    for (const ws of this.#viewers) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  #broadcast(data: Buffer): void {
    for (const ws of this.#viewers) {
      if (ws.readyState !== WebSocket.OPEN) {
        this.#viewers.delete(ws);
        this.#waitingForInit.delete(ws);
        this.#notifyViewerCount();
        continue;
      }

      // Skip viewers that haven't received init segment yet
      if (this.#waitingForInit.has(ws)) {
        continue;
      }

      // Backpressure check
      if (ws.bufferedAmount > this.#config.backpressureLimit) {
        ws.close(4006, "Too slow");
        this.#viewers.delete(ws);
        this.#waitingForInit.delete(ws);
        this.#notifyViewerCount();
        continue;
      }

      ws.send(data, { binary: true });
    }
  }

  #handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const STATIC_FILES: Record<string, { file: string; type: string }> = {
      "/": { file: "viewer.html", type: "text/html; charset=utf-8" },
      "/index.html": { file: "viewer.html", type: "text/html; charset=utf-8" },
      "/viewer.css": { file: "viewer.css", type: "text/css; charset=utf-8" },
      "/viewer.js": { file: "viewer.js", type: "application/javascript; charset=utf-8" },
    };

    const entry = STATIC_FILES[req.url ?? ""];
    if (entry) {
      const filePath = path.join(__dirname, entry.file);
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(500);
          res.end("Server error");
          return;
        }
        res.writeHead(200, { "Content-Type": entry.type });
        res.end(data);
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#httpServer.once("error", reject);
      this.#httpServer.listen(port, () => {
        this.#httpServer.removeListener("error", reject);
        resolve();
      });
    });
  }

  close(): void {
    for (const ws of this.#viewers) {
      ws.close(1001, "Server shutting down");
    }
    this.#viewers.clear();
    this.#waitingForInit.clear();
    this.#wss.close();
    this.#httpServer.close();
    this.#mp4frag.destroy();
  }
}
