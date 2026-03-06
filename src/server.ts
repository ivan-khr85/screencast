import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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

function getLocalIpAddresses(): string[] {
  const addresses = ["127.0.0.1"];
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const info of iface) {
      if (info.family === "IPv4" && !info.internal) {
        addresses.push(info.address);
      }
    }
  }
  return addresses;
}

interface ViewerConnection {
  ws: WebSocket;
  pc: RTCPeerConnection;
  videoTrack: MediaStreamTrack;
  audioTrack: MediaStreamTrack | null;
  ready: boolean;
  waitingForKeyframe: boolean;
}

// Returns true if the RTP packet marks the start of a new GOP — the safe
// point to begin streaming to a new viewer. Handles all H264 RTP formats:
//   - Single-NALU SPS (type 7)
//   - STAP-A (type 24) whose first NAL is SPS — FFmpeg bundles SPS+PPS
//     into one STAP-A packet rather than sending them separately
//   - Single-NALU IDR (type 5) — fallback if encoder omits inline SPS
//   - FU-A (type 28) starting an IDR — fallback for large IDR fragments
function isH264GopStartRtp(packet: Buffer): boolean {
  if (packet.length < 13) return false;
  const cc = packet[0] & 0x0f;
  const hasExt = (packet[0] >> 4) & 0x01;
  let offset = 12 + cc * 4;
  if (hasExt) {
    if (packet.length < offset + 4) return false;
    const extLen = packet.readUInt16BE(offset + 2) * 4;
    offset += 4 + extLen;
  }
  if (packet.length <= offset) return false;
  const nalType = packet[offset] & 0x1f;
  if (nalType === 7) return true; // single-NALU SPS
  if (nalType === 5) return true; // single-NALU IDR
  if (nalType === 24 && packet.length > offset + 3) {
    // STAP-A: first contained NAL starts at offset+3 (1 header + 2 size bytes)
    const firstNal = packet[offset + 3] & 0x1f;
    return firstNal === 7 || firstNal === 5; // SPS or IDR inside STAP-A
  }
  if (nalType === 28 && packet.length > offset + 1) {
    // FU-A: start fragment (S bit set) of an IDR slice
    const fuHeader = packet[offset + 1];
    return (fuHeader & 0x80) !== 0 && (fuHeader & 0x1f) === 5;
  }
  return false;
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
  #videoRtpCount = 0;
  #audioRtpCount = 0;

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
    this.#videoRtpCount++;
    if (this.#videoRtpCount === 1) console.log('[server] first video RTP → pushing to viewers');
    if (this.#videoRtpCount % 300 === 0) {
      const viewerInfo = [...this.#viewers.values()].map((v) =>
        `ready=${v.ready} waiting=${v.waitingForKeyframe} ice=${v.pc.iceConnectionState} conn=${v.pc.connectionState}`
      ).join("; ");
      console.log(`[server] video RTP: ${this.#videoRtpCount} packets, viewers=${this.#viewers.size}${this.#viewers.size > 0 ? ` [${viewerInfo}]` : ""}`);
    }
    // On SPS packet (start of new GOP): allow viewers that connected mid-stream
    // to begin receiving. They will get SPS → PPS → IDR in sequence, ensuring
    // the decoder has a clean reference frame and no green/pink artifacts.
    if (isH264GopStartRtp(packet)) {
      for (const viewer of this.#viewers.values()) {
        if (viewer.ready && viewer.waitingForKeyframe) {
          viewer.waitingForKeyframe = false;
          console.log('[server] viewer keyframe gate lifted — starting stream');
        }
      }
    }
    for (const viewer of this.#viewers.values()) {
      if (viewer.ready && !viewer.waitingForKeyframe) viewer.videoTrack.writeRtp(packet);
    }
  }

  pushAudioRtp(packet: Buffer): void {
    if (!this.#hasAudio) return;
    this.#audioRtpCount++;
    if (this.#audioRtpCount === 1) console.log('[server] first audio RTP → pushing to viewers');
    if (this.#audioRtpCount % 300 === 0) console.log(`[server] audio RTP: ${this.#audioRtpCount} packets, viewers=${this.#viewers.size}`);
    for (const viewer of this.#viewers.values()) {
      if (viewer.ready && viewer.audioTrack) {
        viewer.audioTrack.writeRtp(packet);
      }
    }
  }

  resetConnections(): void {
    console.log(`[server] resetConnections: closing ${this.#viewers.size} viewer(s)`);
    this.#videoRtpCount = 0;
    this.#audioRtpCount = 0;
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
    console.log(`[server] new WS connection (viewers=${this.#viewers.size}/${this.#config.maxViewers})`);
    if (this.#viewers.size >= this.#config.maxViewers) {
      ws.close(4005, "Max viewers reached");
      return;
    }

    try {
      await this.#authenticate(ws);
    } catch {
      console.log('[server] authentication failed');
      return;
    }
    console.log('[server] viewer authenticated');

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
            const answerCands = (msg.sdp as string).split('\n').filter((l) => l.startsWith('a=candidate'));
            const aHost = answerCands.filter((c) => c.includes('typ host')).length;
            const aSrflx = answerCands.filter((c) => c.includes('typ srflx')).length;
            console.log(`[webrtc] answer ICE: ${answerCands.length} total, ${aHost} host, ${aSrflx} srflx`);
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
    console.log(`[server] #setupPeerConnection: hasAudio=${this.#hasAudio}`);
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

    const localAddresses = getLocalIpAddresses();
    console.log(`[webrtc] local addresses for ICE: ${localAddresses.join(", ")}`);

    const pc = new RTCPeerConnection({
      codecs,
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
      ],
      // Include all local network interface IPs so remote viewers on the
      // same LAN can reach us via host candidates. Also includes 127.0.0.1
      // for same-machine viewers (browsers send mDNS-obfuscated candidates
      // that werift can't resolve, so the loopback fallback is still needed).
      iceAdditionalHostAddresses: localAddresses,
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

    // Wait for ICE gathering to complete so srflx (STUN public-IP) candidates are
    // included in the offer. Without this, remote viewers on different networks get
    // only host candidates and ICE fails → black screen.
    if (pc.iceGatheringState !== 'complete') {
      await Promise.race([
        new Promise<void>((resolve) => {
          const sub = pc.iceGatheringStateChange.subscribe((state: string) => {
            if (state === 'complete') { sub.unSubscribe(); resolve(); }
          });
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    }

    // Log offer summary for diagnostics
    const offerSdp = pc.localDescription!.sdp;
    const candidateLines = offerSdp.split("\n").filter((l) => l.startsWith("a=candidate"));
    const rtpmapLines = offerSdp.split("\n").filter((l) => l.startsWith("a=rtpmap")).map((l) => l.trim());
    const profileLine = offerSdp.split("\n").find((l) => l.includes("profile-level-id"))?.trim();
    const hostCount = candidateLines.filter((c) => c.includes("typ host")).length;
    const srflxCount = candidateLines.filter((c) => c.includes("typ srflx")).length;
    const relayCount = candidateLines.filter((c) => c.includes("typ relay")).length;
    console.log(`[server] offer ready — ${candidateLines.length} ICE candidates (${hostCount} host, ${srflxCount} srflx, ${relayCount} relay), gathering=${pc.iceGatheringState}, codecs: ${rtpmapLines.join(" | ")}`);
    console.log(`[server] offer H264 profile: ${profileLine ?? "not found"}`);
    if (srflxCount === 0) console.warn('[server] WARNING: no srflx candidates — remote viewers on different networks may see black screen (STUN may have failed or timed out)');
    candidateLines.forEach((c) => console.log(`[server] ICE: ${c.trim()}`));

    // Store the viewer (not ready until DTLS+ICE both complete; then gated
    // until first SPS so the browser always starts on a clean I-frame boundary)
    const viewer: ViewerConnection = { ws, pc, videoTrack, audioTrack, ready: false, waitingForKeyframe: true };

    // Timeout: disconnect if DTLS+ICE don't complete within 15s
    const connectionTimeout = setTimeout(() => {
      if (!viewer.ready) {
        console.warn('[webrtc] connection timeout — DTLS/ICE did not complete within 15s');
        if (this.#viewers.has(ws)) {
          ws.close(4011, "WebRTC connection timed out");
        }
      }
    }, 15000);
    ws.on("close", () => clearTimeout(connectionTimeout));

    // ICE state — logging only (not used for ready gate)
    pc.iceConnectionStateChange.subscribe((state) => {
      console.log(`[webrtc] ICE: ${state}`);
    });

    // Connection state — includes DTLS; this is the gate for media flow.
    // werift fires "connected" only after both ICE and DTLS complete
    // (peerConnection.js:583), guaranteeing dtlsTransport.state === "connected"
    // so rtpSender.sendRtp() won't silently drop packets.
    pc.connectionStateChange.subscribe((state) => {
      console.log(`[webrtc] connection: ${state}`);
      if (state === "connected") {
        clearTimeout(connectionTimeout);
        viewer.ready = true;
        viewer.waitingForKeyframe = true; // wait for next SPS before forwarding
        console.log("[webrtc] viewer ready — DTLS+ICE complete, waiting for next keyframe");
      }
      if (state === "failed" || state === "closed") {
        clearTimeout(connectionTimeout);
        viewer.ready = false;
        if (this.#viewers.has(ws)) {
          ws.close(4011, "WebRTC connection lost");
        }
      }
    });

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
