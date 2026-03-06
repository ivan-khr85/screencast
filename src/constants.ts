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
  passwordLength: 4, // bytes → 8 hex chars
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
