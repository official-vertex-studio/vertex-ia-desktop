export function getPuter() {
  if (typeof window === 'undefined' || !window.puter) throw new Error('Puter.js n’est pas chargé. Actualisez la page puis réessayez.');
  return window.puter;
}

export const PROVIDERS = [
  { id: 'puter', name: 'Puter', description: 'Connexion au compte Puter de chaque utilisateur.', keyLabel: null, keyUrl: null, help: 'Puter reste une connexion individuelle par compte utilisateur.' },
  { id: 'groq', name: 'Groq', description: 'Inférence cloud rapide avec catalogue dynamique.', keyLabel: 'Clé API Groq', keyUrl: 'https://console.groq.com/keys', help: 'La clé est configurée par le Fondateur et partagée par les membres autorisés.' },
  { id: 'gemini', name: 'Google Gemini', description: 'API Gemini via Google AI Studio.', keyLabel: 'Clé API Gemini', keyUrl: 'https://aistudio.google.com/app/apikey', help: 'La clé est configurée par le Fondateur et partagée par les membres autorisés.' },
  { id: 'openrouter', name: 'OpenRouter', description: 'Un accès unifié à de nombreux modèles.', keyLabel: 'Clé API OpenRouter', keyUrl: 'https://openrouter.ai/settings/keys', help: 'La clé est configurée par le Fondateur et partagée par les membres autorisés.' },
];

export const DEFAULT_PROVIDER = 'puter';
export const DEFAULT_MODEL = 'anthropic/claude-opus-5-5';

const PUTER_FALLBACK_MODELS = [
  { id: 'anthropic/claude-opus-5-5', name: 'Claude Opus 5.5', detail: 'Raisonnement approfondi et tâches complexes' },
  { id: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5', detail: 'Équilibre qualité / rapidité' },
  { id: 'anthropic/claude-haiku-5-5', name: 'Claude Haiku 5.5', detail: 'Réponses rapides' },
];

export function getFallbackModels(provider) {
  return provider === 'puter' ? PUTER_FALLBACK_MODELS : [];
}

function normalizeModel(model, provider) {
  const id = String(model?.id || model?.name || '').trim();
  if (!id) return null;
  const context = Number(model.context_length || model.context || model.context_window || model.inputTokenLimit || 0) || null;
  const pricing = model.pricing || model.cost || null;
  const hasPricing = pricing && (pricing.prompt !== undefined || pricing.completion !== undefined);
  const free = id.endsWith(':free') || (hasPricing && Number(pricing.prompt) === 0 && Number(pricing.completion) === 0);
  return {
    id,
    name: model.name || model.display_name || model.displayName || id,
    detail: [context ? `${context.toLocaleString('fr-FR')} tokens` : '', free ? 'Gratuit (selon quotas)' : ''].filter(Boolean).join(' · '),
    context,
    free: Boolean(free),
    provider,
  };
}

async function callProviderProxy({ action, provider, apiKey, model, messages, signal, supabase, accessToken, onText, onUsage }) {
  if (!supabase?.supabaseUrl || !supabase?.supabaseKey) throw new Error('Supabase n’est pas disponible pour contacter le fournisseur.');
  if (!accessToken) throw new Error('Votre session VERTEX a expiré. Reconnectez-vous.');
  const body = { action };
  if (provider) body.provider = provider;
  if (typeof apiKey === 'string') body.apiKey = apiKey;
  if (model) body.model = model;
  if (messages) body.messages = messages;

  const response = await fetch(`${supabase.supabaseUrl.replace(/\/$/, '')}/functions/v1/provider-proxy`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      apikey: supabase.supabaseKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error || `Erreur de la passerelle IA (${response.status}).`);
  }

  if (action === 'models' || action === 'status' || action === 'admin_save_key' || action === 'admin_delete_key') {
    return response.json();
  }

  if (!response.body) throw new Error('Le fournisseur n’a pas renvoyé de flux de réponse.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let finished = false;

  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') { finished = true; return; }
    let chunk;
    try { chunk = JSON.parse(data); } catch { return; }
    if (chunk.error) throw new Error(chunk.error.message || 'Le fournisseur a interrompu la réponse.');
    const delta = extractText(chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? '');
    if (delta) {
      fullText += delta;
      onText?.(delta, fullText);
    }
    if (chunk.usage) onUsage?.({
      inputTokens: chunk.usage.prompt_tokens || chunk.usage.input_tokens || 0,
      outputTokens: chunk.usage.completion_tokens || chunk.usage.output_tokens || 0,
      totalTokens: chunk.usage.total_tokens || 0,
    });
  };

  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) processLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) processLine(buffer);
  } finally {
    reader.releaseLock();
  }
  return fullText;
}

function extractText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((part) => part?.text || '').join('');
  return '';
}

export async function getGlobalProviderStatus(context = {}) {
  const payload = await callProviderProxy({ action: 'status', supabase: context.supabase, accessToken: context.accessToken });
  return payload?.providers || {};
}

export async function saveGlobalProviderKey(provider, apiKey, context = {}) {
  if (!apiKey?.trim()) throw new Error('Saisissez une clé API avant de l’enregistrer.');
  return callProviderProxy({ action: 'admin_save_key', provider, apiKey: apiKey.trim(), supabase: context.supabase, accessToken: context.accessToken });
}

export async function deleteGlobalProviderKey(provider, context = {}) {
  return callProviderProxy({ action: 'admin_delete_key', provider, supabase: context.supabase, accessToken: context.accessToken });
}

export async function listProviderModels(provider, context = {}) {
  if (provider === 'puter') {
    const puter = getPuter();
    if (!puter.auth.isSignedIn()) return PUTER_FALLBACK_MODELS.map((item) => normalizeModel(item, provider));
    if (typeof puter.ai.listModels !== 'function') return PUTER_FALLBACK_MODELS.map((item) => normalizeModel(item, provider));
    const rows = await puter.ai.listModels();
    const models = (rows || []).map((item) => normalizeModel(item, provider)).filter(Boolean);
    return models.length ? models.sort((a, b) => a.name.localeCompare(b.name)) : PUTER_FALLBACK_MODELS.map((item) => normalizeModel(item, provider));
  }
  const payload = await callProviderProxy({ action: 'models', provider, supabase: context.supabase, accessToken: context.accessToken });
  return (payload.models || []).map((item) => normalizeModel(item, provider)).filter(Boolean);
}

export async function streamProviderChat({ provider, messages, model, signal, onText, onUsage, supabase, accessToken }) {
  if (provider === 'puter') {
    const puter = getPuter();
    if (!puter.auth.isSignedIn()) throw new Error('Connectez votre compte Puter dans les paramètres de VERTEX AI.');
    const stream = await puter.ai.chat(messages, false, { model, stream: true, normalize: true, temperature: 0.7, signal });
    let fullText = '';
    for await (const chunk of stream) {
      if (chunk?.type === 'text' && chunk.text) {
        fullText += chunk.text;
        onText?.(chunk.text, fullText);
      } else if (chunk?.type === 'usage') {
        onUsage?.(chunk.usageDetails || null);
      } else if (chunk?.type === 'error') {
        throw new Error(chunk.message || 'Le fournisseur Puter a interrompu la réponse.');
      }
    }
    return fullText;
  }
  return callProviderProxy({ action: 'chat', provider, model, messages, signal, supabase, accessToken, onText, onUsage });
}

// Remove API keys saved by VERTEX AI 2.4 in this browser session.
// Version 2.5 uses founder-managed, encrypted server-side credentials instead.
export function clearLegacyProviderKeys(userId) {
  if (!userId || typeof window === 'undefined') return;
  try { sessionStorage.removeItem(`vertex-ai:provider-keys:${userId}`); } catch { /* storage unavailable */ }
}
