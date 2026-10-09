// Verbatim ports of the dc runtime's kebabToCamel/cssToObj. Dependency-free so the compiler (build time) and
// the runtime helpers (browser) share exactly one implementation.

export function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

export function cssToObj(css: string): Record<string, string> {
  const o: Record<string, string> = {}
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const prop = decl.slice(0, i).trim()
    o[prop.startsWith('--') ? prop : kebabToCamel(prop)] = decl.slice(i + 1).trim()
  }
  return o
}
