import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import SettingsModal from './components/SettingsModal';
import AdminDashboard from './pages/AdminDashboard';
import AuthScreen, { AuditConsent, PasswordSetup } from './pages/AuthScreen';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, PROVIDERS, getPuter, getFallbackModels, getGlobalProviderStatus, saveGlobalProviderKey, deleteGlobalProviderKey, clearLegacyProviderKeys, listProviderModels, streamProviderChat } from './lib/providers';
import { makeId, titleFromMessage, loadSettings, saveSettings } from './lib/storage';
import { fetchWorkspace, logActivity } from './lib/cloudData';
import { supabase, supabaseConfigured } from './lib/supabase';
import Icon from './components/Icon';

const DEFAULT_SYSTEM_PROMPT = 'Tu es VERTEX AI, un assistant utile, rigoureux et professionnel. Réponds toujours en français, sauf demande contraire. Pour le code, privilégie des solutions claires, robustes et bien expliquées. Ne prétends jamais avoir effectué une action que tu n’as pas réalisée.';

function saveBlob(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function SetupScreen() {
  return <main className="auth-screen"><section className="auth-card"><div className="auth-brand"><span className="brand-mark"><Icon name="logo" size={24}/></span><span><strong>VERTEX<span>AI</span></strong><small>CONFIGURATION REQUISE</small></span></div><div className="auth-heading"><div className="auth-icon"><Icon name="settings" size={22}/></div><span className="eyebrow">MISE EN SERVICE</span><h1>Connectez votre base de données.</h1><p>Le système multi-comptes nécessite un projet Supabase avant de pouvoir ouvrir une session.</p></div><pre className="setup-code">VITE_SUPABASE_URL=https://votre-projet.supabase.co{ '\n' }VITE_SUPABASE_ANON_KEY=votre_cle_publishable</pre><ol className="setup-steps"><li>Copiez <code>.env.example</code> vers <code>.env.local</code>.</li><li>Renseignez l'URL du projet et sa clé publishable Supabase.</li><li>Appliquez <code>supabase/schema.sql</code> dans le SQL Editor.</li><li>Redémarrez Vite avec <code>npm run dev</code>.</li></ol><a className="auth-submit auth-anchor" href="https://supabase.com/dashboard" target="_blank" rel="noreferrer">Ouvrir Supabase <Icon name="external" size={15}/></a></section></main>;
}

function makeLocalMessage(row) {
  return { id: row.id, role: row.role, content: row.content, timestamp: new Date(row.created_at).getTime(), provider: row.provider || 'puter', model: row.model, usage: row.metadata?.usage || null, error: Boolean(row.metadata?.error) };
}

export default function App() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [settings, setSettings] = useState(() => ({ systemPrompt: DEFAULT_SYSTEM_PROMPT, ...loadSettings() }));
  const [provider, setProvider] = useState(() => loadSettings().provider || DEFAULT_PROVIDER);
  const [model, setModel] = useState(() => loadSettings().models?.[loadSettings().provider || DEFAULT_PROVIDER] || DEFAULT_MODEL);
  const [providerStatus, setProviderStatus] = useState({});
  const [providerStatusLoaded, setProviderStatusLoaded] = useState(false);
  const [providerStatusError, setProviderStatusError] = useState('');
  const [models, setModels] = useState(() => getFallbackModels(loadSettings().provider || DEFAULT_PROVIDER));
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [search, setSearch] = useState('');
  const [authLoading, setAuthLoading] = useState(true);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [authError, setAuthError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [providerConnected, setProviderConnected] = useState(false);
  const [providerUser, setProviderUser] = useState(null);
  const [consentBusy, setConsentBusy] = useState(false);
  const abortRef = useRef(null);
  const toastTimer = useRef(null);
  const sessionIdRef = useRef(null);
  const settingsRef = useRef(settings);
  const modelRef = useRef(model);
  settingsRef.current = settings;
  modelRef.current = model;

  const activeConversation = useMemo(() => conversations.find((item) => item.id === activeId) || null, [conversations, activeId]);
  const isAdmin = ['owner', 'admin'].includes(profile?.role);
  const isInviteRoute = window.location.pathname === '/auth/accept-invite';

  useEffect(() => { saveSettings(settings); }, [settings]);

  const notify = useCallback((message) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2800);
  }, []);

  const hydrateSession = useCallback(async (nextSession) => {
    if (!nextSession?.user || !supabase) return;
    if (sessionIdRef.current === nextSession.user.id && profile) {
      // Keep the latest access token after Supabase refreshes the session.
      setSession(nextSession);
      return;
    }
    sessionIdRef.current = nextSession.user.id;
    clearLegacyProviderKeys(nextSession.user.id);
    setSession(nextSession);
    setWorkspaceLoading(true);
    setAuthError('');
    try {
      const { data: nextProfile, error: profileError } = await supabase.from('profiles').select('id,email,display_name,role,is_active,audit_consent_at,created_at').eq('id', nextSession.user.id).single();
      if (profileError) throw profileError;
      if (!nextProfile.is_active) {
        await supabase.auth.signOut();
        setSession(null); setProfile(null); setConversations([]); setActiveId(null);
        setAuthError('Ce compte a été suspendu. Contactez le propriétaire de VERTEX AI.');
        return;
      }
      setProfile(nextProfile);
      setAdminOpen(false);
      if (nextProfile.audit_consent_at) {
        try {
          const status = await getGlobalProviderStatus({ supabase, accessToken: nextSession.access_token });
          setProviderStatus(status);
          setProviderStatusError('');
        } catch (statusError) {
          setProviderStatus({});
          setProviderStatusError(statusError?.message || 'Impossible de vérifier les fournisseurs configurés.');
        } finally {
          setProviderStatusLoaded(true);
        }
        const loaded = await fetchWorkspace(supabase, nextSession.user.id);
        setConversations(loaded);
        setActiveId((current) => loaded.some((item) => item.id === current) ? current : loaded[0]?.id || null);
        if (loaded[0]?.model) setModel(loaded[0].model);
        if (loaded[0]?.provider) setProvider(loaded[0].provider);
      } else {
        setProviderStatus({}); setProviderStatusLoaded(false); setProviderStatusError('');
        setConversations([]); setActiveId(null);
      }
    } catch (error) {
      setAuthError(error?.message || 'Impossible de charger votre espace.');
    } finally {
      setWorkspaceLoading(false);
      setAuthLoading(false);
    }
  }, [profile]);

  useEffect(() => {
    if (!supabaseConfigured || !supabase) { setAuthLoading(false); return undefined; }
    let alive = true;
    supabase.auth.getSession().then(({ data, error }) => {
      if (!alive) return;
      if (error) setAuthError(error.message);
      if (data.session) void hydrateSession(data.session);
      else setAuthLoading(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'SIGNED_OUT' || !nextSession) {
        sessionIdRef.current = null;
        setSession(null); setProfile(null); setConversations([]); setActiveId(null); setAdminOpen(false);
        setProviderStatus({}); setProviderStatusLoaded(false); setProviderStatusError('');
        setAuthLoading(false);
      } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        window.setTimeout(() => { if (alive) void hydrateSession(nextSession); }, 0);
      }
    });
    return () => { alive = false; listener.subscription.unsubscribe(); };
  }, [hydrateSession]);

  useEffect(() => {
    try {
      const puter = getPuter();
      const signed = puter.auth.isSignedIn();
      setProviderConnected(Boolean(signed));
      if (signed) puter.auth.getUser().then(setProviderUser).catch(() => setProviderUser(null));
    } catch { setProviderConnected(false); }
  }, []);

  useEffect(() => {
    let active = true;
    setModelsLoading(true);
    setModelsError('');
    if (!providerStatusLoaded && provider !== 'puter') {
      setModels([]);
      setModelsLoading(false);
      return () => { active = false; };
    }
    if (provider !== 'puter' && !providerStatus[provider]?.configured) {
      setModels([]);
      setModel('');
      setModelsError(providerStatusError || (profile?.role === 'owner'
        ? `Configurez la clé ${PROVIDERS.find((item) => item.id === provider)?.name || provider} dans Paramètres → Fournisseurs IA.`
        : `Le Fondateur n’a pas encore configuré ${PROVIDERS.find((item) => item.id === provider)?.name || provider}.`));
      setModelsLoading(false);
      return () => { active = false; };
    }
    listProviderModels(provider, { supabase, accessToken: session?.access_token }).then((items) => {
      if (!active) return;
      const available = items?.length ? items : getFallbackModels(provider);
      setModels(available);
      const preferred = settingsRef.current.models?.[provider];
      const current = modelRef.current;
      if (current && available.some((item) => item.id === current)) return;
      if (preferred && available.some((item) => item.id === preferred)) setModel(preferred);
      else setModel(available[0]?.id || '');
      if (!available.length && provider !== 'puter') setModelsError('Aucun modèle disponible. Vérifiez la clé configurée par le Fondateur.');
    }).catch((error) => {
      if (!active) return;
      setModels(getFallbackModels(provider));
      setModelsError(`${error?.message || 'Impossible de charger le catalogue.'} Vérifiez la configuration du fournisseur dans Supabase.`);
    }).finally(() => { if (active) setModelsLoading(false); });
    return () => { active = false; };
  }, [provider, providerStatus, providerStatusLoaded, providerStatusError, providerConnected, session?.access_token, profile?.role]);

  useEffect(() => {
    function keyboard(event) {
      const target = event.target;
      const typing = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && session && profile?.audit_consent_at) { event.preventDefault(); void createConversation(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && !typing) { event.preventDefault(); document.querySelector('.search-box input')?.focus(); }
      if (event.key === 'Escape') { setSettingsOpen(false); setMobileOpen(false); }
    }
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  });

  async function signIn(sessionValue) {
    if (sessionValue) await hydrateSession(sessionValue);
    if (supabase) await logActivity(supabase, 'auth.login', 'account', sessionValue?.user?.id || session?.user?.id, { user_agent: navigator.userAgent });
  }

  async function signOut() {
    if (supabase && session) {
      await logActivity(supabase, 'auth.logout', 'account', session.user.id, {});
    }
    setProviderStatus({}); setProviderStatusLoaded(false); setProviderStatusError('');
    await supabase.auth.signOut();
    notify('Déconnexion effectuée.');
  }

  async function acceptConsent() {
    setConsentBusy(true); setAuthError('');
    try {
      const { error } = await supabase.rpc('accept_audit_policy');
      if (error) throw error;
      const { data: nextProfile, error: profileError } = await supabase.from('profiles').select('id,email,display_name,role,is_active,audit_consent_at,created_at').eq('id', session.user.id).single();
      if (profileError) throw profileError;
      setProfile(nextProfile);
      try {
        const status = await getGlobalProviderStatus({ supabase, accessToken: session.access_token });
        setProviderStatus(status); setProviderStatusLoaded(true); setProviderStatusError('');
      } catch (statusError) {
        setProviderStatus({}); setProviderStatusLoaded(true);
        setProviderStatusError(statusError?.message || 'Impossible de vérifier les fournisseurs configurés.');
      }
      const loaded = await fetchWorkspace(supabase, session.user.id);
      setConversations(loaded); setActiveId(loaded[0]?.id || null); if (loaded[0]?.model) setModel(loaded[0].model); if (loaded[0]?.provider) setProvider(loaded[0].provider);
      await logActivity(supabase, 'privacy.audit_consent_accepted', 'account', session.user.id, { policy: 'prompt-and-activity-logging-v1' });
      await logActivity(supabase, 'auth.login', 'account', session.user.id, { user_agent: navigator.userAgent, first_consent_session: true });
      await logActivity(supabase, 'user.activated', 'account', session.user.id, { activation: 'first_consent' });
      notify('Bienvenue dans VERTEX AI.');
    } catch (error) { setAuthError(error?.message || 'Impossible d’enregistrer votre consentement.'); }
    finally { setConsentBusy(false); }
  }

  async function connectProvider() {
    setAuthError('');
    try {
      const puter = getPuter();
      if (!puter.auth.isSignedIn()) await puter.auth.signIn();
      setProviderConnected(Boolean(puter.auth.isSignedIn()));
      try { setProviderUser(await puter.auth.getUser()); } catch { setProviderUser(null); }
      notify('Compte Puter connecté.');
      if (supabase) await logActivity(supabase, 'provider.puter_connected', 'provider', 'puter', {});
      return true;
    } catch (error) { setAuthError(error?.message || 'Connexion Puter impossible.'); return false; }
  }

  async function disconnectProvider() {
    try { await getPuter().auth.signOut(); } catch { /* session déjà fermée */ }
    setProviderConnected(false); setProviderUser(null); notify('Compte Puter déconnecté.');
    if (supabase) await logActivity(supabase, 'provider.puter_disconnected', 'provider', 'puter', {});
  }

  async function ensureProviderReady(providerId = provider) {
    if (providerId === 'puter') {
      try { if (getPuter().auth.isSignedIn()) { setProviderConnected(true); return true; } } catch { /* connexion plus bas */ }
      return connectProvider();
    }
    if (!providerStatus[providerId]?.configured) {
      setSettingsOpen(true);
      notify(profile?.role === 'owner'
        ? `Configurez la clé ${PROVIDERS.find((item) => item.id === providerId)?.name || providerId} dans Paramètres.`
        : `Le Fondateur n’a pas encore configuré ${PROVIDERS.find((item) => item.id === providerId)?.name || providerId}.`);
      return false;
    }
    return true;
  }

  async function refreshGlobalProviderStatus() {
    const status = await getGlobalProviderStatus({ supabase, accessToken: session?.access_token });
    setProviderStatus(status);
    setProviderStatusLoaded(true);
    setProviderStatusError('');
    return status;
  }

  async function handleSaveProviderKey(providerId, apiKey) {
    if (profile?.role !== 'owner') throw new Error('Seul le Fondateur peut configurer les clés IA globales.');
    const result = await saveGlobalProviderKey(providerId, apiKey, { supabase, accessToken: session?.access_token });
    const status = await refreshGlobalProviderStatus();
    notify(`Clé ${PROVIDERS.find((item) => item.id === providerId)?.name || providerId} enregistrée et vérifiée. ${result.modelCount || 0} modèle(s) détecté(s).`);
    return { ...result, status };
  }

  async function handleDeleteProviderKey(providerId) {
    if (profile?.role !== 'owner') throw new Error('Seul le Fondateur peut supprimer les clés IA globales.');
    await deleteGlobalProviderKey(providerId, { supabase, accessToken: session?.access_token });
    const status = await refreshGlobalProviderStatus();
    notify(`Clé ${PROVIDERS.find((item) => item.id === providerId)?.name || providerId} supprimée.`);
    return status;
  }

  async function testProvider(providerId) {
    const modelsFound = await listProviderModels(providerId, { supabase, accessToken: session?.access_token });
    if (!modelsFound?.length) throw new Error('Aucun modèle disponible pour ce fournisseur.');
    return `${modelsFound.length} modèle(s) détecté(s). Connexion valide.`;
  }

  async function refreshModels() {
    setModelsLoading(true); setModelsError('');
    try {
      const items = await listProviderModels(provider, { supabase, accessToken: session?.access_token });
      setModels(items?.length ? items : getFallbackModels(provider));
      notify(`${items.length} modèle(s) chargé(s) pour ${PROVIDERS.find((item) => item.id === provider)?.name || provider}.`);
    } catch (error) {
      setModelsError(error?.message || 'Impossible de charger les modèles.');
      notify(error?.message || 'Impossible de charger les modèles.');
    } finally { setModelsLoading(false); }
  }

  async function selectProvider(nextProvider) {
    const nextModel = settings.models?.[nextProvider] || getFallbackModels(nextProvider)[0]?.id || '';
    setProvider(nextProvider);
    setModel(nextModel);
    const nextSettings = { ...settings, provider: nextProvider, models: { ...(settings.models || {}), [nextProvider]: nextModel } };
    setSettings(nextSettings);
    if (activeId) {
      const { error } = await supabase.from('conversations').update({ provider: nextProvider, model: nextModel, updated_at: new Date().toISOString() }).eq('id', activeId);
      if (error) notify(`Impossible d'enregistrer le fournisseur : ${error.message}`);
      updateConversationLocal(activeId, (current) => ({ ...current, provider: nextProvider, model: nextModel, updatedAt: Date.now() }));
    }
    await logActivity(supabase, 'provider.selected', 'provider', nextProvider, { conversation_id: activeId, model: nextModel });
  }

  async function selectModel(nextModel) {
    setModel(nextModel);
    const nextSettings = { ...settings, provider, models: { ...(settings.models || {}), [provider]: nextModel } };
    setSettings(nextSettings);
    if (activeId) {
      const { error } = await supabase.from('conversations').update({ provider, model: nextModel, updated_at: new Date().toISOString() }).eq('id', activeId);
      if (error) notify(`Impossible d'enregistrer le modèle : ${error.message}`);
      updateConversationLocal(activeId, (current) => ({ ...current, provider, model: nextModel, updatedAt: Date.now() }));
    }
    await logActivity(supabase, 'model.selected', 'model', nextModel, { provider, conversation_id: activeId });
  }

  async function createConversation() {
    if (!supabase || !session) return;
    try {
      const { data, error } = await supabase.from('conversations').insert({ user_id: session.user.id, title: 'Nouvelle conversation', provider, model }).select('id,title,provider,model,created_at,updated_at').single();
      if (error) throw error;
      const next = { id: data.id, title: data.title, provider: data.provider || provider, model: data.model, createdAt: new Date(data.created_at).getTime(), updatedAt: new Date(data.updated_at).getTime(), messages: [] };
      setConversations((current) => [next, ...current]); setActiveId(next.id); setSearch(''); setAdminOpen(false);
    } catch (error) { notify(error?.message || 'Impossible de créer la conversation.'); }
  }

  function updateConversationLocal(id, updater) {
    setConversations((current) => current.map((conversation) => conversation.id === id ? updater(conversation) : conversation));
  }

  async function runRequest(conversationId, history, userText, selectedProvider, selectedModel, requestOptions = {}) {
    if (busy || !supabase || !session) return;
    const connected = await ensureProviderReady(selectedProvider);
    if (!connected) return;
    setBusy(true);
    const controller = new AbortController(); abortRef.current = controller;
    const temporaryAssistantId = makeId();
    updateConversationLocal(conversationId, (conversation) => ({
      ...conversation,
      provider: selectedProvider,
      model: selectedModel,
      messages: [...conversation.messages, { id: temporaryAssistantId, role: 'assistant', content: '', timestamp: Date.now(), provider: selectedProvider, model: selectedModel, pending: true }],
      updatedAt: Date.now(),
    }));
    await logActivity(supabase, requestOptions.regenerate ? 'ai.request.regenerated' : 'ai.request.started', 'conversation', conversationId, { provider: selectedProvider, model: selectedModel, prompt: requestOptions.regenerate ? userText : undefined });
    // Keep earlier turns when switching provider/model. This lets a new provider continue
    // the same conversation and reuse text/code files previously attached to that chat.
    const recentHistory = history.slice(-80);
    const apiMessages = [
      { role: 'system', content: settings.systemPrompt || DEFAULT_SYSTEM_PROMPT },
      ...recentHistory.map((message) => ({ role: message.role, content: message.content })),
      { role: 'user', content: userText },
    ];
    const startedAt = Date.now();
    let latestUsage = null;
    try {
      const fullText = await streamProviderChat({
        provider: selectedProvider, messages: apiMessages, model: selectedModel, signal: controller.signal, supabase, accessToken: session.access_token,
        onText: (_delta, complete) => updateConversationLocal(conversationId, (conversation) => ({
          ...conversation,
          messages: conversation.messages.map((message) => message.id === temporaryAssistantId ? { ...message, content: complete, pending: false } : message),
          updatedAt: Date.now(),
        })),
        onUsage: (usage) => {
          latestUsage = usage;
          updateConversationLocal(conversationId, (conversation) => ({
            ...conversation,
            messages: conversation.messages.map((message) => message.id === temporaryAssistantId ? { ...message, usage, pending: false } : message),
          }));
        },
      });
      const content = fullText || 'Le modèle a terminé sans renvoyer de texte.';
      const { data: saved, error } = await supabase.from('messages').insert({
        conversation_id: conversationId, user_id: session.user.id, role: 'assistant', content,
        provider: selectedProvider, model: selectedModel, metadata: { provider: selectedProvider, duration_ms: Date.now() - startedAt, usage: latestUsage },
      }).select('id,role,content,provider,model,metadata,created_at').single();
      if (error) throw error;
      updateConversationLocal(conversationId, (conversation) => ({
        ...conversation,
        provider: selectedProvider,
        model: selectedModel,
        messages: conversation.messages.map((message) => message.id === temporaryAssistantId ? makeLocalMessage(saved) : message),
        updatedAt: Date.now(),
      }));
      await supabase.from('conversations').update({ provider: selectedProvider, model: selectedModel, updated_at: new Date().toISOString() }).eq('id', conversationId);
      await logActivity(supabase, 'ai.request.completed', 'conversation', conversationId, { provider: selectedProvider, model: selectedModel, duration_ms: Date.now() - startedAt });
    } catch (error) {
      const aborted = error?.name === 'AbortError' || controller.signal.aborted;
      const content = aborted ? 'Génération arrêtée.' : `Une erreur est survenue : ${error?.message || 'Erreur inconnue.'}`;
      try {
        const { data: saved } = await supabase.from('messages').insert({ conversation_id: conversationId, user_id: session.user.id, role: 'assistant', content, provider: selectedProvider, model: selectedModel, metadata: { provider: selectedProvider, error: !aborted, aborted, duration_ms: Date.now() - startedAt } }).select('id,role,content,provider,model,metadata,created_at').single();
        updateConversationLocal(conversationId, (conversation) => ({ ...conversation, messages: conversation.messages.map((message) => message.id === temporaryAssistantId ? (saved ? makeLocalMessage(saved) : { ...message, content, pending: false, error: !aborted }) : message), updatedAt: Date.now() }));
      } catch {
        updateConversationLocal(conversationId, (conversation) => ({ ...conversation, messages: conversation.messages.map((message) => message.id === temporaryAssistantId ? { ...message, content, pending: false, error: !aborted } : message), updatedAt: Date.now() }));
      }
      await logActivity(supabase, aborted ? 'ai.request.stopped' : 'ai.request.failed', 'conversation', conversationId, { provider: selectedProvider, model: selectedModel, error: aborted ? null : String(error?.message || error) });
    } finally { setBusy(false); abortRef.current = null; }
  }

  async function sendMessage(text) {
    if (busy || !session || !supabase) return;
    const providerReady = await ensureProviderReady(provider);
    if (!providerReady) return;
    if (!model) { notify('Sélectionnez un modèle avant d’envoyer un message.'); return; }
    let conversation = activeConversation;
    if (!conversation) {
      const { data, error } = await supabase.from('conversations').insert({ user_id: session.user.id, title: titleFromMessage(text), provider, model }).select('id,title,provider,model,created_at,updated_at').single();
      if (error) { notify(error.message); return; }
      conversation = { id: data.id, title: data.title, provider: data.provider || provider, model: data.model, createdAt: new Date(data.created_at).getTime(), updatedAt: new Date(data.updated_at).getTime(), messages: [] };
      setConversations((current) => [conversation, ...current]); setActiveId(conversation.id);
    }
    const title = conversation.messages.length === 0 ? titleFromMessage(text) : conversation.title;
    if (title !== conversation.title) {
      await supabase.from('conversations').update({ title, updated_at: new Date().toISOString() }).eq('id', conversation.id);
      conversation = { ...conversation, title };
    }
    const { data: savedUser, error } = await supabase.from('messages').insert({ conversation_id: conversation.id, user_id: session.user.id, role: 'user', content: text, provider, model, metadata: { source: 'vertex-web-chat', provider, user_agent: navigator.userAgent } }).select('id,role,content,provider,model,metadata,created_at').single();
    if (error) { notify(error.message); return; }
    const userMessage = makeLocalMessage(savedUser);
    await supabase.from('conversations').update({ provider, model, updated_at: new Date().toISOString() }).eq('id', conversation.id);
    const history = conversation.messages;
    updateConversationLocal(conversation.id, (current) => ({ ...current, title, provider, model, messages: [...current.messages, userMessage], updatedAt: Date.now() }));
    await runRequest(conversation.id, history, text, provider, model);
  }

  function stopGeneration() { abortRef.current?.abort(); }

  async function regenerate() {
    if (busy || !activeConversation) return;
    const messages = [...activeConversation.messages];
    let lastUser = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) { if (messages[index].role === 'user') { lastUser = index; break; } }
    if (lastUser < 0) return;
    const prompt = messages[lastUser].content;
    const history = messages.slice(0, lastUser);
    const lastUserAt = messages[lastUser].timestamp;
    if (lastUserAt) {
      const { error } = await supabase.from('messages').delete().eq('conversation_id', activeConversation.id).gt('created_at', new Date(lastUserAt).toISOString());
      if (error) { notify(error.message); return; }
    }
    updateConversationLocal(activeConversation.id, (conversation) => ({ ...conversation, messages: messages.slice(0, lastUser + 1) }));
    await runRequest(activeConversation.id, history, prompt, provider, model, { regenerate: true });
  }

  async function renameConversation(id) {
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) return;
    const title = window.prompt('Nouveau nom de conversation :', conversation.title);
    if (!title?.trim()) return;
    const { error } = await supabase.from('conversations').update({ title: title.trim(), updated_at: new Date().toISOString() }).eq('id', id);
    if (error) { notify(error.message); return; }
    updateConversationLocal(id, (current) => ({ ...current, title: title.trim(), updatedAt: Date.now() }));
  }

  async function deleteConversation(id) {
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) return;
    if (!window.confirm(`Supprimer « ${conversation.title} » ? Cette action est définitive.`)) return;
    const { error } = await supabase.from('conversations').delete().eq('id', id);
    if (error) { notify(error.message); return; }
    const remaining = conversations.filter((item) => item.id !== id);
    setConversations(remaining); if (activeId === id) setActiveId(remaining[0]?.id || null);
  }

  function exportConversation() {
    if (!activeConversation) return;
    const markdown = `# ${activeConversation.title}\n\n${activeConversation.messages.map((message) => `## ${message.role === 'user' ? 'Vous' : 'VERTEX AI'}\n\n${message.content}`).join('\n\n---\n\n')}`;
    const filename = `${activeConversation.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'conversation'}.md`;
    saveBlob(filename, markdown, 'text/markdown;charset=utf-8');
    void logActivity(supabase, 'conversation.exported', 'conversation', activeConversation.id, {});
  }

  function exportAll() {
    saveBlob('vertex-ai-conversations.json', JSON.stringify(conversations, null, 2), 'application/json');
    notify('Export JSON téléchargé.');
    void logActivity(supabase, 'workspace.exported', 'workspace', session.user.id, { conversation_count: conversations.length });
  }

  async function importConversations(event) {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      if (!Array.isArray(imported)) throw new Error('Le fichier doit contenir une liste de conversations.');
      let count = 0;
      for (const item of imported.filter((candidate) => candidate && typeof candidate.title === 'string' && Array.isArray(candidate.messages))) {
        const { data: row, error } = await supabase.from('conversations').insert({ user_id: session.user.id, title: item.title.slice(0, 160), provider: item.provider || provider, model: item.model || model }).select('id').single();
        if (error) throw error;
        const rows = item.messages.filter((message) => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string').map((message) => ({ conversation_id: row.id, user_id: session.user.id, role: message.role, content: message.content, provider: message.provider || item.provider || provider, model: message.model || item.model || model }));
        if (rows.length) { const { error: messagesError } = await supabase.from('messages').insert(rows); if (messagesError) throw messagesError; }
        count += 1;
      }
      const loaded = await fetchWorkspace(supabase, session.user.id); setConversations(loaded); setActiveId(loaded[0]?.id || null); if (loaded[0]?.provider) setProvider(loaded[0].provider); if (loaded[0]?.model) setModel(loaded[0].model); notify(`${count} conversation(s) importée(s).`);
      await logActivity(supabase, 'workspace.imported', 'workspace', session.user.id, { conversation_count: count });
    } catch (error) { notify(error?.message || 'Import impossible.'); }
    event.target.value = '';
  }

  if (!supabaseConfigured) return <SetupScreen/>;
  if (authLoading) return <div className="auth-loading"><div className="loading-orb"/><span>Initialisation de VERTEX AI…</span></div>;
  if (!session) return <><AuthScreen supabase={supabase} onSignedIn={signIn}/>{authError && <div className="error-banner"><Icon name="info" size={15}/>{authError}</div>}</>;
  if (isInviteRoute) return <PasswordSetup supabase={supabase} onComplete={async () => { window.history.replaceState({}, '', '/'); await hydrateSession(session); notify('Mot de passe défini.'); }}/ >;
  if (authError && !profile) return <div className="auth-loading"><div className="auth-alert auth-alert-error">{authError}</div><button className="secondary-button" onClick={() => supabase.auth.signOut()}>Se déconnecter</button></div>;
  if (!profile?.audit_consent_at) return <><AuditConsent onAccept={acceptConsent} busy={consentBusy}/>{authError && <div className="error-banner"><Icon name="info" size={15}/>{authError}</div>}</>;
  if (workspaceLoading) return <div className="auth-loading"><div className="loading-orb"/><span>Chargement de votre espace…</span></div>;

  return <div className="app-shell">
    <Sidebar conversations={conversations} activeId={activeId} onNew={createConversation} onSelect={(id) => { setActiveId(id); const selected = conversations.find((item) => item.id === id); if (selected?.model) setModel(selected.model); if (selected?.provider) setProvider(selected.provider); setAdminOpen(false); }} onSearch={setSearch} search={search} onRename={renameConversation} onDelete={deleteConversation} onSettings={() => setSettingsOpen(true)} user={profile} onSignIn={() => setSettingsOpen(true)} onSignOut={signOut} signedIn={Boolean(session)} mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} isAdmin={isAdmin} onAdmin={() => { setAdminOpen(true); setMobileOpen(false); }}/>
    {adminOpen && isAdmin ? <AdminDashboard supabase={supabase} profile={profile} session={session} notify={notify}/> : <ChatView conversation={activeConversation} provider={provider} providers={PROVIDERS} model={model} models={models} modelsLoading={modelsLoading} modelsError={modelsError} onProviderChange={selectProvider} onModelChange={selectModel} onRefreshModels={refreshModels} onSend={sendMessage} onStop={stopGeneration} busy={busy} onRegenerate={regenerate} providerConnected={providerConnected} providerReady={provider === 'puter' ? providerConnected : Boolean(providerStatus[provider]?.configured)} onSignIn={connectProvider} onOpenSidebar={() => setMobileOpen(true)} onExport={exportConversation} onOpenSettings={() => setSettingsOpen(true)} user={profile}/>}
    <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} onSave={(next) => { setSettings(next); notify('Préférences enregistrées sur cet appareil.'); }} signedIn={Boolean(session)} user={profile} onSignOut={signOut} providerConnected={providerConnected} providerUser={providerUser} onConnectProvider={connectProvider} onDisconnectProvider={disconnectProvider} providerStatus={providerStatus} providerStatusError={providerStatusError} isOwner={profile?.role === 'owner'} onSaveProviderKey={handleSaveProviderKey} onDeleteProviderKey={handleDeleteProviderKey} onTestProvider={testProvider} onExportAll={exportAll} onImport={() => document.getElementById('import-conversations')?.click()}/>
    {toast && <div className="toast"><Icon name="checkCircle" size={16}/>{toast}</div>}
    {authError && <div className="error-banner"><Icon name="info" size={15}/><span>{authError}</span><button onClick={() => setAuthError('')}><Icon name="close" size={14}/></button></div>}
    <div className="app-status" aria-live="polite"><span className="status-dot online"/>{provider === 'puter' ? (providerConnected ? 'Puter connecté · Espace synchronisé' : 'Espace synchronisé · Puter à connecter') : `${PROVIDERS.find((item) => item.id === provider)?.name || provider} · Espace synchronisé`}</div>
    <input id="import-conversations" type="file" accept="application/json,.json" hidden onChange={importConversations}/>
  </div>;
}
