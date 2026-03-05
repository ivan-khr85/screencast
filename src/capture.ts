import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { DEFAULTS, Config } from './constants.js';

export interface Device {
  index: string;
  name: string;
}

export interface DeviceList {
  screens: Device[];
  audioDevices: Device[];
}

export class Capture extends EventEmitter {
  #process: ChildProcess | null = null;
  #stopped = false;
  #config: Config;

  constructor(config: Partial<Config> = {}) {
    super();
    this.#config = { ...DEFAULTS, ...config };
  }

  start(screenIndex: string, audioDevice: string | null): void {
    this.#stopped = false;
    this.#spawn(screenIndex, audioDevice);
  }

  #spawn(screenIndex: string, audioDevice: string | null): void {
    if (this.#stopped) return;

    const { fps, bitrate, maxrate, bufsize, gopSize, audioBitrate, audioSampleRate, audioChannels } = this.#config;
    const hasAudio = audioDevice != null;
    const inputDevice = hasAudio ? `${screenIndex}:${audioDevice}` : `${screenIndex}:none`;

    const args: string[] = [
      '-hide_banner', '-loglevel', 'error',
      // Input
      '-f', 'avfoundation',
      '-capture_cursor', '1',
      '-framerate', String(fps),
      '-i', inputDevice,
      // Video encoding
      '-c:v', 'h264_videotoolbox',
      '-allow_sw', '1',
      '-realtime', 'true',
      '-prio_speed', 'true',
      '-b:v', bitrate,
      '-maxrate', maxrate,
      '-bufsize', bufsize,
      '-g', String(gopSize),
      '-keyint_min', String(gopSize),
      '-profile:v', 'high',
    ];

    if (hasAudio) {
      args.push(
        '-c:a', 'aac',
        '-b:a', audioBitrate,
        '-ac', String(audioChannels),
        '-ar', String(audioSampleRate),
      );
    } else {
      args.push('-an');
    }

    args.push(
      // Output format
      '-f', 'mp4',
      '-movflags', '+frag_every_frame+empty_moov+default_base_moof',
      '-flush_packets', '1',
      'pipe:1',
    );

    const proc = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.#process = proc;

    proc.stdout!.on('data', (chunk: Buffer) => {
      this.emit('data', chunk);
    });

    proc.stderr!.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) this.emit('log', msg);
    });

    proc.on('close', (code: number | null) => {
      if (this.#stopped) return;
      this.emit('log', `FFmpeg exited with code ${code}, restarting...`);
      setTimeout(() => this.#spawn(screenIndex, audioDevice), 1000);
      this.emit('restart');
    });

    proc.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  stop(): void {
    this.#stopped = true;
    if (this.#process) {
      this.#process.kill('SIGTERM');
      this.#process = null;
    }
  }
}

export async function listDevices(): Promise<DeviceList> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-hide_banner',
      '-f', 'avfoundation',
      '-list_devices', 'true',
      '-i', '',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', () => {
      const screens: Device[] = [];
      const audioDevices: Device[] = [];

      const lines = stderr.split('\n');
      let section: 'video' | 'audio' | null = null;

      for (const line of lines) {
        if (line.includes('AVFoundation video devices:')) {
          section = 'video';
          continue;
        }
        if (line.includes('AVFoundation audio devices:')) {
          section = 'audio';
          continue;
        }

        const match = line.match(/\[(\d+)]\s+(.+)/);
        if (!match) continue;

        const index = match[1];
        const name = match[2].trim();

        if (section === 'video') {
          screens.push({ index, name });
        } else if (section === 'audio') {
          audioDevices.push({ index, name });
        }
      }

      resolve({ screens, audioDevices });
    });

    proc.on('error', reject);
  });
}
