import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'
import { diffPixels } from './diff-pixels'

function image(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h })
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y)
      const i = (y * w + x) * 4
      png.data[i] = r
      png.data[i + 1] = g
      png.data[i + 2] = b
      png.data[i + 3] = 255
    }
  }
  return PNG.sync.write(png)
}

const white = () => [255, 255, 255] as [number, number, number]

describe('diffPixels', () => {
  it('reports zero for identical images and still returns a diff image', () => {
    const a = image(40, 30, white)
    const r = diffPixels(a, a)
    expect(r.mismatched).toBe(0)
    expect(r.boxes).toEqual([])
    expect(r.diffPng).toBeDefined()
  })

  it('counts a single off-by-one colour value (threshold 0)', () => {
    const a = image(40, 30, white)
    const b = image(40, 30, (x, y) => (x === 5 && y === 7 ? [255, 255, 254] : white()))
    const r = diffPixels(a, b)
    expect(r.mismatched).toBe(1)
    expect(r.unmaskedMismatched).toBe(1)
    expect(r.boxes[0]).toMatchObject({ x: 0, y: 0, count: 1 })
  })

  it('reports a size mismatch as a failure', () => {
    const r = diffPixels(image(40, 30, white), image(41, 30, white))
    expect(r.sizeMismatch).toContain('40x30')
    expect(r.mismatched).toBeGreaterThan(0)
  })

  it('masks a region in both images and reports how much it hid', () => {
    const a = image(60, 40, white)
    const b = image(60, 40, (x, y) => (x >= 10 && x < 20 && y >= 10 && y < 20 ? [0, 0, 0] : white()))
    const unmasked = diffPixels(a, b)
    expect(unmasked.mismatched).toBe(100)
    const masked = diffPixels(a, b, [{ id: 'm', rect: { x: 8, y: 8, w: 14, h: 14 } }])
    expect(masked.mismatched).toBe(0)
    expect(masked.unmaskedMismatched).toBe(100)
    expect(masked.maskUsage).toEqual({ m: 100 })
  })

  it('reports a mask that hides nothing as unused (stale)', () => {
    const a = image(60, 40, white)
    const r = diffPixels(a, a, [{ id: 'stale', rect: { x: 0, y: 0, w: 10, h: 10 } }])
    expect(r.maskUsage).toEqual({ stale: 0 })
  })

  it('clusters distant mismatches into separate boxes', () => {
    const a = image(200, 100, white)
    const b = image(200, 100, (x, y) =>
      (x === 3 && y === 3) || (x === 180 && y === 90) ? [0, 0, 0] : white(),
    )
    const r = diffPixels(a, b)
    expect(r.mismatched).toBe(2)
    expect(r.boxes).toHaveLength(2)
  })

  it('agrees with pixelmatch on the mismatch count for exact comparisons', () => {
    const a = image(30, 30, (x, y) => [(x * 8) % 256, (y * 8) % 256, 0])
    const b = image(30, 30, (x, y) => [(x * 8) % 256, (y * 8) % 256, x === y ? 1 : 0])
    const r = diffPixels(a, b)
    expect(r.mismatched).toBe(r.unmaskedMismatched)
    expect(r.mismatched).toBe(30)
  })
})
