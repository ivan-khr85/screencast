export const DEFAULTS = {
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
