import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import {
  RTCPeerConnection,
  MediaStreamTrack,
  RTCRtpCodecParameters,
  useH264,
  useOPUS,
} from "werift";
import { createAuthHandler } from "./auth.js";
import { DEFAULTS, Config } from "./constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ViewerConnection {
  ws: WebSocket;
  pc: RTCPeerConnection;
  videoTrack: MediaStreamTrack;
  audioTrack: MediaStreamTrack | null;
}

export class StreamServer {
  #httpServer: http.Server;
  #wss: WebSocketServer;
  #authenticate: (ws: WebSocket) => Promise<void>;
  #viewers = new Map<WebSocket, ViewerConnection>();
  #viewerNames = new Map<WebSocket, string>();
  #config: Config;
  #viewerCountCallback?: (count: number) => void;
  #chatCallback?: (sender: string, message: string) => void;
  #chatEnabled = true;
  #takenNames = new Set<string>();
  #hasAudio = false;

  constructor(password: string, config: Partial<Config> = {}) {
    this.#config = { ...DEFAULTS, ...config };
    this.#authenticate = createAuthHandler(password);

    this.#httpServer = http.createServer((req, res) => {
      this.#handleHttp(req, res);
    });

    this.#wss = new WebSocketServer({ server: this.#httpServer });
    this.#wss.on("connection", (ws, req) => {
      req.socket.setNoDelay(true);
      this.#handleConnection(ws);
    });
    this.#wss.on("error", () => {});
  }

  setHasAudio(hasAudio: boolean): void {
    this.#hasAudio = hasAudio;
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
    for (const viewer of this.#viewers.values()) {
      if (viewer.ws.readyState === WebSocket.OPEN) viewer.ws.send(msg);
    }
  }

  #notifyViewerCount(): void {
    const count = this.#viewers.size;
    this.#viewerCountCallback?.(count);
    const msg = JSON.stringify({ type: "viewer_count", count });
    for (const viewer of this.#viewers.values()) {
      if (viewer.ws.readyState === WebSocket.OPEN) viewer.ws.send(msg);
    }
  }

  pushVideoRtp(packet: Buffer): void {
    for (const viewer of this.#viewers.values()) {
      viewer.videoTrack.writeRtp(packet);
    }
  }

  pushAudioRtp(packet: Buffer): void {
    if (!this.#hasAudio) return;
    for (const viewer of this.#viewers.values()) {
      if (viewer.audioTrack) {
        viewer.audioTrack.writeRtp(packet);
      }
    }
  }

  resetConnections(): void {
    for (const viewer of this.#viewers.values()) {
      viewer.videoTrack.stop();
      viewer.audioTrack?.stop();
      viewer.pc.close();
      viewer.ws.close(4010, "Stream restarting");
    }
    this.#viewers.clear();
    this.#viewerNames.clear();
    this.#takenNames.clear();
    this.#notifyViewerCount();
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

    // Viewer is authenticated — wait for WebRTC signaling messages
    ws.on("message", async (raw) => {
      let str: string;
      if (typeof raw === "string") {
        str = raw;
      } else {
        try { str = raw.toString(); } catch { return; }
      }
      try {
        const msg = JSON.parse(str);
        if (msg.type === "webrtc_ready") {
          this.#setupPeerConnection(ws).catch((err) => {
            console.error("[webrtc] setup error:", err);
            ws.close(4011, "WebRTC setup failed");
          });
        } else if (msg.type === "webrtc_answer") {
          const viewer = this.#viewers.get(ws);
          if (viewer) {
            console.log("[webrtc] received answer from browser");
            try {
              await viewer.pc.setRemoteDescription({
                type: "answer",
                sdp: msg.sdp,
              });
              console.log("[webrtc] setRemoteDescription OK");
            } catch (err) {
              console.error("[webrtc] setRemoteDescription failed:", err);
              ws.close(4011, "WebRTC negotiation failed");
            }
          }
        } else if (msg.type === "set_name" && typeof msg.name === "string") {
          const name = msg.name.trim().slice(0, 30);
          if (!name) {
            ws.send(JSON.stringify({ type: "name_result", success: false, error: "Name cannot be empty" }));
            return;
          }
          const lower = name.toLowerCase();
          for (const [other, existing] of this.#viewerNames) {
            if (other !== ws && existing.toLowerCase() === lower) {
              ws.send(JSON.stringify({ type: "name_result", success: false, error: "Name already taken" }));
              return;
            }
          }
          const oldName = this.#viewerNames.get(ws);
          if (oldName) this.#takenNames.delete(oldName.toLowerCase());
          this.#viewerNames.set(ws, name);
          this.#takenNames.add(lower);
          ws.send(JSON.stringify({ type: "name_result", success: true, name }));
        } else if (msg.type === "chat" && typeof msg.message === "string") {
          if (!this.#chatEnabled) return;
          const sender = this.#viewerNames.get(ws);
          if (!sender) return;
          const text = msg.message.trim().slice(0, 500);
          if (!text) return;
          this.#broadcastChat(sender, text);
          this.#chatCallback?.(sender, text);
        }
      } catch {}
    });

    const removeViewer = () => {
      const viewer = this.#viewers.get(ws);
      if (viewer) {
        viewer.videoTrack.stop();
        viewer.audioTrack?.stop();
        viewer.pc.close();
      }
      const name = this.#viewerNames.get(ws);
      if (name) this.#takenNames.delete(name.toLowerCase());
      this.#viewers.delete(ws);
      this.#viewerNames.delete(ws);
      this.#notifyViewerCount();
    };

    ws.on("close", removeViewer);
    ws.on("error", removeViewer);
  }

  async #setupPeerConnection(ws: WebSocket): Promise<void> {
    const videoCodec = useH264({
      parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
    });
    const audioCodec = useOPUS();

    const codecs: { video: RTCRtpCodecParameters[]; audio?: RTCRtpCodecParameters[] } = {
      video: [videoCodec],
    };
    if (this.#hasAudio) {
      codecs.audio = [audioCodec];
    }

    const pc = new RTCPeerConnection({
      codecs,
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      // Ensure a loopback candidate exists — werift excludes 127.0.0.1 by
      // default, causing ICE to fail when browsers send mDNS-obfuscated
      // candidates (Chrome 75+) and mDNS resolution times out.
      iceAdditionalHostAddresses: ["127.0.0.1"],
    });

    const videoTrack = new MediaStreamTrack({ kind: "video" });
    pc.addTransceiver(videoTrack, { direction: "sendonly" });

    let audioTrack: MediaStreamTrack | null = null;
    if (this.#hasAudio) {
      audioTrack = new MediaStreamTrack({ kind: "audio" });
      pc.addTransceiver(audioTrack, { direction: "sendonly" });
    }

    // Create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Log offer summary for diagnostics
    const offerSdp = pc.localDescription!.sdp;
    const candidateLines = offerSdp.split("\n").filter((l) => l.startsWith("a=candidate"));
    const rtpmapLines = offerSdp.split("\n").filter((l) => l.startsWith("a=rtpmap")).map((l) => l.trim());
    console.log(`[webrtc] Offer ready — ${candidateLines.length} ICE candidates, codecs: ${rtpmapLines.join(" | ")}`);

    // Monitor ICE + DTLS connection state
    pc.iceConnectionStateChange.subscribe((state) => {
      console.log(`[webrtc] ICE: ${state}`);
      if (state === "disconnected" || state === "failed" || state === "closed") {
        const viewer = this.#viewers.get(ws);
        if (viewer) {
          ws.close(4011, "WebRTC connection lost");
        }
      }
    });

    pc.connectionStateChange.subscribe((state) => {
      console.log(`[webrtc] DTLS: ${state}`);
    });

    // Store the viewer
    const viewer: ViewerConnection = { ws, pc, videoTrack, audioTrack };
    this.#viewers.set(ws, viewer);
    this.#notifyViewerCount();

    // Send the offer to the browser
    ws.send(JSON.stringify({
      type: "webrtc_offer",
      sdp: pc.localDescription!.sdp,
    }));

    // Send stream info
    ws.send(JSON.stringify({
      type: "stream_info",
      fps: this.#config.fps,
      bitrate: this.#config.bitrate,
      hasAudio: this.#hasAudio,
    }));

    // Tell viewer whether chat is enabled
    ws.send(JSON.stringify({ type: "chat_enabled", enabled: this.#chatEnabled }));
  }

  #broadcastChat(sender: string, message: string): void {
    const payload = JSON.stringify({ type: "chat", sender, message });
    for (const viewer of this.#viewers.values()) {
      if (viewer.ws.readyState === WebSocket.OPEN) viewer.ws.send(payload);
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
    for (const viewer of this.#viewers.values()) {
      viewer.videoTrack.stop();
      viewer.audioTrack?.stop();
      viewer.pc.close();
      viewer.ws.close(1001, "Server shutting down");
    }
    this.#viewers.clear();
    this.#wss.close();
    this.#httpServer.close();
  }
}
