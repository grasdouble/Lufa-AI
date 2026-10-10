export function safeEvidenceHref(reference) {
  try {
    const url = new URL(reference);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
