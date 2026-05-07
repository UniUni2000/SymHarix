export function extractIssueIdentifier(text: string): string | null {
  const match = text.match(/\b[A-Z][A-Z0-9]+-\d+\b/i);
  if (match) {
    return match[0].toUpperCase();
  }

  const spaced = text.match(/\b([A-Z][A-Z0-9]{1,9})\s+#?\s*(\d+)\b/i);
  if (!spaced) {
    return null;
  }

  const rawPrefix = spaced[1]!;
  const prefix = rawPrefix.toUpperCase();
  if (rawPrefix !== prefix && prefix !== 'INT') {
    return null;
  }
  if (['ISSUE', 'TICKET', 'TASK', 'PR'].includes(prefix)) {
    return null;
  }
  return `${prefix}-${spaced[2]}`;
}
