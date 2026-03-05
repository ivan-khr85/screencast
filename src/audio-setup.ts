import { listDevices, Device } from './capture.js';

const BLACKHOLE_NAME = 'BlackHole 2ch';

export async function detectBlackHole(): Promise<Device | null> {
  const { audioDevices } = await listDevices();
  const device = audioDevices.find((d) => d.name.includes('BlackHole'));
  return device || null;
}

export function printAudioSetupGuide(): void {
  console.log(`
  ┌─────────────────────────────────────────────────────────┐
  │  System audio capture requires BlackHole virtual driver  │
  └─────────────────────────────────────────────────────────┘

  Install:
    brew install blackhole-2ch

  Setup (one-time):
    1. Open "Audio MIDI Setup" (Spotlight → Audio MIDI Setup)
    2. Click "+" at bottom-left → "Create Multi-Output Device"
    3. Check both your speakers/headphones AND "${BLACKHOLE_NAME}"
    4. Right-click the Multi-Output Device → "Use This Device For Sound Output"

  This routes audio to both your speakers and the virtual device
  so FFmpeg can capture system audio.

  Run with --no-audio to skip audio capture.
`);
}
