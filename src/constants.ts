export type AudioMode = 'system' | 'app' | 'none';

export interface AudioConfig {
  mode: AudioMode;
  appBundleId?: string;
}

export type LatencyMode = "ultra-low" | "medium" | "slow";

export interface LatencyPreset {
  gopMultiplier: number;
  bufsize: string;
  liveEdgeThreshold: number;
  bufferEvictionSeconds: number;
}

export const LATENCY_PRESETS: Record<LatencyMode, LatencyPreset> = {
  "ultra-low": {
    gopMultiplier: 1 / 6,
    bufsize: "2600k",
    liveEdgeThreshold: 0.3,
    bufferEvictionSeconds: 2,
  },
  medium: {
    gopMultiplier: 0.5,
    bufsize: "6500k",
    liveEdgeThreshold: 1,
    bufferEvictionSeconds: 5,
  },
  slow: {
    gopMultiplier: 2,
    bufsize: "13000k",
    liveEdgeThreshold: 3,
    bufferEvictionSeconds: 15,
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
  backpressureLimit: number;
  bufferEvictionSeconds: number;
  liveEdgeThreshold: number;
  passwordLength: number;
}

export const DEFAULTS: Config = {
  port: 8080,
  fps: 60,
  bitrate: "19500k",
  maxrate: "33800k",
  bufsize: "2600k",
  audioBitrate: "166k",
  audioSampleRate: 48000,
  audioChannels: 2,
  gopSize: 10,
  resolution: "original",
  maxViewers: 5,
  authTimeout: 5000,
  backpressureLimit: 4 * 1024 * 1024,
  bufferEvictionSeconds: 2,
  liveEdgeThreshold: 0.3, // seconds behind live to trigger seek
  passwordLength: 4, // bytes → 8 hex chars
};
