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
  backpressureLimit: number;
  bufferEvictionSeconds: number;
  liveEdgeThreshold: number;
  passwordLength: number;
}

export const DEFAULTS: Config = {
  port: 8080,
  fps: 30,
  bitrate: '5000k',
  maxrate: '6000k',
  bufsize: '1000k',
  audioBitrate: '128k',
  audioSampleRate: 48000,
  audioChannels: 2,
  gopSize: 30,
  maxViewers: 5,
  authTimeout: 5000,
  backpressureLimit: 2 * 1024 * 1024, // 2MB
  bufferEvictionSeconds: 10,
  liveEdgeThreshold: 2, // seconds behind live to trigger seek
  passwordLength: 4, // bytes → 8 hex chars
};
