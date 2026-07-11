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
  // Allow viewers to fall back to fMP4-over-WebSocket (MSE) when WebRTC
  // can't connect (e.g. through the tunnel with an unfriendly NAT).
  fallbackEnabled: boolean;
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

// Accepts only what werift's parseIceServers can actually use: a plain
// `turn:host:port` string URL, optionally `?transport=udp`. `turns:`,
// `?transport=tcp` (needs PeerConfig.forceTurnTCP) and IPv6 literals (werift
// splits host:port on ":") are rejected. Returns the URL or null.
export function validateTurnUrl(url: string): string | null {
  return /^turn:[a-z0-9.-]+:\d{1,5}(\?transport=udp)?$/i.test(url) ? url : null;
}

export interface TurnConfig {
  url: string;
  username: string;
  credential: string;
}

// DEFAULTS.iceServers plus one TURN entry. The same array is handed to both
// werift (uses the first `turn:` entry, string urls only) and the browser
// RTCPeerConnection (standard {urls, username, credential} shape).
export function buildIceServers(turn?: TurnConfig): RTCIceServer[] {
  const servers = [...DEFAULTS.iceServers];
  if (turn) {
    servers.push({ urls: turn.url, username: turn.username, credential: turn.credential });
  }
  return servers;
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
  fallbackEnabled: true,
  // STUN only. If you add a TURN server, mind werift's parseIceServers: it
  // uses only the FIRST `stun:` and FIRST `turn:` entry, `urls` must be a
  // string (not an array), `?transport=tcp` is ignored (TURN-over-TCP needs
  // PeerConfig.forceTurnTCP) and `turns:` URLs are never matched. A dead TURN
  // host stalls werift's setLocalDescription, so never list one speculatively.
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ],
};
