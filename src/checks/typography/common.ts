/**
 * Shared line-segmentation for typography checks: only prose segments are
 * checked. Inline code, URLs, markdown link/image targets, and HTML tags
 * are masked. For links/images the visible text stays prose.
 */

export type Segment = { text: string; prose: boolean };

export function segmentLine(line: string): Segment[] {
  const MASK_RE =
    /(`[^`]*`)|(!?\[[^\]]*\]\([^)]*\))|(https?:\/\/[^\s)]+)|(<[^>]+>)/g;
  const segments: Segment[] = [];
  let last = 0;
  for (const m of line.matchAll(MASK_RE)) {
    const index = m.index ?? 0;
    if (index > last) {
      segments.push({ text: line.slice(last, index), prose: true });
    }
    if (m[2]) {
      const bracketEnd = m[2].indexOf("](");
      segments.push({ text: m[2].slice(0, bracketEnd + 1), prose: true });
      segments.push({ text: m[2].slice(bracketEnd + 1), prose: false });
    } else {
      segments.push({ text: m[0], prose: false });
    }
    last = index + m[0].length;
  }
  if (last < line.length) {
    segments.push({ text: line.slice(last), prose: true });
  }
  return segments;
}
