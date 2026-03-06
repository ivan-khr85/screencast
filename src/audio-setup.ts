import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AudioApp {
  pid: number;
  name: string;
  bundleID: string;
}

function getScAudioSearchPaths(): string[] {
  const paths: string[] = [];

  // Packaged Electron app
  if (process.resourcesPath) {
    paths.push(path.join(process.resourcesPath, 'sc-audio'));
  }

  // Resolve __dirname for both ESM and CJS contexts
  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    dir = __dirname;
  }

  // Development — relative to dist/src/
  paths.push(path.join(dir, '..', '..', 'swift', 'sc-audio', '.build', 'release', 'sc-audio'));
  // Development — relative to src/ (tsx)
  paths.push(path.join(dir, '..', 'swift', 'sc-audio', '.build', 'release', 'sc-audio'));

  return paths;
}

export function resolveScAudioPath(): string | null {
  for (const p of getScAudioSearchPaths()) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function isScreenCaptureKitAvailable(): boolean {
  return resolveScAudioPath() !== null;
}

export async function listAudioApps(): Promise<AudioApp[]> {
  const binPath = resolveScAudioPath();
  if (!binPath) return [];

  return new Promise((resolve) => {
    execFile(binPath, ['list'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve([]);
      }
    });
  });
}
