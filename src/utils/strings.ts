/**
 * Shared string utilities.
 */

/**
 * Convert text to a URL/filename-safe slug.
 * Strips non-alphanumeric characters, collapses dashes, caps at 80 chars.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}
