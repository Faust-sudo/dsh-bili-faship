#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成 v3 样片用的 3 个短音效（纯 numpy 合成，无外部采样 → CC0）：

  pop.wav    文字/卡片弹出：30–60ms 起音、150ms 内收（总长 140ms）
  whoosh.wav 转场/卡片滑入：噪声扫频 400→6500Hz，总长 0.30s，立体声
  ding.wav   重点/结论提示：柔和高音叮（E6 泛音钟声），总长 0.38s

规格：48 kHz / 16-bit；pop/ding 单声道，whoosh 立体声；峰值均 ≤ -6 dBFS；
      每个文件 < 100 KB（pop≈13KB / whoosh≈58KB / ding≈36KB）。

用法：python assets/sfx/generate-sfx.py
"""
import os
import wave

import numpy as np

FS = 48000
RNG = np.random.default_rng(20261026)
HERE = os.path.dirname(os.path.abspath(__file__))


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def write_wav(name, audio, peak_dbfs):
    """按目标峰值归一化（<= -6 dBFS）后写 16-bit WAV。"""
    audio = np.asarray(audio, dtype=np.float64)
    peak = np.max(np.abs(audio)) or 1.0
    audio = audio * (10 ** (peak_dbfs / 20.0)) / peak
    audio = np.clip(audio, -1.0, 1.0)
    if audio.ndim == 1:
        pcm = (audio * 32767.0).astype('<i2')
        channels = 1
    else:
        pcm = (audio * 32767.0).astype('<i2')
        channels = audio.shape[1]
    path = os.path.join(HERE, name)
    with wave.open(path, 'wb') as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(FS)
        w.writeframes(pcm.reshape(-1).tobytes())
    dur = audio.shape[0] / FS
    size = os.path.getsize(path)
    actual_peak = 20 * np.log10(np.max(np.abs(audio)) + 1e-12)
    print(f'{name}: {dur*1000:.1f}ms  peak={actual_peak:.2f}dBFS  ch={channels}  size={size} bytes')
    return path


# ---------------------------------------------------------------------------
# 1) pop：柔和短促的“啵”，起音 40ms，140ms 内收干净
# ---------------------------------------------------------------------------

def make_pop():
    dur = 0.140
    n = int(dur * FS)
    t = np.arange(n) / FS
    # 音高从 900Hz 快速滑到 470Hz，产生“弹出”感
    f = 470.0 + 430.0 * np.exp(-t / 0.030)
    phase = 2 * np.pi * np.cumsum(f) / FS
    sig = np.sin(phase) + 0.22 * np.sin(2 * phase + 0.4) + 0.06 * np.sin(3 * phase + 1.2)
    # 30–60ms 起音；尾部 35ms 收干净，总长 140ms
    env = smoothstep(t / 0.042) * smoothstep((dur - t) / 0.035) * np.exp(-t / 0.075)
    sig = np.tanh(sig * env * 1.3)
    sig *= smoothstep((dur - t) / 0.012)  # 保证末尾精确归零，无爆音
    return write_wav('pop.wav', sig, -8.0)


# ---------------------------------------------------------------------------
# 2) whoosh：带噪声扫频的转场“唰”，0.30s，立体声
# ---------------------------------------------------------------------------

def swept_noise(noise, f_start, f_end, stages=2):
    """两级级联时变一阶低通（-12dB/oct，截止频率指数上升）→ 噪声亮度渐强，做“唰”的上升感。"""
    n = len(noise)
    fc = f_start * (f_end / f_start) ** (np.arange(n) / max(1, n - 1))
    fc = np.clip(fc, 60.0, 14000.0)
    out = noise.astype(np.float64).copy()
    for _ in range(stages):
        y = 0.0
        buf = np.zeros(n)
        for i in range(n):
            a = np.exp(-2.0 * np.pi * fc[i] / FS)
            y = (1.0 - a) * out[i] + a * y
            buf[i] = y
        out = buf
    return out


def one_pole_highpass(x, cutoff=140.0):
    """静态一阶高通，去掉转场噪声里的低频轰鸣。"""
    a = np.exp(-2.0 * np.pi * cutoff / FS)
    prev_x = 0.0
    prev_y = 0.0
    out = np.zeros(len(x))
    for i in range(len(x)):
        y = a * (prev_y + x[i] - prev_x)
        out[i] = y
        prev_x = x[i]
        prev_y = y
    return out


def make_whoosh():
    dur = 0.30
    n = int(dur * FS)
    t = np.arange(n) / FS
    # 左右两路独立噪声、同一上升扫频 → 宽而自然的“唰”
    left = one_pole_highpass(swept_noise(RNG.standard_normal(n), 320.0, 9000.0))
    right = one_pole_highpass(swept_noise(RNG.standard_normal(n), 320.0, 9000.0))
    sig = np.stack([left, right], axis=1)
    env = smoothstep(t / 0.085) * smoothstep((dur - t) / 0.11)
    env *= 0.45 + 0.55 * smoothstep(t / 0.20)   # 前段轻、后段推起来
    sig *= env[:, None]
    sig *= smoothstep((dur - t) / 0.012)[:, None]  # 末尾精确归零
    return write_wav('whoosh.wav', sig, -8.0)


# ---------------------------------------------------------------------------
# 3) ding：柔和高音钟声提示（E6 基频 + 泛音，0.38s）
# ---------------------------------------------------------------------------

def make_ding():
    dur = 0.38
    n = int(dur * FS)
    t = np.arange(n) / FS
    base = 1318.51  # E6
    sig = np.zeros(n)
    for ratio, amp, tau in ((1.0, 1.0, 0.30), (2.001, 0.30, 0.19), (3.01, 0.10, 0.12), (4.18, 0.045, 0.08)):
        ph = RNG.uniform(0, 2 * np.pi)
        sig += amp * np.sin(2 * np.pi * base * ratio * t + ph) * np.exp(-t / tau)
    env = smoothstep(t / 0.004) * smoothstep((dur - t) / 0.03)
    sig *= env
    sig = np.tanh(sig * 1.1)
    sig *= smoothstep((dur - t) / 0.015)
    return write_wav('ding.wav', sig, -9.0)


if __name__ == '__main__':
    os.makedirs(HERE, exist_ok=True)
    make_pop()
    make_whoosh()
    make_ding()
    print('done')
