"""帧级渲染：深海背景 + 角色动图 + UI 面板 + 胶囊字幕，直接管道给 ffmpeg 编码。

插件版（从 whale-video/render2 移植）改动：
  · ffmpeg 由 Node 侧传入（--ffmpeg，取自 tools/lib/ffmpeg.mjs），不再写死路径；
  · 画布固定按 1920x1080 设计分辨率绘制，输出尺寸（--width/--height）交给 ffmpeg 缩放：
    小尺寸 storyboard 只影响成片分辨率，不改变版式（渲染耗时仍按 1080p 计）；
  · --work-dir 指定单条视频目录：covers/<BV>.jpg 优先从这里找；封面输出按目标尺寸缩放。

用法（由 render.mjs 调用）：
  python render.py --story storyboard.json --timing timing.json --out silent.mp4 \
      --cover cover.jpg --ffmpeg <ffmpeg.exe> --width 1920 --height 1080 --work-dir <videoDir>
"""
import argparse
import json
import math
import os
import random
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import (  # noqa: E402
    W, H, font, text_size, wrap_text, fit_font, ease_out, ease_back,
    build_background, make_bubbles, make_sparkle, load_mascot_key, paste_layer,
    draw_icon, INK, INK_SOFT, BLUE, BLUE_SOFT, YELLOW, PINK, CYAN, ORANGE, RED,
    set_work_dir,
)
from cards import card_for, stamp_layer  # noqa: E402

CONTENT_X = 88
CONTENT_CY = 520
MASCOT_CX = 1540
MASCOT_BOTTOM = 1046
SUB_Y = H - 96
SHOUT_COLORS = {'yellow': (255, 210, 92), 'pink': (255, 110, 150), 'cyan': (127, 224, 255)}


# ---------------------------------------------------------------- 基础层
class Assets:
    def __init__(self):
        self.bg = build_background()
        self.bubbles = make_bubbles()
        self.sparkle = make_sparkle()
        self.topbar = self._make_topbar(None)
        self.bubble_field = []
        rnd = random.Random(20261024)
        for _ in range(20):
            self.bubble_field.append({
                'x': rnd.uniform(40, W - 40),
                'y': rnd.uniform(0, H),
                'speed': rnd.uniform(18, 46),
                'sway': rnd.uniform(8, 22),
                'phase': rnd.uniform(0, 6.28),
                'img': self.bubbles[rnd.randrange(len(self.bubbles))],
                'alpha': rnd.uniform(0.35, 0.9),
            })
        self.sparkles = [{'x': rnd.uniform(1100, 1850), 'y': rnd.uniform(180, 860),
                          'phase': rnd.uniform(0, 6.28), 'scale': rnd.uniform(0.35, 0.8)} for _ in range(7)]
        self.mascots = {}
        self.stamp_cache = {}
        self.card_cache = {}
        self.subtitle_cache = {}

    def _make_topbar(self, topbar):
        layer = Image.new('RGBA', (W, 170), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        topbar = topbar or {}
        badge = str(topbar.get('badge', 'Day 0'))
        bf = font(32)
        bw = d.textlength(badge, font=bf) + 44
        d.rounded_rectangle((64, 34, 64 + bw, 34 + 58), radius=16, fill=(255, 255, 255, 245))
        d.text((64 + 22, 44), badge, font=bf, fill=(12, 24, 44, 255))
        label = str(topbar.get('label', ''))
        lx = 64 + bw + 26
        d.ellipse((lx, 58, lx + 12, 70), fill=(255, 108, 120, 255))
        d.text((lx + 24, 48), label, font=font(27, False), fill=(214, 230, 248, 235))
        right = str(topbar.get('right', ''))
        rf = font(24, False)
        rw = d.textlength(right, font=rf)
        d.text((W - 64 - rw, 52), right, font=rf, fill=(190, 208, 232, 200))
        return layer

    def set_topbar(self, topbar):
        self.topbar = self._make_topbar(topbar)

    def mascot(self, key):
        if key not in self.mascots:
            self.mascots[key] = load_mascot_key(key)
        return self.mascots[key]

    def card(self, scene):
        sid = scene['id']
        if sid not in self.card_cache:
            spec = scene.get('card') or {}
            try:
                self.card_cache[sid] = card_for(spec)
            except Exception as e:  # 单张卡片坏了不拖垮整条视频
                print(f'[render] 卡片渲染失败 scene={sid}: {e}', flush=True)
                self.card_cache[sid] = None
        return self.card_cache[sid]

    def stamp(self, text):
        if text not in self.stamp_cache:
            self.stamp_cache[text] = stamp_layer(text)
        return self.stamp_cache[text]

    def subtitle(self, cue):
        key = cue['key']
        if key not in self.subtitle_cache:
            self.subtitle_cache[key] = render_subtitle_bar(cue)
        return self.subtitle_cache[key]


def render_subtitle_bar(cue):
    spans = cue['spans']
    tmp = ImageDraw.Draw(Image.new('RGB', (10, 10)))
    size = 44
    while size > 26:
        f = font(size)
        total = sum(tmp.textlength(t, font=f) for t, _ in spans)
        if total <= 1720:
            break
        size -= 2
    f = font(size)
    pad_x, pad_y = 34, 12
    tw = sum(tmp.textlength(t, font=f) for t, _ in spans)
    bw, bh = int(tw + pad_x * 2), int(size + pad_y * 2 + 8)
    layer = Image.new('RGBA', (bw + 40, bh + 40), (0, 0, 0, 0))
    # 柔和投影
    sh = Image.new('RGBA', layer.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((20, 26, 20 + bw, 26 + bh), radius=18, fill=(2, 8, 20, 120))
    layer = Image.alpha_composite(layer, sh.filter(ImageFilter.GaussianBlur(12)))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle((20, 20, 20 + bw, 20 + bh), radius=18, fill=(7, 16, 34, 205))
    x = 20 + pad_x
    for text, color in spans:
        d.text((x, 20 + pad_y - 3), text, font=f, fill=tuple(color))
        x += tmp.textlength(text, font=f)
    return {'img': layer, 'w': bw + 40, 'h': bh + 40}


# ---------------------------------------------------------------- 帧合成
def draw_bubbles(frame, t, assets):
    for b in assets.bubble_field:
        y = (b['y'] - t * b['speed']) % (H + 160) - 80
        x = b['x'] + math.sin(t * 0.45 + b['phase']) * b['sway']
        paste_layer(frame, b['img'], x, y, alpha=b['alpha'])


def draw_sparkles(frame, t, assets):
    for s in assets.sparkles:
        a = 0.25 + 0.75 * max(0.0, math.sin(t * 1.6 + s['phase']))
        img = assets.sparkle
        w = int(img.width * s['scale'])
        h = int(img.height * s['scale'])
        if w < 2:
            continue
        im = img.resize((w, h), Image.BILINEAR)
        paste_layer(frame, im, s['x'] - w / 2, s['y'] - h / 2, alpha=a * 0.8)


def draw_mascot(frame, t, scene, t_scene, assets):
    key = scene.get('mascot', 'happy')
    frames, info = assets.mascot(key)
    if not frames:
        return
    fi = int((t_scene * 20) % len(frames))
    spr = frames[fi]
    bob = 7 * math.sin(t * 2.1 + 0.4)
    # 出场小跳
    hop = 0
    if t_scene < 0.42:
        hop = -26 * (1 - ease_out(t_scene / 0.42))
    # 光晕
    glow = Image.new('RGBA', (spr.width + 260, spr.height + 260), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((60, 60, spr.width + 200, spr.height + 200), fill=(70, 150, 255, 34))
    glow = glow.filter(ImageFilter.GaussianBlur(60))
    gx = MASCOT_CX - glow.width / 2
    gy = MASCOT_BOTTOM - spr.height - 20 - glow.height / 2 + 130
    paste_layer(frame, glow, gx, gy, alpha=1.0)
    # 地面阴影
    sh = Image.new('RGBA', (spr.width, 90), (0, 0, 0, 0))
    ImageDraw.Draw(sh).ellipse((spr.width * 0.16, 18, spr.width * 0.84, 78), fill=(3, 10, 24, 130))
    sh = sh.filter(ImageFilter.GaussianBlur(16))
    paste_layer(frame, sh, MASCOT_CX - spr.width / 2, MASCOT_BOTTOM - 58)
    x = MASCOT_CX - spr.width / 2
    y = MASCOT_BOTTOM - spr.height + bob + hop
    paste_layer(frame, spr, x, y, alpha=1.0)


def draw_card(frame, t_scene, scene, assets):
    card = assets.card(scene)
    if not card:
        return
    p = ease_out(min(1.0, t_scene / 0.36))
    dx = (1 - p) * -110
    alpha = 0.15 + 0.85 * p
    layer = card['img']
    x = CONTENT_X - card['pad'] + dx
    cy = CONTENT_CY + (10 if int(scene.get('i', 0)) % 2 == 0 else -10)
    y = cy - card['h'] / 2 - card['pad']
    paste_layer(frame, layer, x, y, alpha=alpha)


def draw_text_block(frame, t_scene, scene, assets):
    kind = (scene.get('card') or {}).get('kind')
    if kind not in ('big', 'ending'):
        return
    spec = scene['card']
    d = ImageDraw.Draw(frame)
    p = ease_out(min(1.0, t_scene / 0.3))
    if kind == 'big':
        text = str(spec.get('text', ''))
        size = 100
        cx = CONTENT_X + 542
        cy = CONTENT_CY
        while size > 40:
            f = font(size)
            tw = d.textlength(text, font=f)
            if tw <= 1000:
                break
            size -= 2
        f = font(size)
        tw = d.textlength(text, font=f)
        y = cy - size / 2 - 40 + (1 - p) * 24
        # 阴影
        sh = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        sd = ImageDraw.Draw(sh)
        sd.text((cx - tw / 2 + 4, y + 6), text, font=f, fill=(2, 8, 20, 170))
        sh = sh.filter(ImageFilter.GaussianBlur(10))
        frame.paste(sh, (0, 0), sh)
        d = ImageDraw.Draw(frame)
        d.text((cx - tw / 2, y), text, font=f, fill=(255, 255, 255, 255))
        sub = str(spec.get('sub', ''))
        if sub:
            sf = font(40, False)
            sw = d.textlength(sub, font=sf)
            d.text((cx - sw / 2, y + size + 34), sub, font=sf, fill=(178, 208, 240, 255))
    else:  # ending
        title = str(spec.get('title', ''))
        sub = str(spec.get('sub', ''))
        cx = W / 2 - 120
        cy = 470
        tf = fit_font(d, title, 64, 1200)
        tw = d.textlength(title, font=tf)
        d.text((cx - tw / 2, cy - 40), title, font=tf, fill=(255, 255, 255, 255))
        d.line([(cx - 180, cy + 50), (cx + 180, cy + 50)], fill=(120, 200, 255, 180), width=3)
        if sub:
            sf = font(34, False)
            sw = d.textlength(sub, font=sf)
            d.text((cx - sw / 2, cy + 76), sub, font=sf, fill=(176, 205, 238, 255))


def draw_stamp(frame, t_scene, scene, assets):
    st = scene.get('stamp')
    if not st:
        return
    p = ease_back(max(0.0, min(1.0, (t_scene - 0.32) / 0.35)))
    if p <= 0.001:
        return
    layer = assets.stamp(str(st.get('text', '')))
    scale = 0.6 + 0.4 * p
    img = layer.resize((max(2, int(layer.width * scale)), max(2, int(layer.height * scale))), Image.BICUBIC)
    pos = st.get('pos', 'right')
    if pos == 'right':
        x, y = 1000, 240
    elif pos == 'center':
        x, y = 760, 300
    else:
        x, y = 150, 250
    paste_layer(frame, img, x - img.width / 2, y - img.height / 2, alpha=min(1.0, p * 1.2))


def draw_shout(frame, t_scene, scene):
    sh = scene.get('shout')
    if not sh:
        return
    p = ease_back(max(0.0, min(1.0, (t_scene - 0.32) / 0.32)))
    if p <= 0.001:
        return
    text = str(sh.get('text', ''))
    if not text:
        return
    f = font(76)
    tmp = ImageDraw.Draw(Image.new('RGB', (10, 10)))
    tw = tmp.textlength(text, font=f)
    layer = Image.new('RGBA', (int(tw) + 90, 170), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for ox, oy in [(-4, 0), (4, 0), (0, -4), (0, 4), (-4, -4), (4, 4), (-4, 4), (4, -4)]:
        d.text((45 + ox, 26 + oy), text, font=f, fill=(8, 16, 32, 235))
    col = SHOUT_COLORS.get(str(sh.get('color', 'yellow')), SHOUT_COLORS['yellow'])
    d.text((45, 26), text, font=f, fill=col + (255,))
    layer = layer.rotate(float(sh.get('angle', -4)), expand=True, resample=Image.BICUBIC)
    scale = 0.65 + 0.35 * p
    layer = layer.resize((max(2, int(layer.width * scale)), max(2, int(layer.height * scale))), Image.BICUBIC)
    pos = str(sh.get('pos', 'top'))
    if pos == 'right':
        cx, cy = 1120, 235
    elif pos == 'left':
        cx, cy = 300, 250
    else:
        cx, cy = CONTENT_X + 540, 196
    paste_layer(frame, layer, cx - layer.width / 2, cy - layer.height / 2, alpha=min(1.0, p * 1.25))


def draw_footer(frame, footer):
    if not footer:
        return
    d = ImageDraw.Draw(frame)
    d.text((64, 930), footer, font=font(22, False), fill=(176, 200, 228, 105))


def draw_topbar(frame, assets):
    paste_layer(frame, assets.topbar, 0, 0)


def draw_subtitle(frame, t, timing, assets):
    cue = None
    for c in timing['cues']:
        if c['start'] <= t < c['end']:
            cue = c
            break
    if not cue:
        return
    bar = assets.subtitle(cue)
    x = (W - bar['w']) / 2
    y = H - 40 - bar['h'] + 12
    paste_layer(frame, bar['img'], x, y)


def render_frame(t, timing, assets, scene, footer=''):
    frame = assets.bg.copy()
    draw_bubbles(frame, t, assets)
    draw_sparkles(frame, t, assets)
    t_scene = t - scene['start']
    draw_mascot(frame, t, scene, t_scene, assets)
    draw_card(frame, t_scene, scene, assets)
    draw_text_block(frame, t_scene, scene, assets)
    draw_stamp(frame, t_scene, scene, assets)
    draw_shout(frame, t_scene, scene)
    draw_topbar(frame, assets)
    draw_footer(frame, footer)
    draw_subtitle(frame, t, timing, assets)
    return frame


# ---------------------------------------------------------------- 封面
def _cover_mascot(assets):
    frames, info = assets.mascot('happy')
    return frames[len(frames) // 2] if frames else None


def render_cover(story, out_path, assets, target_size=None):
    frame = assets.bg.copy()
    draw_bubbles(frame, 12.0, assets)
    spr = _cover_mascot(assets)
    if spr is not None:
        x = MASCOT_CX - spr.width / 2
        y = MASCOT_BOTTOM - spr.height + 10
        glow = Image.new('RGBA', (spr.width + 260, spr.height + 260), (0, 0, 0, 0))
        ImageDraw.Draw(glow).ellipse((60, 60, spr.width + 200, spr.height + 200), fill=(70, 150, 255, 40))
        pasta = glow.filter(ImageFilter.GaussianBlur(60))
        paste_layer(frame, pasta, x - 130, y - 120)
        paste_layer(frame, spr, x, y)
    d = ImageDraw.Draw(frame)
    title = str(story.get('coverTitle') or story.get('title') or '')
    # 按逗号分句 + 自动选字号/断行，保证两行都能放下
    segs = [x for x in title.split('，') if x]
    chosen = None
    for size in (96, 92, 88, 84, 80, 76):
        fnt = font(size)
        for cut in range(1, max(2, len(segs))):
            if cut >= len(segs):
                continue
            l1 = '，'.join(segs[:cut])
            l2 = '，'.join(segs[cut:])
            w1 = d.textlength(l1, font=fnt)
            w2 = d.textlength(l2, font=fnt)
            if w1 <= 1120 and w2 <= 1120:
                chosen = (size, [l1, l2], max(w1, w2))
                break
        if chosen:
            break
    size, lines, _ = chosen if chosen else (96, [title], 0)
    fnt = font(size)
    y0 = 300
    line_h = int(size * 1.28)
    for i, line in enumerate(lines):
        sh = ImageDraw.Draw(frame)
        sh.text((96 + 4, y0 + i * line_h + 6), line, font=fnt, fill=(2, 8, 20, 180))
        d = ImageDraw.Draw(frame)
        d.text((96, y0 + i * line_h), line, font=fnt, fill=(255, 255, 255, 255))
    sub = str(story.get('coverSub') or '')
    if sub:
        d.text((100, y0 + len(lines) * 126 + 10), sub, font=font(40, False), fill=(180, 212, 246, 255))
    badge = str((story.get('topbar') or {}).get('badge', 'Day 0'))
    bf = font(34)
    bw = d.textlength(badge, font=bf) + 48
    d.rounded_rectangle((96, 190, 96 + bw, 250), radius=16, fill=(255, 255, 255, 245))
    d.text((96 + 24, 201), badge, font=bf, fill=(12, 24, 44, 255))
    label = str((story.get('topbar') or {}).get('label') or 'AI 接管中 · 大肥鱼的运营日志')
    d.text((96 + bw + 24, 202), label, font=font(28, False), fill=(214, 232, 250, 240))
    if target_size and tuple(target_size) != (W, H):
        frame = frame.resize(tuple(target_size), Image.LANCZOS)
    frame.convert('RGB').save(out_path, quality=92)


# ---------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--story', required=True)
    ap.add_argument('--timing', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--cover', default=None)
    ap.add_argument('--ffmpeg', required=True)
    ap.add_argument('--width', type=int, default=W)
    ap.add_argument('--height', type=int, default=H)
    ap.add_argument('--work-dir', default=None)
    args = ap.parse_args()

    out_w, out_h = int(args.width), int(args.height)
    if out_w <= 0 or out_h <= 0:
        raise SystemExit(f'输出尺寸非法: {out_w}x{out_h}')
    if out_w % 2 or out_h % 2:
        raise SystemExit(f'输出尺寸必须为偶数（H.264 yuv420p 要求）: {out_w}x{out_h}')
    set_work_dir(args.work_dir)

    with open(args.story, encoding='utf-8') as f:
        story = json.load(f)
    with open(args.timing, encoding='utf-8') as f:
        timing = json.load(f)
    fps = float(timing.get('fps', 30))
    total = float(timing['total'])
    scenes = timing['scenes']
    if not scenes:
        raise SystemExit('timing.scenes 为空')

    assets = Assets()
    assets.set_topbar(story.get('topbar'))
    footer = str(story.get('footer') or ('不想干活的大肥鱼 · ' + str((story.get('topbar') or {}).get('badge', 'Day 0'))))
    if args.cover:
        render_cover(story, args.cover, assets, target_size=(out_w, out_h))
        print(f'[render] cover {args.cover}', flush=True)

    n = int(round(total * fps))
    cmd = [args.ffmpeg, '-y', '-hide_banner', '-loglevel', 'error',
           '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(fps), '-i', '-']
    if (out_w, out_h) != (W, H):
        cmd += ['-vf', f'scale={out_w}:{out_h}:flags=bicubic']
    cmd += ['-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart', args.out]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    sidx = 0
    try:
        for i in range(n):
            t = i / fps
            while sidx + 1 < len(scenes) and t >= scenes[sidx + 1]['start']:
                sidx += 1
            frame = render_frame(t, timing, assets, scenes[sidx], footer)
            proc.stdin.write(frame.tobytes())
            if i % 150 == 0:
                print(f'[render] {i}/{n}', flush=True)
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        code = proc.wait()
    if code != 0:
        raise SystemExit(f'ffmpeg 编码失败: {code}')
    print(f'[render] done {args.out} {total:.2f}s {out_w}x{out_h}', flush=True)


if __name__ == '__main__':
    main()
