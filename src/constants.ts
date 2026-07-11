import { RTCIceServer } from "werift";

export type AudioMode = "system" | "app" | "none";

export interface AudioConfig {
  mode: AudioMode;
  appBundleId?: string;
}

export interface Config {
  port: number;
  fps: number;
  bitrate: string;
  maxrate: string;
  bufsize: string;
  audioBitrate: string;
  audioSampleRate: number;
  audioChannels: number;
  gopSize: number;
  maxViewers: number;
  authTimeout: number;
  passwordLength: number;
  iceServers: RTCIceServer[];
}

export function parseKbits(bitrate: string): number | null {
  const m = /^(\d+)([kKmM]?)$/.exec(bitrate);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return m[2].toLowerCase() === "m" ? n * 1000 : n;
}

// DEFAULTS.maxrate/bufsize are tuned for the ~100 Mbps LAN preset; for any
// other bitrate they would defeat the cap, so derive them from the target.
// maxrate = bitrate keeps keyframe bursts bounded (latency: bursts above the
// path capacity turn into standing queues); bufsize = 0.5s of bitrate.
// Returns null when the bitrate string is unparsable — callers keep DEFAULTS.
export function deriveRateControl(
  bitrate: string,
): { maxrate: string; bufsize: string } | null {
  const kbits = parseKbits(bitrate);
  if (!kbits) return null;
  return {
    maxrate: `${kbits}k`,
    bufsize: `${Math.max(1, Math.round(kbits / 2))}k`,
  };
}

export const DEFAULTS: Config = {
  port: 8080,
  fps: 60,
  bitrate: "100750k",
  maxrate: "550500k",
  bufsize: "60000k",
  audioBitrate: "256k",
  audioSampleRate: 48000,
  audioChannels: 2,
  gopSize: 10,
  maxViewers: 5,
  authTimeout: 5000,
  passwordLength: 6, // bytes → 12 hex chars (~48 bits)
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turns:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
};
