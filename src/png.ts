// A PNG made smaller, with Node's own zlib and nothing else: an Orca bot's uploaded picture is a
// square PNG of 512 to 2000 px and up to 2 MB, and the Inbox keeps an agent's picture only up to
// 512 KB. Reads 8-bit PNGs that are not interlaced (grey, RGB, palette, grey with alpha, RGBA), which
// is what Orca writes; anything else is not read, and the caller decides what to do without it.
import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const MAX_SIDE = 4096
/** Bytes per pixel for each 8-bit colour type. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

export function isPng(bytes: Uint8Array): boolean {
  return bytes.byteLength > 8 && SIGNATURE.every((value, index) => bytes[index] === value)
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff
  for (const part of parts) for (const byte of part) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

type Rgba = { width: number; height: number; pixels: Uint8Array }

/** The image as RGBA, or null when it is not a PNG this reads. Never throws. */
export function decodePng(bytes: Uint8Array): Rgba | null {
  try {
    return decode(bytes)
  } catch {
    return null
  }
}

function decode(bytes: Uint8Array): Rgba | null {
  if (!isPng(bytes)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 8
  let header: { width: number; height: number; type: number } | null = null
  let palette: Uint8Array | null = null
  let alpha: Uint8Array | null = null
  const data: Uint8Array[] = []
  while (at + 12 <= bytes.byteLength) {
    const length = view.getUint32(at)
    const kind = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    const body = bytes.subarray(at + 8, at + 8 + length)
    if (body.byteLength !== length) return null
    const start = at
    at += 12 + length
    if (kind === 'IHDR') {
      if (length !== 13) return null
      const width = view.getUint32(start + 8)
      const height = view.getUint32(start + 12)
      const [depth, type, compression, filter, interlace] = body.subarray(8, 13)
      if (depth !== 8 || compression !== 0 || filter !== 0 || interlace !== 0 || type === undefined || !(type in CHANNELS)) return null
      if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) return null
      header = { width, height, type }
    } else if (kind === 'PLTE') palette = body
    else if (kind === 'tRNS') alpha = body
    else if (kind === 'IDAT') data.push(body)
    else if (kind === 'IEND') break
  }
  if (!header || data.length === 0) return null
  const { width, height, type } = header
  if (type === 3 && !palette) return null
  const channels = CHANNELS[type]!
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(data), { maxOutputLength: (stride + 1) * height })
  if (raw.byteLength !== (stride + 1) * height) return null
  // Undo each row's filter in place, row by row.
  const rows = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = rows.subarray(y * stride, (y + 1) * stride)
    const up = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels]! : 0
      const b = up ? up[x]! : 0
      const c = up && x >= channels ? up[x - channels]! : 0
      let value = line[x]!
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) return null
      out[x] = value & 0xff
    }
  }
  if (type === 6) return { width, height, pixels: rows }
  const pixels = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const s = i * channels
    const o = i * 4
    if (type === 3) {
      const index = rows[s]!
      if (index * 3 + 2 >= palette!.byteLength) return null
      pixels[o] = palette![index * 3]!
      pixels[o + 1] = palette![index * 3 + 1]!
      pixels[o + 2] = palette![index * 3 + 2]!
      pixels[o + 3] = alpha && index < alpha.byteLength ? alpha[index]! : 255
    } else if (type === 2) {
      pixels[o] = rows[s]!
      pixels[o + 1] = rows[s + 1]!
      pixels[o + 2] = rows[s + 2]!
      pixels[o + 3] = 255
    } else {
      // Grey (0), or grey with alpha (4).
      pixels[o] = pixels[o + 1] = pixels[o + 2] = rows[s]!
      pixels[o + 3] = type === 4 ? rows[s + 1]! : 255
    }
  }
  return { width, height, pixels }
}

function chunk(kind: string, body: Uint8Array): Uint8Array {
  const head = new Uint8Array(8)
  const view = new DataView(head.buffer)
  view.setUint32(0, body.byteLength)
  head.set([...kind].map((char) => char.charCodeAt(0)), 4)
  const tail = new Uint8Array(4)
  new DataView(tail.buffer).setUint32(0, crc32([head.subarray(4), body]))
  return Buffer.concat([head, body, tail])
}

export function encodePng(image: Rgba): Uint8Array {
  const { width, height, pixels } = image
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header.set([8, 6, 0, 0, 0], 8)
  const raw = new Uint8Array((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1)
  return Buffer.concat([Uint8Array.from(SIGNATURE), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))])
}

/**
 * The picture cut to its centre square (as Orca's tile shows it, `object-cover`) and averaged down
 * to at most `side` px, as an RGBA PNG; null when it is not a PNG this reads.
 */
export function shrinkPng(bytes: Uint8Array, side: number): Uint8Array | null {
  const image = decodePng(bytes)
  if (!image) return null
  const square = Math.min(image.width, image.height)
  const left = Math.floor((image.width - square) / 2)
  const top = Math.floor((image.height - square) / 2)
  const size = Math.max(1, Math.min(side, square))
  const out = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    const y0 = top + Math.floor((y * square) / size)
    const y1 = top + Math.max(Math.floor(((y + 1) * square) / size), Math.floor((y * square) / size) + 1)
    for (let x = 0; x < size; x++) {
      const x0 = left + Math.floor((x * square) / size)
      const x1 = left + Math.max(Math.floor(((x + 1) * square) / size), Math.floor((x * square) / size) + 1)
      // Colours weighted by their alpha, so a transparent edge does not darken what it touches.
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * image.width + sx) * 4
          const alpha = image.pixels[i + 3]!
          r += image.pixels[i]! * alpha
          g += image.pixels[i + 1]! * alpha
          b += image.pixels[i + 2]! * alpha
          a += alpha
          n += 1
        }
      }
      const o = (y * size + x) * 4
      if (a > 0) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
        out[o + 3] = Math.round(a / n)
      }
    }
  }
  return encodePng({ width: size, height: size, pixels: out })
}
