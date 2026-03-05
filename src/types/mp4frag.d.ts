declare module 'mp4frag' {
  import { Transform } from 'node:stream';

  interface Mp4FragInitEvent {
    mime: string;
    initialization: Buffer;
    m3u8: string | null;
  }

  interface Mp4FragSegmentEvent {
    segment: Buffer;
    sequence: number;
    duration: number;
    timestamp: number;
    keyframe: boolean;
  }

  class Mp4Frag extends Transform {
    constructor(options?: Record<string, unknown>);

    get mime(): string | null;
    get initialization(): Buffer | null;
    get segment(): Buffer | null;

    on(event: 'initialized', listener: (data: Mp4FragInitEvent) => void): this;
    on(event: 'segment', listener: (data: Mp4FragSegmentEvent) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  }

  export default Mp4Frag;
}
