"""卡片渲染：参考 BV1pGnn67EC2 的 UI 面板风格（白底圆角 + 高亮行 + 图标）。

插件版改动：封面从「videoDir/covers/<BV>.jpg」或 assets/covers 读，缺失时画占位；
手写字体走 lib 里的候选路径（Windows 宋体/楷体，找不到退回默认字体）。
"""
import os
from PIL import Image, ImageDraw
from lib import (
    W, H, font, text_size, fit_font, wrap_text, rounded_shadow_layer,
    INK, INK_SOFT, BLUE, BLUE_SOFT, YELLOW, PINK, CYAN, ORANGE, RED, CARD_BG,
    CARD_BORDER, draw_icon, paste_layer, COVERS_DIRS, FONT_SONG, FONT_SONG_BOLD,
    _load_font,
)

CARD_W = 1084
PAD_L = 40


def _title_row(d, pad, x0, title, icon='whale', icon_color=BLUE, size=44):
    cx, cy = x0 + pad + 34, pad + 52
    d.ellipse((cx - 34, cy - 34, cx + 34, cy + 34), fill=(228, 241, 255, 255))
    draw_icon(d, icon, cx, cy, 40, icon_color)
    f = fit_font(d, title, size, CARD_W - pad * 2 - 120)
    d.text((x0 + pad + 92, cy - size * 0.62), title, font=f, fill=INK)
    return pad + 108


def card_profile(spec):
    rows = spec.get('rows', [])
    h = 108 + len(rows) * 66 + 40
    layer, pad = rounded_shadow_layer(CARD_W, h, fill=CARD_BG, border=CARD_BORDER)
    d = ImageDraw.Draw(layer)
    y = _title_row(d, pad, 0, spec.get('title', ''), spec.get('icon', 'whale'))
    for i, row in enumerate(rows):
        if isinstance(row, dict):
            label, value = row.get('label', ''), row.get('value', '')
        else:
            try:
                label, value = row
            except Exception:
                label, value = '', row
        ly = y + i * 66
        d.text((pad + PAD_L, ly + 12), str(label), font=font(31, False), fill=INK_SOFT)
        vf = font(36)
        vw = d.textlength(str(value), font=vf)
        d.text((pad + CARD_W - PAD_L - vw, ly + 6), str(value), font=vf, fill=BLUE)
        if i < len(rows) - 1:
            d.line([(pad + PAD_L, ly + 58), (pad + CARD_W - PAD_L, ly + 58)], fill=(225, 235, 248, 255), width=2)
    return {'img': layer, 'pad': pad, 'w': CARD_W, 'h': h}


def card_list(spec):
    items = spec.get('items', [])
    hi = spec.get('highlight', -1)
    dim = spec.get('dimTail', 0)
    row_h = 104
    h = 108 + len(items) * row_h + 36
    layer, pad = rounded_shadow_layer(CARD_W, h, fill=CARD_BG, border=CARD_BORDER)
    d = ImageDraw.Draw(layer)
    y = _title_row(d, pad, 0, spec.get('title', ''), spec.get('icon', 'check'))
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            it = {'text': str(it)}
        ry = y + i * row_h
        dimmed = dim > 0 and i >= len(items) - dim
        color = (150, 165, 188, 255) if dimmed else INK
        if i == hi:
            d.rounded_rectangle((pad + PAD_L - 14, ry - 6, pad + CARD_W - PAD_L + 14, ry + row_h - 8),
                                radius=18, fill=(233, 243, 255, 255), outline=BLUE, width=3)
        cx = pad + PAD_L + 26
        cy = ry + 32
        if i <= hi or hi < 0:
            d.ellipse((cx - 24, cy - 24, cx + 24, cy + 24), fill=BLUE)
            nf = font(27)
            nw = d.textlength(str(i + 1), font=nf)
            d.text((cx - nw / 2, cy - 17), str(i + 1), font=nf, fill=(255, 255, 255, 255))
        else:
            d.ellipse((cx - 24, cy - 24, cx + 24, cy + 24), outline=(170, 185, 205, 255), width=3)
            nf = font(25)
            nw = d.textlength(str(i + 1), font=nf)
            d.text((cx - nw / 2, cy - 15), str(i + 1), font=nf, fill=(170, 185, 205, 255))
        d.text((cx + 50, ry + 8), str(it.get('text', '')), font=font(35), fill=color)
        if it.get('sub'):
            d.text((cx + 50, ry + 54), str(it['sub']), font=font(24, False),
                   fill=(120, 138, 165, 255) if not dimmed else (170, 182, 200, 255))
    return {'img': layer, 'pad': pad, 'w': CARD_W, 'h': h}


def _cover_placeholder(size):
    tw, th = size
    im = Image.new('RGB', size, (18, 44, 82))
    d = ImageDraw.Draw(im)
    for i, alpha in enumerate((26, 20, 14)):
        d.rounded_rectangle((i * 8, i * 8, tw - i * 8, th - i * 8), radius=24 - i * 4,
                            outline=(90, 160, 230, alpha), width=2)
    draw_icon(d, 'play', tw / 2, th / 2, min(tw, th) * 0.42, (150, 200, 245, 220))
    return im


def _load_cover(bv, size=(300, 169)):
    """读引用视频封面：<videoDir>/covers/<BV>.jpg 已下载就用，否则画占位（不让渲染崩）。"""
    tw, th = size
    im = None
    if bv:
        for d in COVERS_DIRS:
            for ext in ('.jpg', '.jpeg', '.png', '.webp'):
                p = os.path.join(d, str(bv) + ext)
                if os.path.isfile(p):
                    try:
                        im = Image.open(p).convert('RGB')
                        break
                    except Exception:
                        im = None
            if im is not None:
                break
    if im is None:
        im = _cover_placeholder((tw * 2, th * 2)).resize((tw * 2, th * 2), Image.LANCZOS)
    s = max(tw / im.width, th / im.height)
    im = im.resize((int(im.width * s) + 1, int(im.height * s) + 1), Image.LANCZOS)
    left = (im.width - tw) // 2
    top = (im.height - th) // 2
    im = im.crop((left, top, left + tw, top + th))
    mask = Image.new('L', size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, tw - 1, th - 1), radius=18, fill=255)
    out = Image.new('RGBA', size, (0, 0, 0, 0))
    out.paste(im, (0, 0))
    out.putalpha(mask)
    d = ImageDraw.Draw(out)
    d.polygon([(tw / 2 - 16, th / 2 - 22), (tw / 2 + 24, th / 2), (tw / 2 - 16, th / 2 + 22)],
              fill=(255, 255, 255, 225))
    return out


def card_videos(spec):
    items = spec.get('items', [])
    item_h = 238
    h = 108 + len(items) * item_h + 24
    layer, pad = rounded_shadow_layer(CARD_W, h, fill=CARD_BG, border=CARD_BORDER)
    d = ImageDraw.Draw(layer)
    y = _title_row(d, pad, 0, spec.get('title', ''), 'play')
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            it = {'title': str(it)}
        ry = y + i * item_h
        cover = _load_cover(it.get('bv', ''))
        layer.paste(cover, (int(pad + PAD_L), int(ry + 14)), cover)
        tx = pad + PAD_L + 330
        title = str(it.get('title', ''))
        tf = font(33)
        for k, line in enumerate(wrap_text(d, title, tf, CARD_W - (tx - pad) - 50)[:2]):
            d.text((tx, ry + 16 + k * 44), line, font=tf, fill=INK)
        meta = f"{it.get('up', '')} · {it.get('bv', '')}"
        d.text((tx, ry + 116), meta, font=font(26, False), fill=(110, 128, 158, 255))
        tag = str(it.get('note', '引用'))
        tw = d.textlength(tag, font=font(22))
        d.rounded_rectangle((tx, ry + 158, tx + tw + 26, ry + 194), radius=12, fill=(231, 243, 255, 255))
        d.text((tx + 13, ry + 163), tag, font=font(22), fill=BLUE)
        if i < len(items) - 1:
            d.line([(pad + PAD_L, ry + item_h - 8), (pad + CARD_W - PAD_L, ry + item_h - 8)],
                   fill=(226, 236, 249, 255), width=2)
    return {'img': layer, 'pad': pad, 'w': CARD_W, 'h': h}


def card_bubble(spec):
    text = str(spec.get('text', ''))
    speaker = str(spec.get('speaker', '我'))
    owner = spec.get('tone') == 'owner'
    col = ORANGE if owner else BLUE
    bw = 960
    tmp = ImageDraw.Draw(Image.new('RGB', (10, 10)))
    tf = font(37)
    lines = wrap_text(tmp, text, tf, bw - 150)
    h = 120 + len(lines) * 54 + 34
    layer, pad = rounded_shadow_layer(bw, h, fill=(234, 244, 255, 252), border=CARD_BORDER)
    d = ImageDraw.Draw(layer)
    pill_w = d.textlength(speaker, font=font(27)) + 44
    d.rounded_rectangle((pad + 36, pad + 26, pad + 36 + pill_w, pad + 74), radius=24, fill=col)
    d.text((pad + 58, pad + 36), speaker, font=font(27), fill=(255, 255, 255, 255))
    d.polygon([(pad + 60, pad + h - 24), (pad + 60, pad + h + 18), (pad + 112, pad + h - 24)],
              fill=(234, 244, 255, 252))
    for k, line in enumerate(lines):
        d.text((pad + 40, pad + 100 + k * 54), line, font=tf, fill=INK)
    return {'img': layer, 'pad': pad, 'w': bw, 'h': h}


def card_alert(spec):
    text = str(spec.get('text', ''))
    bw = 980
    tmp = ImageDraw.Draw(Image.new('RGB', (10, 10)))
    tf = font(31, False)
    lines = wrap_text(tmp, text, tf, bw - 180)
    h = 118 + len(lines) * 44 + 34
    layer, pad = rounded_shadow_layer(bw, h, fill=(255, 247, 232, 252), border=(255, 200, 120, 200))
    d = ImageDraw.Draw(layer)
    cx, cy = pad + 64, pad + 56
    d.ellipse((cx - 32, cy - 32, cx + 32, cy + 32), fill=(255, 190, 90, 255))
    draw_icon(d, 'warn', cx, cy, 40, (255, 255, 255, 255))
    d.text((pad + 118, pad + 26), str(spec.get('title', '')), font=font(38), fill=(140, 84, 20, 255))
    for k, line in enumerate(lines):
        d.text((pad + 118, pad + 86 + k * 44), line, font=tf, fill=(120, 84, 40, 255))
    return {'img': layer, 'pad': pad, 'w': bw, 'h': h}


def card_cta(spec):
    bw, h = CARD_W, 380
    layer, pad = rounded_shadow_layer(bw, h, fill=CARD_BG, border=CARD_BORDER)
    d = ImageDraw.Draw(layer)
    title = str(spec.get('title', '想看什么，评论区写'))
    tf = fit_font(d, title, 44, bw - 120)
    tw = d.textlength(title, font=tf)
    d.text((pad + (bw - tw) / 2, pad + 34), title, font=tf, fill=INK)
    items = spec.get('items', ['关注', '点赞', '评论'])
    cols = [PINK, (80, 140, 255), CYAN]
    icons = ['heart', 'thumb', 'comment']
    n = max(1, len(items))
    gap = 180
    total = gap * (n - 1)
    x = pad + (bw - total) / 2
    for i, label in enumerate(items):
        cx = x + i * gap
        cy = pad + 210
        d.ellipse((cx - 56, cy - 56, cx + 56, cy + 56), fill=cols[i % 3])
        draw_icon(d, icons[i % 3], cx, cy, 52, (255, 255, 255, 255))
        lw = d.textlength(str(label), font=font(28))
        d.text((cx - lw / 2, cy + 68), str(label), font=font(28), fill=INK_SOFT)
    return {'img': layer, 'pad': pad, 'w': bw, 'h': h}


def stamp_layer(text, color=RED, angle=-8, size=44):
    tmp = ImageDraw.Draw(Image.new('RGB', (10, 10)))
    f = font(size)
    tw = tmp.textlength(text, font=f)
    w, h = int(tw + 76), int(size + 48)
    layer = Image.new('RGBA', (w + 20, h + 20), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle((10, 10, 10 + w, 10 + h), radius=14, fill=(0, 0, 0, 0),
                        outline=color, width=6)
    d.rounded_rectangle((18, 18, 2 + w, 2 + h), radius=10, fill=color)
    d.text((10 + 38, 10 + 20), text, font=f, fill=(255, 255, 255, 255))
    layer = layer.rotate(angle, expand=True, resample=Image.BICUBIC)
    return layer


def card_for(spec):
    kind = spec.get('kind', 'none')
    if kind == 'profile':
        return card_profile(spec)
    if kind == 'list':
        return card_list(spec)
    if kind == 'videos':
        return card_videos(spec)
    if kind == 'bubble':
        return card_bubble(spec)
    if kind == 'alert':
        return card_alert(spec)
    if kind == 'cta':
        return card_cta(spec)
    if kind == 'stats':
        return card_stats(spec)
    if kind == 'note':
        return card_note(spec)
    if kind == 'dm':
        return card_dm(spec)
    return None


# ---------------------------------------------------------------- v3：她自己的卡片
def _tape(w, h, angle=12):
    lay = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(lay).rounded_rectangle((0, 0, w - 1, h - 1), radius=4, fill=(255, 239, 186, 190))
    return lay.rotate(angle, expand=True, resample=Image.BICUBIC)


def card_stats(spec):
    rows = spec.get('rows', [])
    cols = 2
    n = len(rows)
    line_n = (n + cols - 1) // cols
    tw, th, gap = 496, 158, 22
    h = 108 + line_n * th + max(0, line_n - 1) * gap + 40
    layer, pad = rounded_shadow_layer(CARD_W, h, fill=CARD_BG, border=CARD_BORDER)
    d = ImageDraw.Draw(layer)
    y0 = _title_row(d, pad, 0, spec.get('title', '今日数据'), 'clock')
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            row = {'label': '', 'value': row}
        cx = pad + PAD_L + (i % cols) * (tw + gap)
        cy = y0 + (i // cols) * (th + gap)
        d.rounded_rectangle((cx, cy, cx + tw, cy + th), radius=20, fill=(233, 244, 255, 255),
                            outline=(186, 218, 255, 255), width=2)
        d.text((cx + 28, cy + 20), str(row.get('label', '')), font=font(27, False), fill=(110, 130, 160, 255))
        d.text((cx + 28, cy + 60), str(row.get('value', '')), font=font(58), fill=BLUE)
    return {'img': layer, 'pad': pad, 'w': CARD_W, 'h': h}


def card_note(spec):
    lines = [str(x) for x in spec.get('lines', [])][:4]
    bw = 1000
    h = 118 + len(lines) * 68 + 44
    layer, pad = rounded_shadow_layer(bw, h, fill=(255, 248, 232, 253), border=(226, 198, 146, 210),
                                      shadow_alpha=110)
    d = ImageDraw.Draw(layer)
    # 胶带
    tape = _tape(120, 36, 12)
    layer.paste(tape, (int(pad + 40), int(pad - 20)), tape)
    tape2 = _tape(120, 36, -14)
    layer.paste(tape2, (int(pad + bw - 170), int(pad - 16)), tape2)
    d = ImageDraw.Draw(layer)
    tf = _load_font(FONT_SONG_BOLD, 44)
    d.text((pad + 44, pad + 44), str(spec.get('title', '日记')), font=tf, fill=(96, 70, 40, 255))
    lf = _load_font(FONT_SONG, 44)
    for i, line in enumerate(lines):
        d.text((pad + 48, pad + 112 + i * 68), line, font=lf, fill=(78, 60, 38, 255))
    return {'img': layer, 'pad': pad, 'w': bw, 'h': h}


def _avatar(letter, color):
    im = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse((0, 0, 63, 63), fill=color)
    f = font(30)
    w = d.textlength(letter, font=f)
    d.text(((64 - w) / 2, 14), letter, font=f, fill=(255, 255, 255, 255))
    return im


def card_dm(spec):
    bw = 1000
    msgs = spec.get('messages', [])[:4]
    tmp = ImageDraw.Draw(Image.new('RGB', (10, 10)))
    tf = font(32)
    prepared = []
    for m in msgs:
        if not isinstance(m, dict):
            m = {'text': str(m)}
        lines = wrap_text(tmp, str(m.get('text', '')), tf, 600)
        prepared.append((m, lines, 34 + len(lines) * 46 + 26))
    h = 108 + sum(p[2] + 16 for p in prepared) + 26
    layer, pad = rounded_shadow_layer(bw, h, fill=CARD_BG, border=CARD_BORDER)
    d = ImageDraw.Draw(layer)
    y = _title_row(d, pad, 0, spec.get('title', '主人的私信'), 'comment')
    for m, lines, mh in prepared:
        owner = m.get('from') == '主人'
        if owner:
            av = _avatar('主', (255, 158, 66, 255))
            layer.paste(av, (int(pad + 40), int(y + 8)), av)
            bx = pad + 120
            d.rounded_rectangle((bx, y, bx + 640, y + mh), radius=18, fill=(240, 244, 250, 255))
            d.text((bx + 24, y + 12), '主人', font=font(24, False), fill=(150, 130, 100, 255))
            for k, line in enumerate(lines):
                d.text((bx + 24, y + 44 + k * 46), line, font=tf, fill=INK)
        else:
            bx = pad + bw - 40 - 640
            d.rounded_rectangle((bx, y, bx + 640, y + mh), radius=18, fill=(228, 242, 255, 255))
            d.text((bx + 24, y + 12), '我', font=font(24, False), fill=(90, 130, 180, 255))
            for k, line in enumerate(lines):
                d.text((bx + 24, y + 44 + k * 46), line, font=tf, fill=(24, 52, 92, 255))
            av = _avatar('鱼', (56, 132, 255, 255))
            layer.paste(av, (int(pad + bw - 104), int(y + 8)), av)
        y += mh + 16
    return {'img': layer, 'pad': pad, 'w': bw, 'h': h}
