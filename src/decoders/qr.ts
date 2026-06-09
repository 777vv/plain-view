// Minimal but standards-compliant QR code generator.
// - Byte mode only (handles any UTF-8 text)
// - Error correction level M (~15%)
// - Versions 1..10 (max ~200 chars)
// - Reed-Solomon error correction
// - Mask 7 (fixed)
//
// Returns a 2D boolean matrix (true = dark module). Callers render to canvas.
//
// Reference: ISO/IEC 18004:2015 (QR Code 2005)

export interface QrResult {
  size: number;        // module count per side
  matrix: boolean[][]; // [row][col], true = dark
  version: number;
}

// ── Error correction parameters (level M, ~15%) ────────────────
// [totalCodewords, ecCodewordsPerBlock, group1Blocks, group1DataPerBlock, group2Blocks, group2DataPerBlock]
const EC_TABLE: number[][] = [
  [0, 0, 0, 0, 0, 0],                       // version 0 (unused)
  [26,  10,  1,  16, 0,  0],                // v1
  [44,  16,  1,  28, 0,  0],                // v2
  [70,  26,  1,  44, 0,  0],                // v3
  [100, 18,  2,  32, 0,  0],                // v4
  [134, 24,  2,  43, 0,  0],                // v5
  [172, 16,  4,  27, 0,  0],                // v6
  [196, 18,  4,  31, 0,  0],                // v7
  [242, 22,  2,  38, 2,  39],               // v8
  [292, 22,  3,  36, 2,  37],               // v9
  [346, 26,  4,  43, 1,  44],               // v10
];

// ── Public API ────────────────────────────────────────────────
export function generateQr(text: string): QrResult {
  const bytes = utf8Encode(text);
  const version = pickVersion(bytes.length);
  if (version < 0) throw new Error('Input too long for QR M v1-10 (max ~200 chars)');

  const dataCw = buildDataCodewords(bytes, version);
  const ecCw   = buildEcCodewords(dataCw, version);
  const stream = interleave(dataCw, ecCw, version);

  return draw(stream, version);
}

// ── UTF-8 encode ──────────────────────────────────────────────
function utf8Encode(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

// ── Version selection ─────────────────────────────────────────
function pickVersion(byteCount: number): number {
  for (let v = 1; v <= 10; v++) {
    const cap = dataCapacityBytes(v);
    if (byteCount <= cap) return v;
  }
  return -1;
}

function dataCapacityBytes(version: number): number {
  const t = EC_TABLE[version];
  const dataBits = (t[2] * t[3] + t[4] * t[5]) * 8;
  // mode (4) + length (8 for v1-9 in byte mode; 16 for v10+)
  const lenBits  = version >= 10 ? 16 : 8;
  return Math.floor((dataBits - 4 - lenBits) / 8);
}

// ── Build data codewords (mode + length + payload + terminator + padding) ──
function buildDataCodewords(bytes: number[], version: number): number[] {
  const t = EC_TABLE[version];
  const totalDataBits = (t[2] * t[3] + t[4] * t[5]) * 8;

  const bits: number[] = [];
  // Mode indicator: 0100 (byte mode)
  appendBits(bits, 0b0100, 4);
  // Character count indicator
  appendBits(bits, bytes.length, version >= 10 ? 16 : 8);
  // Payload
  for (const b of bytes) appendBits(bits, b, 8);
  // Terminator (up to 4 bits)
  appendBits(bits, 0, Math.min(4, totalDataBits - bits.length));
  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);
  // Pad with alternating 0xEC / 0x11 until the data area is full
  let padIdx = 0;
  while (bits.length < totalDataBits) {
    appendBits(bits, padIdx++ % 2 === 0 ? 0xEC : 0x11, 8);
  }
  return bitsToBytes(bits.slice(0, totalDataBits));
}

function appendBits(bits: number[], value: number, n: number): void {
  for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1);
}

function bitsToBytes(bits: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] || 0);
    out.push(b);
  }
  return out;
}

// ── Reed-Solomon error correction ─────────────────────────────
// GF(256) with primitive polynomial 0x11D
const GF_EXP: number[] = new Array(512);
const GF_LOG: number[] = new Array(256);
(function initGf(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x = x << 1;
    if (x & 0x100) x ^= 0x11D;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGenPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j]     ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data: number[], ecCount: number): number[] {
  const gen = rsGenPoly(ecCount);
  const buf = data.concat(new Array(ecCount).fill(0));
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      buf[i + j] ^= gfMul(gen[j], factor);
    }
  }
  return buf.slice(data.length);
}

function buildEcCodewords(dataCw: number[], version: number): number[][] {
  const t = EC_TABLE[version];
  const ecPerBlock = t[1];
  const blocks: number[][] = [];
  let idx = 0;
  for (let i = 0; i < t[2]; i++) {
    const block = dataCw.slice(idx, idx + t[3]);
    idx += t[3];
    blocks.push(rsEncode(block, ecPerBlock));
  }
  for (let i = 0; i < t[4]; i++) {
    const block = dataCw.slice(idx, idx + t[5]);
    idx += t[5];
    blocks.push(rsEncode(block, ecPerBlock));
  }
  return blocks;
}

function splitDataBlocks(dataCw: number[], version: number): number[][] {
  const t = EC_TABLE[version];
  const blocks: number[][] = [];
  let idx = 0;
  for (let i = 0; i < t[2]; i++) { blocks.push(dataCw.slice(idx, idx + t[3])); idx += t[3]; }
  for (let i = 0; i < t[4]; i++) { blocks.push(dataCw.slice(idx, idx + t[5])); idx += t[5]; }
  return blocks;
}

function interleave(dataCw: number[], ecBlocks: number[][], version: number): number[] {
  const dataBlocks = splitDataBlocks(dataCw, version);
  const out: number[] = [];
  // Data: column-major across blocks
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const blk of dataBlocks) if (i < blk.length) out.push(blk[i]);
  }
  // EC: column-major across blocks
  const maxEc = ecBlocks[0].length;
  for (let i = 0; i < maxEc; i++) {
    for (const blk of ecBlocks) out.push(blk[i]);
  }
  return out;
}

// ── Matrix drawing ────────────────────────────────────────────
function draw(stream: number[], version: number): QrResult {
  const size = version * 4 + 17;
  // -1 = unset, 0/1 = function pattern, 2 reserved (format/version), data after
  const mat: number[][] = Array.from({ length: size }, () => new Array(size).fill(-1));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));

  drawFinders(mat, reserved, size);
  drawSeparators(mat, reserved, size);
  drawTiming(mat, reserved, size);
  drawAlignment(mat, reserved, version);
  drawDarkModule(mat, reserved, version);
  reserveFormatArea(reserved, size);
  if (version >= 7) reserveVersionArea(reserved, size);

  drawData(mat, reserved, size, stream);

  const MASK = 7;
  const trial = mat.map((row) => row.slice());
  applyMask(trial, reserved, size, MASK);
  drawFormatInfo(trial, size, MASK);
  trial[4 * version + 9][8] = 1;

  const matrix = trial.map((row) => row.map((v) => v === 1));
  return { size, matrix, version };
}

function drawFinders(mat: number[][], res: boolean[][], size: number): void {
  for (const [r, c] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let dr = 0; dr < 7; dr++) {
      for (let dc = 0; dc < 7; dc++) {
        const inner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        const ring  = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        mat[r + dr][c + dc] = (ring || inner) ? 1 : 0;
        res[r + dr][c + dc] = true;
      }
    }
  }
}

function drawSeparators(mat: number[][], res: boolean[][], size: number): void {
  const set = (r: number, c: number): void => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    mat[r][c] = 0;
    res[r][c] = true;
  };
  for (let i = 0; i < 8; i++) {
    set(7, i); set(i, 7);
    set(7, size - 1 - i); set(i, size - 8);
    set(size - 8, i); set(size - 1 - i, 7);
  }
}

function drawTiming(mat: number[][], res: boolean[][], size: number): void {
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    if (!res[6][i]) { mat[6][i] = v; res[6][i] = true; }
    if (!res[i][6]) { mat[i][6] = v; res[i][6] = true; }
  }
}

function alignmentPositions(version: number): number[] {
  // Subset used for v1-10; v1 has none.
  const table: number[][] = [
    [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  ];
  return table[version] ?? [];
}

function drawAlignment(mat: number[][], res: boolean[][], version: number): void {
  const positions = alignmentPositions(version);
  for (const r of positions) {
    for (const c of positions) {
      if (res[r][c]) continue; // overlaps finder
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          mat[r + dr][c + dc] = (ring === 0 || ring === 2) ? 1 : 0;
          res[r + dr][c + dc] = true;
        }
      }
    }
  }
}

function drawDarkModule(mat: number[][], res: boolean[][], version: number): void {
  const r = 4 * version + 9;
  mat[r][8] = 1;
  res[r][8] = true;
}

function reserveFormatArea(res: boolean[][], size: number): void {
  for (let i = 0; i < 9; i++)        res[8][i] = true;
  for (let i = 0; i < 8; i++)        res[i][8] = true;
  for (let i = size - 8; i < size; i++) res[8][i] = true;
  for (let i = size - 7; i < size; i++) res[i][8] = true;
}

function reserveVersionArea(res: boolean[][], size: number): void {
  for (let r = 0; r < 6; r++) for (let c = size - 11; c < size - 8; c++) res[r][c] = true;
  for (let c = 0; c < 6; c++) for (let r = size - 11; r < size - 8; r++) res[r][c] = true;
}

function drawData(mat: number[][], res: boolean[][], size: number, stream: number[]): void {
  let bitIdx = 0;
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip timing column
    for (let i = 0; i < size; i++) {
      const r = up ? size - 1 - i : i;
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (res[r][c]) continue;
        const byte = stream[bitIdx >> 3];
        const bit  = byte === undefined ? 0 : (byte >> (7 - (bitIdx & 7))) & 1;
        mat[r][c] = bit;
        bitIdx++;
      }
    }
    up = !up;
  }
}

function maskBit(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

function applyMask(mat: number[][], res: boolean[][], size: number, mask: number): void {
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (res[r][c]) continue;
      if (maskBit(mask, r, c)) mat[r][c] ^= 1;
    }
  }
}

// ── Format info (15 bits, BCH error correction) ───────────────
function drawFormatInfo(mat: number[][], size: number, mask: number): void {
  const ecLevel = 0b00; // M
  let data = (ecLevel << 3) | mask;
  let bch = data << 10;
  for (let i = 4; i >= 0; i--) {
    if ((bch >> (i + 10)) & 1) bch ^= 0x537 << i;
  }
  const bits = ((data << 10) | bch) ^ 0x5412;

  for (let i = 0; i < 6; i++) mat[8][i]               = (bits >> i) & 1;
  mat[8][7] = (bits >> 6) & 1;
  mat[8][8] = (bits >> 7) & 1;
  mat[7][8] = (bits >> 8) & 1;
  for (let i = 9; i < 15; i++) mat[14 - i][8]         = (bits >> i) & 1;
  for (let i = 0; i < 8; i++) mat[size - 1 - i][8]    = (bits >> i) & 1;
  for (let i = 8; i < 15; i++) mat[8][size - 15 + i]  = (bits >> i) & 1;
}

