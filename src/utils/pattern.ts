/**
 * Match a value against a glob pattern. Only `*` is supported as a wildcard.
 * All other regex metacharacters (including `?`) are escaped to literals.
 */
export function matchesPattern(value: string, pattern: string): boolean {
  if (!pattern.includes("*")) return value === pattern;
  // Escape all regex metacharacters INCLUDING `?` before replacing `*` with `.*`
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // `?` is in the escape set
        .replace(/\*/g, ".*") +
      "$",
  );
  return re.test(value);
}
