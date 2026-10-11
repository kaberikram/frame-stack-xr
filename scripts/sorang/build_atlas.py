# Builds the stock-photo atlas: seeded Lorem Picsum photos, stratified by luma, packed dark-to-light into one JPEG grid.
# Usage: python3 -I scripts/sorang/build_atlas.py <outDir> [--candidates 240] [--count 100] [--tile 128]
import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.request

import numpy as np
from PIL import Image, ImageOps

SEED_URL = 'https://picsum.photos/seed/sorang-%03d/256/256'
INFO_URL = 'https://picsum.photos/id/%s/info'
USER_AGENT = 'frame-stack-xr-sorang-atlas/1.0 (+python-urllib)'
COLS = 10
BINS = 10
WORKERS = 4
TIMEOUT = 20
ATTEMPTS = 3
MAX_BYTES = 8 * 1024 * 1024


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def get(url):
    """GET with retries. Returns (body, final_url, headers) or raises the last error."""
    last = None
    for attempt in range(ATTEMPTS):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
                body = res.read(MAX_BYTES + 1)
                if len(body) > MAX_BYTES:
                    raise ValueError('response too large')
                return body, res.geturl(), res.headers
        except Exception as err:  # network, HTTP or size error: back off and retry
            last = err
            time.sleep(1.0 + attempt * 2.0)
    raise last


def fetch_candidate(n, tmp):
    seed = 'sorang-%03d' % n
    try:
        body, final_url, headers = get(SEED_URL % n)
    except Exception as err:
        log('skip %s: %s' % (seed, err))
        return None
    pid = (headers.get('picsum-id') or '').strip()
    if not pid.isdigit():
        m = re.search(r'/id/(\d+)/', final_url)
        pid = m.group(1) if m else ''
    if not pid:
        log('skip %s: no picsum id (%s)' % (seed, final_url))
        return None
    path = os.path.join(tmp, seed + '.jpg')
    with open(path, 'wb') as f:
        f.write(body)
    return {'seed': seed, 'id': pid, 'path': path}


def fetch_info(pid):
    try:
        body, _, _ = get(INFO_URL % pid)
        info = json.loads(body.decode('utf-8'))
        author, url = info.get('author'), info.get('url')
        if not isinstance(author, str) or not isinstance(url, str) or not url.startswith('https://'):
            raise ValueError('incomplete info')
        return {'author': author, 'url': url}
    except Exception as err:
        log('no credits for id %s: %s' % (pid, err))
        return None


def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def make_tile(path, tile):
    with Image.open(path) as im:
        im.load()
        im = ImageOps.exif_transpose(im).convert('RGB')
    w, h = im.size
    s = min(w, h)
    left, top = (w - s) // 2, (h - s) // 2
    im = im.crop((left, top, left + s, top + s)).resize((tile, tile), Image.LANCZOS)
    rgb = srgb_to_linear(np.asarray(im, dtype=np.float64) / 255.0)
    luma = float((rgb @ np.array([0.2126, 0.7152, 0.0722])).mean())
    return im, luma


def select(pool, count, lo, hi):
    """Pick `count` photos, an equal quota per luma decile of [lo, hi]; short bins borrow the nearest leftovers."""
    span = (hi - lo) or 1.0
    quota = count // BINS
    width = span / BINS
    bins = [[] for _ in range(BINS)]
    for c in pool:
        bins[min(int((c['luma'] - lo) / span * BINS), BINS - 1)].append(c)
    chosen, short = [], []
    for b, members in enumerate(bins):
        members.sort(key=lambda c: (c['luma'], c['seed']))
        if len(members) <= quota:
            picked = members
        else:  # spread the quota evenly through the bin so the ramp stays smooth
            idx = np.round(np.linspace(0, len(members) - 1, quota)).astype(int)
            picked = [members[i] for i in idx]
        chosen.extend(picked)
        if len(picked) < quota:
            short.append((b, quota - len(picked)))
    used = {c['seed'] for c in chosen}
    for b, missing in short:
        centre = lo + (b + 0.5) * width
        spare = sorted((c for c in pool if c['seed'] not in used), key=lambda c: (abs(c['luma'] - centre), c['seed']))
        for c in spare[:missing]:
            chosen.append(c)
            used.add(c['seed'])
    return chosen, [len(m) for m in bins]


def main():
    ap = argparse.ArgumentParser(description='Build the sorang stock-photo atlas from Lorem Picsum.')
    ap.add_argument('outDir')
    ap.add_argument('--candidates', type=int, default=240)
    ap.add_argument('--count', type=int, default=100)
    ap.add_argument('--tile', type=int, default=128)
    args = ap.parse_args()
    if args.count <= 0 or args.count % COLS or args.count % BINS:
        ap.error('--count must be a positive multiple of %d' % COLS)
    out_dir = os.path.abspath(args.outDir)
    rows = args.count // COLS

    tmp = tempfile.mkdtemp(prefix='sorang-atlas-')
    try:
        # 1. Download candidates (small, polite concurrency).
        with concurrent.futures.ThreadPoolExecutor(WORKERS) as ex:
            results = list(ex.map(lambda n: fetch_candidate(n, tmp), range(args.candidates)))
        downloaded = [r for r in results if r]
        log('downloaded %d/%d candidates' % (len(downloaded), args.candidates))

        # 2. Drop duplicate ids (and byte-identical tiles), decode, crop, measure luma.
        pool, seen_ids, seen_px = [], set(), set()
        for c in downloaded:
            if c['id'] in seen_ids:
                continue
            seen_ids.add(c['id'])
            try:
                c['tile'], c['luma'] = make_tile(c['path'], args.tile)
            except Exception as err:
                log('skip %s (id %s): undecodable: %s' % (c['seed'], c['id'], err))
                continue
            digest = hashlib.sha1(c['tile'].tobytes()).hexdigest()
            if digest in seen_px:
                continue
            seen_px.add(digest)
            pool.append(c)
        log('%d unique photos (%d duplicate ids dropped)' % (len(pool), len(downloaded) - len(seen_ids)))
        if len(pool) < args.count:
            sys.exit('only %d unique photos, need %d; raise --candidates' % (len(pool), args.count))
        lumas = [c['luma'] for c in pool]
        lo, hi = min(lumas), max(lumas)

        # 3. Stratify, fetching credits for the chosen set; a photo without credits is dropped and the pick redone.
        credits = {}
        while True:
            chosen, hist = select(pool, args.count, lo, hi)
            need = [c['id'] for c in chosen if c['id'] not in credits]
            with concurrent.futures.ThreadPoolExecutor(WORKERS) as ex:
                for pid, info in zip(need, ex.map(fetch_info, need)):
                    credits[pid] = info
            missing = {c['id'] for c in chosen if credits[c['id']] is None}
            if not missing:
                break
            pool = [c for c in pool if c['id'] not in missing]
            if len(pool) < args.count:
                sys.exit('not enough credited photos (%d), need %d' % (len(pool), args.count))
        if len(chosen) != args.count:
            sys.exit('selection produced %d photos, need %d' % (len(chosen), args.count))
        chosen.sort(key=lambda c: (c['luma'], c['seed']))

        # 4. Pack row-major, dark to light.
        atlas = Image.new('RGB', (COLS * args.tile, rows * args.tile))
        for k, c in enumerate(chosen):
            atlas.paste(c['tile'], ((k % COLS) * args.tile, (k // COLS) * args.tile))
        os.makedirs(out_dir, exist_ok=True)
        atlas.save(os.path.join(out_dir, 'photos.jpg'), 'JPEG', quality=85, subsampling=0, optimize=True)

        meta = {
            'tile': args.tile,
            'cols': COLS,
            'rows': rows,
            'count': args.count,
            'source': 'Lorem Picsum (picsum.photos), photos from Unsplash',
            'license': 'Unsplash License',
            'photos': [
                {
                    'layer': k,
                    'seed': c['seed'],
                    'id': c['id'],
                    'author': credits[c['id']]['author'],
                    'url': credits[c['id']]['url'],
                    'luma': round(c['luma'], 4),
                }
                for k, c in enumerate(chosen)
            ],
        }
        with open(os.path.join(out_dir, 'photos.json'), 'w', encoding='utf-8') as f:
            f.write(json.dumps(meta, indent=2, ensure_ascii=False) + '\n')

        log('candidate luma range %.4f..%.4f, decile counts %s' % (lo, hi, hist))
        log('atlas luma range %.4f..%.4f -> %s' % (chosen[0]['luma'], chosen[-1]['luma'], out_dir))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
