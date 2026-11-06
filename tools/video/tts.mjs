/**
 * tts.mjs — 纯 Node（零依赖）Edge TTS 客户端：给「大肥鱼」视频管线配音。
 *
 * 移植自 whale-video/src/tts.mjs（已验证能出片），插件版改动只有三处：
 *   ① 去掉 CLI/main（插件里只作为模块用）；
 *   ② ffmpeg 定位改用插件统一的 tools/lib/ffmpeg.mjs（requireFfmpeg，不再写死路径）；
 *   ③ 输出目录交给调用方（render.mjs 传 <dir>/.work/tts/*.mp3）。
 *
 * 用法（模块）：
 *   import { synthesize } from './tts.mjs'
 *   const { mp3, durationMs } = await synthesize({
 *     text: '那天晚上，我本来是想去看 AI 的。',
 *     voice: 'zh-CN-XiaoyiNeural', rate: '+8%', pitch: '+8Hz',
 *     outMp3: path.join(dir, 'tts', 's00.mp3'),
 *   })
 *
 * 实现说明：
 * - 不依赖 Python / npm 包。Node 内置 https + crypto 完成 WebSocket 握手与帧编解码。
 * - 使用 Edge ReadAloud 协议（与 edge-tts 7.3.1 对齐）：
 *   v2 Sec-MS-GEC token（CS64+SHA256，版本 2-143.0.3650.75）+ Cookie muid。
 *   注：老资料的 v1 token / 1-130.0.2849.68 现在会被 403，本文件按 v2 实现。
 * - 输出 MP3 为 24kHz / 48kbps / 单声道（服务端固定格式）。
 * - 时长优先用 ffmpeg 实测，没有 ffmpeg 时按 48kbps CBR 字节数估算。
 * - 失败会抛带可读原因的错误（HTTP 状态、WebSocket close code、无音频等），绝不静默写空文件。
 *
 * ⚠️ 这是一个会访问网络的模块（speech.platform.bing.com）。单测不要调 synthesize，
 *    只测 generateSecMsGec / selfTestToken 这类纯函数。
 */

import crypto from 'node:crypto';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { requireFfmpeg } from '../lib/ffmpeg.mjs';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WS_HOST = 'speech.platform.bing.com';
const WS_PATH = '/consumer/speech/synthesize/readaloud/edge/v1';
const SEC_MS_GEC_VERSION = '2-143.0.3650.75';
const AUDIO_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const MP3_BITRATE_BPS = 48000;
const TICKS_PER_SECOND = 10000000;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_VOICE = 'zh-CN-XiaoyiNeural';
const CONNECT_TIMEOUT_MS = 15000;
const TURN_TIMEOUT_MS = 60000;
const MAX_CHUNK_CHARS = 1200; // 服务端 SSML 单请求上限约 4096 字节，中文按 3B/字留余量
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';

// ---------------------------------------------------------------------------
// Sec-MS-GEC v2 token
// 移植自 edge-tts 7.3.1 的 edge_tts/drm.py（服务端已改用 v2，旧的纯 SHA256 v1 会 403）。
// 已用 out/tts-probe/verify-token.mjs 在 5 个固定时间戳上与 Python 实现逐字节比对通过。
// ---------------------------------------------------------------------------

const WIN_EPOCH = 11644473600n;
const U32 = 0xffffffff;
const U32N = 0xffffffffn;

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2,
];
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
  0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564,
];
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const SHA256_ADJUSTMENT = 0xc9dc06a7;
const SHA256_BLOCK_CONSTANTS = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14),
  SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15),
];
const SIGMA0_ADJ = 0x059c0b80;
const SIGMA1_ADJ = 0x000b92c0;

const CS64_COEFFICIENTS = [
  [0xe82e91b1, 0xb32700d0], [0x44de24c6, 0x88dff51d], [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf], [0x8d1ec211, 0xd405b4d5], [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6], [0xf0a5b9d5, 0x82b2c1fb], [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464], [0xbed20560, 0x3c3c74f3], [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1], [0xcb49e3c6, 0xc5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJ0 = 0xf2f90b1a;
const CS64_ADJ1 = 0x0b1a0000;

const mul = (a, b) => Math.imul(a, b) >>> 0;

function rol16(value) {
  const v = value & U32;
  return ((((v << 16) | (v >>> 16)) & U32) >>> 0);
}
function sigma0(v) {
  return (((((v >>> 7) ^ (v << 25) ^ (v >>> 18) ^ (v << 14) ^ (v >>> 3)) & U32)) >>> 0);
}
function sigma1(v) {
  return (((((v >>> 17) ^ (v << 15) ^ (v >>> 19) ^ (v << 13) ^ (v >>> 10)) & U32)) >>> 0);
}
// 低 32 位等价于 ROTR(value, shift)，用 BigInt 保证 64 位中间量正确。
function rotE(value, shift) {
  const x = (BigInt(value >>> 0) * 0x100000001n) >> BigInt(shift);
  return Number(x & U32N);
}

function sha256Rounds(state, words, firstRound = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  const aligned = Math.min(64, Math.floor((firstRound + 7) / 8) * 8);
  for (let i = firstRound; i < aligned; i++) {
    const t1 = (h + (rotE(e, 6) ^ rotE(e, 11) ^ rotE(e, 25)) + (g ^ (e & (f ^ g))) + constants[i] + words[i]) & U32;
    const t2 = ((rotE(a, 2) ^ rotE(a, 13) ^ rotE(a, 22)) + ((a & b) | (c & (a | b)))) & U32;
    [a, b, c, d, e, f, g, h] = [(t1 + t2) & U32, a, b, c, (d + t1) & U32, e, f, g];
  }
  for (let i = aligned; i < 64; i += 8) {
    let t1 = (h + (rotE(e, 6) ^ rotE(e, 11) ^ rotE(e, 25)) + (g ^ (e & (f ^ g))) + constants[i] + words[i]) & U32;
    d = (d + t1) & U32;
    h = (t1 + (rotE(a, 2) ^ rotE(a, 13) ^ rotE(a, 22)) + ((a & b) | (c & (a | b)))) & U32;
    t1 = (g + (rotE(d, 6) ^ rotE(d, 11) ^ rotE(d, 25)) + (f ^ (d & (e ^ f))) + constants[i + 1] + words[i + 1]) & U32;
    c = (c + t1) & U32;
    g = (t1 + (rotE(h, 2) ^ rotE(h, 13) ^ rotE(h, 22)) + ((h & a) | (b & (h | a)))) & U32;
    t1 = (f + (rotE(c, 6) ^ rotE(c, 11) ^ rotE(c, 25)) + (e ^ (c & (d ^ e))) + constants[i + 2] + words[i + 2]) & U32;
    b = (b + t1) & U32;
    f = (t1 + (rotE(g, 2) ^ rotE(g, 13) ^ rotE(g, 22)) + ((g & h) | (a & (g | h)))) & U32;
    t1 = (e + (rotE(b, 6) ^ rotE(b, 11) ^ rotE(b, 25)) + (d ^ (b & (c ^ d))) + constants[i + 3] + words[i + 3]) & U32;
    a = (a + t1) & U32;
    e = (t1 + (rotE(f, 2) ^ rotE(f, 13) ^ rotE(f, 22)) + ((f & g) | (h & (f | g)))) & U32;
    t1 = (d + (rotE(a, 6) ^ rotE(a, 11) ^ rotE(a, 25)) + (c ^ (a & (b ^ c))) + constants[i + 4] + words[i + 4]) & U32;
    h = (h + t1) & U32;
    d = (t1 + (rotE(e, 2) ^ rotE(e, 13) ^ rotE(e, 22)) + ((e & f) | (g & (e | f)))) & U32;
    t1 = (c + (rotE(h, 6) ^ rotE(h, 11) ^ rotE(h, 25)) + (b ^ (h & (a ^ b))) + constants[i + 5] + words[i + 5]) & U32;
    g = (g + t1) & U32;
    c = (t1 + (rotE(d, 2) ^ rotE(d, 13) ^ rotE(d, 22)) + ((d & e) | (f & (d | e)))) & U32;
    t1 = (b + (rotE(g, 6) ^ rotE(g, 11) ^ rotE(g, 25)) + (a ^ (g & (h ^ a))) + constants[i + 6] + words[i + 6]) & U32;
    f = (f + t1) & U32;
    b = (t1 + (rotE(c, 2) ^ rotE(c, 13) ^ rotE(c, 22)) + ((c & d) | (e & (c | d)))) & U32;
    t1 = (a + (rotE(f, 6) ^ rotE(f, 11) ^ rotE(f, 25)) + (h ^ (f & (g ^ h))) + constants[i + 7] + words[i + 7]) & U32;
    e = (e + t1) & U32;
    a = (t1 + (rotE(b, 2) ^ rotE(b, 13) ^ rotE(b, 22)) + ((b & c) | (d & (b | c)))) & U32;
  }
  return [a, b, c, d, e, f, g, h];
}

function expandSha256Schedule(words, firstWord = 16) {
  for (let i = firstWord; i < 64; i++) {
    const x = words[i - 2];
    const y = words[i - 15];
    const s1 = (x >>> 17) ^ (x << 15) ^ (x >>> 19) ^ (x << 13) ^ (x >>> 10);
    const s0 = (y >>> 7) ^ (y << 25) ^ (y >>> 18) ^ (y << 14) ^ (y >>> 3);
    words.push((s1 + words[i - 7] + s0 + words[i - 16]) & U32);
  }
}

function sha256Init(data /* 7 bytes */) {
  const words = new Array(14).fill(0);
  words.push(data.readUIntBE(0, 3));
  words.push(data.readUIntBE(3, 4));
  for (let i = 16; i < 30; i++) {
    let value = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) value = (value + (sigma1(words[i - 2]) ^ (i === 16 ? SIGMA1_ADJ : 0))) & U32;
    if (i - 7 >= 14) value = (value + words[i - 7]) & U32;
    if (i - 15 >= 14) value = (value + (sigma0(words[i - 15]) ^ (i === 29 ? SIGMA0_ADJ : 0))) & U32;
    words.push(value & U32);
  }
  words.push(
    (sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] + SHA256_ADJUSTMENT - SHA256_ROUND_CONSTANTS[14]) & U32,
  );
  expandSha256Schedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return working.map((x, i) => (x + SHA256_INITIAL[i]) & U32);
}

function sha256Digest(data) {
  if (data.length < 7) throw new Error('token salt must be at least 7 bytes');
  const length = 57 + data.length;
  const padLen = ((55 - length) % 64 + 64) % 64;
  const padded = Buffer.alloc(data.length - 7 + 1 + padLen + 8);
  data.copy(padded, 0, 7);
  padded[data.length - 7] = 0x80;
  const bits = length * 8;
  padded.writeUInt32BE(Math.floor(bits / 0x100000000), padded.length - 8);
  padded.writeUInt32BE(bits >>> 0, padded.length - 4);
  let state = sha256Init(data.subarray(0, 7));
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = [];
    for (let i = 0; i < 16; i++) words.push(padded.readUInt32BE(offset + i * 4));
    expandSha256Schedule(words);
    const working = sha256Rounds(state, words);
    state = working.map((x, i) => (x + state[i]) & U32);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) out.writeUInt32BE(state[i] >>> 0, i * 4);
  return out;
}

function wordsLe4Even(data) {
  const pad = (4 - (data.length % 4)) % 4;
  const padded = Buffer.alloc(data.length + pad);
  data.copy(padded);
  const words = [];
  for (let i = 0; i < padded.length; i += 4) words.push(padded.readUInt32LE(i));
  if (words.length % 2) words.push(0);
  return words;
}

function cs64Digest(data, digest) {
  const keyA = digest.readUInt32LE(0) | 1;
  const keyB = digest.readUInt32LE(4) | 1;
  const factors = [mul(keyA, CS64_FACTOR), mul(keyB, CS64_FACTOR)];
  const terms = CS64_COEFFICIENTS.map(([coef], i) => mul(coef, factors[i % 2]));
  const offsets = CS64_COEFFICIENTS.map(([, off]) => off);
  const words = wordsLe4Even(Buffer.concat([Buffer.from([0]), data]));
  for (let i = 0; i < words.length; i++) {
    let term = mul(words[i], i % 2 === 0 ? keyA : keyB);
    let offset = mul(rol16(words[i]), i % 2 === 0 ? 0xef0569fb : 0xc31713db);
    if (i === 0) {
      term = (term + mul(CS64_ADJ0, factors[0])) & U32;
      offset = (offset + CS64_ADJ1) & U32;
    }
    terms.push(term & U32);
    offsets.push(offset & U32);
  }
  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    let t = rol16((offsets[i] + terms[i]) & U32);
    let q = mul(t, 0x76f50f34);
    swapAcc = (swapAcc + ((mul(rol16(q), 0xc3efea97) + q) & U32)) & U32;
    t = rol16((offsets[i + 1] + terms[i + 1]) & U32);
    q = mul(t, 0x1881ce3c);
    swapLast = (mul(rol16(q), 0x35bd1ec9) + q) & U32;
    swapAcc = (swapAcc + swapLast) & U32;
    state = (mul(state, keyA) + terms[i]) & U32;
    state = mul(rol16(state), 0xcf98b111);
    state = mul(rol16(state), 0x87085b9f);
    state = mul(rol16(state), 0x12ceb96d);
    state = mul(rol16(state), 0x257e1d83);
    acc = (acc + state) & U32;
    let t2 = (mul(state, keyB) + terms[i + 1]) & U32;
    t2 = mul(rol16(t2), 0xa27416f5);
    t2 = mul(rol16(t2), 0xd38396ff);
    state = mul(rol16(mul(rol16(t2), 0x7c932b89)), 0xbfa49f69);
    acc = (acc + state) & U32;
  }
  const out = Buffer.alloc(8);
  out.writeUInt32LE((swapLast ^ state) >>> 0, 0);
  out.writeUInt32LE((swapAcc ^ acc) >>> 0, 4);
  return out;
}

function tokenHash(data) {
  const digest = sha256Digest(data);
  return {
    cs64: cs64Digest(data, digest).toString('hex').toUpperCase(),
    sha256: digest.toString('hex').toUpperCase(),
  };
}

/** 生成 Sec-MS-GEC v2 token；unixTimestampSec 仅用于自测。 */
export function generateSecMsGec(unixTimestampSec) {
  let ticks = unixTimestampSec === undefined
    ? BigInt(Math.floor(Date.now() / 1000))
    : BigInt(Math.floor(unixTimestampSec));
  ticks += WIN_EPOCH;
  ticks -= ticks % 300n;
  ticks *= 10000000n;
  const salt = Buffer.from(`${ticks}${TRUSTED_CLIENT_TOKEN}`, 'ascii');
  const { cs64, sha256 } = tokenHash(salt);
  return `${cs64}-${sha256}`;
}

// 与 Python edge-tts 7.3.1 的 generate_sec_ms_gec_v2() 逐字节比对过的固定向量（自检用）。
const TOKEN_VECTORS = [
  [1700000000, '2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2'],
  [1750000000, 'B029A7426816F097-4579D112DC47FC3BF432B499C0A282F427C659474AF9BF5FA33CE2C003F9E9C2'],
  [1793000000, '781C1B76C9F739B3-1A772624F17530DF13FBF300637917F70D55C163861ADEC2DA70A248A0DE438A'],
  [1793000300, '2D53AE79BABA1836-B8B1E1EB63A0281B58B809609078BF1D6D5147978D4835960D423F7C73F4B098'],
];

/** 自检：校验 Sec-MS-GEC v2 实现与 Python edge-tts 7.3.1 一致。 */
export function selfTestToken() {
  return TOKEN_VECTORS.map(([ts, expected]) => {
    const got = generateSecMsGec(ts);
    return { timestamp: ts, expected, got, pass: got === expected };
  });
}

// ---------------------------------------------------------------------------
// 极简 WebSocket 客户端（仅本协议所需：文本/二进制帧、ping/pong、close）
// 全局 WebSocket 无法携带自定义头（Origin / Cookie muid），服务端会 1006，故自实现。
// ---------------------------------------------------------------------------

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  const mask = crypto.randomBytes(4);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, body]);
}

/**
 * 连上 Edge TTS 的 WebSocket，返回 { sendText, waitTurnEnd, close }。
 * 内部做帧解析，把文本帧交给 onText、二进制帧交给 onBinary。
 */
function openEdgeSocket({ onText, onBinary }) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const connId = crypto.randomBytes(16).toString('hex');
    const muid = crypto.randomBytes(16).toString('hex').toUpperCase();
    const reqPath =
      `${WS_PATH}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&ConnectionId=${connId}` +
      `&Sec-MS-GEC=${generateSecMsGec()}` +
      `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      reject(err);
    };

    const req = https.request({
      hostname: WS_HOST,
      port: 443,
      path: reqPath,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': USER_AGENT,
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: `muid=${muid};`,
      },
    });

    const connectTimer = setTimeout(
      () => fail(new Error(`连接 Edge TTS 超时（${CONNECT_TIMEOUT_MS}ms），检查网络/代理`)),
      CONNECT_TIMEOUT_MS,
    );

    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').slice(0, 300);
        fail(
          new Error(
            `Edge TTS WebSocket 握手被拒绝：HTTP ${res.statusCode}` +
              (res.statusMessage ? ` ${res.statusMessage}` : '') +
              (body ? `；响应体：${body}` : '') +
              '。常见原因：系统时间偏差 >5 分钟、网络代理拦截、或 Edge 服务协议变更。',
          ),
        );
      });
    });

    req.on('error', (err) => fail(new Error(`连接 Edge TTS 失败：${err.message}`)));

    req.on('upgrade', (res, socket, head) => {
      clearTimeout(connectTimer);
      if (res.statusCode !== 101) {
        fail(new Error(`Edge TTS WebSocket 升级失败：HTTP ${res.statusCode}`));
        return;
      }
      const expected = crypto
        .createHash('sha1')
        .update(key + WS_GUID)
        .digest('base64');
      if (res.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        fail(new Error('Edge TTS WebSocket 握手校验失败：Sec-WebSocket-Accept 不匹配'));
        return;
      }
      if (settled) {
        socket.destroy();
        return;
      }
      settled = true;

      let closedByUs = false;
      let closeReason = null;
      let buffer = Buffer.alloc(0);
      let fragOpcode = 0;
      let fragParts = [];

      const send = (opcode, payload) => {
        if (!socket.destroyed) socket.write(encodeFrame(opcode, payload));
      };

      const deliver = (opcode, payload) => {
        if (opcode === 0x1) onText(payload.toString('utf8'));
        else if (opcode === 0x2) onBinary(Buffer.from(payload));
      };

      const parse = () => {
        while (true) {
          if (buffer.length < 2) return;
          const fin = (buffer[0] & 0x80) !== 0;
          const rsv = buffer[0] & 0x70;
          const opcode = buffer[0] & 0x0f;
          const masked = (buffer[1] & 0x80) !== 0;
          let len = buffer[1] & 0x7f;
          let offset = 2;
          if (len === 126) {
            if (buffer.length < 4) return;
            len = buffer.readUInt16BE(2);
            offset = 4;
          } else if (len === 127) {
            if (buffer.length < 10) return;
            const big = buffer.readBigUInt64BE(2);
            if (big > 0x7fffffffn) {
              socket.destroy();
              return;
            }
            len = Number(big);
            offset = 10;
          }
          if (rsv !== 0) {
            // 未协商扩展，RSV 必须为 0
            socket.destroy();
            return;
          }
          let maskKey = null;
          if (masked) {
            if (buffer.length < offset + 4) return;
            maskKey = buffer.subarray(offset, offset + 4);
            offset += 4;
          }
          if (buffer.length < offset + len) return;
          let payload = buffer.subarray(offset, offset + len);
          buffer = buffer.subarray(offset + len);
          if (maskKey) {
            const un = Buffer.alloc(len);
            for (let i = 0; i < len; i++) un[i] = payload[i] ^ maskKey[i % 4];
            payload = un;
          }
          if (opcode === 0x8) {
            closeReason = 'server close';
            socket.end();
            return;
          }
          if (opcode === 0x9) {
            send(0xa, payload);
            continue;
          }
          if (opcode === 0xa) continue; // pong
          if (opcode === 0x0) {
            fragParts.push(Buffer.from(payload));
            if (fin) {
              deliver(fragOpcode, Buffer.concat(fragParts));
              fragParts = [];
              fragOpcode = 0;
            }
          } else if (opcode === 0x1 || opcode === 0x2) {
            if (fin) deliver(opcode, payload);
            else {
              fragOpcode = opcode;
              fragParts = [Buffer.from(payload)];
            }
          }
        }
      };

      socket.on('data', (chunk) => {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
        try {
          parse();
        } catch (err) {
          socket.destroy();
          console.error('[tts] WebSocket 帧解析错误：', err.message);
        }
      });
      socket.on('error', (err) => {
        if (!closedByUs) console.error('[tts] WebSocket 错误：', err.message);
      });
      socket.on('close', () => {
        if (!closedByUs) closeReason = closeReason || 'socket closed';
      });
      if (head && head.length) {
        buffer = Buffer.from(head);
        try {
          parse();
        } catch { /* 忽略 */ }
      }

      resolve({
        sendText: (text) => send(0x1, Buffer.from(text, 'utf8')),
        close: () => {
          closedByUs = true;
          try {
            send(0x8, Buffer.alloc(0));
          } catch { /* ignore */ }
          socket.destroy();
        },
        getCloseReason: () => closeReason,
        getSocket: () => socket,
      });
    });

    req.end();
  });
}

// ---------------------------------------------------------------------------
// 文本 / SSML / 分块
// ---------------------------------------------------------------------------

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 去掉服务端不支持的 C0 控制字符（保留 \n \t）。 */
function cleanText(text) {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
}

function buildSsml({ text, voice, rate, pitch, volume }) {
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>" +
    `<voice name='${voice}'>` +
    `<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
    escapeXml(text) +
    '</prosody></voice></speak>'
  );
}

function timestampUtc() {
  const d = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = (n) => String(n).padStart(2, '0');
  return (
    `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${p2(d.getUTCDate())} ${d.getUTCFullYear()} ` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  );
}

/** 按句末标点把长文本切成 < 1200 字符的块；短文本不切。 */
function splitText(text, maxChars = MAX_CHUNK_CHARS) {
  if (text.length <= maxChars) return [text];
  const pieces = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = -1;
    for (let i = maxChars; i > maxChars * 0.4; i--) {
      if (/[。！？!?；;\n]/.test(rest[i - 1])) {
        cut = i;
        break;
      }
    }
    if (cut < 0) {
      for (let i = maxChars; i > maxChars * 0.6; i--) {
        if (/[，,、：:]/.test(rest[i - 1])) {
          cut = i;
          break;
        }
      }
    }
    if (cut < 0) cut = maxChars;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) pieces.push(rest);
  return pieces.filter((p) => p.trim().length);
}

/** 调一次 WebSocket，拿一块音频 + 词边界。 */
async function synthesizeChunk({ text, voice, rate, pitch, volume }) {
  const audioChunks = [];
  const words = [];
  let sawTurnEnd = false;
  let resolveDone;
  let rejectDone;
  const done = new Promise((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  let socket;
  const finishOk = () => {
    if (sawTurnEnd) return;
    sawTurnEnd = true;
    socket?.close();
    resolveDone();
  };
  const finishErr = (err) => {
    if (sawTurnEnd) return;
    sawTurnEnd = true;
    socket?.close();
    rejectDone(err);
  };

  try {
    socket = await openEdgeSocket({
      onText: (frame) => {
        const headerEnd = frame.indexOf('\r\n\r\n');
        const head = headerEnd >= 0 ? frame.slice(0, headerEnd) : frame;
        const body = headerEnd >= 0 ? frame.slice(headerEnd + 4) : '';
        const pathMatch = head.match(/^Path:(.*)$/m);
        const framePath = pathMatch ? pathMatch[1].trim() : '';
        if (framePath === 'audio.metadata') {
          try {
            const meta = JSON.parse(body);
            for (const item of meta.Metadata || []) {
              if (item.Type === 'WordBoundary') {
                words.push({
                  offsetMs: item.Data.Offset / (TICKS_PER_SECOND / 1000),
                  durationMs: item.Data.Duration / (TICKS_PER_SECOND / 1000),
                  text: item.Data.text.Text,
                });
              }
            }
          } catch (err) {
            // 元数据解析失败不影响音频，只影响字幕；记录但继续
            console.error('[tts] 词边界元数据解析失败：', err.message);
          }
        } else if (framePath === 'turn.end') {
          finishOk();
        } else if (framePath === 'turn.start' || framePath === 'response') {
          // 正常但无需处理
        }
        // 未知 path 忽略（服务端偶尔会加新事件）
      },
      onBinary: (buf) => {
        if (buf.length < 2) return;
        const headerLength = buf.readUInt16BE(0);
        if (headerLength > buf.length - 2) {
          finishErr(new Error('Edge TTS 返回的二进制帧头长度非法'));
          return;
        }
        const header = buf.subarray(2, 2 + headerLength).toString('ascii');
        const data = buf.subarray(2 + headerLength);
        if (!/^Path:audio\r?$/m.test(header)) return;
        if (data.length) audioChunks.push(Buffer.from(data));
      },
    });
  } catch (err) {
    throw err;
  }

  // 依次发送 speech.config + SSML
  const requestId = crypto.randomBytes(16).toString('hex');
  socket.sendText(
    `X-RequestId:${requestId}\r\n` +
      'Content-Type:application/json; charset=utf-8\r\n' +
      `X-Timestamp:${timestampUtc()}\r\n` +
      'Path:speech.config\r\n\r\n' +
      JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
              outputFormat: AUDIO_FORMAT,
            },
          },
        },
      }) +
      '\r\n',
  );
  const ssml = buildSsml({ text, voice, rate, pitch, volume });
  socket.sendText(
    `X-RequestId:${requestId}\r\n` +
      'Content-Type:application/ssml+xml\r\n' +
      `X-Timestamp:${timestampUtc()}Z\r\n` +
      'Path:ssml\r\n\r\n' +
      ssml,
  );

  const timer = setTimeout(
    () => finishErr(new Error(`Edge TTS 合成超时（${TURN_TIMEOUT_MS}ms 未收到 turn.end）`)),
    TURN_TIMEOUT_MS,
  );
  // socket 提前关闭也算失败
  socket.getSocket().on('close', () => {
    setTimeout(() => {
      if (!sawTurnEnd) finishErr(new Error(`Edge TTS 连接意外关闭（${socket.getCloseReason() || '无原因'}）`));
    }, 50);
  });

  try {
    await done;
  } finally {
    clearTimeout(timer);
    socket.close();
  }

  if (!audioChunks.length) {
    throw new Error('Edge TTS 没有返回音频数据（检查 voice 参数是否有效、文本是否为空）');
  }
  return { audio: Buffer.concat(audioChunks), words };
}

// ---------------------------------------------------------------------------
// SRT
// ---------------------------------------------------------------------------

function formatSrtTime(ms) {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const milli = total % 1000;
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)},${String(milli).padStart(3, '0')}`;
}

const SENTENCE_END = /[。！？!?…]$/;
const CLAUSE_END = /[，,、；;：:]$/;
const PUNCT_ONLY = /^[\s，,。.！!？?；;：:、…\u2014\u2013\-—）)」』"”'’]+$/;

/**
 * Edge 的 WordBoundary token 本身不含标点（中文尤其明显）。这里把 token 按顺序回填到原文，
 * 把 token 之间的标点/空格挂到「前一个 token」的尾部，使字幕保留正常中文标点。
 * 对齐失败时降级为原 token，不抛错。
 */
function reattachPunctuation(words, originalText) {
  const out = [];
  let cursor = 0;
  let prev = null;
  for (const w of words) {
    const token = w.text;
    if (!token) continue;
    let idx = originalText.indexOf(token, cursor);
    if (idx < 0) idx = originalText.indexOf(token.trim(), cursor);
    if (idx >= 0) {
      const gap = originalText.slice(cursor, idx);
      if (prev && gap && PUNCT_ONLY.test(gap)) prev.text += gap;
      cursor = idx + token.length;
      prev = { ...w, text: token };
    } else {
      prev = { ...w, text: token };
    }
    out.push(prev);
  }
  if (prev && cursor < originalText.length) {
    const tail = originalText.slice(cursor);
    if (PUNCT_ONLY.test(tail)) prev.text += tail;
  }
  return out;
}

/**
 * 把 WordBoundary 列表编排成 SRT。规则：
 * - 句末标点后断句；逗号/顿号等子句标点后（累计 >= 4 字）断句；
 * - 单条最长 24 字 / 5 秒；
 * - 词间静音 > 600ms 也断句（自然停顿）；
 * - 整条时间轴平移，使第一条从 00:00:00,000 开始；
 * - 不重叠、最短 400ms。
 */
function wordsToSrt(words, durationMs) {
  const items = words
    .filter((w) => w.text && w.text.trim())
    .map((w) => ({
      start: w.offsetMs,
      end: w.offsetMs + w.durationMs,
      text: w.text,
    }))
    .sort((a, b) => a.start - b.start);
  if (!items.length) return '';

  const base = items[0].start; // 让字幕从 0 开始
  const cues = [];
  let cur = null;
  const flush = (endCap) => {
    if (!cur) return;
    const text = cur.text.trim();
    if (text) {
      let end = Math.min(cur.end, endCap ?? Infinity);
      if (end <= cur.start) end = cur.start + 400;
      cues.push({ start: cur.start, end, text });
    }
    cur = null;
  };

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const start = Math.max(0, it.start - base);
    const end = Math.max(start + 1, it.end - base);
    const gap = cur ? start - cur.end : 0;
    if (cur && gap > 600) flush(cur.end + 120);
    if (!cur) cur = { start, end, text: '' };
    cur.text += it.text;
    cur.end = end;
    const chars = [...cur.text].length;
    const endsSentence = SENTENCE_END.test(it.text.trim());
    const endsClause = CLAUSE_END.test(it.text.trim());
    if (endsSentence) flush(cur.end + 80);
    else if (endsClause && chars >= 4) flush(cur.end + 60);
    else if (chars >= 24) flush(cur.end + 40);
    else if (cur.end - cur.start >= 5000) flush(cur.end + 40);
  }
  flush();

  // 单调、不重叠、不越界
  const total = Math.max(durationMs || 0, 1);
  let prevEnd = 0;
  for (const c of cues) {
    c.start = Math.max(c.start, prevEnd);
    if (c.end <= c.start) c.end = c.start + 400;
    prevEnd = c.end;
  }
  for (let i = 0; i < cues.length; i++) {
    const nextStart = i + 1 < cues.length ? cues[i + 1].start : total;
    if (cues[i].end > nextStart - 30) {
      cues[i].end = Math.max(cues[i].start + 200, nextStart - 30);
    }
    if (cues[i].end > total && cues[i].start < total) cues[i].end = Math.max(cues[i].start + 1, total);
  }

  const lines = [];
  let idx = 0;
  for (const c of cues) {
    if (!c.text.trim()) continue;
    idx++;
    lines.push(String(idx));
    lines.push(`${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}`);
    lines.push(c.text.trim());
    lines.push('');
  }
  return lines.length ? lines.join('\n') : '';
}

/** 无词边界时的兜底字幕：按标点切句，按字数比例分配时长。 */
function fallbackSrt(text, durationMs) {
  const parts = text
    .split(/(?<=[。！？!?；;…])/u)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length || !durationMs) return '';
  const totalChars = parts.reduce((n, s) => n + [...s].length, 0) || 1;
  const cues = [];
  let cursor = 0;
  for (const p of parts) {
    const share = ([...p].length / totalChars) * durationMs;
    const start = cursor;
    const end = Math.min(durationMs, cursor + Math.max(300, share));
    cues.push({ start, end, text: p });
    cursor = end;
  }
  return cues
    .map((c, i) => `${i + 1}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${c.text}\n`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// ffmpeg：解析时长 / 转码
// ---------------------------------------------------------------------------

function resolveFfmpeg() {
  // 插件统一入口：环境变量 FFMPEG → PATH → <插件>/bin → ~/.dsh/bili-whale/bin → 剪映自带
  // 找不到时退回 PATH 里的 'ffmpeg'，让时长探测走「估算」兜底（不阻断合成）。
  try {
    return requireFfmpeg();
  } catch {
    return 'ffmpeg';
  }
}

function probeDurationMs(mp3Path) {
  const ffmpeg = resolveFfmpeg();
  const r = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-i', mp3Path], { encoding: 'utf8' });
  const text = `${r.stderr || ''}\n${r.stdout || ''}`;
  const m = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (m) {
    const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  }
  return null;
}

function estimateDurationMs(byteLength) {
  // 48 kbps CBR = 6000 bytes/s
  return Math.round((byteLength * 8 * 1000) / MP3_BITRATE_BPS);
}

/** 用 ffmpeg 把 mp3 转 48k 单声道 wav（可选辅助函数，管线里也能直接用 CLI）。 */
export function mp3ToWav(mp3Path, wavPath, { sampleRate = 48000, channels = 1 } = {}) {
  const ffmpeg = resolveFfmpeg();
  fs.mkdirSync(path.dirname(path.resolve(wavPath)), { recursive: true });
  const r = spawnSync(
    ffmpeg,
    ['-hide_banner', '-y', '-nostdin', '-i', mp3Path, '-ar', String(sampleRate), '-ac', String(channels), wavPath],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) {
    throw new Error(`ffmpeg 转 wav 失败（exit ${r.status}）：${(r.stderr || '').slice(-800)}`);
  }
  return wavPath;
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

// 注：原版还有一个 getVoiceList（fetch 音色列表）的辅助函数；插件里不需要，且插件有
// 「tools/ 下调用 fetch 必须走 traffic.mjs 的 guardedFetch」的守卫（B站请求节流），
// Edge TTS 不属于 B站流量，所以这里直接不提供联网的音色列表接口（音色用配置写死即可）。

function validateParam(name, value, pattern, example) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`参数 ${name} 格式非法：${JSON.stringify(value)}，应形如 ${example}`);
  }
}

/**
 * 合成一段语音。
 * @param {object} opts
 * @param {string} opts.text   要读的文本（中文标点正常）
 * @param {string} [opts.voice='zh-CN-XiaoyiNeural']
 * @param {string} [opts.rate='+0%']  例如 '+4%'
 * @param {string} [opts.pitch='+0Hz'] 例如 '+8Hz'
 * @param {string} [opts.volume='+0%']
 * @param {string} [opts.outMp3] 输出 mp3 路径（不传则返回 Buffer）
 * @param {string} [opts.outSrt] 输出 srt 路径（不传则返回 srt 文本）
 * @returns {Promise<{mp3: string|Buffer, srt: string|undefined, durationMs: number, wordCount: number, words: Array<{offsetMs:number,durationMs:number,text:string}>, voice: string}>}
 */
export async function synthesize(opts) {
  const {
    text,
    voice = DEFAULT_VOICE,
    rate = '+0%',
    pitch = '+0Hz',
    volume = '+0%',
    outMp3,
    outSrt,
  } = opts || {};

  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('text 不能为空');
  }
  if (typeof voice !== 'string' || !/^[A-Za-z]{2,3}-[A-Za-z0-9-]+Neural$/.test(voice)) {
    throw new Error(`voice 参数非法：${JSON.stringify(voice)}，应形如 zh-CN-XiaoyiNeural`);
  }
  validateParam('rate', rate, /^[+-]\d+%$/, '+4%');
  validateParam('pitch', pitch, /^[+-]\d+Hz$/, '+8Hz');
  validateParam('volume', volume, /^[+-]\d+%$/, '+0%');
  if (outMp3 && typeof outMp3 !== 'string') throw new Error('outMp3 必须是文件路径');
  if (outSrt && typeof outSrt !== 'string') throw new Error('outSrt 必须是文件路径');

  const clean = cleanText(text).trim();
  const chunks = splitText(clean);
  const audioParts = [];
  const allWords = [];
  let cumulativeAudioBytes = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    let result;
    try {
      result = await synthesizeChunk({ text: chunk, voice, rate, pitch, volume });
    } catch (err) {
      throw new Error(`第 ${i + 1}/${chunks.length} 段合成失败：${err.message}`);
    }
    if (i > 0) {
      // 多段拼接：用前面已收音频字节数（48kbps CBR）补偿时间轴
      const offsetMs = (cumulativeAudioBytes * 8 * 1000) / MP3_BITRATE_BPS;
      for (const w of result.words) w.offsetMs += offsetMs;
    }
    // 回填标点（基于该段原始文本，不做 XML 转义）
    const enriched = reattachPunctuation(result.words, chunk);
    audioParts.push(result.audio);
    allWords.push(...enriched);
    cumulativeAudioBytes += result.audio.length;
  }

  const audio = Buffer.concat(audioParts);
  if (!audio.length) throw new Error('合成结果为空音频');

  // 写文件
  let mp3Out;
  if (outMp3) {
    const abs = path.resolve(outMp3);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, audio);
    mp3Out = abs;
  } else {
    mp3Out = audio;
  }

  // 时长：优先 ffmpeg 实测
  let durationMs = null;
  if (outMp3) durationMs = probeDurationMs(path.resolve(outMp3));
  if (!durationMs) durationMs = estimateDurationMs(audio.length);

  // 字幕：有词边界就精确编排，没有就按字数兜底
  let srtText = wordsToSrt(allWords, durationMs);
  if (!srtText) srtText = fallbackSrt(clean, durationMs);

  let srtOut;
  if (outSrt) {
    const abs = path.resolve(outSrt);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, srtText, 'utf8'); // UTF-8 无 BOM，时间轴从 0 开始
    srtOut = abs;
  } else {
    srtOut = srtText || undefined;
  }

  return {
    mp3: mp3Out,
    srt: srtOut,
    durationMs,
    wordCount: allWords.length,
    words: allWords,
    voice,
  };
}
