export function parseAgentPlan(response) {
  const cleaned = String(response || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Réponse JSON invalide de l’agent.');
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Le plan de l’agent doit être un objet JSON.');
  return { summary: String(parsed.summary || ''), actions: Array.isArray(parsed.actions) ? parsed.actions : [] };
}

export function isSafeProjectRelativePath(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 240) return false;
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z]:/.test(value)) return false;
  const parts = value.replaceAll('\\', '/').split('/');
  return parts.every(part => part && part !== '.' && part !== '..' && !/[\0\r\n]/.test(part));
}
