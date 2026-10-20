/**
 * Records Rooms to an MP4 by stepping the song clock, not by filming the screen.
 * Every frame is exactly 1/60 s, so the file stays at 60 fps even when a frame is slow to draw.
 */
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  Quality,
  canEncodeAudio,
  canEncodeVideo,
} from 'mediabunny';
import { MUSIC_URL } from './rooms-assets.js';

/** Frames per second of the exported picture. */
export const ROOMS_EXPORT_FPS = 60;
/** The file's picture size. H.264 wants even sides. */
export const ROOMS_EXPORT_WIDTH = 1920;
export const ROOMS_EXPORT_HEIGHT = 1080;

const VIDEO_BITRATE = 10_000_000;
const VIDEO_BITRATE_720 = 6_000_000;
const AUDIO_BITRATE = 192_000;
const FILE_NAME = 'rooms.mp4';

interface FilmSize {
  width: number;
  height: number;
  bitrate: number;
}

export interface RoomsExportFile {
  bytes: number;
  /** False when the song could not be read or encoded. The picture is still written. */
  audio: boolean;
}

export interface RoomsExportJob {
  /** Song seconds to record, from the start. */
  seconds: number;
  signal: AbortSignal;
  onSize: (width: number, height: number) => void;
  onProgress: (done: number, total: number) => void;
  /**
   * Draw song second `second`, then call `blit` with the canvas that holds that picture.
   * `blit` copies it before this function returns.
   */
  render: (second: number, blit: (source: HTMLCanvasElement) => void) => Promise<void>;
}

interface OpenFilm {
  output: Output;
  target: BufferTarget;
  picture: CanvasSource;
  song: AudioBufferSource | null;
}

/** Encode the piece and download `rooms.mp4`. */
export async function writeRoomsMp4(job: RoomsExportJob): Promise<RoomsExportFile> {
  const size = await pickFilmSize();
  const film = document.createElement('canvas');
  film.width = size.width;
  film.height = size.height;
  const ctx = film.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('This browser cannot copy the picture into the file.');
  job.onSize(size.width, size.height);

  const frames = Math.max(1, Math.round(job.seconds * ROOMS_EXPORT_FPS));
  const frameDur = 1 / ROOMS_EXPORT_FPS;
  const audio = await loadSong(frames * frameDur, job.signal);
  if (job.signal.aborted) throw new DOMException('Export stopped', 'AbortError');

  let filmOut = await openFilm(film, size, audio);
  let songWritten = false;
  try {
    if (filmOut.song && audio) {
      try {
        await filmOut.song.add(audio);
        songWritten = true;
      } catch (err) {
        if (job.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) throw err;
        console.warn('[rooms] export has no song', err);
        await cancelOutput(filmOut.output);
        filmOut = await openFilm(film, size, null);
      }
    }
    for (let i = 0; i < frames; i++) {
      if (job.signal.aborted) throw new DOMException('Export stopped', 'AbortError');
      await job.render(Math.min(job.seconds, i * frameDur), (source) => {
        ctx.drawImage(source, 0, 0, size.width, size.height);
      });
      await filmOut.picture.add(i * frameDur, frameDur);
      job.onProgress(i + 1, frames);
    }
    await filmOut.output.finalize();
  } catch (err) {
    await cancelOutput(filmOut.output);
    throw err;
  }

  const buffer = filmOut.target.buffer;
  if (!buffer) throw new Error('The export finished without a file.');
  const brand = new Uint8Array(buffer, 4, 4);
  const ftyp = String.fromCharCode(brand[0] ?? 0, brand[1] ?? 0, brand[2] ?? 0, brand[3] ?? 0);
  if (ftyp !== 'ftyp') throw new Error('The export was not an MP4.');
  download(buffer, FILE_NAME);
  console.info(
    `[rooms] export ${FILE_NAME} ${buffer.byteLength} bytes, ${size.width}x${size.height}, ${ROOMS_EXPORT_FPS} fps${songWritten ? '' : ', no song'}`,
  );
  return { bytes: buffer.byteLength, audio: songWritten };
}

/** Tracks are added before the file is started. The song samples come after. */
async function openFilm(film: HTMLCanvasElement, size: FilmSize, audio: AudioBuffer | null): Promise<OpenFilm> {
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target,
  });
  const picture = new CanvasSource(film, {
    codec: 'avc',
    quality: new Quality({ bitrate: size.bitrate, bitrateMode: 'variable' }),
    keyFrameInterval: 1,
  });
  output.addVideoTrack(picture, { frameRate: ROOMS_EXPORT_FPS });
  const song = audio ? new AudioBufferSource({ codec: 'aac', quality: new Quality({ bitrate: AUDIO_BITRATE }) }) : null;
  if (song) output.addAudioTrack(song);
  await output.start();
  return { output, target, picture, song };
}

async function cancelOutput(output: Output): Promise<void> {
  if (output.state === 'started' || output.state === 'finalizing') await output.cancel().catch(() => {});
}

/** 1920×1080 when the browser can encode it, otherwise 1280×720. */
async function pickFilmSize(): Promise<FilmSize> {
  const hd: FilmSize = { width: ROOMS_EXPORT_WIDTH, height: ROOMS_EXPORT_HEIGHT, bitrate: VIDEO_BITRATE };
  if (await canEncodeFilm(hd)) return hd;
  const sd: FilmSize = { width: 1280, height: 720, bitrate: VIDEO_BITRATE_720 };
  if (await canEncodeFilm(sd)) return sd;
  throw new Error('This browser cannot write an H.264 MP4.');
}

function canEncodeFilm(size: FilmSize): Promise<boolean> {
  return canEncodeVideo('avc', {
    width: size.width,
    height: size.height,
    frameRate: ROOMS_EXPORT_FPS,
    quality: new Quality({ bitrate: size.bitrate, bitrateMode: 'variable' }),
  });
}

/** The soundtrack, trimmed to the picture. Null when it cannot be read or encoded. */
async function loadSong(seconds: number, signal: AbortSignal): Promise<AudioBuffer | null> {
  try {
    const res = await fetch(MUSIC_URL, { signal });
    if (!res.ok) return null;
    const ctx = new AudioContext();
    try {
      const decoded = await ctx.decodeAudioData(await res.arrayBuffer());
      if (signal.aborted) return null;
      const channels = decoded.numberOfChannels;
      const audible = await canEncodeAudio('aac', {
        numberOfChannels: channels,
        sampleRate: decoded.sampleRate,
        quality: new Quality({ bitrate: AUDIO_BITRATE }),
      });
      if (!audible) return null;
      const frames = Math.max(1, Math.min(decoded.length, Math.round(seconds * decoded.sampleRate)));
      const clip = ctx.createBuffer(channels, frames, decoded.sampleRate);
      for (let c = 0; c < channels; c++) clip.copyToChannel(decoded.getChannelData(c).subarray(0, frames), c);
      return clip;
    } finally {
      await ctx.close().catch(() => {});
    }
  } catch (err) {
    if (signal.aborted) return null;
    console.warn('[rooms] export has no song', err);
    return null;
  }
}

function download(buffer: ArrayBuffer, name: string): void {
  const url = URL.createObjectURL(new Blob([buffer], { type: 'video/mp4' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
  link.remove();
}
