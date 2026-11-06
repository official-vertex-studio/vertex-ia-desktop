import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from '../components/Icon';

const PAGE_SIZE = 50;

function dateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function labelForAction(action) {
  const labels = {
    'chat.created': 'Conversation créée', 'chat.renamed': 'Conversation renommée', 'chat.deleted': 'Conversation supprimée',
    'chat.model_changed': 'Modèle changé', 'chat.provider_changed': 'Fournisseur changé', 'prompt.sent': 'Prompt envoyé', 'assistant.response_saved': 'Réponse enregistrée',
    'ai.request.started': 'Requête IA démarrée', 'ai.request.failed': 'Requête IA échouée', 'ai.request.completed': 'Requête IA terminée',
    'ai.request.regenerated': 'Réponse régénérée', 'ai.request.stopped': 'Génération arrêtée',
    'account.invited': 'Compte invité', 'account.role_changed': 'Rôle modifié', 'account.activated': 'Compte activé', 'account.suspended': 'Compte suspendu', 'account.deleted': 'Compte supprimé', 'account.deletion_requested': 'Suppression demandée',
    'auth.login': 'Connexion', 'auth.logout': 'Déconnexion', 'user.activated': 'Espace activé', 'privacy.audit_consent_accepted': 'Consentement de journalisation accepté',
    'provider.puter_connected': 'Compte Puter connecté', 'provider.puter_disconnected': 'Compte Puter déconnecté', 'provider.keys_updated': 'Clés API mises à jour', 'provider.selected': 'Fournisseur sélectionné',
    'model.selected': 'Modèle sélectionné', 'conversation.exported': 'Conversation exportée', 'workspace.exported': 'Espace exporté', 'workspace.imported': 'Espace importé',
    'admin.conversation_viewed': 'Transcription consultée par le Fondateur', 'admin.conversation_exported': 'Transcription exportée par le Fondateur', 'audit.exported': 'Journal d’audit exporté',
  };
  return labels[action] || action;
}

function download(name, content, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function transcriptMarkdown(conversation, messages, user) {
  const body = messages.map((message) => {
    const speaker = message.role === 'user' ? user?.display_name || user?.email || 'Utilisateur' : 'VERTEX AI';
    return `## ${speaker} · ${dateTime(message.created_at)}\n\n${message.content}`;
  }).join('\n\n---\n\n');
  return `# ${conversation.title}\n\n- Utilisateur : ${user?.email || conversation.user_id}\n- Fournisseur : ${conversation.provider || 'puter'}\n- Modèle : ${conversation.model}\n- Créée : ${dateTime(conversation.created_at)}\n- Dernière activité : ${dateTime(conversation.updated_at)}\n\n---\n\n${body}\n`;
}

export default function AdminDashboard({ supabase, profile, session, notify }) {
  const isOwner = profile.role === 'owner';
  const [tab, setTab] = useState(isOwner ? 'overview' : 'users');
  const [logs, setLogs] = useState([]);
  const [logsTotal, setLogsTotal] = useState(0);
  const [promptCountTotal, setPromptCountTotal] = useState(0);
  const [logsHasMore, setLogsHasMore] = useState(false);
  const [loadingMoreLogs, setLoadingMoreLogs] = useState(false);
  const [users, setUsers] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [conversationsTotal, setConversationsTotal] = useState(0);
  const [conversationsHasMore, setConversationsHasMore] = useState(false);
  const [loadingMoreConversations, setLoadingMoreConversations] = useState(false);
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [selectedMessages, setSelectedMessages] = useState([]);
  const [selectedMessagesTotal, setSelectedMessagesTotal] = useState(0);
  const [messagesHasMore, setMessagesHasMore] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false);
  const [exportingMessages, setExportingMessages] = useState(false);
  const [exportingLogs, setExportingLogs] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('all');
  const [conversationSearch, setConversationSearch] = useState('');
  const [selectedUserFilter, setSelectedUserFilter] = useState('all');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [inviting, setInviting] = useState(false);
  const [retention, setRetention] = useState(90);
  const [savingRetention, setSavingRetention] = useState(false);
  const [error, setError] = useState('');

  const userById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);

  const callAdmin = useCallback(async (action, payload = {}) => {
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) throw new Error('Session expirée. Reconnectez-vous.');
    const { data, error: invokeError } = await supabase.functions.invoke('admin-users', {
      body: { action, ...payload },
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (invokeError) throw invokeError;
    if (data?.error) throw new Error(data.error);
    return data?.data;
  }, [supabase]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const userPromise = supabase.from('profiles')
        .select('id,email,display_name,role,is_active,audit_consent_at,created_at')
        .order('created_at', { ascending: false });
      const [userResult] = await Promise.all([userPromise]);
      if (userResult.error) throw userResult.error;
      setUsers(userResult.data || []);

      if (isOwner) {
        const [logResult, settingsResult, conversationResult, promptCountResult] = await Promise.all([
          supabase.from('audit_logs').select('id,actor_id,actor_email,action,entity_type,entity_id,prompt_text,result_preview,provider,model,metadata,created_at', { count: 'exact' }).order('created_at', { ascending: false }).order('id', { ascending: false }).range(0, PAGE_SIZE - 1),
          supabase.from('app_settings').select('audit_retention_days').eq('id', 1).maybeSingle(),
          supabase.from('conversations').select('id,user_id,title,provider,model,created_at,updated_at', { count: 'exact' }).order('updated_at', { ascending: false }).range(0, PAGE_SIZE - 1),
          supabase.from('audit_logs').select('id', { count: 'exact', head: true }).eq('action', 'prompt.sent'),
        ]);
        if (logResult.error) throw logResult.error;
        if (settingsResult.error) throw settingsResult.error;
        if (conversationResult.error) throw conversationResult.error;
        if (promptCountResult.error) throw promptCountResult.error;
        setLogs(logResult.data || []);
        setLogsTotal(logResult.count || 0);
        setLogsHasMore((logResult.data || []).length < (logResult.count || 0));
        setPromptCountTotal(promptCountResult.count || 0);
        setRetention(settingsResult.data?.audit_retention_days || 90);
        setConversations(conversationResult.data || []);
        setConversationsTotal(conversationResult.count || 0);
        setConversationsHasMore((conversationResult.data || []).length < (conversationResult.count || 0));
      } else {
        setLogs([]); setLogsTotal(0); setLogsHasMore(false); setPromptCountTotal(0);
        setConversations([]); setConversationsTotal(0); setConversationsHasMore(false);
      }
    } catch (err) {
      setError(err?.message || 'Impossible de charger les données administrateur.');
    } finally {
      setLoading(false);
    }
  }, [supabase, isOwner]);

  useEffect(() => { void reload(); }, [reload]);

  async function loadMoreLogs() {
    if (loadingMoreLogs || !logsHasMore) return;
    setLoadingMoreLogs(true); setError('');
    try {
      const from = logs.length;
      const { data, error: logsError } = await supabase.from('audit_logs')
        .select('id,actor_id,actor_email,action,entity_type,entity_id,prompt_text,result_preview,provider,model,metadata,created_at')
        .order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, from + PAGE_SIZE - 1);
      if (logsError) throw logsError;
      setLogs((current) => [...current, ...(data || [])]);
      setLogsHasMore(from + (data || []).length < logsTotal);
    } catch (err) { setError(err?.message || 'Impossible de charger la suite du journal.'); }
    finally { setLoadingMoreLogs(false); }
  }

  async function loadMoreConversations() {
    if (loadingMoreConversations || !conversationsHasMore) return;
    setLoadingMoreConversations(true); setError('');
    try {
      const from = conversations.length;
      const { data, error: queryError } = await supabase.from('conversations')
        .select('id,user_id,title,provider,model,created_at,updated_at')
        .order('updated_at', { ascending: false }).range(from, from + PAGE_SIZE - 1);
      if (queryError) throw queryError;
      setConversations((current) => [...current, ...(data || [])]);
      setConversationsHasMore(from + (data || []).length < conversationsTotal);
    } catch (err) { setError(err?.message || 'Impossible de charger les conversations.'); }
    finally { setLoadingMoreConversations(false); }
  }

  async function openConversation(conversation) {
    setSelectedConversation(conversation);
    setSelectedMessages([]);
    setSelectedMessagesTotal(0);
    setMessagesHasMore(false);
    setLoadingMessages(true);
    setError('');
    try {
      const { data, error: queryError, count } = await supabase.from('messages')
        .select('id,conversation_id,user_id,role,content,provider,model,metadata,created_at', { count: 'exact' })
        .eq('conversation_id', conversation.id)
        .order('created_at', { ascending: true })
        .range(0, 499);
      if (queryError) throw queryError;
      const { error: auditError } = await supabase.rpc('log_activity', {
        p_action: 'admin.conversation_viewed',
        p_entity_type: 'conversation',
        p_entity_id: conversation.id,
        p_details: { owner_view: true, conversation_title: conversation.title, subject_user_id: conversation.user_id },
      });
      if (auditError) throw new Error(`Lecture bloquée : la consultation n'a pas pu être journalisée (${auditError.message}).`);
      setSelectedMessages(data || []);
      setSelectedMessagesTotal(count || 0);
      setMessagesHasMore((data || []).length < (count || 0));
    } catch (err) {
      setSelectedMessages([]);
      setSelectedMessagesTotal(0);
      setMessagesHasMore(false);
      setError(err?.message || 'Impossible de lire cette conversation. Vérifiez la politique RLS owner.');
    } finally { setLoadingMessages(false); }
  }


  async function loadMoreMessages() {
    if (!selectedConversation || loadingMoreMessages || !messagesHasMore) return;
    setLoadingMoreMessages(true);
    setError('');
    try {
      const from = selectedMessages.length;
      const { data, error: queryError } = await supabase.from('messages')
        .select('id,conversation_id,user_id,role,content,provider,model,metadata,created_at')
        .eq('conversation_id', selectedConversation.id)
        .order('created_at', { ascending: true })
        .range(from, from + 499);
      if (queryError) throw queryError;
      setSelectedMessages((current) => [...current, ...(data || [])]);
      setMessagesHasMore(from + (data || []).length < selectedMessagesTotal);
    } catch (err) {
      setError(err?.message || 'Impossible de charger la suite de la transcription.');
    } finally { setLoadingMoreMessages(false); }
  }


  async function exportSelectedConversation() {
    if (!selectedConversation || exportingMessages || loadingMessages) return;
    setExportingMessages(true);
    setError('');
    try {
      let allMessages = [...selectedMessages];
      while (allMessages.length < selectedMessagesTotal) {
        const from = allMessages.length;
        const { data, error: queryError } = await supabase.from('messages')
          .select('id,conversation_id,user_id,role,content,provider,model,metadata,created_at')
          .eq('conversation_id', selectedConversation.id)
          .order('created_at', { ascending: true })
          .range(from, from + 499);
        if (queryError) throw queryError;
        if (!data?.length) break;
        allMessages = [...allMessages, ...data];
      }
      if (allMessages.length < selectedMessagesTotal) throw new Error('La transcription complète n’a pas pu être chargée. Réessayez.');
      const user = userById.get(selectedConversation.user_id);
      const { error: auditError } = await supabase.rpc('log_activity', {
        p_action: 'admin.conversation_exported',
        p_entity_type: 'conversation',
        p_entity_id: selectedConversation.id,
        p_details: { conversation_title: selectedConversation.title, subject_user_id: selectedConversation.user_id, message_count: allMessages.length },
      });
      if (auditError) throw new Error(`Export annulé : impossible de journaliser l'opération (${auditError.message}).`);
      const fileName = `vertex-${selectedConversation.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48) || 'conversation'}.md`;
      download(fileName, transcriptMarkdown(selectedConversation, allMessages, user), 'text/markdown;charset=utf-8');
    } catch (err) { setError(err?.message || 'Export de la conversation impossible.'); }
    finally { setExportingMessages(false); }
  }

  async function invite(event) {
    event.preventDefault();
    if (!isOwner) return;
    setInviting(true); setError('');
    try {
      await callAdmin('invite', { email, displayName });
      setEmail(''); setDisplayName(''); notify('Invitation envoyée par e-mail.'); await reload();
    } catch (err) { setError(err?.message || 'Invitation impossible.'); }
    finally { setInviting(false); }
  }

  async function changeRole(target, role) {
    if (!isOwner) return;
    if (!window.confirm(`Attribuer le rôle « ${role} » à ${target.email} ?`)) return;
    try { await callAdmin('set_role', { userId: target.id, role }); notify('Rôle mis à jour.'); await reload(); }
    catch (err) { setError(err?.message || 'Modification du rôle impossible.'); }
  }

  async function changeActive(target) {
    if (!isOwner) return;
    const next = !target.is_active;
    if (!window.confirm(`${next ? 'Réactiver' : 'Suspendre'} le compte ${target.email} ?`)) return;
    try { await callAdmin('set_active', { userId: target.id, isActive: next }); notify(next ? 'Compte réactivé.' : 'Compte suspendu.'); await reload(); }
    catch (err) { setError(err?.message || 'Modification du compte impossible.'); }
  }

  async function deleteAccount(target) {
    if (!isOwner) return;
    const confirmation = window.prompt(`Cette opération supprimera définitivement le compte ${target.email} ainsi que ses conversations et messages. Le journal d'audit historique sera conservé selon sa durée de conservation.\n\nPour confirmer, saisissez SUPPRIMER :`);
    if (confirmation !== 'SUPPRIMER') return;
    try {
      await callAdmin('delete_user', { userId: target.id });
      notify('Compte supprimé. Le journal historique est conservé.');
      if (selectedConversation?.user_id === target.id) { setSelectedConversation(null); setSelectedMessages([]); setSelectedMessagesTotal(0); setMessagesHasMore(false); }
      await reload();
    } catch (err) { setError(err?.message || 'Suppression du compte impossible.'); }
  }

  async function exportAllLogs() {
    if (!isOwner || exportingLogs) return;
    setExportingLogs(true);
    setError('');
    try {
      const allRows = [];
      let from = 0;
      const batchSize = 500;
      while (from < logsTotal || from === 0) {
        const { data, error: queryError } = await supabase.from('audit_logs')
          .select('id,actor_id,actor_email,action,entity_type,entity_id,prompt_text,result_preview,provider,model,metadata,created_at')
          .order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, from + batchSize - 1);
        if (queryError) throw queryError;
        if (!data?.length) break;
        allRows.push(...data);
        from += data.length;
        if (data.length < batchSize) break;
      }
      const { error: auditError } = await supabase.rpc('log_activity', {
        p_action: 'audit.exported',
        p_entity_type: 'audit_log',
        p_entity_id: null,
        p_details: { exported_event_count: allRows.length },
      });
      if (auditError) throw new Error(`Export annulé : impossible de journaliser l'opération (${auditError.message}).`);
      const exportRows = allRows.map((item) => ({
        id: item.id, date: item.created_at, actor_id: item.actor_id, email: item.actor_email,
        action: item.action, entity_type: item.entity_type, entity_id: item.entity_id,
        prompt: item.prompt_text, response_preview: item.result_preview, provider: item.provider, model: item.model, metadata: item.metadata,
      }));
      download(`vertex-ai-audit-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(exportRows, null, 2), 'application/json');
      notify(`${allRows.length} événement(s) exporté(s).`);
    } catch (err) { setError(err?.message || 'Export du journal impossible.'); }
    finally { setExportingLogs(false); }
  }

  async function saveRetention() {
    if (!isOwner) return;
    setSavingRetention(true);
    try {
      const { error: updateError } = await supabase.from('app_settings').update({ audit_retention_days: Number(retention), updated_at: new Date().toISOString() }).eq('id', 1);
      if (updateError) throw updateError;
      await supabase.rpc('log_activity', { p_action: 'audit.retention_changed', p_entity_type: 'settings', p_entity_id: 'audit_retention_days', p_details: { days: Number(retention) } });
      notify('Durée de conservation enregistrée.');
    } catch (err) { setError(err?.message || 'Enregistrement impossible.'); }
    finally { setSavingRetention(false); }
  }

  const filteredLogs = useMemo(() => logs.filter((item) => {
    const query = search.toLowerCase();
    const matchesSearch = !query || [item.actor_email, item.action, item.prompt_text, item.result_preview, item.provider, item.model, item.entity_id].some((part) => String(part || '').toLowerCase().includes(query));
    return matchesSearch && (actionFilter === 'all' || item.action === actionFilter);
  }), [logs, search, actionFilter]);

  const filteredConversations = useMemo(() => conversations.filter((item) => {
    const owner = userById.get(item.user_id);
    const query = conversationSearch.toLowerCase();
    const matchesText = !query || [item.title, item.provider, item.model, owner?.email, owner?.display_name].some((part) => String(part || '').toLowerCase().includes(query));
    return matchesText && (selectedUserFilter === 'all' || item.user_id === selectedUserFilter);
  }), [conversations, conversationSearch, selectedUserFilter, userById]);

  const activeUsers = users.filter((entry) => entry.is_active).length;
  const roleLabel = profile.role === 'owner' ? 'Fondateur' : 'Administrateur';

  return <main className="admin-main">
    <header className="admin-topbar">
      <div><span className="admin-eyebrow">CONSOLE PRIVÉE · VERTEX STUDIO</span><h1>Administration</h1><p>Gestion des accès, conversations et journal d’audit.</p></div>
      <button className="secondary-button" onClick={reload}><Icon name="refresh" size={15}/> Actualiser</button>
    </header>

    <section className="admin-metrics">
      <article><span>COMPTES</span><strong>{users.length}</strong><small>{activeUsers} actifs</small></article>
      <article><span>CONVERSATIONS</span><strong>{isOwner ? conversationsTotal : '—'}</strong><small>{isOwner ? 'Tous les utilisateurs' : 'Accès propriétaire'}</small></article>
      <article><span>PROMPTS JOURNALISÉS</span><strong>{isOwner ? promptCountTotal : '—'}</strong><small>{isOwner ? `${logsTotal} événements disponibles` : 'Réservé au propriétaire'}</small></article>
      <article><span>SESSION</span><strong>{roleLabel}</strong><small>{profile.email}</small></article>
    </section>

    <div className="admin-tabs">
      {isOwner && <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}><Icon name="activity" size={15}/> Vue d’ensemble</button>}
      {isOwner && <button className={tab === 'conversations' ? 'active' : ''} onClick={() => setTab('conversations')}><Icon name="message" size={15}/> Conversations</button>}
      {isOwner && <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}><Icon name="list" size={15}/> Journal d’activité</button>}
      <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}><Icon name="users" size={15}/> Comptes</button>
      {isOwner && <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}><Icon name="settings" size={15}/> Paramètres</button>}
    </div>

    {error && <div className="admin-error"><Icon name="info" size={15}/>{error}<button onClick={() => setError('')}><Icon name="close" size={14}/></button></div>}
    {loading ? <div className="admin-empty">Chargement des données sécurisées…</div> : <>
      {tab === 'overview' && isOwner && <section className="admin-panel overview-panel">
        <div className="admin-panel-head"><div><h2>Vue d’ensemble</h2><p>Les indicateurs sont issus des conversations et événements réellement enregistrés.</p></div></div>
        <div className="overview-grid">
          <button onClick={() => setTab('conversations')}><Icon name="message"/><strong>{conversationsTotal}</strong><span>Conversations · ouvrir</span></button>
          <button onClick={() => setTab('users')}><Icon name="users"/><strong>{users.length}</strong><span>Comptes · gérer</span></button>
          <button onClick={() => setTab('activity')}><Icon name="activity"/><strong>{logsTotal}</strong><span>Événements · consulter</span></button>
        </div>
        <div className="owner-notice"><Icon name="shield" size={17}/><div><strong>Accès fondateur</strong><p>Vous pouvez consulter les conversations des membres, lire leurs prompts et réponses, gérer les invitations et suspendre les comptes. Chaque consultation d’une conversation est elle-même inscrite dans le journal d’audit.</p></div></div>
      </section>}

      {tab === 'conversations' && isOwner && <section className="admin-panel conversation-admin-panel">
        <div className="admin-panel-head"><div><h2>Conversations de tous les comptes</h2><p>Consultation en lecture seule. Les membres ne voient que leurs propres conversations ; seul le fondateur peut ouvrir les échanges des autres comptes.</p></div><span className="owner-only-pill"><Icon name="lock" size={12}/> Fondateur uniquement</span></div>
        <div className="admin-filters">
          <label className="admin-search"><Icon name="search" size={15}/><input value={conversationSearch} onChange={(event) => setConversationSearch(event.target.value)} placeholder="Rechercher un titre, un membre ou un modèle…"/></label>
          <select value={selectedUserFilter} onChange={(event) => setSelectedUserFilter(event.target.value)}><option value="all">Tous les membres</option>{users.map((user) => <option key={user.id} value={user.id}>{user.display_name || user.email}</option>)}</select>
        </div>
        <div className="conversation-browser">
          <div className="conversation-index">
            {filteredConversations.length === 0 ? <div className="admin-empty">Aucune conversation trouvée dans les conversations chargées.</div> : filteredConversations.map((conversation) => {
              const owner = userById.get(conversation.user_id);
              return <button className={`conversation-index-item ${selectedConversation?.id === conversation.id ? 'active' : ''}`} key={conversation.id} onClick={() => void openConversation(conversation)}>
                <strong>{conversation.title}</strong><span>{owner?.display_name || owner?.email || 'Compte supprimé'}</span><small>{dateTime(conversation.updated_at)} · {conversation.provider || 'puter'} · {conversation.model?.replace('anthropic/', '')}</small>
              </button>;
            })}
            {conversationsHasMore && <button className="secondary-button conversation-more" disabled={loadingMoreConversations} onClick={loadMoreConversations}>{loadingMoreConversations ? 'Chargement…' : `Charger plus (${conversations.length}/${conversationsTotal})`}</button>}
          </div>
          <div className="conversation-reader">
            {!selectedConversation ? <div className="admin-empty conversation-placeholder"><Icon name="messages" size={28}/><strong>Sélectionnez une conversation</strong><span>Son historique s’affichera ici en lecture seule.</span></div> : <>
              <div className="conversation-reader-head"><div><span className="eyebrow">TRANSCRIPTION · LECTURE SEULE</span><h3>{selectedConversation.title}</h3><p>{userById.get(selectedConversation.user_id)?.email || selectedConversation.user_id} · {selectedConversation.provider || 'puter'} · {selectedConversation.model}</p></div><button className="secondary-button" onClick={exportSelectedConversation} disabled={!selectedMessages.length || exportingMessages || loadingMessages}><Icon name="download" size={14}/> {exportingMessages ? 'Préparation…' : 'Exporter la transcription complète'}</button></div>
              {loadingMessages ? <div className="admin-empty">Chargement de la transcription…</div> : <div className="conversation-transcript">{selectedMessages.length ? selectedMessages.map((message) => <article className={`transcript-message ${message.role === 'user' ? 'transcript-user' : 'transcript-assistant'}`} key={message.id}><div><strong>{message.role === 'user' ? userById.get(selectedConversation.user_id)?.display_name || 'Utilisateur' : 'VERTEX AI'}</strong><time>{dateTime(message.created_at)}</time></div><p>{message.content}</p>{(message.provider || message.model) && <small>{message.provider || 'puter'} · {message.model}</small>}</article>) : <div className="admin-empty">Aucun message enregistré dans cette conversation.</div>}{messagesHasMore && <div className="admin-load-more"><button className="secondary-button" onClick={loadMoreMessages} disabled={loadingMoreMessages}>{loadingMoreMessages ? 'Chargement…' : `Charger la suite (${selectedMessages.length}/${selectedMessagesTotal})`}</button></div>}</div>}
            </>}

          </div>
        </div>
      </section>}

      {tab === 'activity' && isOwner && <section className="admin-panel">
        <div className="admin-panel-head"><div><h2>Journal d’activité</h2><p>Prompts, extraits de réponses et actions des utilisateurs. {logsTotal} événements au total.</p></div><button className="secondary-button" onClick={exportAllLogs} disabled={exportingLogs}><Icon name="download" size={14}/> {exportingLogs ? 'Préparation…' : 'Exporter tout le journal JSON'}</button></div>
        <div className="admin-filters"><label className="admin-search"><Icon name="search" size={15}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Rechercher dans les événements chargés…"/></label><select value={actionFilter} onChange={(event) => setActionFilter(event.target.value)}><option value="all">Toutes les activités</option>{[...new Set(logs.map((item) => item.action))].sort().map((action) => <option key={action} value={action}>{labelForAction(action)}</option>)}</select></div>
        <div className="audit-list">{filteredLogs.length === 0 ? <div className="admin-empty">Aucun événement pour ces filtres.</div> : filteredLogs.map((item) => <article className="audit-entry" key={item.id}><div className="audit-entry-head"><div><strong>{labelForAction(item.action)}</strong><span>{item.actor_email} · {item.actor_id ? item.actor_id.slice(0, 8) : 'système'}</span></div><time>{dateTime(item.created_at)}</time></div>{item.prompt_text && <div className="audit-prompt"><span>PROMPT ENVOYÉ</span><p>{item.prompt_text}</p></div>}{item.result_preview && <details className="audit-response"><summary>Voir l’extrait de réponse</summary><p>{item.result_preview}</p></details>}<div className="audit-meta"><span>{item.provider ? `${item.provider} · ` : ''}{item.model || item.entity_type}</span>{item.metadata?.conversation_title && <span>{item.metadata.conversation_title}</span>}{item.metadata?.duration_ms && <span>{item.metadata.duration_ms} ms</span>}{item.metadata?.character_count && <span>{item.metadata.character_count} caractères</span>}</div>{Object.keys(item.metadata || {}).length > 0 && <details className="audit-response audit-technical"><summary>Détails de l’événement</summary><pre>{JSON.stringify(item.metadata, null, 2)}</pre></details>}</article>)}</div>
        {logsHasMore && <div className="admin-load-more"><button className="secondary-button" onClick={loadMoreLogs} disabled={loadingMoreLogs}>{loadingMoreLogs ? 'Chargement…' : `Charger ${PAGE_SIZE} événements supplémentaires (${logs.length}/${logsTotal})`}</button></div>}
      </section>}

      {tab === 'users' && <section className="admin-panel">
        <div className="admin-panel-head"><div><h2>Comptes utilisateurs</h2><p>{isOwner ? 'Seul le fondateur peut inviter ou supprimer des comptes et attribuer les rôles.' : 'Consultation des comptes. La création et l’administration globale sont réservées au fondateur.'}</p></div></div>
        {isOwner && <form className="invite-form" onSubmit={invite}><label>Adresse e-mail<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="membre@exemple.fr"/></label><label>Nom affiché<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Nom (facultatif)"/></label><button className="primary-button" disabled={inviting}><Icon name="plus" size={14}/>{inviting ? 'Envoi…' : 'Inviter un membre'}</button></form>}
        <div className="user-table-wrap"><table className="admin-table"><thead><tr><th>Utilisateur</th><th>Rôle</th><th>État</th><th>Inscription</th><th>Actions</th></tr></thead><tbody>{users.map((target) => <tr key={target.id}><td><strong>{target.display_name || target.email?.split('@')[0]}</strong><small>{target.email}</small></td><td><span className={`role-pill role-${target.role}`}>{target.role === 'owner' ? 'Fondateur' : target.role === 'admin' ? 'Admin' : 'Utilisateur'}</span></td><td><span className={!target.is_active ? 'state-disabled' : !target.audit_consent_at ? 'state-pending' : 'state-active'}>{!target.is_active ? 'Suspendu' : !target.audit_consent_at ? 'Invitation en attente' : 'Actif'}</span></td><td>{dateTime(target.created_at)}</td><td><div className="table-actions">{isOwner && target.role !== 'owner' && <select aria-label={`Rôle de ${target.email}`} value={target.role} onChange={(event) => changeRole(target, event.target.value)}><option value="user">Utilisateur</option><option value="admin">Admin</option></select>}{isOwner && target.role !== 'owner' && target.id !== session.user.id && <><button className="secondary-button" onClick={() => changeActive(target)}>{target.is_active ? 'Suspendre' : 'Réactiver'}</button><button className="danger-button" onClick={() => deleteAccount(target)} title="Supprimer définitivement le compte"><Icon name="trash" size={13}/> Supprimer</button></>}</div></td></tr>)}</tbody></table></div>
      </section>}

      {tab === 'settings' && isOwner && <section className="admin-panel"><div className="admin-panel-head"><div><h2>Conservation des journaux</h2><p>Choisissez une durée de conservation limitée et compréhensible pour les membres.</p></div></div><div className="retention-setting"><label>Durée de conservation<select value={retention} onChange={(event) => setRetention(Number(event.target.value))}><option value={30}>30 jours</option><option value={90}>90 jours</option><option value={180}>180 jours</option><option value={365}>365 jours</option></select></label><button className="primary-button" disabled={savingRetention} onClick={saveRetention}>{savingRetention ? 'Enregistrement…' : 'Enregistrer'}</button></div><div className="retention-note"><Icon name="info" size={16}/> La purge automatique doit être programmée dans Supabase Cron. Les conversations restent disponibles tant que le compte et les données ne sont pas supprimés.</div></section>}
    </>}
    <footer className="admin-foot">Accès aux conversations et au journal complet réservé au fondateur · Consultations administratives elles-mêmes journalisées · VERTEX AI</footer>
  </main>;
}
