/** Truncate text to max chars, adding ellipsis if needed */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

/** Strip MDX/JSX components and imports from body text */
export function stripMdx(body: string): string {
  let text = body;
  // Remove import statements
  text = text.replace(/^import\s+.*$/gm, '');
  // Remove JSX components (<Component ... /> and <Component>...</Component>)
  text = text.replace(/<[A-Z][a-zA-Z]*[^>]*\/>/g, '');
  text = text.replace(/<[A-Z][a-zA-Z]*[^>]*>[\s\S]*?<\/[A-Z][a-zA-Z]*>/g, '');
  // Remove {expressions}
  text = text.replace(/\{[^}]*\}/g, '');
  // Remove export statements
  text = text.replace(/^export\s+.*$/gm, '');
  return text.trim();
}

/** Convert markdown to plain text */
export function toPlainText(markdown: string): string {
  let text = stripMdx(markdown);
  // Remove headers
  text = text.replace(/^#{1,6}\s+/gm, '');
  // Remove bold/italic
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/_([^_]+)_/g, '$1');
  // Remove inline code
  text = text.replace(/`([^`]+)`/g, '$1');
  // Remove code blocks
  text = text.replace(/```[\s\S]*?```/g, '');
  // Remove links, keep text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Remove images
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  // Remove horizontal rules
  text = text.replace(/^---+$/gm, '');
  // Remove blockquotes
  text = text.replace(/^>\s?/gm, '');
  // Remove list markers
  text = text.replace(/^[\s]*[-*+]\s+/gm, '');
  text = text.replace(/^[\s]*\d+\.\s+/gm, '');
  // Collapse whitespace
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/** Add hashtags to text, respecting character limit */
export function addHashtags(text: string, tags: string[], maxLength?: number): string {
  const tagStr = tags.map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' ');
  const combined = `${text}\n\n${tagStr}`;
  if (maxLength && combined.length > maxLength) {
    return truncate(text, maxLength);
  }
  return combined;
}

/** Extract first N sentences from text */
export function firstSentences(text: string, n: number): string {
  const sentences = text.match(/[^.!?]+[.!?]+/g);
  if (!sentences) return text;
  return sentences.slice(0, n).join(' ').trim();
}

/** Extract key paragraphs (non-empty, non-heading, substantive) */
export function extractKeyParagraphs(text: string, max: number): string[] {
  const plain = toPlainText(text);
  const paragraphs = plain
    .split('\n\n')
    .map((p) => p.trim())
    .filter((p) => p.length > 80);
  return paragraphs.slice(0, max);
}

/** Format a stat for display: "51 MCP Tools" */
export function formatStat(value: number, label: string, suffix: string): string {
  return `${value}${suffix} ${label}`;
}
