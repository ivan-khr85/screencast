export type AudioMode = 'system' | 'app' | 'none';

export interface AudioConfig {
  mode: AudioMode;
  appBundleId?: string;
}

export type LatencyMode = "ultra-low" | "medium" | "slow";

export interface LatencyPreset {
  gopMultiplier: number;
  bufsize: string;
}

export const LATENCY_PRESETS: Record<LatencyMode, LatencyPreset> = {
  "ultra-low": {
    gopMultiplier: 1 / 6,
    bufsize: "6500k",
  },
  medium: {
    gopMultiplier: 0.5,
    bufsize: "16250k",
  },
  slow: {
    gopMultiplier: 2,
    bufsize: "32500k",
  },
};

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
  resolution: string;
  maxViewers: number;
  authTimeout: number;
  passwordLength: number;
}

export const DEFAULTS: Config = {
  port: 8080,
  fps: 60,
  bitrate: "48750k",
  maxrate: "84500k",
  bufsize: "6500k",
  audioBitrate: "256k",
  audioSampleRate: 48000,
  audioChannels: 2,
  gopSize: 10,
  resolution: "original",
  maxViewers: 5,
  authTimeout: 5000,
  passwordLength: 4, // bytes → 8 hex chars
};
