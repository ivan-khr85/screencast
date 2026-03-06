import { spawn, ChildProcess } from 'node:child_process';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { DEFAULTS, Config, AudioConfig } from './constants.js';
import { resolveScAudioPath } from './audio-setup.js';

// AVCaptureScreenInput was deprecated in macOS 14 (Darwin 23) and removed in
// macOS 15+. Use FFmpeg's screencapturekit input device on those systems.
export function useSck(): boolean {
  return process.platform === 'darwin' && parseInt(os.release().split('.')[0], 10) >= 23;
}

// Returns false if the installed FFmpeg lacks screencapturekit support.
// FFmpeg 7.0+ (built with ScreenCaptureKit) is required on macOS 15+.
export function checkSckVideoSupport(): Promise<boolean> {
  if (!useSck()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-f', 'screencapturekit', '-h'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    proc.stdout!.on('data', (d: Buffer) => { output += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { output += d.toString(); });
    proc.on('close', () => resolve(!/unknown input format/i.test(output)));
    proc.on('error', () => resolve(false));
  });
}

export interface Device {
  index: string;
  name: string;
}

export interface DeviceList {
  screens: Device[];
  audioDevices: Device[];
}

function bindUdpSocket(): Promise<{ socket: dgram.Socket; port: number }> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.on('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      const addr = socket.address();
      resolve({ socket, port: addr.port });
    });
  });
}

export class Capture extends EventEmitter {
  #process: ChildProcess | null = null;
  #videoEncoder: ChildProcess | null = null;
  #audioProcess: ChildProcess | null = null;
  #audioEncoder: ChildProcess | null = null;
  #videoSocket: dgram.Socket | null = null;
  #audioSocket: dgram.Socket | null = null;
  #stopped = false;
  #config: Config;

  constructor(config: Partial<Config> = {}) {
    super();
    this.#config = { ...DEFAULTS, ...config };
  }

  async start(screenIndex: string, audio: AudioConfig): Promise<void> {
    this.#stopped = false;
    console.log(`[capture] start: screenIndex=${screenIndex} audio.mode=${audio.mode} useSck=${useSck()} osRelease=${os.release()}`);
    await this.#spawnVideo(screenIndex);
    if (audio.mode !== 'none') {
      await this.#spawnAudio(audio);
    }
  }

  async #spawnVideo(screenIndex: string): Promise<void> {
    if (this.#stopped) return;

    const { socket, port } = await bindUdpSocket();
    this.#videoSocket = socket;

    const { fps, bitrate, maxrate, bufsize, gopSize } = this.#config;

    const sck = useSck();
    const args: string[] = [
      '-hide_banner', '-loglevel', 'error',
      '-thread_queue_size', '512',
      '-f', sck ? 'screencapturekit' : 'avfoundation',
      '-capture_cursor', '1',
      '-pixel_format', 'nv12',
      '-framerate', String(fps),
      '-i', sck ? screenIndex : `${screenIndex}:none`,
      '-vf', 'crop=trunc(iw/16)*16:trunc(ih/16)*16:0:0',
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
      '-an',
    ];

    const recordTo = process.env.SCREENCAST_RECORD_TO;
    if (recordTo) {
      // Debug: write encoded video to file instead of RTP to check for encoding artifacts.
      // WebRTC stream will be inactive. Open the file in VLC to inspect.
      args.push('-f', 'matroska', recordTo);
      console.log(`[capture] DEBUG recording to ${recordTo} — WebRTC stream inactive`);
    } else {
      args.push('-f', 'rtp', `rtp://127.0.0.1:${port}`);
    }

    this.emit('log', `Starting ffmpeg: screen=${screenIndex} (RTP to port ${port})`);
    console.log(`[capture] #spawnVideo: port=${port}`);
    console.log(`[capture] #spawnVideo: ffmpeg ${args.join(' ')}`);

    const proc = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    this.#process = proc;

    // Forward RTP packets from the UDP socket
    socket.on('message', (msg: Buffer) => {
      this.emit('videoRtp', msg);
    });

    let gotData = false;
    const noDataTimer = setTimeout(() => {
      if (!gotData && !this.#stopped) {
        this.emit('log', 'WARNING: No video data after 5 seconds. Screen recording permission may be missing.');
        this.emit('log', 'Go to: System Settings → Privacy & Security → Screen Recording → enable your terminal app.');
      }
    }, 5000);

    // Detect first RTP packet as "got data"
    const onFirstPacket = () => {
      if (!gotData) {
        gotData = true;
        clearTimeout(noDataTimer);
        this.emit('log', 'First video RTP packet received');
      }
    };
    socket.once('message', onFirstPacket);

    let fatalError = false;
    proc.stderr!.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        this.emit('log', msg);
        if (/unknown input format|no such input format|unrecognized input format/i.test(msg)) {
          fatalError = true;
          console.log(`[capture] FATAL detected in FFmpeg stderr: "${msg}"`);
        }
      }
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(noDataTimer);
      if (this.#stopped) return;
      if (fatalError) {
        // FFmpeg screencapturekit unavailable at runtime — switch to native Swift capture.
        // Delay 2.5s so the audio SCK stream (which retries at 1s) can connect first;
        // simultaneous SCK startCapture() calls from two processes interfere with each other.
        console.log('[capture] fatalError → calling #spawnVideoFallback (delayed 2.5s)');
        this.emit('log', 'FFmpeg screencapturekit unavailable, switching to native capture...');
        this.#closeVideoSocket();
        setTimeout(() => {
          if (this.#stopped) return;
          this.#spawnVideoFallback(screenIndex).catch((err: Error) => {
            console.error('[capture] #spawnVideoFallback error:', err);
            this.emit('error', err);
          });
        }, 2500);
        return;
      }
      this.emit('log', `FFmpeg exited with code ${code}, restarting...`);
      this.#closeVideoSocket();
      this.emit('restart');
      setTimeout(() => this.#spawnVideo(screenIndex), 1000);
    });

    proc.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  async #spawnVideoFallback(screenIndex: string): Promise<void> {
    if (this.#stopped) return;

    const { socket, port } = await bindUdpSocket();
    this.#videoSocket = socket;

    const { fps, bitrate, bufsize, gopSize } = this.#config;

    const binPath = resolveScAudioPath();
    console.log(`[capture] #spawnVideoFallback: sc-audio path=${binPath ?? 'NOT FOUND'}`);
    if (!binPath) {
      this.emit('error', new Error('sc-audio not found; cannot capture screen'));
      return;
    }

    const displayIndex = parseInt(screenIndex, 10) || 0;
    this.emit('log', `Starting sc-video fallback: display=${displayIndex} fps=${fps}`);
    console.log(`[capture] #spawnVideoFallback: display=${displayIndex} fps=${fps}`);

    const scVideo = spawn(binPath, ['capture-screen', '--display', String(displayIndex), '--fps', String(fps)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.#process = scVideo;

    // Wait for JSON header line on stderr: {"width":W,"height":H}\n
    let dims: { width: number; height: number };
    try {
      dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        let buf = '';
        const onData = (chunk: Buffer) => {
          buf += chunk.toString();
          const nl = buf.indexOf('\n');
          if (nl === -1) return;
          const line = buf.slice(0, nl);
          scVideo.stderr!.removeListener('data', onData);
          try {
            const parsed = JSON.parse(line);
            resolve({ width: parsed.width, height: parsed.height });
          } catch {
            reject(new Error(`sc-video: bad header: ${line}`));
          }
        };
        scVideo.stderr!.on('data', onData);
        scVideo.once('close', (code) => reject(new Error(`sc-video exited early (code ${code})`)));
        scVideo.once('error', reject);
      });
    } catch (err) {
      // Transient SCK error on startup (e.g. "application connection interrupted").
      // Retry like the audio pipeline does instead of treating it as fatal.
      if (this.#stopped) { if (scVideo.exitCode === null) scVideo.kill(); return; }
      if (scVideo.exitCode === null) scVideo.kill();
      this.#closeVideoSocket();
      this.emit('log', `sc-video startup failed (${(err as Error).message}), retrying...`);
      setTimeout(() => this.#spawnVideoFallback(screenIndex), 2500);
      return;
    }

    if (this.#stopped) { scVideo.kill(); return; }

    // Forward remaining stderr as log
    scVideo.stderr!.on('data', (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) this.emit('log', `[sc-video] ${msg}`);
    });

    const videoSize = `${dims.width}x${dims.height}`;
    console.log(`[capture] sc-video header received: ${videoSize}`);
    this.emit('log', `sc-video: ${videoSize}, starting encoder`);

    const ffmpegArgs: string[] = [
      '-hide_banner', '-loglevel', 'error',
      '-thread_queue_size', '512',
      '-f', 'rawvideo',
      '-pixel_format', 'nv12',
      '-video_size', videoSize,
      '-framerate', String(fps),
      '-i', 'pipe:0',
      '-vf', 'crop=trunc(iw/16)*16:trunc(ih/16)*16:0:0',
      '-c:v', 'h264_videotoolbox',
      '-allow_sw', '1',
      '-realtime', 'true',
      '-prio_speed', 'true',
      '-b:v', bitrate,
      '-maxrate', bitrate,
      '-bufsize', bufsize,
      '-g', String(gopSize),
      '-keyint_min', String(gopSize),
      '-profile:v', 'baseline',
      '-an',
    ];

    const recordTo = process.env.SCREENCAST_RECORD_TO;
    if (recordTo) {
      ffmpegArgs.push('-f', 'matroska', recordTo);
      console.log(`[capture] DEBUG recording to ${recordTo} — WebRTC stream inactive`);
    } else {
      ffmpegArgs.push('-f', 'rtp', `rtp://127.0.0.1:${port}`);
    }
    console.log(`[capture] encoder: ffmpeg ${ffmpegArgs.join(' ')}`);

    const encoder = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.#videoEncoder = encoder;

    scVideo.stdout!.pipe(encoder.stdin!);
    encoder.stdin!.on('error', () => {});

    socket.on('message', (msg: Buffer) => { this.emit('videoRtp', msg); });

    let gotData = false;
    const noDataTimer = setTimeout(() => {
      if (!gotData && !this.#stopped) {
        this.emit('log', 'WARNING: No video data after 5 seconds. Screen recording permission may be missing.');
      }
    }, 5000);
    socket.once('message', () => {
      if (!gotData) {
        gotData = true;
        clearTimeout(noDataTimer);
        console.log('[capture] #spawnVideoFallback: first RTP packet received!');
        this.emit('log', 'First video RTP packet received');
      }
    });

    encoder.stderr!.on('data', (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) this.emit('log', `[ffmpeg-enc] ${msg}`);
    });
    encoder.on('error', (err: Error) => { this.emit('error', err); });

    const restart = (source: string, code: number | null) => {
      clearTimeout(noDataTimer);
      if (this.#stopped) return;
      this.emit('log', `[${source}] Exited with code ${code}, restarting...`);
      if (this.#process) { this.#process.kill(); this.#process = null; }
      this.#killVideoEncoder();
      this.#closeVideoSocket();
      this.emit('restart');
      setTimeout(() => this.#spawnVideoFallback(screenIndex), 1000);
    };

    scVideo.on('close', (code) => restart('sc-video', code));
    encoder.on('close', (code) => {
      if (scVideo.exitCode === null && !scVideo.killed) restart('ffmpeg-enc', code);
    });
  }

  async #spawnAudio(audio: AudioConfig): Promise<void> {
    if (this.#stopped) return;

    const binPath = resolveScAudioPath();
    console.log(`[capture] #spawnAudio: mode=${audio.mode} sc-audio=${binPath ?? 'NOT FOUND'}`);
    if (!binPath) {
      this.emit('log', 'WARNING: sc-audio helper not found. Audio will be disabled.');
      return;
    }

    const { socket, port } = await bindUdpSocket();
    console.log(`[capture] #spawnAudio: Opus RTP port=${port}`);
    this.#audioSocket = socket;

    const helperArgs = ['capture'];
    if (audio.mode === 'app' && audio.appBundleId) {
      helperArgs.push('--app', audio.appBundleId);
    }

    this.emit('log', `Starting sc-audio: ${helperArgs.join(' ')} (Opus RTP to port ${port})`);

    // Spawn sc-audio — outputs raw PCM (f32le, 48kHz, stereo) to stdout
    const scAudio = spawn(binPath, helperArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.#audioProcess = scAudio;

    // Spawn FFmpeg to encode PCM → Opus → RTP
    const encoder = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
      '-c:a', 'libopus',
      '-b:a', this.#config.audioBitrate,
      '-frame_duration', '20',
      '-application', 'audio',
      '-vbr', 'on',
      '-f', 'rtp', `rtp://127.0.0.1:${port}`,
    ], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    this.#audioEncoder = encoder;

    // Pipe sc-audio stdout → FFmpeg stdin
    scAudio.stdout!.pipe(encoder.stdin!);

    // Forward RTP packets from the UDP socket
    socket.on('message', (msg: Buffer) => {
      this.emit('audioRtp', msg);
    });

    // Logging
    scAudio.stderr!.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) this.emit('log', `[sc-audio] ${msg}`);
    });

    encoder.stderr!.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) this.emit('log', `[opus] ${msg}`);
    });

    scAudio.on('error', (err: Error) => {
      this.emit('log', `[sc-audio] Error: ${err.message}`);
    });

    encoder.on('error', (err: Error) => {
      this.emit('log', `[opus] Error: ${err.message}`);
    });

    // Handle pipe errors
    encoder.stdin!.on('error', () => {});

    // Restart logic: if either process dies, kill the other and restart both
    const restartAudio = (source: string, code: number | null) => {
      if (this.#stopped) return;
      this.emit('log', `[${source}] Exited with code ${code}, restarting audio pipeline...`);
      this.#killAudioPipeline();
      setTimeout(() => this.#spawnAudio(audio), 1000);
    };

    scAudio.on('close', (code) => restartAudio('sc-audio', code));
    encoder.on('close', (code) => {
      if (scAudio.exitCode === null && !scAudio.killed) {
        restartAudio('opus', code);
      }
    });
  }

  #closeVideoSocket(): void {
    if (this.#videoSocket) {
      this.#videoSocket.close();
      this.#videoSocket = null;
    }
  }

  #killVideoEncoder(): void {
    if (this.#videoEncoder) {
      this.#videoEncoder.kill('SIGTERM');
      this.#videoEncoder = null;
    }
  }

  #killAudioPipeline(): void {
    if (this.#audioEncoder) {
      this.#audioEncoder.kill('SIGTERM');
      this.#audioEncoder = null;
    }
    if (this.#audioProcess) {
      this.#audioProcess.kill('SIGTERM');
      this.#audioProcess = null;
    }
    if (this.#audioSocket) {
      this.#audioSocket.close();
      this.#audioSocket = null;
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#killAudioPipeline();
    this.#killVideoEncoder();
    this.#closeVideoSocket();
    if (this.#process) {
      this.#process.kill('SIGTERM');
      this.#process = null;
    }
  }
}

export async function listDevices(): Promise<DeviceList> {
  return new Promise((resolve, reject) => {
    const sck = useSck();
    const args = sck
      // screencapturekit uses -list_displays, not avfoundation's -list_devices
      ? ['-hide_banner', '-f', 'screencapturekit', '-list_displays', '1', '-i', '']
      : ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''];

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let output = '';
    proc.stdout!.on('data', (d: Buffer) => { output += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { output += d.toString(); });
    proc.on('close', () => {
      const screens: Device[] = [];
      const audioDevices: Device[] = [];
      const lines = output.split('\n');

      if (sck) {
        // screencapturekit lists displays as: [N] Capture screen N
        for (const line of lines) {
          const match = line.match(/\[(\d+)]\s+(.+)/);
          if (match) screens.push({ index: match[1], name: match[2].trim() });
        }
        // Fallback: if listing failed or this FFmpeg build doesn't support
        // -list_displays, assume main display exists at index 0.
        if (screens.length === 0) {
          screens.push({ index: '0', name: 'Capture screen 0' });
        }
      } else {
        let section: 'video' | 'audio' | null = null;
        for (const line of lines) {
          if (line.includes('AVFoundation video devices:')) { section = 'video'; continue; }
          if (line.includes('AVFoundation audio devices:')) { section = 'audio'; continue; }
          const match = line.match(/\[(\d+)]\s+(.+)/);
          if (!match) continue;
          const index = match[1];
          const name = match[2].trim();
          if (section === 'video') screens.push({ index, name });
          else if (section === 'audio') audioDevices.push({ index, name });
        }
      }

      resolve({ screens, audioDevices });
    });

    proc.on('error', reject);
  });
}
