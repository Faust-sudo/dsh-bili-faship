"""视频渲染基础库：素材缓存、背景、字体、贴纸动图、通用绘制工具。

插件版（从 whale-video/render2 移植，dsh-bili-faship 的 tools/video）改动：
  · 素材路径相对本文件（tools/video/assets），不写死绝对路径；
  · 表情包按 DESIGN §3 的解析链找：
      WHALE_STICKER_DIR（宿主/渲染器显式传入，含"设置页配置"的值）
      → <DSH_HOME>/bili-whale/stickers/packs/大肥鱼（本机已有就复用，不重复下载）
      → <DSH_HOME>/bili-faship/stickers（插件自己的兜底目录）
    衍生帧缓存默认写到 <DSH_HOME>/bili-faship/cache（WHALE_VIDEO_CACHE 可覆盖），不污染插件包；
  · 字体按 Windows 自带路径找，找不到退回 Pillow 默认字体（不崩）；
  · 画布固定按 1920x1080 设计分辨率绘制，输出尺寸由 render.py 交给 ffmpeg 缩放。
"""
import glob
import json
import os
import functools

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
VIDEO_DIR = os.path.dirname(HERE)               # tools/video
ASSETS = os.path.join(VIDEO_DIR, 'assets')

HOME = os.environ.get('USERPROFILE') or os.environ.get('HOME') or os.path.expanduser('~')
DSH_HOME = os.environ.get('DSH_HOME') or os.path.join(HOME, '.dsh')
FASHIP_HOME = os.path.join(DSH_HOME, 'bili-faship')


def _first_dir(cands, fallback):
    """返回第一个存在的目录；都不存在时返回 fallback（调用方拿它做提示/缓存位）。"""
    for p in cands:
        if p and os.path.isdir(p):
            return p
    return fallback


# 表情包目录：env/配置传入的 WHALE_STICKER_DIR 优先，其次复用本机 bili-whale 的表情包，
# 最后落到插件自己的 stickers/（DESIGN §3）。宿主在调渲染器前会把配置值塞进这个 env。
STICKER_SRC = _first_dir([
    os.environ.get('WHALE_STICKER_DIR'),
    os.path.join(DSH_HOME, 'bili-whale', 'stickers', 'packs', '大肥鱼'),
], os.path.join(FASHIP_HOME, 'stickers'))

# 表情帧缓存：env WHALE_VIDEO_CACHE 最优先（render.mjs 会把配置 paths.cache 合进去），
# 默认 <DSH_HOME>/bili-faship/cache —— 不要写进插件包，也不要写到 bili-whale 的数据目录里。
CACHE_ROOT = os.environ.get('WHALE_VIDEO_CACHE') or os.path.join(FASHIP_HOME, 'cache')
CACHE_MASCOT = os.path.join(CACHE_ROOT, 'mascot')
CACHE_BG = os.path.join(CACHE_ROOT, 'bg')
# 引用视频封面（可选）：<videoDir>/covers/<BV>.jpg 或 assets/covers/<BV>.jpg，缺失时画占位
COVERS_DIRS = []
_work_dir = None


def set_work_dir(path):
    """render.py 传入的单条视频工作目录：优先从这里找 covers/<BV>.jpg。"""
    global _work_dir, COVERS_DIRS
    _work_dir = path
    dirs = []
    if path:
        dirs.append(os.path.join(path, 'covers'))
    env = os.environ.get('WHALE_VIDEO_COVERS')
    if env:
        dirs.append(env)
    dirs.append(os.path.join(ASSETS, 'covers'))
    COVERS_DIRS = dirs


# ---------------------------------------------------------------- 字体
FONT_CANDIDATES_BOLD = [
    os.environ.get('WHALE_FONT_BOLD'),
    'C:/Windows/Fonts/msyhbd.ttc',
    'C:/Windows/Fonts/msyh.ttc',
    '/System/Library/Fonts/PingFang.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
]
FONT_CANDIDATES_REG = [
    os.environ.get('WHALE_FONT_REG'),
    'C:/Windows/Fonts/msyh.ttc',
    'C:/Windows/Fonts/msyhbd.ttc',
    '/System/Library/Fonts/PingFang.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
]
FONT_SONG_CANDIDATES = [
    os.environ.get('WHALE_FONT_SONG'),
    'C:/Windows/Fonts/STKAITI.TTF',
    'C:/Windows/Fonts/simkai.ttf',
    '/System/Library/Fonts/STKaiti.ttc',
]
FONT_SONG_BOLD_CANDIDATES = [
    os.environ.get('WHALE_FONT_SONG_BOLD'),
    'C:/Windows/Fonts/FZSTK.TTF',
    'C:/Windows/Fonts/STKAITI.TTF',
    'C:/Windows/Fonts/simkai.ttf',
]


def _first_existing(cands):
    for p in cands:
        if p and os.path.isfile(p):
            return p
    return None


FONT_BOLD = _first_existing(FONT_CANDIDATES_BOLD)
FONT_REG = _first_existing(FONT_CANDIDATES_REG) or FONT_BOLD
FONT_SONG = _first_existing(FONT_SONG_CANDIDATES)
FONT_SONG_BOLD = _first_existing(FONT_SONG_BOLD_CANDIDATES) or FONT_SONG


def _load_font(path, size):
    if path:
        try:
            return ImageFont.truetype(path, max(8, int(size)))
        except Exception:
            pass
    try:
        return ImageFont.load_default(size=max(8, int(size)))
    except TypeError:  # Pillow < 10
        return ImageFont.load_default()


@functools.lru_cache(maxsize=512)
def font(size, bold=True):
    """按字号取字体（带缓存：逐帧渲染时能省不少 IO）。"""
    return _load_font(FONT_BOLD if bold else FONT_REG, size)


@functools.lru_cache(maxsize=128)
def _song_font(size, bold=True):
    return _load_font(FONT_SONG_BOLD if bold else FONT_SONG, size)


# 设计分辨率（所有坐标/字号都按这个尺寸写死；输出尺寸由 ffmpeg 缩放）
DESIGN_W, DESIGN_H = 1920, 1080
W, H = DESIGN_W, DESIGN_H

MASCOT_KEYS = {
    'dian': '13N01', 'surprised': '13N07', 'idea': '15N01', 'happy': '16N01',
    'brave': '16N02', 'lazy': '3N05', 'fish': '8N12', 'hop': '9N07',
    'heal': 'EX69', 'arrow': 'EX78', 'special': '特殊02',
}

# 卡片配色（深海底上的浅色面板）
CARD_BG = (248, 251, 255, 252)
CARD_BORDER = (140, 200, 255, 150)
INK = (22, 40, 68, 255)
INK_SOFT = (96, 116, 146, 255)
BLUE = (56, 132, 255, 255)
BLUE_SOFT = (226, 240, 255, 255)
YELLOW = (255, 206, 84, 255)
PINK = (255, 110, 150, 255)
CYAN = (96, 226, 255, 255)
ORANGE = (255, 158, 66, 255)
RED = (226, 60, 60, 255)


def text_size(draw, text, fnt):
    box = draw.textbbox((0, 0), text, font=fnt)
    return box[2] - box[0], box[3] - box[1], box


def fit_font(draw, text, size, max_w, bold=True, min_size=18):
    while size > min_size:
        f = font(size, bold)
        if draw.textlength(text, font=f) <= max_w:
            return f
        size -= 2
    return font(min_size, bold)


def wrap_text(draw, text, fnt, max_w):
    lines, cur = [], ''
    for ch in text:
        if ch == '\n':
            lines.append(cur); cur = ''; continue
        if draw.textlength(cur + ch, font=fnt) > max_w and cur:
            lines.append(cur); cur = ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines


def rounded_shadow_layer(width, height, radius=34, fill=CARD_BG, border=None,
                         shadow_blur=30, shadow_offset=(0, 14), shadow_alpha=95):
    """返回一张带投影和圆角的卡片 RGBA。"""
    pad = shadow_blur * 3
    layer = Image.new('RGBA', (width + pad * 2, height + pad * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    sx, sy = shadow_offset
    d.rounded_rectangle((pad + sx, pad + sy, pad + sx + width, pad + sy + height),
                        radius=radius, fill=(4, 12, 28, shadow_alpha))
    layer = layer.filter(ImageFilter.GaussianBlur(shadow_blur))
    body = Image.new('RGBA', layer.size, (0, 0, 0, 0))
    bd = ImageDraw.Draw(body)
    bd.rounded_rectangle((pad, pad, pad + width, pad + height), radius=radius, fill=fill,
                         outline=border, width=2)
    layer = Image.alpha_composite(layer, body)
    return layer, pad


def paste_layer(base, layer, x, y, alpha=1.0):
    """把 RGBA layer 贴到 RGB base；(x,y) 是 layer 左上角坐标。"""
    if alpha <= 0:
        return
    if alpha < 1:
        r, g, b, a = layer.split()
        a = a.point(lambda v: int(v * alpha))
        layer = Image.merge('RGBA', (r, g, b, a))
    base.paste(layer, (int(x), int(y)), layer)


# ---------------------------------------------------------------- mascots
def build_mascots(width=620):
    """把她的 GIF 表情解成统一缩放/去特效帧的 PNG 序列（缓存到 CACHE_MASCOT）。"""
    os.makedirs(CACHE_MASCOT, exist_ok=True)
    meta = {}
    for key, prefix in MASCOT_KEYS.items():
        out_dir = os.path.join(CACHE_MASCOT, key)
        marker = os.path.join(out_dir, 'meta.json')
        files = sorted(glob.glob(os.path.join(STICKER_SRC, prefix + '*.gif')))
        if not files:
            continue
        if os.path.isdir(out_dir) and os.path.exists(marker):
            try:
                info = json.load(open(marker, encoding='utf-8'))
                if info.get('n') and all(os.path.exists(os.path.join(out_dir, f'{i:03d}.png')) for i in range(info['n'])):
                    meta[key] = {'dir': out_dir, 'n': info['n'], 'w': info['w'], 'h': info['h']}
                    continue
            except Exception:
                pass
        frames = []
        im = Image.open(files[0])
        n = getattr(im, 'n_frames', 1)
        for i in range(n):
            im.seek(i)
            frames.append(im.convert('RGBA'))
        # 去掉「特效帧」：个别 GIF 的动效帧带不透明黑底/白闪，贴到深海底会露方块；
        # 另外「蹦」这类帧里角色会短暂跑出画面（覆盖率骤降），也一并过滤。
        stats = []
        for fr in frames:
            a = np.array(fr)
            alpha = a[..., 3]
            cov = (alpha > 200).mean()
            op = a[alpha > 200][:, :3]
            bright = op.mean() if len(op) else 0
            stats.append((cov, bright))
        covs = [c for c, _ in stats]
        max_cov = max(covs) if covs else 0
        brights = [b for _, b in stats]
        med_b = float(np.median(brights)) if brights else 0
        good = [fr for fr, (cov, bright) in zip(frames, stats)
                if cov >= max_cov * 0.45 and abs(bright - med_b) <= 38]
        if len(good) < 3:
            good = [fr for fr, (cov, _) in zip(frames, stats) if cov >= max_cov * 0.45]
        if len(good) < 3:
            best = max(range(len(frames)), key=lambda i: stats[i][0])
            good = [frames[best]]
        frames = good
        if not frames or not frames[0].getbbox():
            continue
        # 统一裁剪框（避免逐帧抖动）
        union = (min(fr.getbbox()[0] for fr in frames), min(fr.getbbox()[1] for fr in frames),
                 max(fr.getbbox()[2] for fr in frames), max(fr.getbbox()[3] for fr in frames))
        crop = [fr.crop(union) for fr in frames]
        scale = width / max(c.width for c in crop)
        out_frames = []
        for fr in crop:
            w = max(1, int(fr.width * scale))
            h = max(1, int(fr.height * scale))
            r = fr.resize((w, h), Image.LANCZOS)
            out_frames.append(r)
        os.makedirs(out_dir, exist_ok=True)
        for f in glob.glob(os.path.join(out_dir, '*.png')):
            os.remove(f)
        for i, fr in enumerate(out_frames):
            fr.save(os.path.join(out_dir, f'{i:03d}.png'))
        meta[key] = {'dir': out_dir, 'n': len(out_frames), 'w': out_frames[0].width, 'h': out_frames[0].height}
        with open(marker, 'w', encoding='utf-8') as f:
            json.dump({'n': len(out_frames), 'w': out_frames[0].width, 'h': out_frames[0].height}, f)
    return meta


def load_mascot_key(key, width=620):
    meta = build_mascots(width)
    info = meta.get(key) or meta.get('happy') or next(iter(meta.values()), None)
    if not info:
        return [], {}
    frames = []
    for i in range(info['n']):
        p = os.path.join(info['dir'], f'{i:03d}.png')
        if os.path.exists(p):
            frames.append(Image.open(p).convert('RGBA'))
    return frames, info


# ---------------------------------------------------------------- background
def build_background(force=False):
    os.makedirs(CACHE_BG, exist_ok=True)
    p = os.path.join(CACHE_BG, f'base-{W}x{H}.png')
    if os.path.exists(p) and not force:
        return Image.open(p).convert('RGB')
    # 径向渐变：上方偏亮、边缘深
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    cx, cy = W * 0.5, H * 0.18
    dist = np.sqrt(((xx - cx) / (W * 0.95)) ** 2 + ((yy - cy) / (H * 0.9)) ** 2)
    dist = np.clip(dist, 0, 1.2) / 1.2
    top = np.array([26, 74, 128], dtype=np.float32)
    bottom = np.array([5, 15, 34], dtype=np.float32)
    base = bottom + (top - bottom) * (1 - dist[..., None]) ** 1.6
    rng = np.random.default_rng(7)
    base += rng.normal(0, 2.2, base.shape)
    img = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8), 'RGB')
    # 光柱
    rays = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rays)
    for x0, spread, alpha in [(-120, 420, 26), (260, 520, 20), (700, 560, 16), (1180, 460, 22), (1500, 380, 15)]:
        rd.polygon([(x0, -50), (x0 + spread, -50), (x0 + spread * 2.2, H), (x0 + spread * 0.5, H)],
                   fill=(130, 200, 255, alpha))
    rays = rays.filter(ImageFilter.GaussianBlur(40))
    img = Image.alpha_composite(img.convert('RGBA'), rays)
    # 底部压暗
    grad = Image.new('L', (1, H), 0)
    for y in range(H):
        v = 0 if y < H * 0.45 else int(150 * ((y - H * 0.45) / (H * 0.55)) ** 1.5)
        grad.putpixel((0, y), v)
    dark = Image.new('RGBA', (W, H), (3, 8, 20, 255))
    img = Image.composite(dark, img, grad.resize((W, H)))
    # 四角暗角
    vig = Image.new('L', (W, H), 0)
    vd = ImageDraw.Draw(vig)
    vd.ellipse((-W * 0.25, -H * 0.2, W * 1.25, H * 1.2), fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(180))
    dark2 = Image.new('RGBA', (W, H), (2, 6, 14, 255))
    img = Image.composite(dark2, img, Image.eval(vig, lambda v: 255 - v).point(lambda v: int(v * 0.55)))
    img.convert('RGB').save(p)
    return img.convert('RGB')


def make_bubbles():
    out = []
    for size, alpha in [(46, 90), (30, 70), (18, 60), (12, 45)]:
        im = Image.new('RGBA', (size + 8, size + 8), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        d.ellipse((4, 4, size + 4, size + 4), fill=(190, 225, 255, 18), outline=(210, 240, 255, alpha), width=2)
        if size >= 20:
            d.arc((4 + size * 0.22, 4 + size * 0.18, 4 + size * 0.72, 4 + size * 0.62),
                  200, 330, fill=(255, 255, 255, alpha), width=2)
        out.append(im)
    return out


def make_sparkle(size=54):
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c = size / 2
    pts = [(c, 2), (c + size * 0.09, c - size * 0.09), (size - 2, c), (c + size * 0.09, c + size * 0.09),
           (c, size - 2), (c - size * 0.09, c + size * 0.09), (2, c), (c - size * 0.09, c - size * 0.09)]
    d.polygon(pts, fill=(255, 255, 255, 210))
    return im


# ---------------------------------------------------------------- icons
def draw_icon(d, kind, cx, cy, s, color):
    """用简单矢量形状画图标（s 为外接尺寸）。"""
    r = s / 2
    if kind == 'check':
        d.line([(cx - r * 0.6, cy + r * 0.05), (cx - r * 0.12, cy + r * 0.55), (cx + r * 0.65, cy - r * 0.5)],
               fill=color, width=max(3, int(s * 0.14)), joint='curve')
    elif kind == 'warn':
        d.polygon([(cx, cy - r * 0.85), (cx + r * 0.95, cy + r * 0.75), (cx - r * 0.95, cy + r * 0.75)], fill=color)
        d.line([(cx, cy - r * 0.25), (cx, cy + r * 0.25)], fill=(255, 255, 255, 255), width=max(3, int(s * 0.12)))
        d.ellipse((cx - s * 0.05, cy + r * 0.42, cx + s * 0.05, cy + r * 0.62), fill=(255, 255, 255, 255))
    elif kind == 'play':
        d.polygon([(cx - r * 0.55, cy - r * 0.75), (cx + r * 0.85, cy), (cx - r * 0.55, cy + r * 0.75)], fill=color)
    elif kind == 'heart':
        d.ellipse((cx - r * 0.9, cy - r * 0.9, cx + r * 0.1, cy + r * 0.05), fill=color)
        d.ellipse((cx - r * 0.1, cy - r * 0.9, cx + r * 0.9, cy + r * 0.05), fill=color)
        d.polygon([(cx - r * 0.86, cy - r * 0.3), (cx + r * 0.86, cy - r * 0.3), (cx, cy + r * 0.92)], fill=color)
    elif kind == 'thumb':
        d.rounded_rectangle((cx - r * 0.75, cy - r * 0.05, cx + r * 0.15, cy + r * 0.85), radius=int(s * 0.1), fill=color)
        d.polygon([(cx + r * 0.1, cy + r * 0.7), (cx + r * 0.9, cy + r * 0.55),
                   (cx + r * 0.55, cy - r * 0.75), (cx + r * 0.12, cy - r * 0.35)], fill=color)
    elif kind == 'comment':
        d.rounded_rectangle((cx - r * 0.9, cy - r * 0.75, cx + r * 0.9, cy + r * 0.45), radius=int(s * 0.25), fill=color)
        d.polygon([(cx - r * 0.2, cy + r * 0.35), (cx + r * 0.35, cy + r * 0.35), (cx - r * 0.35, cy + r * 0.95)], fill=color)
    elif kind == 'star':
        pts = []
        for i in range(10):
            ang = -np.pi / 2 + i * np.pi / 5
            rad = r if i % 2 == 0 else r * 0.45
            pts.append((cx + rad * np.cos(ang), cy + rad * np.sin(ang)))
        d.polygon(pts, fill=color)
    elif kind == 'clock':
        d.ellipse((cx - r * 0.85, cy - r * 0.85, cx + r * 0.85, cy + r * 0.85), outline=color, width=max(3, int(s * 0.1)))
        d.line([(cx, cy), (cx, cy - r * 0.55)], fill=color, width=max(3, int(s * 0.09)))
        d.line([(cx, cy), (cx + r * 0.42, cy + r * 0.1)], fill=color, width=max(3, int(s * 0.09)))
    elif kind == 'whale':
        # 小鲸鱼：身体椭圆 + 尾巴 + 眼睛 + 水柱
        d.ellipse((cx - r * 0.9, cy - r * 0.35, cx + r * 0.35, cy + r * 0.55), fill=color)
        d.polygon([(cx + r * 0.2, cy + r * 0.05), (cx + r * 0.95, cy - r * 0.45),
                   (cx + r * 0.9, cy + r * 0.35), (cx + r * 0.35, cy + r * 0.45)], fill=color)
        d.ellipse((cx - r * 0.55, cy - r * 0.02, cx - r * 0.38, cy + r * 0.15), fill=(255, 255, 255, 255))
        d.line([(cx - r * 0.35, cy - r * 0.42), (cx - r * 0.42, cy - r * 0.9)], fill=color, width=max(2, int(s * 0.08)))
        d.line([(cx - r * 0.2, cy - r * 0.42), (cx - r * 0.12, cy - r * 0.8)], fill=color, width=max(2, int(s * 0.08)))
    elif kind == 'spark':
        draw_icon(d, 'star', cx, cy, s, color)
    else:
        d.ellipse((cx - r * 0.5, cy - r * 0.5, cx + r * 0.5, cy + r * 0.5), fill=color)


def ease_out(t):
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) ** 3


def ease_back(t):
    t = max(0.0, min(1.0, t))
    c1, c3 = 1.70158, 2.70158
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2
