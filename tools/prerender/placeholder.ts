// Image helpers without native dependencies: a transparent PNG of a given size (the logo placeholder until the owner
// supplies assets/oasis-logo.png, DEVIATIONS.md DV-LOGO) and a box-filter downscale through pngjs (favicons from the
// logo). Deterministic: the same input bytes always give the same output bytes.
import zlib from 'node:zlib'
import { PNG } from 'pngjs'

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (b: Buffer): number => {
  let c = 0xffffffff
  for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/** The placeholder PNG size for a missing image asset (DEVIATIONS.md DV-LOGO). */
export const PLACEHOLDER_SIZE = 1024

/** A fully transparent RGBA PNG. */
export function transparentPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const row = Buffer.alloc(1 + width * 4) // filter byte 0 + transparent pixels
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes.readUInt32BE(12) !== 0x49484452) return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/** Downscales a PNG to fit in size x size (aspect kept, box filter, centred on a transparent square canvas). */
export function pngIcon(bytes: Buffer, size: number): Buffer {
  const src = PNG.sync.read(bytes)
  const scale = Math.max(src.width, src.height) / size
  const w = Math.max(1, Math.round(src.width / scale))
  const h = Math.max(1, Math.round(src.height / scale))
  const out = new PNG({ width: size, height: size })
  const ox = Math.floor((size - w) / 2)
  const oy = Math.floor((size - h) / 2)
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y * scale)
    const sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * scale))
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x * scale)
      const sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * scale))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = sy0; sy < sy1 && sy < src.height; sy++) {
        for (let sx = sx0; sx < sx1 && sx < src.width; sx++) {
          const i = (sy * src.width + sx) * 4
          const al = src.data[i + 3]!
          r += src.data[i]! * al
          g += src.data[i + 1]! * al
          b += src.data[i + 2]! * al
          a += al
          n++
        }
      }
      const o = ((oy + y) * size + ox + x) * 4
      if (a > 0) {
        out.data[o] = Math.round(r / a)
        out.data[o + 1] = Math.round(g / a)
        out.data[o + 2] = Math.round(b / a)
        out.data[o + 3] = Math.round(a / n)
      }
    }
  }
  return PNG.sync.write(out, { deflateLevel: 9 })
}
