// Capability taxonomy: namespaced, dotted, versionless ids like "doc.extract.tables".
// Policy and discovery match against glob patterns ("doc.*", "infer.llm.*", "*").

const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const validateTaxonomyId = (id: string): boolean =>
  id.length > 0 && id.split('.').every((seg) => SEGMENT.test(seg))

// Glob semantics: a trailing ".*" matches the prefix and any deeper segments;
// a bare "*" matches everything; otherwise an exact match.
export const matchTaxonomy = (pattern: string, id: string): boolean => {
  if (pattern === '*') return true
  if (pattern === id) return true
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2)
    return id === prefix || id.startsWith(`${prefix}.`)
  }
  return false
}

// True if `id` is allowed by an allow-list and not blocked by a deny-list.
// Deny takes precedence over allow (deny-by-default friendly).
export const taxonomyAllowed = (
  id: string,
  allow: readonly string[],
  deny: readonly string[],
): boolean => {
  if (deny.some((p) => matchTaxonomy(p, id))) return false
  return allow.some((p) => matchTaxonomy(p, id))
}
