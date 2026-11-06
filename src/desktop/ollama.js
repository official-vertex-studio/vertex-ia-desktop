import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11435';
export const desktopInvoke = (command, args = {}) => invoke(command, args);

export async function getOllamaStatus(baseUrl = DEFAULT_OLLAMA_URL) {
  try { return { online: true, version: (await invoke('ollama_health', { baseUrl })).version || 'connecté' }; }
  catch (error) { return { online: false, error: String(error) }; }
}

export async function listLocalModels(baseUrl = DEFAULT_OLLAMA_URL) {
  const result = await invoke('ollama_local_models', { baseUrl });
  return result.models || [];
}

export async function pullModel(model, baseUrl, onProgress) {
  const unlisten = await listen('ollama-pull-progress', (event) => onProgress?.(event.payload));
  try { await invoke('ollama_pull', { baseUrl, model }); }
  finally { unlisten(); }
}

export async function chatWithOllama({ model, messages, baseUrl, onToken, onDone, options }) {
  const offToken = await listen('ollama-chat-token', (event) => onToken?.(event.payload));
  const offDone = await listen('ollama-chat-done', (event) => onDone?.(event.payload));
  try { await invoke('ollama_chat', { baseUrl, model, messages, options: options || null }); }
  finally { offToken(); offDone(); }
}

export async function searchLibrary(query = '', page = 1) {
  const html = await invoke('search_ollama_library', { query, page });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const seen = new Set();
  const results = [];
  for (const anchor of doc.querySelectorAll('a[href^="/library/"]')) {
    const href = (anchor.getAttribute('href') || '').split('?')[0].replace(/\/$/, '');
    const slug = href.replace(/^\/library\//, '');
    // Only catalog model pages; ignore tag pages, documentation and nested routes.
    if (!slug || slug.includes('/') || slug.includes(':') || seen.has(slug)) continue;
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) continue;
    const card = anchor.closest('article, li') || anchor.parentElement?.parentElement || anchor;
    const title = card.querySelector('h2,h3,[class*="title"]')?.textContent?.trim() || anchor.textContent?.trim() || slug;
    const description = card.querySelector('p,[class*="description"]')?.textContent?.replace(/\s+/g, ' ').trim() || (card.innerText || '').replace(/\s+/g, ' ').trim();
    const text = `${title} ${description} ${card.innerText || ''}`;
    seen.add(slug);
    results.push({ name: slug, title: title.slice(0, 90), description: description.slice(0, 260), cloud: /\bcloud\b/i.test(text), pull: `${slug}:latest`, url: `https://ollama.com${href}` });
  }
  return results.slice(0, 100);
}

export function extractModelTags(html, model) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tags = new Set(['latest']);
  const prefix = `/library/${model}`;
  for (const anchor of doc.querySelectorAll('a[href]')) {
    const href = decodeURIComponent((anchor.getAttribute('href') || '').split('?')[0]);
    let tag = '';
    if (href.startsWith(`${prefix}:`)) tag = href.slice(prefix.length + 1).split('/')[0];
    else if (href.startsWith(`${prefix}/tags/`)) tag = href.slice(`${prefix}/tags/`.length).split('/')[0];
    else if (href.startsWith(`${prefix}/`)) tag = href.slice(prefix.length + 1).split('/')[0];
    if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,50}$/.test(tag) && tag !== 'tags') tags.add(tag);
  }
  const escapedModel = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const match of html.matchAll(new RegExp(`${escapedModel}[:/]([a-zA-Z0-9][a-zA-Z0-9._-]{0,50})`, 'g'))) { if (match[1] !== 'tags') tags.add(match[1]); }
  return [...tags];
}

export function formatBytes(bytes = 0) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}
