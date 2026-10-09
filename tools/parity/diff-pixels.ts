import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

export interface PixelRect {
  x: number
  y: number
  w: number
  h: number
}
export interface PixelMask {
  id: string
  rect: PixelRect
}
export interface PixelBox extends PixelRect {
  count: number
}
export interface PixelResult {
  width: number
  height: number
  /** pixels that differ after masks were applied (pixelmatch, threshold 0, antialiasing NOT forgiven) */
  mismatched: number
  /** pixels that differ before masks were applied */
  unmaskedMismatched: number
  /** per mask id: differing pixels it hides */
  maskUsage: Record<string, number>
  sizeMismatch?: string
  diffPng?: Buffer
  boxes: PixelBox[]
}

const MASK_RGBA = [255, 0, 255, 255] as const

function clampRect(r: PixelRect, w: number, h: number): PixelRect {
  const x0 = Math.max(0, Math.floor(r.x))
  const y0 = Math.max(0, Math.floor(r.y))
  const x1 = Math.min(w, Math.ceil(r.x + r.w))
  const y1 = Math.min(h, Math.ceil(r.y + r.h))
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
}

function fill(img: PNG, r: PixelRect): void {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * img.width + x) * 4
      img.data[i] = MASK_RGBA[0]
      img.data[i + 1] = MASK_RGBA[1]
      img.data[i + 2] = MASK_RGBA[2]
      img.data[i + 3] = MASK_RGBA[3]
    }
  }
}

/** Merges 32px tiles that contain mismatches into connected bounding boxes (for readable reports). */
function clusterBoxes(neq: Uint8Array, width: number, height: number, maxBoxes = 24): PixelBox[] {
  const T = 32
  const tw = Math.ceil(width / T)
  const th = Math.ceil(height / T)
  const counts = new Uint32Array(tw * th)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++)
      if (neq[y * width + x]) counts[Math.floor(y / T) * tw + Math.floor(x / T)]!++
  }
  const seen = new Uint8Array(tw * th)
  const boxes: PixelBox[] = []
  for (let start = 0; start < counts.length; start++) {
    if (!counts[start] || seen[start]) continue
    let minX = Infinity
    let minY = Infinity
    let maxX = -1
    let maxY = -1
    let count = 0
    const queue = [start]
    seen[start] = 1
    while (queue.length) {
      const t = queue.pop()!
      const tx = t % tw
      const ty = Math.floor(t / tw)
      count += counts[t]!
      minX = Math.min(minX, tx)
      minY = Math.min(minY, ty)
      maxX = Math.max(maxX, tx)
      maxY = Math.max(maxY, ty)
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = tx + dx
        const ny = ty + dy
        if (nx < 0 || ny < 0 || nx >= tw || ny >= th) continue
        const n = ny * tw + nx
        if (counts[n] && !seen[n]) {
          seen[n] = 1
          queue.push(n)
        }
      }
    }
    boxes.push({
      x: minX * T,
      y: minY * T,
      w: Math.min(width, (maxX + 1) * T) - minX * T,
      h: Math.min(height, (maxY + 1) * T) - minY * T,
      count,
    })
  }
  return boxes.sort((a, b) => b.count - a.count).slice(0, maxBoxes)
}

/**
 * pixelmatch at threshold 0 (any colour difference counts) with antialiasing NOT ignored. Masks blank the same rectangle in
 * both images first; the result reports how many mismatches each mask hid so stale masks can be detected.
 */
export function diffPixels(origPng: Buffer, portPng: Buffer, masks: readonly PixelMask[] = []): PixelResult {
  const a = PNG.sync.read(origPng)
  const b = PNG.sync.read(portPng)
  if (a.width !== b.width || a.height !== b.height) {
    return {
      width: Math.max(a.width, b.width),
      height: Math.max(a.height, b.height),
      mismatched: Math.max(a.width * a.height, b.width * b.height),
      unmaskedMismatched: Math.max(a.width * a.height, b.width * b.height),
      maskUsage: {},
      sizeMismatch: `orig ${a.width}x${a.height} vs port ${b.width}x${b.height}`,
      boxes: [],
    }
  }
  const { width, height } = a
  const total = width * height
  const neq = new Uint8Array(total)
  let unmasked = 0
  for (let p = 0; p < total; p++) {
    const i = p * 4
    if (
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2] ||
      a.data[i + 3] !== b.data[i + 3]
    ) {
      neq[p] = 1
      unmasked++
    }
  }
  const maskUsage: Record<string, number> = {}
  const rects = masks.map((m) => ({ id: m.id, rect: clampRect(m.rect, width, height) }))
  for (const { id, rect } of rects) {
    let n = 0
    for (let y = rect.y; y < rect.y + rect.h; y++)
      for (let x = rect.x; x < rect.x + rect.w; x++) n += neq[y * width + x]!
    maskUsage[id] = n
  }
  for (const { rect } of rects) {
    fill(a, rect)
    fill(b, rect)
  }
  const diff = new PNG({ width, height })
  const mismatched = pixelmatch(a.data, b.data, diff.data, width, height, { threshold: 0, includeAA: true })
  const maskedNeq = rects.length ? new Uint8Array(neq) : neq
  for (const { rect } of rects)
    for (let y = rect.y; y < rect.y + rect.h; y++)
      maskedNeq.fill(0, y * width + rect.x, y * width + rect.x + rect.w)
  return {
    width,
    height,
    mismatched,
    unmaskedMismatched: unmasked,
    maskUsage,
    diffPng: PNG.sync.write(diff),
    boxes: mismatched ? clusterBoxes(maskedNeq, width, height) : [],
  }
}
