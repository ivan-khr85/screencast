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
import { RemuxPipeline } from "./remux.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Binary WS frame prefixes for the fMP4 fallback stream.
const FRAME_INIT = Buffer.from([0x01]);
const FRAME_SEGMENT = Buffer.from([0x02]);

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
  // 'webrtc' streams RTP through a werift peer connection; 'ws' streams
  // fMP4 segments over the signaling WebSocket (MSE fallback for viewers
  // whose networks block the direct UDP media path).
  transport: "webrtc" | "ws";
  pc: RTCPeerConnection | null;
  videoTrack: MediaStreamTrack | null;
  audioTrack: MediaStreamTrack | null;
  ready: boolean;
  waitingForKeyframe: boolean; // webrtc: gate until next SPS
  wsWaitingForSegment: boolean; // ws: init sent, start on next segment
  iceCandidateCount: number; // trickle-ICE flood cap
  connectionTimeout: NodeJS.Timeout | null;
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
  #debugEnabled = true;
  #hasAudio = false;
  #videoRtpCount = 0;
  #audioRtpCount = 0;
  #authFailures = new Map<string, { count: number; resetAt: number }>();
  #wsAlive = new WeakMap<WebSocket, boolean>();
  #keepaliveTimer: NodeJS.Timeout;
  // fMP4-over-WS fallback: lazily spawned remux pipeline fed by teeing the
  // live RTP; payload types are sniffed from the first packets seen.
  #remux: RemuxPipeline | null = null;
  #remuxRespawns = 0;
  #remuxStopTimer: NodeJS.Timeout | null = null;
  #remuxAudioWaitTimer: NodeJS.Timeout | null = null;
  #videoPt: number | null = null;
  #audioPt: number | null = null;

  constructor(password: string, config: Partial<Config> = {}) {
    this.#config = { ...DEFAULTS, ...config };
    this.#authenticate = createAuthHandler(password);

    this.#httpServer = http.createServer((req, res) => {
      this.#handleHttp(req, res);
    });

    this.#wss = new WebSocketServer({ server: this.#httpServer, maxPayload: 64 * 1024 });
    this.#wss.on("connection", (ws, req) => {
      req.socket.setNoDelay(true);
      this.#wsAlive.set(ws, true);
      ws.on("pong", () => this.#wsAlive.set(ws, true));
      this.#handleConnection(ws, req);
    });
    this.#wss.on("error", (err) => console.error('[server] wss error:', err.message));

    // Keepalive: protocol pings detect dead sockets (NAT/proxy idle drops,
    // sleeping devices) so they don't linger as ghost viewers; the JSON ping
    // feeds the browser-side watchdog, which can't observe protocol pings.
    this.#keepaliveTimer = setInterval(() => {
      const jsonPing = JSON.stringify({ type: "ping", t: Date.now() });
      for (const ws of this.#wss.clients) {
        if (this.#wsAlive.get(ws) === false) {
          console.log('[server] keepalive: terminating unresponsive socket');
          ws.terminate();
          continue;
        }
        this.#wsAlive.set(ws, false);
        try { ws.ping(); } catch {}
      }
      for (const viewer of this.#viewers.values()) {
        if (viewer.ws.readyState === WebSocket.OPEN) viewer.ws.send(jsonPing);
      }
    }, 25_000);
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

  // Host toggle for the viewer-side debug panel (connection/playback
  // internals). Cosmetic gate — the same data is reachable via devtools.
  setDebugEnabled(enabled: boolean): void {
    this.#debugEnabled = enabled;
    const msg = JSON.stringify({ type: "debug_enabled", enabled });
    for (const viewer of this.#viewers.values()) {
      if (viewer.ws.readyState === WebSocket.OPEN) viewer.ws.send(msg);
    }
  }

  #notifyViewerCount(): void {
    const count = this.#viewers.size;
    this.#viewerCountCallback?.(count);
    const msg = JSON.stringify({ type: "viewer_count", count, maxViewers: this.#config.maxViewers });
    for (const viewer of this.#viewers.values()) {
      if (viewer.ws.readyState === WebSocket.OPEN) viewer.ws.send(msg);
    }
  }

  pushVideoRtp(packet: Buffer): void {
    this.#videoRtpCount++;
    if (this.#videoRtpCount === 1) console.log('[server] first video RTP → pushing to viewers');
    if (this.#videoPt === null && packet.length >= 12) {
      this.#videoPt = packet[1] & 0x7f;
      this.#maybeStartRemux();
    }
    if (this.#videoRtpCount % 300 === 0) {
      const viewerInfo = [...this.#viewers.values()].map((v) =>
        v.transport === "ws"
          ? `ready=${v.ready} transport=ws`
          : `ready=${v.ready} waiting=${v.waitingForKeyframe} ice=${v.pc?.iceConnectionState ?? "-"} conn=${v.pc?.connectionState ?? "-"}`
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
      if (viewer.ready && !viewer.waitingForKeyframe && viewer.videoTrack) viewer.videoTrack.writeRtp(packet);
    }
    this.#remux?.writeVideoRtp(packet);
  }

  pushAudioRtp(packet: Buffer): void {
    if (!this.#hasAudio) return;
    this.#audioRtpCount++;
    if (this.#audioRtpCount === 1) console.log('[server] first audio RTP → pushing to viewers');
    if (this.#audioPt === null && packet.length >= 12) {
      this.#audioPt = packet[1] & 0x7f;
      this.#maybeStartRemux();
    }
    if (this.#audioRtpCount % 300 === 0) console.log(`[server] audio RTP: ${this.#audioRtpCount} packets, viewers=${this.#viewers.size}`);
    for (const viewer of this.#viewers.values()) {
      if (viewer.ready && viewer.audioTrack) {
        viewer.audioTrack.writeRtp(packet);
      }
    }
    this.#remux?.writeAudioRtp(packet);
  }

  resetConnections(): void {
    console.log(`[server] resetConnections: closing ${this.#viewers.size} viewer(s)`);
    this.#resetStreamState();
    for (const viewer of this.#viewers.values()) {
      if (viewer.connectionTimeout) clearTimeout(viewer.connectionTimeout);
      viewer.videoTrack?.stop();
      viewer.audioTrack?.stop();
      viewer.pc?.close();
      viewer.ws.close(4010, "Stream restarting");
    }
    this.#viewers.clear();
    this.#viewerNames.clear();
    this.#notifyViewerCount();
  }

  // Capture pipeline restarted (new encoder, fresh RTP stream): renegotiate
  // every viewer in place instead of dropping them. WebRTC viewers get a new
  // peer connection + offer over their existing socket; WS-fallback viewers
  // get a fresh init segment when the remux respawns on the new stream.
  restartStreams(): void {
    console.log(`[server] restartStreams: refreshing ${this.#viewers.size} viewer(s) in place`);
    this.#resetStreamState();
    const restarting = JSON.stringify({ type: "stream_restarting" });
    for (const viewer of this.#viewers.values()) {
      if (viewer.ws.readyState === WebSocket.OPEN) {
        try { viewer.ws.send(restarting); } catch {}
      }
      if (viewer.transport === "webrtc") {
        if (viewer.connectionTimeout) { clearTimeout(viewer.connectionTimeout); viewer.connectionTimeout = null; }
        viewer.videoTrack?.stop();
        viewer.audioTrack?.stop();
        const oldPc = viewer.pc;
        viewer.pc = null; // detach before close so its state handler stays quiet
        viewer.videoTrack = null;
        viewer.audioTrack = null;
        oldPc?.close();
        viewer.ready = false;
        viewer.waitingForKeyframe = true;
        viewer.iceCandidateCount = 0;
        this.#setupWebRTC(viewer).catch((err) => {
          console.error("[webrtc] restart setup error:", err);
          viewer.ws.close(4011, "WebRTC setup failed");
        });
      } else {
        viewer.ready = false;
        viewer.wsWaitingForSegment = false;
      }
    }
  }

  // Reset per-stream state (RTP counters, sniffed payload types, remux) —
  // used when the capture pipeline restarts and produces a fresh stream.
  #resetStreamState(): void {
    this.#videoRtpCount = 0;
    this.#audioRtpCount = 0;
    this.#videoPt = null;
    this.#audioPt = null;
    this.#stopRemux();
  }

  #stopRemux(): void {
    if (this.#remuxStopTimer) { clearTimeout(this.#remuxStopTimer); this.#remuxStopTimer = null; }
    if (this.#remuxAudioWaitTimer) { clearTimeout(this.#remuxAudioWaitTimer); this.#remuxAudioWaitTimer = null; }
    if (this.#remux) {
      this.#remux.stop();
      this.#remux = null;
    }
  }

  #hasFallbackViewers(): boolean {
    for (const v of this.#viewers.values()) {
      if (v.transport === "ws") return true;
    }
    return false;
  }

  // Start the remux pipeline when there's demand and the payload types are
  // known. If audio is expected but hasn't flowed within 3s (e.g. the audio
  // pipeline died), start video-only rather than never starting.
  #maybeStartRemux(): void {
    if (this.#remux || !this.#hasFallbackViewers() || this.#videoPt === null) return;
    const audioReady = !this.#hasAudio || this.#audioPt !== null;
    if (!audioReady) {
      if (!this.#remuxAudioWaitTimer) {
        this.#remuxAudioWaitTimer = setTimeout(() => {
          this.#remuxAudioWaitTimer = null;
          if (!this.#remux && this.#hasFallbackViewers() && this.#videoPt !== null) {
            console.warn('[server] no audio RTP seen — starting WS fallback video-only');
            this.#startRemux(false);
          }
        }, 3000);
      }
      return;
    }
    if (this.#remuxAudioWaitTimer) { clearTimeout(this.#remuxAudioWaitTimer); this.#remuxAudioWaitTimer = null; }
    this.#startRemux(this.#hasAudio);
  }

  #startRemux(withAudio: boolean): void {
    if (this.#remux || this.#videoPt === null) return;
    const remux = new RemuxPipeline();
    this.#remux = remux;

    remux.on("log", (msg: string) => console.log(`[server] ${msg}`));

    remux.on("init", (init: Buffer, mime: string) => {
      if (this.#remux !== remux) return;
      this.#remuxRespawns = 0;
      const frame = Buffer.concat([FRAME_INIT, init]);
      const start = JSON.stringify({ type: "fallback_start", mime });
      for (const v of this.#viewers.values()) {
        if (v.transport !== "ws" || v.ws.readyState !== WebSocket.OPEN) continue;
        v.ws.send(start);
        v.ws.send(frame, { binary: true });
        v.wsWaitingForSegment = true;
      }
    });

    remux.on("segment", (segment: Buffer) => {
      if (this.#remux !== remux) return;
      const frame = Buffer.concat([FRAME_SEGMENT, segment]);
      for (const v of this.#viewers.values()) {
        if (v.transport !== "ws" || v.ws.readyState !== WebSocket.OPEN) continue;
        if (!v.wsWaitingForSegment && !v.ready) continue; // init not delivered yet
        // Slow client: skip segments instead of queueing unbounded — every
        // segment starts on an IDR, so gaps are safe (MSE jumps to live edge).
        if (v.ws.bufferedAmount > 8_000_000) continue;
        v.wsWaitingForSegment = false;
        v.ready = true;
        v.ws.send(frame, { binary: true });
      }
    });

    remux.on("exit", () => {
      if (this.#remux !== remux) return;
      remux.stop(); // release socket/tempdir even on unexpected death
      this.#remux = null;
      this.#remuxRespawns++;
      if (this.#remuxRespawns > 3) {
        console.error('[server] remux pipeline failed repeatedly — WS fallback unavailable');
        const msg = JSON.stringify({ type: "fallback_unavailable" });
        for (const v of this.#viewers.values()) {
          if (v.transport !== "ws") continue;
          try { v.ws.send(msg); } catch {}
          v.ws.close(4011, "Fallback unavailable");
        }
        return;
      }
      this.#maybeStartRemux();
    });

    remux.start({ hasAudio: withAudio, videoPt: this.#videoPt, audioPt: this.#audioPt }).catch((err) => {
      console.error('[server] remux start failed:', err instanceof Error ? err.message : err);
      if (this.#remux === remux) {
        remux.stop();
        this.#remux = null;
      }
    });
  }

  // Deliver the cached init to a viewer that joined after the remux started.
  #sendFallbackStart(viewer: ViewerConnection): void {
    const remux = this.#remux;
    if (!remux?.initSegment || !remux.mime) return;
    if (viewer.ws.readyState !== WebSocket.OPEN) return;
    viewer.ws.send(JSON.stringify({ type: "fallback_start", mime: remux.mime }));
    viewer.ws.send(Buffer.concat([FRAME_INIT, remux.initSegment]), { binary: true });
    viewer.wsWaitingForSegment = true;
  }

  // Keep the remux alive for 30s after the last fallback viewer leaves so
  // quick reconnects don't pay the ffmpeg startup cost.
  #maybeScheduleRemuxStop(): void {
    if (!this.#remux || this.#remuxStopTimer || this.#hasFallbackViewers()) return;
    this.#remuxStopTimer = setTimeout(() => {
      this.#remuxStopTimer = null;
      if (this.#remux && !this.#hasFallbackViewers()) {
        console.log('[server] no WS-fallback viewers for 30s — stopping remux');
        this.#remux.stop();
        this.#remux = null;
      }
    }, 30_000);
  }

  async #handleConnection(ws: WebSocket, req: http.IncomingMessage): Promise<void> {
    console.log(`[server] new WS connection (viewers=${this.#viewers.size}/${this.#config.maxViewers})`);
    if (this.#viewers.size >= this.#config.maxViewers) {
      ws.close(4005, "Max viewers reached");
      return;
    }

    // Per-IP brute-force throttle: 10 failed auths per 60s window
    const ip = req.socket.remoteAddress ?? 'unknown';
    const failures = this.#authFailures.get(ip);
    if (failures && Date.now() >= failures.resetAt) this.#authFailures.delete(ip);
    else if (failures && failures.count >= 10) {
      ws.close(4008, "Too many attempts");
      return;
    }

    try {
      await this.#authenticate(ws);
      this.#authFailures.delete(ip);
    } catch {
      console.log('[server] authentication failed');
      const entry = this.#authFailures.get(ip);
      if (entry && Date.now() < entry.resetAt) entry.count++;
      else this.#authFailures.set(ip, { count: 1, resetAt: Date.now() + 60_000 });
      return;
    }
    console.log('[server] viewer authenticated');

    // Both transports need these right after auth — the WS-fallback path
    // never runs WebRTC setup, which used to send them.
    ws.send(JSON.stringify({
      type: "stream_info",
      fps: this.#config.fps,
      bitrate: this.#config.bitrate,
      hasAudio: this.#hasAudio,
    }));
    ws.send(JSON.stringify({ type: "chat_enabled", enabled: this.#chatEnabled }));
    ws.send(JSON.stringify({ type: "debug_enabled", enabled: this.#debugEnabled }));

    // Viewer is authenticated — wait for WebRTC signaling messages.
    // Map membership doubles as the "setup started" latch: the entry is
    // registered synchronously on webrtc_ready, so a spammed message can't
    // create parallel peer connections.
    let chatTimestamps: number[] = [];
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
          if (this.#viewers.has(ws)) return;
          if (this.#viewers.size >= this.#config.maxViewers) {
            ws.close(4005, "Max viewers reached");
            return;
          }
          const viewer: ViewerConnection = {
            ws,
            transport: "webrtc",
            pc: null,
            videoTrack: null,
            audioTrack: null,
            ready: false,
            waitingForKeyframe: true,
            wsWaitingForSegment: false,
            iceCandidateCount: 0,
            connectionTimeout: null,
          };
          this.#viewers.set(ws, viewer);
          this.#notifyViewerCount();
          this.#setupWebRTC(viewer).catch((err) => {
            console.error("[webrtc] setup error:", err);
            ws.close(4011, "WebRTC setup failed");
          });
        } else if (msg.type === "webrtc_answer") {
          const viewer = this.#viewers.get(ws);
          if (viewer?.pc) {
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
        } else if (msg.type === "ice_candidate") {
          // Trickled browser candidate. Untrusted input: cap the count and
          // bound every field before it reaches werift.
          const viewer = this.#viewers.get(ws);
          if (!viewer?.pc) return;
          viewer.iceCandidateCount++;
          if (viewer.iceCandidateCount > 64) return;
          const c = msg.candidate;
          if (!c || typeof c.candidate !== "string" || c.candidate.length === 0 || c.candidate.length > 512) return;
          const sdpMLineIndex = Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex <= 8
            ? (c.sdpMLineIndex as number) : undefined;
          const sdpMid = typeof c.sdpMid === "string" && c.sdpMid.length <= 16 ? c.sdpMid : undefined;
          viewer.pc.addIceCandidate({ candidate: c.candidate, sdpMid, sdpMLineIndex })
            .catch((err) => console.warn("[webrtc] addIceCandidate failed:", err instanceof Error ? err.message : err));
        } else if (msg.type === "ice_complete") {
          // werift has no public end-of-remote-candidates API; poking the
          // ice transports directly lets failed ICE fail fast instead of
          // waiting out the timeout.
          const viewer = this.#viewers.get(ws);
          if (!viewer?.pc) return;
          for (const t of viewer.pc.iceTransports) {
            try { t.addRemoteCandidate(undefined); } catch {}
          }
        } else if (msg.type === "transport_fallback") {
          // Viewer requests the fMP4-over-WS transport (WebRTC failed or
          // ?ws=1). Keeps the socket; tears down any WebRTC attempt.
          if (!this.#config.fallbackEnabled) {
            ws.send(JSON.stringify({ type: "fallback_unavailable" }));
            return;
          }
          let viewer = this.#viewers.get(ws);
          if (!viewer) {
            if (this.#viewers.size >= this.#config.maxViewers) {
              ws.close(4005, "Max viewers reached");
              return;
            }
            viewer = {
              ws,
              transport: "ws",
              pc: null,
              videoTrack: null,
              audioTrack: null,
              ready: false,
              waitingForKeyframe: false,
              wsWaitingForSegment: false,
              iceCandidateCount: 0,
              connectionTimeout: null,
            };
            this.#viewers.set(ws, viewer);
            this.#notifyViewerCount();
          } else if (viewer.transport === "webrtc") {
            viewer.transport = "ws"; // before pc.close() so its state handler stays quiet
            if (viewer.connectionTimeout) { clearTimeout(viewer.connectionTimeout); viewer.connectionTimeout = null; }
            viewer.videoTrack?.stop();
            viewer.audioTrack?.stop();
            viewer.pc?.close();
            viewer.pc = null;
            viewer.videoTrack = null;
            viewer.audioTrack = null;
            viewer.ready = false;
            viewer.waitingForKeyframe = false;
            viewer.wsWaitingForSegment = false;
          } else {
            return; // already on the ws transport
          }
          console.log('[server] viewer switched to WS fallback transport');
          if (this.#remuxStopTimer) { clearTimeout(this.#remuxStopTimer); this.#remuxStopTimer = null; }
          if (this.#remux) {
            this.#sendFallbackStart(viewer); // no-op until the init exists
          } else {
            this.#maybeStartRemux();
          }
        } else if (msg.type === "set_name" && typeof msg.name === "string") {
          const name = msg.name.trim().slice(0, 30);
          if (!name) {
            ws.send(JSON.stringify({ type: "name_result", success: false, code: "empty", error: "Name cannot be empty" }));
            return;
          }
          const lower = name.toLowerCase();
          // "Host" is reserved for messages sent from the streamer's own UI —
          // a viewer must not be able to impersonate it.
          if (lower === "host") {
            ws.send(JSON.stringify({ type: "name_result", success: false, code: "reserved", error: "Name reserved" }));
            return;
          }
          for (const [other, existing] of this.#viewerNames) {
            if (other !== ws && existing.toLowerCase() === lower) {
              ws.send(JSON.stringify({ type: "name_result", success: false, code: "taken", error: "Name already taken" }));
              return;
            }
          }
          this.#viewerNames.set(ws, name);
          ws.send(JSON.stringify({ type: "name_result", success: true, name }));
        } else if (msg.type === "chat" && typeof msg.message === "string") {
          if (!this.#chatEnabled) return;
          const sender = this.#viewerNames.get(ws);
          if (!sender) return;
          const text = msg.message.trim().slice(0, 500);
          if (!text) return;
          // Rate limit: max 5 messages per 5s per viewer
          const now = Date.now();
          chatTimestamps = chatTimestamps.filter((t) => now - t < 5000);
          if (chatTimestamps.length >= 5) return;
          chatTimestamps.push(now);
          this.#broadcastChat(sender, text);
          this.#chatCallback?.(sender, text);
        }
      } catch {}
    });

    const removeViewer = () => {
      const viewer = this.#viewers.get(ws);
      if (viewer) {
        if (viewer.connectionTimeout) clearTimeout(viewer.connectionTimeout);
        viewer.videoTrack?.stop();
        viewer.audioTrack?.stop();
        viewer.pc?.close();
      }
      this.#viewers.delete(ws);
      this.#viewerNames.delete(ws);
      this.#notifyViewerCount();
      this.#maybeScheduleRemuxStop();
    };

    ws.on("close", removeViewer);
    ws.on("error", removeViewer);
  }

  async #setupWebRTC(viewer: ViewerConnection): Promise<void> {
    const ws = viewer.ws;
    console.log(`[server] #setupWebRTC: hasAudio=${this.#hasAudio}`);
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
      iceServers: this.#config.iceServers,
      // Include all local network interface IPs so remote viewers on the
      // same LAN can reach us via host candidates. Also includes 127.0.0.1
      // for same-machine viewers (browsers send mDNS-obfuscated candidates
      // that werift can't resolve, so the loopback fallback is still needed).
      iceAdditionalHostAddresses: localAddresses,
      // One ICE transport for the whole bundle instead of one per m-line:
      // halves STUN gathering and keeps trickled candidates uniform.
      bundlePolicy: "max-bundle",
    });

    const videoTrack = new MediaStreamTrack({ kind: "video" });
    pc.addTransceiver(videoTrack, { direction: "sendonly" });

    let audioTrack: MediaStreamTrack | null = null;
    if (this.#hasAudio) {
      audioTrack = new MediaStreamTrack({ kind: "audio" });
      pc.addTransceiver(audioTrack, { direction: "sendonly" });
    }

    viewer.pc = pc;
    viewer.videoTrack = videoTrack;
    viewer.audioTrack = audioTrack;

    // Trickle ICE: forward candidates to the browser as werift gathers them.
    pc.onIceCandidate.subscribe((candidate) => {
      if (viewer.pc !== pc || ws.readyState !== WebSocket.OPEN) return;
      if (candidate) {
        ws.send(JSON.stringify({ type: "ice_candidate", candidate }));
      } else {
        ws.send(JSON.stringify({ type: "ice_complete" }));
      }
    });

    // Timeout: disconnect if DTLS+ICE don't complete within 35s
    viewer.connectionTimeout = setTimeout(() => {
      if (!viewer.ready) {
        console.warn('[webrtc] connection timeout — DTLS/ICE did not complete within 35s');
        if (this.#viewers.has(ws)) {
          ws.close(4011, "WebRTC connection timed out");
        }
      }
    }, 35000);

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
        if (viewer.connectionTimeout) { clearTimeout(viewer.connectionTimeout); viewer.connectionTimeout = null; }
        viewer.ready = true;
        viewer.waitingForKeyframe = true; // wait for next SPS before forwarding
        const pair = pc.iceTransports[0]?.connection.nominated;
        if (pair) {
          console.log(`[webrtc] selected pair: local=${pair.protocol.localCandidate?.type ?? "?"} remote=${pair.remoteCandidate.type} (${pair.remoteCandidate.host}:${pair.remoteCandidate.port})`);
        }
        console.log("[webrtc] viewer ready — DTLS+ICE complete, waiting for next keyframe");
      }
      if (state === "failed" || state === "closed") {
        if (viewer.connectionTimeout) { clearTimeout(viewer.connectionTimeout); viewer.connectionTimeout = null; }
        viewer.ready = false;
        // The fallback path closes the pc on purpose — only treat this as a
        // lost connection while the viewer is still on the webrtc transport.
        if (viewer.transport === "webrtc" && viewer.pc === pc && this.#viewers.has(ws)) {
          ws.close(4011, "WebRTC connection lost");
        }
      }
    });

    const offer = await pc.createOffer();
    // werift's setLocalDescription resolves only after FULL ICE gathering
    // (all STUN queries). localDescription is populated synchronously, so
    // send the candidate-less offer now and trickle the rest — awaiting here
    // would turn slow STUN back into a fixed pre-offer delay.
    pc.setLocalDescription(offer).then(() => {
      if (viewer.pc !== pc) return;
      const offerSdp = pc.localDescription!.sdp;
      const candidateLines = offerSdp.split("\n").filter((l) => l.startsWith("a=candidate"));
      const hostCount = candidateLines.filter((c) => c.includes("typ host")).length;
      const srflxCount = candidateLines.filter((c) => c.includes("typ srflx")).length;
      const relayCount = candidateLines.filter((c) => c.includes("typ relay")).length;
      console.log(`[server] ICE gathering done — ${candidateLines.length} candidates (${hostCount} host, ${srflxCount} srflx, ${relayCount} relay)`);
      if (srflxCount === 0) console.warn('[server] WARNING: no srflx candidates — STUN failed; remote viewers will need the WS fallback');
      candidateLines.forEach((c) => console.log(`[server] ICE: ${c.trim()}`));
    }).catch((err) => {
      console.error("[webrtc] setLocalDescription failed:", err);
      if (viewer.pc === pc && this.#viewers.has(ws)) {
        ws.close(4011, "WebRTC setup failed");
      }
    });

    const offerSdp = pc.localDescription!.sdp;
    const rtpmapLines = offerSdp.split("\n").filter((l) => l.startsWith("a=rtpmap")).map((l) => l.trim());
    const profileLine = offerSdp.split("\n").find((l) => l.includes("profile-level-id"))?.trim();
    console.log(`[server] offer ready (trickle) — codecs: ${rtpmapLines.join(" | ")}`);
    console.log(`[server] offer H264 profile: ${profileLine ?? "not found"}`);

    // Send the offer to the browser (include ICE servers so the browser uses
    // the same STUN/TURN config). Candidates follow as ice_candidate messages.
    ws.send(JSON.stringify({
      type: "webrtc_offer",
      sdp: offerSdp,
      iceServers: this.#config.iceServers,
    }));
  }

  sendHostChat(message: string): boolean {
    if (!this.#chatEnabled) return false;
    const text = message.trim().slice(0, 500);
    if (!text) return false;
    this.#broadcastChat("Host", text);
    return true;
  }

  #broadcastChat(sender: string, message: string): void {
    const payload = JSON.stringify({ type: "chat", sender, message });
    for (const viewer of this.#viewers.values()) {
      if (viewer.ws.readyState === WebSocket.OPEN) viewer.ws.send(payload);
    }
  }

  #handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const CSS = "text/css; charset=utf-8";
    const JS = "application/javascript; charset=utf-8";
    const WOFF2 = "font/woff2";
    const STATIC_FILES: Record<string, { file: string; type: string }> = {
      "/": { file: "viewer.html", type: "text/html; charset=utf-8" },
      "/index.html": { file: "viewer.html", type: "text/html; charset=utf-8" },
      "/styles/tokens.css": { file: "styles/tokens.css", type: CSS },
      "/styles/viewer-base.css": { file: "styles/viewer-base.css", type: CSS },
      "/styles/viewer-player.css": { file: "styles/viewer-player.css", type: CSS },
      "/styles/viewer-chat.css": { file: "styles/viewer-chat.css", type: CSS },
      "/js/viewer.js": { file: "js/viewer.js", type: JS },
      "/js/viewer-chat.js": { file: "js/viewer-chat.js", type: JS },
      "/js/viewer-stats.js": { file: "js/viewer-stats.js", type: JS },
      "/js/viewer-mse.js": { file: "js/viewer-mse.js", type: JS },
      "/js/viewer-debug.js": { file: "js/viewer-debug.js", type: JS },
      "/fonts/manrope-600.woff2": { file: "fonts/manrope-600.woff2", type: WOFF2 },
      "/fonts/manrope-700.woff2": { file: "fonts/manrope-700.woff2", type: WOFF2 },
      "/fonts/inter-400.woff2": { file: "fonts/inter-400.woff2", type: WOFF2 },
      "/fonts/inter-500.woff2": { file: "fonts/inter-500.woff2", type: WOFF2 },
      "/fonts/inter-600.woff2": { file: "fonts/inter-600.woff2", type: WOFF2 },
      "/fonts/inter-700.woff2": { file: "fonts/inter-700.woff2", type: WOFF2 },
      "/assets/icon-128.png": { file: "assets/icon-128.png", type: "image/png" },
      "/i18n-dom.js": { file: "i18n-dom.js", type: JS },
      "/vendor/i18next.min.js": { file: "vendor/i18next.min.js", type: JS },
      "/locales/en.json": { file: "locales/en.json", type: "application/json; charset=utf-8" },
      "/locales/uk.json": { file: "locales/uk.json", type: "application/json; charset=utf-8" },
    };

    // Strip the query string — the viewer page is also requested as
    // /?ws=1 (force the WebSocket media fallback).
    const urlPath = (req.url ?? "").split("?")[0];
    const entry = STATIC_FILES[urlPath];
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
        this.#httpServer.on("error", (err) => console.error('[server] http error:', err.message));
        resolve();
      });
    });
  }

  close(): void {
    clearInterval(this.#keepaliveTimer);
    this.#stopRemux();
    // Tell viewers this is a deliberate end-of-stream, not a network drop,
    // so they can show "stream ended" instead of reconnecting forever.
    const ended = JSON.stringify({ type: "stream_ended" });
    for (const viewer of this.#viewers.values()) {
      if (viewer.ws.readyState === WebSocket.OPEN) {
        try { viewer.ws.send(ended); } catch {}
      }
      if (viewer.connectionTimeout) clearTimeout(viewer.connectionTimeout);
      viewer.videoTrack?.stop();
      viewer.audioTrack?.stop();
      viewer.pc?.close();
      viewer.ws.close(1000, "Stream ended");
    }
    this.#viewers.clear();
    this.#wss.close();
    this.#httpServer.close();
  }
}
