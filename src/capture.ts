import { spawn, execSync, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, unlinkSync } from 'node:fs';
import { DEFAULTS, Config, AudioConfig } from './constants.js';
import { resolveScAudioPath } from './audio-setup.js';

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
  #audioHelper: ChildProcess | null = null;
  #fifoPath: string | null = null;
  #stopped = false;
  #config: Config;

  constructor(config: Partial<Config> = {}) {
    super();
    this.#config = { ...DEFAULTS, ...config };
  }

  start(screenIndex: string, audio: AudioConfig): void {
    this.#stopped = false;
    this.#spawn(screenIndex, audio);
  }

  #spawn(screenIndex: string, audio: AudioConfig): void {
    if (this.#stopped) return;

    const { fps, bitrate, maxrate, bufsize, gopSize, resolution, audioBitrate, audioSampleRate, audioChannels } = this.#config;
    const hasAudio = audio.mode !== 'none';

    // Set up audio helper + FIFO for ScreenCaptureKit modes
    if (hasAudio) {
      this.#setupAudioHelper(audio);
    }

    // --- Inputs ---
    const args: string[] = [
      '-hide_banner', '-loglevel', 'error',
      // Input 0: Video
      '-thread_queue_size', '512',
      '-f', 'avfoundation',
      '-capture_cursor', '1',
      '-pixel_format', 'nv12',
      '-framerate', String(fps),
      '-i', `${screenIndex}:none`,
    ];

    if (hasAudio && this.#fifoPath) {
      // Input 1: Audio from FIFO — skip probing (format is known)
      args.push(
        '-thread_queue_size', '512',
        '-probesize', '32',
        '-analyzeduration', '0',
        '-f', 'f32le',
        '-ar', String(audioSampleRate),
        '-ac', String(audioChannels),
        '-i', this.#fifoPath,
      );
    }

    // --- Encoding & Output (after all inputs) ---
    args.push(
      '-c:v', 'h264_videotoolbox',
      '-allow_sw', '1',
      '-realtime', 'true',
      '-prio_speed', 'true',
      '-b:v', bitrate,
      '-maxrate', maxrate,
      '-bufsize', bufsize,
      '-g', String(gopSize),
      '-keyint_min', String(gopSize),
      '-profile:v', 'baseline',
    );

    if (resolution && resolution !== 'original') {
      args.push('-vf', `scale=-2:${resolution}`);
    }

    if (hasAudio && this.#fifoPath) {
      args.push(
        '-c:a', 'aac',
        '-b:a', audioBitrate,
        '-map', '0:v',
        '-map', '1:a',
      );
    } else {
      args.push('-an');
    }

    args.push(
      '-max_delay', '0',
      '-f', 'mp4',
      '-movflags', '+frag_every_frame+empty_moov+default_base_moof',
      '-flush_packets', '1',
      'pipe:1',
    );

    this.emit('log', `Starting ffmpeg: screen=${screenIndex} audio=${audio.mode}${audio.appBundleId ? ` app=${audio.appBundleId}` : ''}`);

    const proc = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.#process = proc;

    let gotData = false;
    const noDataTimer = setTimeout(() => {
      if (!gotData && !this.#stopped) {
        this.emit('log', 'WARNING: No video data after 5 seconds. Screen recording permission may be missing.');
        this.emit('log', 'Go to: System Settings → Privacy & Security → Screen Recording → enable your terminal app.');
      }
    }, 5000);

    proc.stdout!.on('data', (chunk: Buffer) => {
      if (!gotData) {
        gotData = true;
        clearTimeout(noDataTimer);
        this.emit('log', `First ffmpeg output: ${chunk.length} bytes`);
      }
      this.emit('data', chunk);
    });

    proc.stderr!.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) this.emit('log', msg);
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(noDataTimer);
      if (this.#stopped) return;
      this.emit('log', `FFmpeg exited with code ${code}, restarting...`);
      this.#cleanupAudioHelper();
      setTimeout(() => this.#spawn(screenIndex, audio), 1000);
      this.emit('restart');
    });

    proc.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  #setupAudioHelper(audio: AudioConfig): void {
    const binPath = resolveScAudioPath();
    if (!binPath) {
      this.emit('log', 'WARNING: sc-audio helper not found. Audio will be disabled.');
      return;
    }

    // Create named pipe (FIFO)
    this.#fifoPath = `/tmp/screencast-audio-${process.pid}.pcm`;
    if (existsSync(this.#fifoPath)) {
      unlinkSync(this.#fifoPath);
    }
    execSync(`mkfifo "${this.#fifoPath}"`);

    // Build sc-audio args
    const helperArgs = ['capture', '--output', this.#fifoPath];
    if (audio.mode === 'app' && audio.appBundleId) {
      helperArgs.push('--app', audio.appBundleId);
    }

    this.emit('log', `Starting sc-audio: ${helperArgs.join(' ')}`);

    this.#audioHelper = spawn(binPath, helperArgs, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    this.#audioHelper.stderr!.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) this.emit('log', `[sc-audio] ${msg}`);
    });

    this.#audioHelper.on('error', (err: Error) => {
      this.emit('log', `[sc-audio] Error: ${err.message}`);
    });

    this.#audioHelper.on('close', (code: number | null) => {
      if (this.#stopped) return;
      this.emit('log', `[sc-audio] Exited with code ${code}`);
    });
  }

  #cleanupAudioHelper(): void {
    if (this.#audioHelper) {
      this.#audioHelper.kill('SIGTERM');
      this.#audioHelper = null;
    }
    if (this.#fifoPath && existsSync(this.#fifoPath)) {
      try { unlinkSync(this.#fifoPath); } catch {}
      this.#fifoPath = null;
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#cleanupAudioHelper();
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
