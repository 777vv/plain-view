// QR code generator — ported from Kazuhiko Arase's qrcode-generator (MIT).
// This is a battle-tested implementation; only the byte-mode + level-H path
// is retained, plus the auto type-number (1..40) selection. UTF-8 encoding is
// used so Chinese / any Unicode text scans correctly.
//
// Reference: ISO/IEC 18004:2015
// Source:    https://github.com/kazuhikoarase/qrcode-generator

export interface QrResult {
  size: number;        // module count per side
  matrix: boolean[][]; // [row][col], true = dark
  version: number;     // 1..40
}

const EC_LEVEL_H = 2;            // format-info identifier for level H (~30%)
const MODE_8BIT = 1 << 2;         // byte mode indicator

// ── GF(256) exponential / logarithm tables (QRMath) ────────────
const EXP_TABLE = new Array(256);
const LOG_TABLE = new Array(256);
for (let i = 0; i < 8; i++) EXP_TABLE[i] = 1 << i;
for (let i = 8; i < 256; i++)
  EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
for (let i = 0; i < 255; i++) LOG_TABLE[EXP_TABLE[i]] = i;
function glog(n: number): number { if (n < 1) throw new Error('glog(' + n + ')'); return LOG_TABLE[n]; }
function gexp(n: number): number {
  while (n < 0) n += 255;
  while (n >= 256) n -= 255;
  return EXP_TABLE[n];
}

// ── Reed-Solomon polynomial helpers ────────────────────────────
class Poly {
  num: number[];
  constructor(num: number[], shift = 0) {
    let offset = 0;
    while (offset < num.length && num[offset] === 0) offset++;
    this.num = new Array(num.length - offset + shift).fill(0);
    for (let i = 0; i < num.length - offset; i++) this.num[i] = num[i + offset];
  }
  get(index: number): number { return this.num[index]; }
  get length(): number { return this.num.length; }
  multiply(e: Poly): Poly {
    const n = new Array(this.length + e.length - 1).fill(0);
    for (let i = 0; i < this.length; i++)
      for (let j = 0; j < e.length; j++)
        n[i + j] ^= gexp(glog(this.get(i)) + glog(e.get(j)));
    return new Poly(n, 0);
  }
  mod(e: Poly): Poly {
    if (this.length - e.length < 0) return this;
    const ratio = glog(this.get(0)) - glog(e.get(0));
    const n = this.num.slice();
    for (let i = 0; i < e.length; i++) n[i] ^= gexp(glog(e.get(i)) + ratio);
    return new Poly(n, 0).mod(e);
  }
}
function errorCorrectPolynomial(ecLen: number): Poly {
  let a = new Poly([1], 0);
  for (let i = 0; i < ecLen; i++) a = a.multiply(new Poly([1, gexp(i)], 0));
  return a;
}

// ── RS block table (ISO 18004 Table 9), [count, total, data, ...] ──
// Level H entries (4th of each version group).
const RS_BLOCK_H: number[][] = [
  /*  1 */ [1, 26, 9],
  /*  2 */ [1, 44, 16],
  /*  3 */ [2, 35, 13],
  /*  4 */ [4, 25, 9],
  /*  5 */ [2, 33, 11, 2, 34, 12],
  /*  6 */ [4, 43, 15],
  /*  7 */ [4, 39, 13, 1, 40, 14],
  /*  8 */ [4, 40, 14, 2, 41, 15],
  /*  9 */ [4, 36, 12, 4, 37, 13],
  /* 10 */ [6, 43, 15, 2, 44, 16],
  /* 11 */ [3, 36, 12, 8, 37, 13],
  /* 12 */ [7, 42, 14, 4, 43, 15],
  /* 13 */ [12, 33, 11, 4, 34, 12],
  /* 14 */ [11, 36, 12, 5, 37, 13],
  /* 15 */ [11, 36, 12, 7, 37, 13],
  /* 16 */ [3, 45, 15, 13, 46, 16],
  /* 17 */ [2, 42, 14, 17, 43, 15],
  /* 18 */ [2, 42, 14, 19, 43, 15],
  /* 19 */ [9, 39, 13, 16, 40, 14],
  /* 20 */ [15, 43, 15, 10, 44, 16],
  /* 21 */ [19, 46, 16, 6, 47, 17],
  /* 22 */ [34, 37, 13],
  /* 23 */ [16, 45, 15, 14, 46, 16],
  /* 24 */ [30, 42, 14, 2, 43, 15],
  /* 25 */ [22, 41, 14, 13, 42, 15],
  /* 26 */ [33, 39, 13, 4, 40, 14],
  /* 27 */ [12, 45, 15, 28, 46, 16],
  /* 28 */ [11, 45, 15, 31, 46, 16],
  /* 29 */ [19, 45, 15, 26, 46, 16],
  /* 30 */ [23, 44, 14, 28, 45, 15],
  /* 31 */ [23, 43, 13, 41, 44, 14],
  /* 32 */ [19, 44, 14, 46, 45, 15],
  /* 33 */ [15, 44, 14, 54, 45, 15],
  /* 34 */ [43, 43, 13, 23, 44, 14],
  /* 35 */ [22, 43, 13, 48, 44, 14],
  /* 36 */ [13, 43, 13, 60, 44, 14],
  /* 37 */ [6, 44, 14, 68, 45, 15],
  /* 38 */ [10, 43, 13, 78, 44, 14],
  /* 39 */ [6, 44, 14, 78, 45, 15],
  /* 40 */ [8, 44, 14, 81, 45, 15],
];
function getRsBlocks(version: number): { total: number; data: number }[] {
  const rs = RS_BLOCK_H[version - 1];
  const list: { total: number; data: number }[] = [];
  for (let i = 0; i < rs.length / 3; i++) {
    const count = rs[i * 3], total = rs[i * 3 + 1], data = rs[i * 3 + 2];
    for (let j = 0; j < count; j++) list.push({ total, data });
  }
  return list;
}

// ── Pattern-position table for alignment patterns (1..40) ──────
const PATTERN_POS: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54],
  [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
  [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86],
  [6, 34, 62, 90], [6, 28, 50, 72, 94], [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102], [6, 28, 54, 80, 106], [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114], [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170],
];

// ── BCH helpers for format / version info ─────────────────────
const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);
function bchDigit(data: number): number { let d = 0; while (data !== 0) { d++; data >>>= 1; } return d; }
function bchTypeInfo(data: number): number {
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= (G15 << (bchDigit(d) - bchDigit(G15)));
  return ((data << 10) | d) ^ G15_MASK;
}
function bchTypeNumber(data: number): number {
  let d = data << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= (G18 << (bchDigit(d) - bchDigit(G18)));
  return (data << 12) | d;
}

// ── Mask patterns (8) ─────────────────────────────────────────
function maskFunc(mask: number): (r: number, c: number) => boolean {
  switch (mask) {
    case 0: return (i, j) => (i + j) % 2 === 0;
    case 1: return (i) => i % 2 === 0;
    case 2: return (i, j) => j % 3 === 0;
    case 3: return (i, j) => (i + j) % 3 === 0;
    case 4: return (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return (i, j) => (i * j) % 2 + (i * j) % 3 === 0;
    case 6: return (i, j) => ((i * j) % 2 + (i * j) % 3) % 2 === 0;
    case 7: return (i, j) => ((i * j) % 3 + (i + j) % 2) % 2 === 0;
    default: throw new Error('bad mask:' + mask);
  }
}

// length-in-bits for the mode indicator at a given version range
function lengthBits(version: number): number {
  if (version < 10) return 8;
  if (version < 27) return 16;
  return 16;
}

// ── Bit buffer (MSB-first) ────────────────────────────────────
class BitBuffer {
  buf: number[] = [];
  len = 0;
  put(num: number, length: number): void {
    for (let i = 0; i < length; i++) this.putBit(((num >>> (length - i - 1)) & 1) === 1);
  }
  putBit(bit: boolean): void {
    const i = Math.floor(this.len / 8);
    if (this.buf.length <= i) this.buf.push(0);
    if (bit) this.buf[i] |= (0x80 >>> (this.len % 8));
    this.len++;
  }
}

// ── UTF-8 encoder (replaces the library's default latin-1 path) ──
function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c <= 0xdbff) {
      // surrogate pair → supplementary plane
      const c2 = s.charCodeAt(++i);
      c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

// ── Build the final interleaved data+EC byte stream ───────────
function createData(version: number, data: Uint8Array): number[] {
  const rsBlocks = getRsBlocks(version);

  const buffer = new BitBuffer();
  buffer.put(MODE_8BIT, 4);
  buffer.put(data.length, lengthBits(version));
  for (const b of data) buffer.put(b, 8);

  let totalDataCount = 0;
  for (const b of rsBlocks) totalDataCount += b.data;

  if (buffer.len > totalDataCount * 8)
    throw new Error('code length overflow (' + buffer.len + '>' + totalDataCount * 8 + ')');

  // terminator
  if (buffer.len + 4 <= totalDataCount * 8) buffer.put(0, 4);
  // pad to byte boundary
  while (buffer.len % 8 !== 0) buffer.putBit(false);
  // pad bytes 0xEC / 0x11
  const PAD0 = 0xec, PAD1 = 0x11;
  while (buffer.len < totalDataCount * 8) {
    buffer.put(PAD0, 8);
    if (buffer.len >= totalDataCount * 8) break;
    buffer.put(PAD1, 8);
  }

  // interleave data + EC across all blocks
  const offset = 0;
  let maxDc = 0, maxEc = 0;
  const dcdata: number[][] = [];
  const ecdata: number[][] = [];
  let off = offset;
  for (let r = 0; r < rsBlocks.length; r++) {
    const dcCount = rsBlocks[r].data;
    const ecCount = rsBlocks[r].total - dcCount;
    maxDc = Math.max(maxDc, dcCount);
    maxEc = Math.max(maxEc, ecCount);

    dcdata[r] = new Array(dcCount);
    for (let i = 0; i < dcCount; i++) dcdata[r][i] = 0xff & buffer.buf[i + off];
    off += dcCount;

    const rsPoly = errorCorrectPolynomial(ecCount);
    const rawPoly = new Poly(dcdata[r], rsPoly.length - 1);
    const modPoly = rawPoly.mod(rsPoly);
    ecdata[r] = new Array(rsPoly.length - 1);
    for (let i = 0; i < ecdata[r].length; i++) {
      const modIndex = i + modPoly.length - ecdata[r].length;
      ecdata[r][i] = modIndex >= 0 ? modPoly.get(modIndex) : 0;
    }
  }

  let totalCodeCount = 0;
  for (const b of rsBlocks) totalCodeCount += b.total;
  const result: number[] = new Array(totalCodeCount);
  let index = 0;
  for (let i = 0; i < maxDc; i++)
    for (let r = 0; r < rsBlocks.length; r++)
      if (i < dcdata[r].length) result[index++] = dcdata[r][i];
  for (let i = 0; i < maxEc; i++)
    for (let r = 0; r < rsBlocks.length; r++)
      if (i < ecdata[r].length) result[index++] = ecdata[r][i];
  return result;
}

// ── QR matrix builder ─────────────────────────────────────────
class QRMatrix {
  modules: (boolean | null)[][];
  size: number;
  test: boolean;
  constructor(version: number, test: boolean) {
    this.size = version * 4 + 17;
    this.test = test;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean | null>(this.size).fill(null));
  }
  isDark(r: number, c: number): boolean {
    return this.modules[r][c] === true;
  }

  setupPositionProbe(row: number, col: number): void {
    for (let r = -1; r <= 7; r++) {
      if (row + r <= -1 || this.size <= row + r) continue;
      for (let c = -1; c <= 7; c++) {
        if (col + c <= -1 || this.size <= col + c) continue;
        if ((r >= 0 && r <= 6 && (c === 0 || c === 6))
          || (c >= 0 && c <= 6 && (r === 0 || r === 6))
          || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) {
          this.modules[row + r][col + c] = true;
        } else {
          this.modules[row + r][col + c] = false;
        }
      }
    }
  }

  setupTimingPattern(): void {
    for (let r = 8; r < this.size - 8; r++) if (this.modules[r][6] === null) this.modules[r][6] = r % 2 === 0;
    for (let c = 8; c < this.size - 8; c++) if (this.modules[6][c] === null) this.modules[6][c] = c % 2 === 0;
  }

  setupPositionAdjust(version: number): void {
    const pos = PATTERN_POS[version - 1];
    for (let i = 0; i < pos.length; i++)
      for (let j = 0; j < pos.length; j++) {
        const row = pos[i], col = pos[j];
        if (this.modules[row][col] !== null) continue;
        for (let r = -2; r <= 2; r++)
          for (let c = -2; c <= 2; c++)
            this.modules[row + r][col + c] = (r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0));
      }
  }

  setupTypeInfo(maskPattern: number): void {
    const data = (EC_LEVEL_H << 3) | maskPattern;
    const bits = bchTypeInfo(data);
    for (let i = 0; i < 15; i++) {
      const mod = !this.test && ((bits >> i) & 1) === 1;
      if (i < 6) this.modules[i][8] = mod;
      else if (i < 8) this.modules[i + 1][8] = mod;
      else this.modules[this.size - 15 + i][8] = mod;
    }
    for (let i = 0; i < 15; i++) {
      const mod = !this.test && ((bits >> i) & 1) === 1;
      if (i < 8) this.modules[8][this.size - i - 1] = mod;
      else if (i < 9) this.modules[8][15 - i - 1 + 1] = mod;
      else this.modules[8][15 - i - 1] = mod;
    }
    this.modules[this.size - 8][8] = !this.test;
  }

  setupTypeNumber(version: number): void {
    const bits = bchTypeNumber(version);
    for (let i = 0; i < 18; i++) {
      const mod = !this.test && ((bits >> i) & 1) === 1;
      this.modules[Math.floor(i / 3)][i % 3 + this.size - 8 - 3] = mod;
    }
    for (let i = 0; i < 18; i++) {
      const mod = !this.test && ((bits >> i) & 1) === 1;
      this.modules[i % 3 + this.size - 8 - 3][Math.floor(i / 3)] = mod;
    }
  }

  mapData(data: number[], maskPattern: number): void {
    let inc = -1, row = this.size - 1, bitIndex = 7, byteIndex = 0;
    const mf = maskFunc(maskPattern);
    for (let col = this.size - 1; col > 0; col -= 2) {
      if (col === 6) col -= 1;
      while (true) {
        for (let c = 0; c < 2; c++) {
          if (this.modules[row][col - c] === null) {
            let dark = false;
            if (byteIndex < data.length) dark = ((data[byteIndex] >>> bitIndex) & 1) === 1;
            if (mf(row, col - c)) dark = !dark;
            this.modules[row][col - c] = dark;
            bitIndex--;
            if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
          }
        }
        row += inc;
        if (row < 0 || this.size <= row) { row -= inc; inc = -inc; break; }
      }
    }
  }
}

// ISO 18004 §8.8.2 mask penalty (lower is better)
function lostPoint(m: QRMatrix): number {
  const n = m.size;
  let p = 0;
  // N1 — 3x3 neighbourhood similarity (finder-protection heuristic)
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      let same = 0;
      const dark = m.isDark(r, c);
      for (let dr = -1; dr <= 1; dr++) {
        if (r + dr < 0 || n <= r + dr) continue;
        for (let dc = -1; dc <= 1; dc++) {
          if (c + dc < 0 || n <= c + dc) continue;
          if (dr === 0 && dc === 0) continue;
          if (dark === m.isDark(r + dr, c + dc)) same++;
        }
      }
      if (same > 5) p += 3 + same - 5;
    }
  // N2 — 2x2 same-colour blocks
  for (let r = 0; r < n - 1; r++)
    for (let c = 0; c < n - 1; c++) {
      let cnt = 0;
      if (m.isDark(r, c)) cnt++;
      if (m.isDark(r + 1, c)) cnt++;
      if (m.isDark(r, c + 1)) cnt++;
      if (m.isDark(r + 1, c + 1)) cnt++;
      if (cnt === 0 || cnt === 4) p += 3;
    }
  // N3 — 1:1:3:1:1 finder-like run in rows and columns
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n - 6; c++) {
      if (m.isDark(r, c) && !m.isDark(r, c + 1) && m.isDark(r, c + 2)
        && m.isDark(r, c + 3) && m.isDark(r, c + 4) && !m.isDark(r, c + 5) && m.isDark(r, c + 6)) p += 40;
    }
  for (let c = 0; c < n; c++)
    for (let r = 0; r < n - 6; r++) {
      if (m.isDark(r, c) && !m.isDark(r + 1, c) && m.isDark(r + 2, c)
        && m.isDark(r + 3, c) && m.isDark(r + 4, c) && !m.isDark(r + 5, c) && m.isDark(r + 6, c)) p += 40;
    }
  // N4 — overall dark ratio
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m.isDark(r, c)) dark++;
  const ratio = Math.abs(100 * dark / n / n - 50) / 5;
  p += ratio * 10;
  return p;
}

// Pick the smallest version (1..40) whose H-level data capacity fits.
function pickVersion(bytes: number[]): number {
  for (let v = 1; v <= 40; v++) {
    let totalData = 0;
    for (const b of getRsBlocks(v)) totalData += b.data;
    // 4 (mode) + lengthBits + 8*bytes must fit
    if (4 + lengthBits(v) + 8 * bytes.length <= totalData * 8) return v;
  }
  throw new Error('Input too long for QR H v1-40');
}

// Build one full matrix (test or real) for a version + mask.
function makeImpl(version: number, test: boolean, maskPattern: number, data: number[]): QRMatrix {
  const m = new QRMatrix(version, test);
  m.setupPositionProbe(0, 0);
  m.setupPositionProbe(m.size - 7, 0);
  m.setupPositionProbe(0, m.size - 7);
  m.setupPositionAdjust(version);
  m.setupTimingPattern();
  m.setupTypeInfo(maskPattern);
  if (version >= 7) m.setupTypeNumber(version);
  m.mapData(data, maskPattern);
  return m;
}

/**
 * Generate a QR code matrix for the given UTF-8 text at level H (~30% recovery).
 * Throws if the text cannot fit even at version 40.
 */
export function generateQr(text: string): QrResult {
  const bytes = utf8Bytes(text);
  const version = pickVersion(bytes);
  const data = createData(version, new Uint8Array(bytes));

  // choose the mask with the lowest penalty score
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mk = 0; mk < 8; mk++) {
    const tm = makeImpl(version, true, mk, data);
    const score = lostPoint(tm);
    if (score < bestScore) { bestScore = score; bestMask = mk; }
  }

  const m = makeImpl(version, false, bestMask, data);
  const matrix = m.modules.map((row) => row.map((v) => v === true));
  return { size: m.size, matrix, version };
}
