#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成 v2 样片 BGM：轻快 lo-fi / 电子小律动，104 BPM，24 小节无缝循环。

设计（对应 Lead 要求）：
- 100–112 BPM：104 BPM（循环总长取整采样，实际 103.99999 BPM）
- 40–60s 无缝循环：24 小节 = 55.38s；尾音折返叠加，loop 无断口
- 柔和底鼓 + 轻 hi-hat（8 分音符，带 swing/人性化）+ 圆润 sine bass
  + 电钢感分解和弦（8 分，偶有休止）+ 低音量暖 pad + 稀疏 bell
- 无重低音 / 无人声 / 无抢戏主旋律；侧链轻微 duck 给律动
- 整体 -28 LUFS（用 ffmpeg ebur128 校准，命令见 --gain-db 用法）

纯 numpy 合成，无外部采样 → CC0 / 无版权问题。

用法：
  python assets/bgm2/generate-soft-groove.py                    # 默认峰值 -6 dBFS、增益 0
  python assets/bgm2/generate-soft-groove.py --gain-db=-11.4    # 校准到 -28 LUFS 的实际增益
"""
import argparse
import os
import wave

import numpy as np

FS = 48000
BPM = 104.0
BARS = 24                 # 40–60s：24 bars @104BPM ≈ 55.38s
BEATS_PER_BAR = 4
TAIL = 2.0                # release 尾巴，最后折返到开头实现无缝循环
RNG = np.random.default_rng(20261025)

LOOP_SAMPLES = int(round(BARS * BEATS_PER_BAR * 60.0 / BPM * FS))  # 2658462
BEAT = LOOP_SAMPLES / (BARS * BEATS_PER_BAR)                       # 样本/拍（浮点，保证循环整数采样）
BAR = BEAT * BEATS_PER_BAR
BEAT_SEC = 60.0 / BPM                                              # 秒/拍（给合成函数用）
BAR_SEC = BEAT_SEC * BEATS_PER_BAR
TOTAL = LOOP_SAMPLES + int(TAIL * FS)

# 和弦（MIDI）：Cmaj7 – Am7 – Fmaj7 – G6，每个 2 小节，8 小节一循环 × 3
CHORDS = [
    {'bass': 48, 'pad': [48, 52, 55, 59], 'arp': [60, 64, 67, 71]},   # Cmaj7
    {'bass': 45, 'pad': [45, 48, 52, 55], 'arp': [57, 60, 64, 67]},   # Am7
    {'bass': 41, 'pad': [41, 45, 48, 52], 'arp': [53, 57, 60, 64]},   # Fmaj7
    {'bass': 43, 'pad': [43, 47, 50, 52], 'arp': [55, 59, 62, 64]},   # G6
]


def hz(m):
    return 440.0 * 2.0 ** ((m - 69.0) / 12.0)


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def pan(pan_value):
    pan_value = float(np.clip(pan_value, -1.0, 1.0))
    return np.sqrt((1.0 - pan_value) / 2.0), np.sqrt((1.0 + pan_value) / 2.0)


def add(buf, start_sample, sig, gl, gr):
    """把单声道片段按左右增益叠加到立体声 buffer。
    start 为负（第 0 拍人性化提前）时按循环语义折到 buffer 末尾，保证 loop 无缝。"""
    i0 = int(round(start_sample))
    if i0 < 0:
        return add(buf, LOOP_SAMPLES + i0, sig, gl, gr)
    if i0 >= buf.shape[0] or len(sig) == 0:
        return
    if i0 + len(sig) > buf.shape[0]:
        sig = sig[:buf.shape[0] - i0]
    if len(sig) == 0:
        return
    buf[i0:i0 + len(sig), 0] += sig * gl
    buf[i0:i0 + len(sig), 1] += sig * gr


def fft_filter(x, lo=None, hi=None):
    """FFT 砖墙滤波（离线合成用，足够干净）。"""
    n = len(x)
    if n == 0:
        return x
    spec = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(n, 1.0 / FS)
    mask = np.ones_like(spec)
    if lo:
        mask *= smoothstep((freqs - lo * 0.7) / (lo * 0.3))
    if hi:
        mask *= 1.0 - smoothstep((freqs - hi * 0.85) / (hi * 0.35))
    return np.fft.irfft(spec * mask, n)


# ---------------------------------------------------------------------------
# 单件乐器
# ---------------------------------------------------------------------------

def kick(dur=0.32):
    n = int(dur * FS)
    t = np.arange(n) / FS
    f = 42.0 + 28.0 * np.exp(-t / 0.018)
    phase = 2 * np.pi * np.cumsum(f) / FS
    env = smoothstep(t / 0.004) * np.exp(-t / 0.13)
    sig = np.sin(phase) * env
    sig = np.tanh(sig * 1.15) * 0.95
    return fft_filter(sig, hi=1800.0)  # 去掉高频 click，保持“软”


def bass_note(freq, dur):
    n = int(dur * FS)
    t = np.arange(n) / FS
    w = np.sin(2 * np.pi * freq * t) + 0.24 * np.sin(2 * np.pi * freq * 2 * t + 0.4)
    w += 0.06 * np.sin(2 * np.pi * freq * 3 * t + 1.1)
    attack = smoothstep(t / 0.022)
    release = smoothstep((dur - t) / 0.09)
    env = attack * release * np.exp(-t / 1.6)
    return np.tanh(w * env * 1.05) * 0.9


def ep_note(freq, dur, pan_value=0.0):
    """电钢感 pluck：additive + 轻微 detune/vibrato，短促圆润。"""
    n = int(dur * FS)
    t = np.arange(n) / FS
    vib = 1.0 + 0.0018 * np.sin(2 * np.pi * 4.2 * t + RNG.uniform(0, 6.28))
    base = 2 * np.pi * freq * vib * t
    w = np.sin(base) + 0.30 * np.sin(2 * base + 0.3) + 0.09 * np.sin(3 * base + 0.8)
    w += 0.045 * np.sin(4.01 * base)
    env = smoothstep(t / 0.006) * np.exp(-t / 0.34)
    sig = w * env
    gl, gr = pan(pan_value)
    return sig, gl, gr


def hat(level=1.0):
    dur = 0.055
    n = int(dur * FS)
    t = np.arange(n) / FS
    noise = RNG.standard_normal(n)
    noise = fft_filter(noise, lo=6200.0, hi=15000.0)
    env = smoothstep(t / 0.002) * np.exp(-t / 0.016)
    return noise * env * 0.5 * level


def pad_chord(tones, dur):
    """暖 pad：每音双路轻微失谐 + 2 次泛音，慢起音慢收尾。"""
    n = int(dur * FS)
    t = np.arange(n) / FS
    left = np.zeros(n)
    right = np.zeros(n)
    for i, m in enumerate(tones):
        f = hz(m)
        for det, amp, side in ((1.0, 1.0, 0), (1.0017, 0.7, 1), (0.9987, 0.7, -1)):
            ph = RNG.uniform(0, 2 * np.pi)
            w = np.sin(2 * np.pi * f * det * t + ph) + 0.12 * np.sin(2 * np.pi * f * det * 2 * t + ph * 1.3)
            w *= amp * 0.75 / (1.0 + 0.15 * max(0, m - 52))
            if side >= 0:
                left += w
            if side <= 0:
                right += w
    env = smoothstep(t / 0.55) * smoothstep((dur - t) / 1.1)
    left *= env
    right *= env
    return left, right


def bell_note(freq=1568.0, dur=0.9):
    n = int(dur * FS)
    t = np.arange(n) / FS
    sig = np.zeros(n)
    for ratio, amp, tau in ((1.0, 1.0, 0.5), (2.01, 0.45, 0.32), (3.02, 0.2, 0.2), (4.19, 0.08, 0.12)):
        sig += amp * np.sin(2 * np.pi * freq * ratio * t + RNG.uniform(0, 6)) * np.exp(-t / tau)
    sig *= smoothstep(t / 0.004) * 0.55
    return sig


# ---------------------------------------------------------------------------
# 编曲
# ---------------------------------------------------------------------------

def render():
    buses = {k: np.zeros((TOTAL, 2)) for k in ('kick', 'hat', 'bass', 'pluck', 'pad', 'bell')}
    kick_times = []
    n_pluck = 0
    n_hat = 0

    for bar in range(BARS):
        chord = CHORDS[(bar // 2) % len(CHORDS)]
        bar_start = bar * BAR
        # ---- kick：1、3 拍，每 2 小节在 3.5 拍加一个轻 ghost ----
        beats = [0.0, 2.0]
        if bar % 2 == 1:
            beats.append(3.5)
        for beat in beats:
            jitter = RNG.uniform(-0.004, 0.004) * FS
            pos = bar_start + beat * BEAT + jitter
            level = 1.0 if beat < 3 else 0.55
            k_gl, k_gr = pan(0.0)  # 底鼓居中
            add(buses['kick'], pos, kick() * level, k_gl, k_gr)
            kick_times.append(pos)

        # ---- hi-hat：8 分音符，swing 后移 + 力度人性化 ----
        vel_pattern = [0.95, 0.30, 0.58, 0.34, 0.82, 0.30, 0.55, 0.40]
        for i in range(8):
            beat = i * 0.5
            swing = 0.055 * BEAT if i % 2 == 1 else 0.0
            pos = bar_start + beat * BEAT + swing + RNG.uniform(-0.003, 0.003) * FS
            lvl = vel_pattern[i] * RNG.uniform(0.88, 1.12)
            sig = hat(lvl)
            gl, gr = pan(0.18 if i % 2 == 0 else 0.30)
            add(buses['hat'], pos, sig, gl, gr)
            n_hat += 1

        # ---- bass：根音长音 + 2.5 拍五度/高八度点缀 ----
        root = hz(chord['bass'])
        add(buses['bass'], bar_start + 0.0 * BEAT, bass_note(root, BEAT_SEC * 1.4), 1.0, 1.0)
        fifth = root * 1.5
        add(buses['bass'], bar_start + 2.5 * BEAT, bass_note(fifth, BEAT_SEC * 0.9), 1.0, 1.0)
        if bar % 4 == 0:
            add(buses['bass'], bar_start + 3.5 * BEAT, bass_note(root * 2, BEAT_SEC * 0.45), 1.0, 1.0)

        # ---- 分解和弦（电钢感）：8 分音符，带休止与 swing ----
        pattern = [0, -1, 2, 1, -1, 3, 2, -1]
        pans = [-0.28, 0.22, -0.12, 0.30, -0.22, 0.12, -0.30, 0.18]
        for i, idx in enumerate(pattern):
            if idx < 0:
                continue
            note = chord['arp'][idx % len(chord['arp'])]
            midi = note
            # 偶尔高八度，增加轻快感（不构成主旋律）
            if bar % 8 == 3 and i == 4:
                midi += 12
            if bar % 8 == 6 and i in (2, 6):
                midi += 12
            dur = 0.42 if i % 2 == 0 else 0.30
            swing = 0.055 * BEAT if i % 2 == 1 else 0.0
            pos = bar_start + i * 0.5 * BEAT + swing + RNG.uniform(-0.0035, 0.0035) * FS
            sig, gl, gr = ep_note(hz(midi), dur, pans[i])
            amp = (0.95 if i % 2 == 0 else 0.7) * RNG.uniform(0.9, 1.1)
            add(buses['pluck'], pos, sig * amp, gl, gr)
            n_pluck += 1

        # ---- pad：每 2 小节换一次和弦 ----
        if bar % 2 == 0:
            left, right = pad_chord(chord['pad'], BAR_SEC * 2 + 0.6)
            i0 = int(bar_start)
            if i0 + len(left) > TOTAL:
                left = left[:TOTAL - i0]
                right = right[:TOTAL - i0]
            buses['pad'][i0:i0 + len(left), 0] += left
            buses['pad'][i0:i0 + len(left), 1] += right

        # ---- bell：每 8 小节一个轻柔提示音 ----
        if bar % 8 == 0:
            note = 79 if (bar // 8) % 2 == 0 else 83   # G5 / B5
            pos = bar_start + 2.75 * BEAT
            add(buses['bell'], pos, bell_note(hz(note)), 0.9, 0.75)

    # 尾音折返，保证 loop 无缝：把 loop 之后的 release 尾巴叠加回开头
    tail_n = TOTAL - LOOP_SAMPLES
    for key, bus in buses.items():
        bus[:tail_n] += bus[LOOP_SAMPLES:]
        buses[key] = bus[:LOOP_SAMPLES].copy()

    # 侧链 duck：kick 事件后 0.30 衰减，压 bass/pad/pluck
    duck = np.ones(LOOP_SAMPLES)
    for pos in kick_times:
        i0 = int(round(pos)) % LOOP_SAMPLES
        n = int(0.45 * FS)
        tt = np.arange(n) / FS
        factor = 1.0 - 0.18 * np.exp(-tt / 0.085)
        idx = (i0 + np.arange(n)) % LOOP_SAMPLES
        duck[idx] *= factor

    # ---- 混音（v3：kick/hat/bass/pluck/pad 按 RMS 重新配平，pad 只做暖底）----
    mix = np.zeros((LOOP_SAMPLES, 2))
    mix += buses['kick'] * 0.78
    mix += buses['hat'] * 4.0
    ducked = (buses['bass'] * 0.32 + buses['pad'] * 0.055 + buses['pluck'] * 0.36)
    mix += ducked * duck[:, None]
    mix += buses['bell'] * 0.30

    debug = bool(os.environ.get('BGM_DEBUG'))
    if debug:
        for key, bus in buses.items():
            print(f'[debug] bus {key:6s} seam={abs(bus[0,0]-bus[-1,0]):.6f} rms={np.sqrt(np.mean(bus**2)):.5f}', flush=True)
        print(f'[debug] mix pre-noise seam={abs(mix[0,0]-mix[-1,0]):.6f}', flush=True)

    # 轻微黑胶底噪，增加暖度（约 -58 dBFS）
    noise = RNG.standard_normal((LOOP_SAMPLES, 2)) * 0.0012
    noise = np.stack([fft_filter(noise[:, 0], lo=180.0, hi=7000.0),
                      fft_filter(noise[:, 1], lo=180.0, hi=7000.0)], axis=1)
    mix += noise

    # lo-fi 处理：去超低频（不轰头）+ 柔化高频 + 轻饱和
    for ch in range(2):
        mix[:, ch] = fft_filter(mix[:, ch], lo=48.0, hi=12500.0)
    mix = np.tanh(mix * 1.05) * 0.95
    if debug:
        print(f'[debug] mix post-fx seam={abs(mix[0,0]-mix[-1,0]):.6f} diffStd={np.abs(np.diff(mix[:,0])).std():.6f}', flush=True)

    # 循环无缝性依赖上面的“尾音折返”：所有 release 尾巴都叠加回开头，
    # 因此 loop 点前后是同一个周期信号的相邻采样，不需要额外交叉淡化（加了反而会引入跳变）。
    if debug:
        d = np.abs(np.diff(mix[:, 0]))
        seam = abs(mix[0, 0] - mix[-1, 0])
        print(f'[debug] final seam={seam:.6f} localDiffP99={np.percentile(d,99):.6f} '
              f'first100Max={np.max(np.abs(mix[:100,0])):.4f} last100Max={np.max(np.abs(mix[-100:,0])):.4f}', flush=True)

    # 归一化到目标峰值（LUFS 用 --gain-db 校准）
    peak = np.max(np.abs(mix)) or 1.0
    mix *= (10 ** (-6.0 / 20.0)) / peak
    return mix, n_pluck, n_hat, len(kick_times)


def lufs_gain_path(mix, gain_db):
    out = mix * (10 ** (gain_db / 20.0))
    peak = np.max(np.abs(out))
    if peak > 0.99:
        out *= 0.99 / peak
    return out


def write_wav(path, audio):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(FS)
        w.writeframes(pcm.tobytes())


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument('--out', default=os.path.join(here, 'soft-groove.wav'))
    ap.add_argument('--gain-db', type=float, default=0.0)
    args = ap.parse_args()

    mix, n_pluck, n_hat, n_kick = render()
    audio = lufs_gain_path(mix, args.gain_db)
    write_wav(args.out, audio)

    dur = LOOP_SAMPLES / FS
    actual_bpm = 60.0 * FS * (BARS * BEATS_PER_BAR) / LOOP_SAMPLES
    peak_db = 20 * np.log10(np.max(np.abs(audio)) + 1e-12)
    rms_db = 20 * np.log10(np.sqrt(np.mean(audio ** 2)) + 1e-12)
    seam = abs(audio[0, 0] - audio[-1, 0])
    print(f'wrote {args.out}')
    print(f'BPM={actual_bpm:.4f} bars={BARS} loop={dur:.3f}s samples={LOOP_SAMPLES} fs={FS} stereo')
    print(f'peak={peak_db:.2f} dBFS rms={rms_db:.2f} dBFS seamJump={seam:.6f}')
    print(f'events: kick={n_kick} hat={n_hat} pluck={n_pluck}')


if __name__ == '__main__':
    main()
