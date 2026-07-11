// Lazy fMP4 remux pipeline for the WebSocket media fallback.
//
// Spawns FFmpeg reading the SAME RTP the WebRTC path uses (the server tees
// packets here over loopback UDP), copies the H264 as-is, re-encodes audio
// to AAC (universal MSE support — Opus-in-MP4 is too new for Safari), and
// emits fragmented MP4 on stdout. The stdout stream is split into top-level
// MP4 boxes: `ftyp`+`moov` form the init segment, each `moof`+`mdat` pair is
// one media segment (every segment starts on an IDR thanks to
// -movflags frag_keyframe and the encoder's inline SPS/PPS per GOP).
//
// Events:
//   'init'    (initSegment: Buffer, mime: string)
//   'segment' (segment: Buffer)
//   'log'     (message: string)
//   'exit'    (code: number | null)   — unexpected death only (not stop())
import { spawn, ChildProcess } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

// SIGTERM first; SIGKILL after 3s if the process ignores it (same policy
// as capture.ts).
function killWithEscalation(proc: ChildProcess): void {
  if (proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }, 3000);
  timer.unref();
  proc.once("close", () => clearTimeout(timer));
}

// Bind-to-0 probe: returns a loopback UDP port that was free a moment ago.
// FFmpeg re-binds it right after; the tiny race is acceptable on loopback.
function allocLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    sock.once("error", reject);
    sock.bind(0, "127.0.0.1", () => {
      const { port } = sock.address();
      sock.close(() => resolve(port));
    });
  });
}

export interface RemuxStartOpts {
  hasAudio: boolean;
  videoPt: number;
  audioPt: number | null;
}

export class RemuxPipeline extends EventEmitter {
  #proc: ChildProcess | null = null;
  #sender: dgram.Socket | null = null;
  #videoPort = 0;
  #audioPort = 0;
  #sdpDir: string | null = null;
  #stopped = false;
  #buffer: Buffer = Buffer.alloc(0);
  #initParts: Buffer[] = [];
  #pendingMoof: Buffer | null = null;
  #init: Buffer | null = null;
  #mime: string | null = null;

  get mime(): string | null {
    return this.#mime;
  }

  get initSegment(): Buffer | null {
    return this.#init;
  }

  async start(opts: RemuxStartOpts): Promise<void> {
    this.#stopped = false;
    this.#videoPort = await allocLoopbackPort();
    const useAudio = opts.hasAudio && opts.audioPt !== null;
    if (useAudio) this.#audioPort = await allocLoopbackPort();

    const sdpLines = [
      "v=0",
      "o=- 0 0 IN IP4 127.0.0.1",
      "s=icast-remux",
      "c=IN IP4 127.0.0.1",
      "t=0 0",
      `m=video ${this.#videoPort} RTP/AVP ${opts.videoPt}`,
      `a=rtpmap:${opts.videoPt} H264/90000`,
    ];
    if (useAudio) {
      sdpLines.push(
        `m=audio ${this.#audioPort} RTP/AVP ${opts.audioPt}`,
        `a=rtpmap:${opts.audioPt} opus/48000/2`,
      );
    }
    // FFmpeg's data: protocol support varies by build — a temp SDP file works
    // everywhere. The dir is removed on stop().
    this.#sdpDir = fs.mkdtempSync(path.join(os.tmpdir(), "icast-remux-"));
    const sdpPath = path.join(this.#sdpDir, "stream.sdp");
    fs.writeFileSync(sdpPath, sdpLines.join("\n") + "\n");

    const args = [
      "-hide_banner",
      "-loglevel", "warning",
      "-protocol_whitelist", "file,crypto,udp,rtp",
      "-fflags", "+nobuffer",
      "-analyzeduration", "500000",
      "-probesize", "500000",
      "-reorder_queue_size", "0",
      "-max_delay", "200000",
      "-f", "sdp",
      "-i", sdpPath,
      "-map", "0:v",
      "-c:v", "copy",
      ...(useAudio ? ["-map", "0:a", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"] : []),
      "-f", "mp4",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof",
      "-muxdelay", "0",
      "-muxpreload", "0",
      "pipe:1",
    ];

    this.emit("log", `remux: starting ffmpeg (video RTP :${this.#videoPort}${useAudio ? `, audio RTP :${this.#audioPort}` : ""})`);
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.#proc = proc;
    this.#sender = dgram.createSocket("udp4");

    proc.stdout!.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    proc.stderr!.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) this.emit("log", `remux ffmpeg: ${msg}`);
    });
    proc.on("error", (err: Error) => {
      this.emit("log", `remux ffmpeg spawn error: ${err.message}`);
      if (!this.#stopped) this.emit("exit", null);
    });
    proc.on("close", (code) => {
      if (this.#proc === proc && !this.#stopped) {
        this.emit("log", `remux ffmpeg exited unexpectedly (code ${code})`);
        this.emit("exit", code);
      }
    });
  }

  writeVideoRtp(packet: Buffer): void {
    if (this.#sender && this.#videoPort) {
      this.#sender.send(packet, this.#videoPort, "127.0.0.1", () => {});
    }
  }

  writeAudioRtp(packet: Buffer): void {
    if (this.#sender && this.#audioPort) {
      this.#sender.send(packet, this.#audioPort, "127.0.0.1", () => {});
    }
  }

  stop(): void {
    this.#stopped = true;
    if (this.#proc) {
      killWithEscalation(this.#proc);
      this.#proc = null;
    }
    if (this.#sender) {
      try { this.#sender.close(); } catch {}
      this.#sender = null;
    }
    if (this.#sdpDir) {
      try { fs.rmSync(this.#sdpDir, { recursive: true, force: true }); } catch {}
      this.#sdpDir = null;
    }
    this.#buffer = Buffer.alloc(0);
    this.#initParts = [];
    this.#pendingMoof = null;
  }

  // Streaming top-level MP4 box splitter. FFmpeg flushes wherever it likes,
  // so never assume a chunk boundary lines up with a box boundary.
  #onStdout(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 8) {
      const size = this.#buffer.readUInt32BE(0);
      if (size < 8) {
        // size 0 ("rest of file") / 1 (64-bit) never appear with our movflags —
        // the stream is corrupt, restart the pipeline.
        this.emit("log", `remux: unexpected MP4 box size ${size} — restarting pipeline`);
        if (this.#proc) killWithEscalation(this.#proc);
        this.#buffer = Buffer.alloc(0);
        return;
      }
      if (this.#buffer.length < size) return; // wait for the rest
      const box = this.#buffer.subarray(0, size);
      const type = box.toString("ascii", 4, 8);
      this.#buffer = this.#buffer.subarray(size);
      this.#onBox(type, Buffer.from(box));
    }
  }

  #onBox(type: string, box: Buffer): void {
    if (this.#init === null) {
      // Everything up to and including moov (ftyp, free, moov) is the init
      // segment — with empty_moov the moov is written before any fragment.
      this.#initParts.push(box);
      if (type === "moov") {
        this.#init = Buffer.concat(this.#initParts);
        this.#initParts = [];
        this.#mime = this.#deriveMime(this.#init);
        this.emit("log", `remux: init segment ready (${this.#init.length} bytes, ${this.#mime})`);
        this.emit("init", this.#init, this.#mime);
      }
      return;
    }
    if (type === "moof") {
      this.#pendingMoof = box;
      return;
    }
    if (type === "mdat" && this.#pendingMoof) {
      const segment = Buffer.concat([this.#pendingMoof, box]);
      this.#pendingMoof = null;
      this.emit("segment", segment);
      return;
    }
    // sidx/styp/etc — not produced with our movflags; ignore defensively.
  }

  // Codec string for MediaSource.isTypeSupported: avc1 profile/compat/level
  // come from the avcC box inside moov; audio is always our own AAC-LC.
  #deriveMime(init: Buffer): string {
    let videoCodec = "avc1.42e01f"; // safe default: baseline 3.1
    const idx = init.indexOf("avcC");
    if (idx !== -1 && init.length >= idx + 8) {
      const profile = init[idx + 5];
      const compat = init[idx + 6];
      const level = init[idx + 7];
      const hex = (b: number) => b.toString(16).padStart(2, "0");
      videoCodec = `avc1.${hex(profile)}${hex(compat)}${hex(level)}`;
    }
    const hasAudioTrack = init.indexOf("mp4a") !== -1;
    return `video/mp4; codecs="${videoCodec}${hasAudioTrack ? ", mp4a.40.2" : ""}"`;
  }
}
