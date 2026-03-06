import { spawn, execFileSync, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  #audioProcess: ChildProcess | null = null;
  #stopped = false;
  #config: Config;
  #fifoPath: string | null = null;
  #screenIndex: string = '1';
  #audioConfig: AudioConfig = { mode: 'none' };

  constructor(config: Partial<Config> = {}) {
    super();
    this.#config = { ...DEFAULTS, ...config };
  }

  start(screenIndex: string, audio: AudioConfig): void {
    this.#stopped = false;
    this.#screenIndex = screenIndex;
    this.#audioConfig = audio;

    if (audio.mode !== 'none') {
      this.#fifoPath = this.#createFifo();
      this.#spawnAudio(audio);
    }
    this.#spawnVideo(screenIndex, audio);
  }

  #createFifo(): string {
    const fifoPath = path.join(os.tmpdir(), `screencast-audio-${process.pid}.fifo`);
    try { fs.unlinkSync(fifoPath); } catch {}
    execFileSync('mkfifo', [fifoPath]);
    return fifoPath;
  }

  #cleanupFifo(): void {
    if (this.#fifoPath) {
      try { fs.unlinkSync(this.#fifoPath); } catch {}
      this.#fifoPath = null;
    }
  }

  #spawnVideo(screenIndex: string, audio: AudioConfig): void {
    if (this.#stopped) return;

    const { fps, bitrate, maxrate, bufsize, gopSize, resolution, audioBitrate } = this.#config;

    const args: string[] = [
      '-hide_banner', '-loglevel', 'error',
      '-thread_queue_size', '512',
      '-f', 'avfoundation',
      '-capture_cursor', '1',
      '-pixel_format', 'nv12',
      '-framerate', String(fps),
      '-i', `${screenIndex}:none`,
    ];

    // Audio input from FIFO (raw PCM from sc-audio)
    if (this.#fifoPath && audio.mode !== 'none') {
      args.push(
        '-thread_queue_size', '1024',
        '-f', 'f32le',
        '-ar', '48000',
        '-ac', '2',
        '-i', this.#fifoPath,
      );
    }

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
      '-profile:v', 'main',
    );

    if (resolution && resolution !== 'original') {
      args.push('-vf', `scale=-2:${resolution}`);
    }

    if (this.#fifoPath && audio.mode !== 'none') {
      // Map video from input 0, audio from input 1
      args.push(
        '-map', '0:v', '-map', '1:a',
        '-c:a', 'aac_at',
        '-b:a', audioBitrate,
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

    this.emit('log', `Starting ffmpeg: screen=${screenIndex}${audio.mode !== 'none' ? ' + audio (AAC muxed)' : ' (video only)'}`);

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
      this.#restartAll();
    });

    proc.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  #spawnAudio(audio: AudioConfig): void {
    if (this.#stopped) return;

    const binPath = resolveScAudioPath();
    if (!binPath) {
      this.emit('log', 'WARNING: sc-audio helper not found. Audio will be disabled.');
      return;
    }

    const helperArgs = ['capture'];
    if (audio.mode === 'app' && audio.appBundleId) {
      helperArgs.push('--app', audio.appBundleId);
    }
    if (this.#fifoPath) {
      helperArgs.push('--output', this.#fifoPath);
    }

    this.emit('log', `Starting sc-audio: ${helperArgs.join(' ')}`);

    const proc = spawn(binPath, helperArgs, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    this.#audioProcess = proc;

    proc.stderr!.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) this.emit('log', `[sc-audio] ${msg}`);
    });

    proc.on('error', (err: Error) => {
      this.emit('log', `[sc-audio] Error: ${err.message}`);
    });

    proc.on('close', (code: number | null) => {
      if (this.#stopped) return;
      this.emit('log', `[sc-audio] Exited with code ${code}, triggering restart...`);
      // Kill FFmpeg too — it will trigger a full restart via its own close handler
      if (this.#process) {
        this.#process.kill('SIGTERM');
      }
    });
  }

  #restartAll(): void {
    if (this.#stopped) return;

    // Kill audio process if still running
    if (this.#audioProcess) {
      this.#audioProcess.kill('SIGTERM');
      this.#audioProcess = null;
    }
    this.#process = null;

    this.emit('restart');

    // Recreate FIFO and restart both processes
    setTimeout(() => {
      if (this.#stopped) return;
      this.#cleanupFifo();
      if (this.#audioConfig.mode !== 'none') {
        this.#fifoPath = this.#createFifo();
        this.#spawnAudio(this.#audioConfig);
      }
      this.#spawnVideo(this.#screenIndex, this.#audioConfig);
    }, 1000);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#audioProcess) {
      this.#audioProcess.kill('SIGTERM');
      this.#audioProcess = null;
    }
    if (this.#process) {
      this.#process.kill('SIGTERM');
      this.#process = null;
    }
    this.#cleanupFifo();
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
