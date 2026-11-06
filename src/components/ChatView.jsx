import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import Markdown from './Markdown';

const suggestions = [
  { icon: 'code', title: 'Développer un projet', text: 'Aide-moi à concevoir et développer une application propre et maintenable.' },
  { icon: 'box', title: 'Minecraft & plugins', text: 'Aide-moi à créer un plugin Paper avec une architecture professionnelle.' },
  { icon: 'bug', title: 'Déboguer du code', text: 'Analyse ce code, trouve les erreurs et propose une correction expliquée.' },
  { icon: 'spark', title: 'Explorer une idée', text: 'Aide-moi à transformer mon idée en un plan de réalisation concret.' },
];

function BrandAvatar({ small = false }) {
  return <div className={`assistant-avatar ${small ? 'assistant-avatar-small' : ''}`}><Icon name="spark" size={small ? 15 : 19}/></div>;
}

function MessageActions({ message, onRegenerate, isLastAssistant }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(message.content); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); }
  }
  return <div className="message-actions"><button onClick={copy} title="Copier la réponse"><Icon name={copied ? 'check' : 'copy'} size={14}/>{copied ? 'Copié' : 'Copier'}</button>{isLastAssistant && <button onClick={onRegenerate} title="Régénérer la réponse"><Icon name="refresh" size={14}/>Régénérer</button>}</div>;
}

export default function ChatView({
  conversation, provider, providers, model, models, modelsLoading, modelsError,
  onProviderChange, onModelChange, onRefreshModels, onSend, onStop, busy,
  onRegenerate, providerConnected, providerReady, onSignIn, onOpenSidebar,
  onExport, onOpenSettings, user,
}) {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [fileError, setFileError] = useState('');
  const [modelNote, setModelNote] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const textareaRef = useRef(null);
  const bottomRef = useRef(null);
  const fileRef = useRef(null);
  const messages = conversation?.messages || [];
  const isEmpty = messages.length === 0;
  const selectedProvider = providers.find((item) => item.id === provider) || providers[0];
  const currentModel = models.find((item) => item.id === model) || { id: model, name: model || 'Choisir un modèle', detail: '' };
  const lastAssistantIndex = messages.map((message) => message.role).lastIndexOf('assistant');
  const filteredModels = useMemo(() => {
    const needle = modelSearch.trim().toLowerCase();
    if (!needle) return models;
    return models.filter((item) => `${item.name} ${item.id} ${item.detail || ''}`.toLowerCase().includes(needle));
  }, [models, modelSearch]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: busy ? 'smooth' : 'auto', block: 'end' }); }, [messages, busy]);
  useEffect(() => { setModelSearch(''); }, [provider]);
  useEffect(() => { if (!busy && textareaRef.current) textareaRef.current.focus(); }, [conversation?.id]);

  async function addFiles(event) {
    const files = Array.from(event.target.files || []);
    setFileError('');
    let acceptedCount = attachments.length;
    for (const file of files) {
      if (acceptedCount >= 8) { setFileError('Limite de 8 fichiers par message.'); break; }
      if (file.size > 160 * 1024) { setFileError(`${file.name} dépasse la limite de 160 Ko.`); continue; }
      if (!/\.(txt|md|json|js|jsx|ts|tsx|css|html|yml|yaml|java|py|go|php|sql|xml|log|toml|properties|gradle|sh|ps1|vue|svelte|bbmodel|mcmeta|cfg|ini|bat|c|cpp|h|cs|rb|rs|kt|swift)$/i.test(file.name)) { setFileError(`${file.name} : type de fichier non pris en charge.`); continue; }
      try { const text = await file.text(); setAttachments((current) => [...current, { id: `${file.name}-${file.lastModified}`, name: file.name, text }]); acceptedCount += 1; }
      catch { setFileError(`Impossible de lire ${file.name}.`); }
    }
    event.target.value = '';
  }

  function submit() {
    const trimmed = input.trim();
    if ((!trimmed && attachments.length === 0) || busy) return;
    const fileContext = attachments.map((file) => `\n\n--- Fichier joint : ${file.name} ---\n${file.text}\n--- Fin du fichier ---`).join('');
    const message = `${trimmed}${fileContext}`.trim();
    onSend(message);
    setInput(''); setAttachments([]); setFileError('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }

  function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
  }

  function handleInput(event) {
    setInput(event.target.value);
    event.target.style.height = 'auto';
    event.target.style.height = `${Math.min(event.target.scrollHeight, 190)}px`;
  }

  const providerNeedsPuterLogin = provider === 'puter' && !providerConnected;
  const providerMissingKey = provider !== 'puter' && !providerReady;

  return (
    <main className="main-panel">
      <header className="topbar">
        <div className="topbar-left"><button className="icon-button mobile-menu-button" onClick={onOpenSidebar} aria-label="Ouvrir le menu"><Icon name="menu"/></button><div className="crumb"><span>Workspace</span><Icon name="chevron" size={13}/><strong>{conversation?.title || 'Nouvelle conversation'}</strong></div></div>
        <div className="topbar-right provider-model-controls">
          <label className="provider-select-wrap"><span>FOURNISSEUR</span><select aria-label="Choisir le fournisseur IA" value={provider} onChange={(event) => onProviderChange(event.target.value)} disabled={busy}>{providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label className="model-select-wrap"><span>MODÈLE {modelsLoading ? '· CHARGEMENT' : ''}</span><div className="model-select-row"><select aria-label="Choisir le modèle IA" value={models.some((item) => item.id === model) ? model : ''} onChange={(event) => onModelChange(event.target.value)} disabled={busy || modelsLoading || models.length === 0}><option value="" disabled>{modelsLoading ? 'Chargement des modèles…' : 'Choisir un modèle'}</option>{filteredModels.map((item) => <option key={item.id} value={item.id}>{item.name}{item.free ? ' · Gratuit' : ''}</option>)}</select>{models.length > 18 && <input className="model-filter-input" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="Filtrer…" aria-label="Filtrer les modèles"/>}<button className="model-refresh-button" onClick={onRefreshModels} disabled={modelsLoading || busy} title="Actualiser le catalogue des modèles"><Icon name="refresh" size={14}/></button></div></label>
          <button className="topbar-icon" title="Exporter la conversation" onClick={onExport} disabled={messages.length === 0}><Icon name="download" size={17}/></button>
          <button className="profile-pill" onClick={onOpenSettings}><span className="profile-dot"/><span>{user?.display_name || user?.email?.split('@')[0] || 'Compte'}</span></button>
        </div>
      </header>

      {modelsError && <div className="provider-inline-error"><Icon name="info" size={14}/>{modelsError}<button onClick={onOpenSettings}>Configurer</button></div>}
      <div className={`chat-scroll ${isEmpty ? 'chat-scroll-empty' : ''}`}>
        {isEmpty ? <div className="welcome-wrap">
          <div className="welcome-orb"><div className="orb-core"><Icon name="spark" size={31}/></div><span className="orb-ring orb-ring-one"/><span className="orb-ring orb-ring-two"/></div>
          <div className="eyebrow"><span/> VOTRE ESPACE D'INTELLIGENCE</div>
          <h1>Qu'est-ce qu'on <span>construit</span><br/>aujourd'hui&nbsp;?</h1>
          <p className="welcome-description">Un espace pour réfléchir, créer et résoudre. Posez votre question, partagez une idée ou démarrez un nouveau projet.</p>
          <div className="suggestion-grid">{suggestions.map((item) => <button className="suggestion-card" key={item.title} onClick={() => { setInput(item.text); textareaRef.current?.focus(); }}><span className={`suggestion-icon suggestion-${item.icon}`}><Icon name={item.icon === 'code' ? 'edit' : item.icon === 'box' ? 'logo' : item.icon === 'bug' ? 'search' : 'spark'} size={17}/></span><span><strong>{item.title}</strong><small>{item.text}</small></span><Icon name="chevron" size={15} className="suggestion-arrow"/></button>)}</div>
          <div className="welcome-foot"><Icon name="shield" size={14}/> Historique synchronisé · fournisseur : {selectedProvider.name} · modèle : {currentModel.name}. <button onClick={() => setModelNote(!modelNote)}>Confidentialité</button></div>
          {modelNote && <div className="model-note">Les messages sont envoyés au fournisseur et au modèle sélectionnés. Les prompts et actions sont journalisés dans VERTEX AI. Le Fondateur peut consulter les conversations complètes en lecture seule. Les clés API personnelles restent dans la session du navigateur et ne sont pas enregistrées en base. Changer de fournisseur conserve le chat : les 80 derniers messages, y compris le code joint, sont transmis au nouveau modèle.</div>}
        </div> : <div className="messages-wrap">{messages.map((message, index) => (
          <article className={`message-row ${message.role === 'user' ? 'message-user' : 'message-assistant'}`} key={message.id || index}>
            {message.role === 'assistant' && <BrandAvatar small/>}
            <div className="message-column">
              <div className="message-meta"><strong>{message.role === 'user' ? 'Vous' : 'VERTEX AI'}</strong><span>{message.timestamp ? new Date(message.timestamp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : ''}</span>{(message.provider || message.model) && <span className="message-model">{message.provider ? `${message.provider} · ` : ''}{message.model?.replace('anthropic/', '')}</span>}</div>
              <div className={`message-content ${message.role === 'user' ? 'user-content' : 'assistant-content'}`}>
                {message.role === 'assistant' ? <Markdown content={message.content}/> : <div className="user-text">{message.content}</div>}
                {message.pending && !message.content && <div className="thinking-indicator"><i/><i/><i/><span>Réflexion en cours…</span></div>}
              </div>
              {message.role === 'assistant' && message.content && <MessageActions message={message} onRegenerate={onRegenerate} isLastAssistant={index === lastAssistantIndex && !busy}/>}
              {message.usage && <div className="usage-note">{message.usage.inputTokens || 0} tokens entrée · {message.usage.outputTokens || 0} tokens sortie</div>}
            </div>
          </article>
        ))}<div ref={bottomRef}/></div>}
      </div>

      <div className="composer-area">
        {providerNeedsPuterLogin && <div className="signin-hint"><Icon name="info" size={14}/> Connectez votre compte Puter pour utiliser ce fournisseur. <button onClick={onSignIn}>Connecter Puter</button></div>}
        {providerMissingKey && <div className="signin-hint"><Icon name="info" size={14}/> Ajoutez une clé API {selectedProvider.name} pour envoyer des messages. <button onClick={onOpenSettings}>Configurer le fournisseur</button></div>}
        <div className="composer-shell">
          {attachments.length > 0 && <div className="attachment-list">{attachments.map((file) => <div className="attachment-chip" key={file.id}><Icon name="paperclip" size={13}/><span>{file.name}</span><button onClick={() => setAttachments((current) => current.filter((item) => item.id !== file.id))} aria-label="Retirer le fichier"><Icon name="close" size={13}/></button></div>)}</div>}
          <textarea ref={textareaRef} value={input} onChange={handleInput} onKeyDown={handleKeyDown} placeholder="Écrivez votre message…" rows={1} disabled={busy}/>
          <div className="composer-toolbar"><div className="composer-tools"><button className="tool-button" onClick={() => fileRef.current?.click()} title="Joindre un fichier texte ou code" disabled={busy}><Icon name="paperclip" size={17}/><span>Joindre du code</span></button><input ref={fileRef} type="file" multiple hidden accept=".txt,.md,.json,.js,.jsx,.ts,.tsx,.css,.html,.yml,.yaml,.java,.py,.go,.php,.sql,.xml,.log,.toml,.properties,.gradle,.sh,.ps1,.vue,.svelte,.bbmodel,.mcmeta,.cfg,.ini,.bat,.c,.cpp,.h,.cs,.rb,.rs,.kt,.swift" onChange={addFiles}/><span className="composer-shortcut">Maj + Entrée pour une nouvelle ligne · 8 fichiers max · 160 Ko chacun</span></div>
            <div className="composer-send-area"><span className="composer-model-label">{selectedProvider.name} · {currentModel.name}</span>{busy ? <button className="send-button stop-button" onClick={onStop} title="Arrêter la génération"><Icon name="stop" size={17}/></button> : <button className="send-button" onClick={submit} disabled={(!input.trim() && attachments.length === 0) || providerNeedsPuterLogin || providerMissingKey || modelsLoading} title="Envoyer le message"><Icon name="arrowUp" size={18}/></button>}</div>
          </div>
        </div>
        {fileError && <div className="file-error">{fileError}</div>}
        <div className="disclaimer">VERTEX AI peut faire des erreurs. Vérifiez les informations importantes. <span>{selectedProvider.name} · {currentModel.name} · clés API propres à chaque compte</span></div>
      </div>
    </main>
  );
}
