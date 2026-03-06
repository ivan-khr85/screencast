export type AudioMode = 'system' | 'app' | 'none';

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
  maxViewers: 5,
  authTimeout: 5000,
  passwordLength: 4, // bytes → 8 hex chars
};
