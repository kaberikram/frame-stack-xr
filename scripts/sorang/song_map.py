# Prints a song's map for timing Sorang to it: loudness, bass and highs per 4 s, and the strongest
# low-end onsets (where the drops are). Read it to re-time SONG_MAP in src/sorang-song.ts.
# Usage: python3 -I scripts/sorang/song_map.py public/sorang/music.mp3
import argparse
import subprocess

import numpy as np

SR = 22050
N = 1024
HOP = 256
FPS = 50
BASS = (20, 150)
HIGH = (4000, 11000)
# Attack and release of each envelope, seconds: fast up, slower down, so a hit reads as a pulse.
SMOOTH = {'bass': (0.01, 0.16), 'high': (0.005, 0.08), 'energy': (0.02, 0.25)}
KICK_GAP = 0.12
HIT_GAP = 0.1
# A peak must clear the local median by this many local MADs to count as an onset.
KICK_K = 2.5
HIT_K = 3.0


def decode(path):
    raw = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'],
        check=True, stdout=subprocess.PIPE,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


def spectrum(x):
    frames = (len(x) - N) // HOP
    win = np.hanning(N).astype(np.float32)
    idx = np.arange(N)[None, :] + HOP * np.arange(frames)[:, None]
    mags = np.abs(np.fft.rfft(x[idx] * win, axis=1))
    freqs = np.fft.rfftfreq(N, 1 / SR)
    # Frame centre, seconds.
    centres = (np.arange(frames) * HOP + N / 2) / SR
    return mags, freqs, centres


def band(mags, freqs, lo, hi):
    m = (freqs >= lo) & (freqs < hi)
    return mags[:, m].sum(1)


def normalise(v):
    """Log level mapped so the quiet floor is 0 and the loud end is 1."""
    db = 20 * np.log10(v + 1e-6)
    lo, hi = np.percentile(db, 5), np.percentile(db, 99.5)
    return np.clip((db - lo) / max(hi - lo, 1e-6), 0, 1)


def to_fps(values, centres, duration):
    count = int(np.ceil(duration * FPS))
    t = np.arange(count) / FPS
    return np.interp(t, centres, values)


def smooth(v, attack, release):
    out = np.empty_like(v)
    a = 1 - np.exp(-1 / (FPS * attack))
    r = 1 - np.exp(-1 / (FPS * release))
    y = 0.0
    for i, x in enumerate(v):
        y += (x - y) * (a if x > y else r)
        out[i] = y
    return out


def onsets(flux, gap, k):
    """Peaks of an onset curve above a local median + k·MAD, at least `gap` apart. Times are diff-frame centres."""
    fps = SR / HOP
    half = int(fps * 0.5)
    times = []
    strengths = []
    for i in range(1, len(flux) - 1):
        if flux[i] < flux[i - 1] or flux[i] < flux[i + 1]:
            continue
        lo, hi = max(0, i - half), min(len(flux), i + half)
        local = flux[lo:hi]
        med = np.median(local)
        mad = np.median(np.abs(local - med)) + 1e-6
        if flux[i] < med + k * mad:
            continue
        # The flux between frames i and i+1 peaks when the onset crosses the window centre.
        t = (i * HOP + N / 2 + HOP / 2) / SR
        if times and t - times[-1] < gap:
            if flux[i] > strengths[-1]:
                times[-1] = t
                strengths[-1] = flux[i]
            continue
        times.append(t)
        strengths.append(flux[i])
    s = np.array(strengths)
    scale = np.percentile(s, 98) if len(s) else 1
    return [[round(float(t), 3), round(float(min(1.0, v / scale)), 2)] for t, v in zip(times, s)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('audio')
    parser.add_argument('--drops', type=int, default=6, help='How many of the strongest low-end onsets to list.')
    args = parser.parse_args()

    x = decode(args.audio)
    duration = len(x) / SR
    mags, freqs, centres = spectrum(x)
    log_mags = np.log1p(100 * mags)
    low = freqs < BASS[1]
    low_flux = np.maximum(0, np.diff(log_mags[:, low], axis=0)).sum(1)
    full_flux = np.maximum(0, np.diff(log_mags, axis=0)).sum(1)
    rms = np.sqrt(np.mean((mags / N) ** 2, axis=1))

    env = {}
    for name, values in (
        ('bass', band(mags, freqs, *BASS)),
        ('high', band(mags, freqs, *HIGH)),
        ('energy', rms),
    ):
        env[name] = smooth(to_fps(normalise(values), centres, duration), *SMOOTH[name])

    kicks = onsets(low_flux, KICK_GAP, KICK_K)
    hits = onsets(full_flux, HIT_GAP, HIT_K)

    print(f'{args.audio}: {duration:.2f} s, {len(kicks)} low onsets, {len(hits)} hits')
    print('strongest low onsets (drop candidates):', ', '.join(f'{t:.2f}s' for t, _ in sorted(kicks, key=lambda k: -k[1])[: args.drops]))
    for start in range(0, int(duration), 4):
        sl = slice(start * FPS, (start + 4) * FPS)
        e, b, h = env['energy'][sl].mean(), env['bass'][sl].mean(), env['high'][sl].mean()
        k = sum(1 for t, s in kicks if start <= t < start + 4 and s > 0.4)
        print(f'{start:4d}s energy {e:.2f} bass {b:.2f} high {h:.2f} strong kicks {k:2d} ' + '#' * int(e * 40))


if __name__ == '__main__':
    main()
