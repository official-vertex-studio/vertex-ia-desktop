import React, { useEffect, useState } from 'react';
import Icon from './Icon';
import { PROVIDERS } from '../lib/providers';

const DEFAULT_PROMPT = 'Tu es VERTEX AI, un assistant utile, rigoureux et professionnel. Réponds toujours en français, sauf demande contraire. Pour le code, privilégie des solutions claires, robustes et bien expliquées. Ne prétends jamais avoir effectué une action que tu n’as pas réalisée.';

function formatDate(value) {
  if (!value) return 'Date inconnue';
  try { return new Date(value).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }); }
  catch { return 'Date inconnue'; }
}

export default function SettingsModal({
  open, onClose, settings, onSave, signedIn, user, onSignOut,
  providerConnected, providerUser, onConnectProvider, onDisconnectProvider,
  providerStatus = {}, providerStatusError = '', isOwner = false,
  onSaveProviderKey, onDeleteProviderKey, onTestProvider,
  onExportAll, onImport,
}) {
  const [systemPrompt, setSystemPrompt] = useState(settings.systemPrompt || DEFAULT_PROMPT);
  const [draftKeys, setDraftKeys] = useState({});
  const [showKeys, setShowKeys] = useState({});
  const [saved, setSaved] = useState(false);
  const [keyStatus, setKeyStatus] = useState({});
  const [keyBusy, setKeyBusy] = useState({});

  useEffect(() => { setSystemPrompt(settings.systemPrompt || DEFAULT_PROMPT); }, [settings.systemPrompt, open]);
  useEffect(() => {
    setDraftKeys({});
    setShowKeys({});
    setKeyStatus({});
    setKeyBusy({});
  }, [open]);
  if (!open) return null;

  function save() {
    onSave({ ...settings, systemPrompt });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1700);
  }

  async function saveProviderKey(providerId) {
    const apiKey = (draftKeys[providerId] || '').trim();
    if (!apiKey) {
      setKeyStatus((current) => ({ ...current, [providerId]: 'Saisissez une clé API.' }));
      return;
    }
    setKeyBusy((current) => ({ ...current, [providerId]: true }));
    setKeyStatus((current) => ({ ...current, [providerId]: 'Vérification de la clé auprès du fournisseur, puis chiffrement et enregistrement…' }));
    try {
      const result = await onSaveProviderKey?.(providerId, apiKey);
      setDraftKeys((current) => ({ ...current, [providerId]: '' }));
      setKeyStatus((current) => ({ ...current, [providerId]: `Clé validée et enregistrée. ${result?.modelCount ?? 0} modèle(s) détecté(s).` }));
      setShowKeys((current) => ({ ...current, [providerId]: false }));
    } catch (error) {
      setKeyStatus((current) => ({ ...current, [providerId]: error?.message || 'Enregistrement impossible.' }));
    } finally {
      setKeyBusy((current) => ({ ...current, [providerId]: false }));
    }
  }

  async function testProvider(providerId) {
    setKeyBusy((current) => ({ ...current, [providerId]: true }));
    setKeyStatus((current) => ({ ...current, [providerId]: 'Test de la clé enregistrée…' }));
    try {
      const result = await onTestProvider?.(providerId);
      setKeyStatus((current) => ({ ...current, [providerId]: result || 'Connexion réussie.' }));
    } catch (error) {
      setKeyStatus((current) => ({ ...current, [providerId]: error?.message || 'Connexion impossible.' }));
    } finally {
      setKeyBusy((current) => ({ ...current, [providerId]: false }));
    }
  }

  async function deleteProviderKey(providerId) {
    const name = PROVIDERS.find((item) => item.id === providerId)?.name || providerId;
    if (!window.confirm(`Supprimer la clé globale ${name} ? Les membres ne pourront plus utiliser ce fournisseur tant qu'une nouvelle clé n'est pas enregistrée.`)) return;
    setKeyBusy((current) => ({ ...current, [providerId]: true }));
    setKeyStatus((current) => ({ ...current, [providerId]: 'Suppression de la clé globale…' }));
    try {
      await onDeleteProviderKey?.(providerId);
      setKeyStatus((current) => ({ ...current, [providerId]: 'Clé globale supprimée.' }));
    } catch (error) {
      setKeyStatus((current) => ({ ...current, [providerId]: error?.message || 'Suppression impossible.' }));
    } finally {
      setKeyBusy((current) => ({ ...current, [providerId]: false }));
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="modal-header"><div><span className="modal-eyebrow">PERSONNALISATION</span><h2 id="settings-title">Paramètres</h2></div><button className="icon-button" onClick={onClose} aria-label="Fermer"><Icon name="close"/></button></header>
        <div className="settings-content">
          <section className="settings-section">
            <div className="settings-section-title"><span className="settings-section-icon"><Icon name="user" size={16}/></span><div><strong>Compte VERTEX AI</strong><small>Identité et rôle sur cette application</small></div></div>
            <div className="account-settings-row"><div className="avatar-small">{user?.display_name?.[0]?.toUpperCase() || user?.email?.[0]?.toUpperCase() || 'V'}</div><div className="account-copy"><strong>{user?.display_name || user?.email}</strong><small>{user?.role === 'owner' ? 'Fondateur' : user?.role === 'admin' ? 'Administrateur' : 'Utilisateur'}</small></div><button className="secondary-button" onClick={onSignOut}>Déconnexion</button></div>
          </section>

          <section className="settings-section">
            <div className="settings-section-title"><span className="settings-section-icon"><Icon name="layers" size={16}/></span><div><strong>Fournisseurs IA</strong><small>Le Fondateur configure les clés partagées. Les membres choisissent le fournisseur et le modèle.</small></div></div>
            <div className="provider-key-card">
              <div className="provider-key-head"><div><strong>Puter</strong><small>{providerConnected ? (providerUser?.username || 'Compte Puter connecté') : 'Connexion par compte individuel, sans clé API VERTEX'}</small></div><button className="secondary-button" onClick={providerConnected ? onDisconnectProvider : onConnectProvider}>{providerConnected ? 'Déconnecter' : 'Connecter Puter'}</button></div>
              <p>Puter reste lié au compte Puter de chaque utilisateur. Les clés Groq, Gemini et OpenRouter ci-dessous sont, elles, centralisées et gérées par le Fondateur.</p>
            </div>

            <div className="provider-management-heading">
              <div><strong>Clés API globales</strong><small>{isOwner ? 'Ces identifiants seront utilisés par tous les membres VERTEX ; leurs requêtes consommeront les quotas et crédits du compte fournisseur du Fondateur.' : 'État des fournisseurs configurés par le Fondateur.'}</small></div>
              <span className="provider-owner-badge"><Icon name={isOwner ? 'shield' : 'lock'} size={12}/>{isOwner ? 'Gestion Fondateur' : 'Lecture seule'}</span>
            </div>
            {providerStatusError && <div className="provider-key-status is-error">{providerStatusError}</div>}

            {PROVIDERS.filter((provider) => provider.keyLabel).map((provider) => {
              const status = providerStatus[provider.id] || {};
              const busy = Boolean(keyBusy[provider.id]);
              return <div className="provider-key-card" key={provider.id}>
                <div className="provider-key-head">
                  <div><strong>{provider.name}</strong><small>{provider.help}</small></div>
                  <div className="provider-key-status-pill">
                    <span className={`status-dot ${status.configured ? 'online' : 'offline'}`}/>
                    {status.configured ? 'Configuré' : 'Non configuré'}
                  </div>
                </div>
                {isOwner ? (
                  <>
                    <label className="provider-key-label">{status.configured ? 'Remplacer la clé API' : provider.keyLabel}
                      <div className="provider-key-input-row"><input type={showKeys[provider.id] ? 'text' : 'password'} autoComplete="new-password" spellCheck="false" value={draftKeys[provider.id] || ''} onChange={(event) => setDraftKeys((current) => ({ ...current, [provider.id]: event.target.value }))} placeholder={status.configured ? 'Saisir une nouvelle clé pour remplacer celle en place' : 'Collez la clé API du compte Fondateur'}/><button type="button" className="icon-button" onClick={() => setShowKeys((current) => ({ ...current, [provider.id]: !current[provider.id] }))} title={showKeys[provider.id] ? 'Masquer la clé' : 'Afficher la clé'}><Icon name={showKeys[provider.id] ? 'eyeOff' : 'eye'} size={15}/></button></div>
                    </label>
                    <div className="provider-key-actions">
                      <button className="primary-button" onClick={() => saveProviderKey(provider.id)} disabled={busy || !(draftKeys[provider.id] || '').trim()}><Icon name="lock" size={13}/>{busy ? 'Traitement…' : 'Vérifier et enregistrer'}</button>
                      <a className="provider-key-link" href={provider.keyUrl} target="_blank" rel="noreferrer">Obtenir une clé <Icon name="external" size={12}/></a>
                    </div>
                    {status.configured && <div className="provider-key-meta">Dernière mise à jour : {formatDate(status.updatedAt)}{status.keyHint ? ` · Clé se terminant par ${status.keyHint}` : ''}</div>}
                    {status.configured && <div className="provider-key-actions"><button className="secondary-button" onClick={() => testProvider(provider.id)} disabled={busy}><Icon name="checkCircle" size={13}/> Tester la clé enregistrée</button><button className="text-danger-button" onClick={() => deleteProviderKey(provider.id)} disabled={busy}>Supprimer la clé</button></div>}
                  </>
                ) : (
                  <div className="provider-member-status">{status.configured ? `Ce fournisseur est prêt à être utilisé avec la clé globale gérée par le Fondateur. Dernière mise à jour : ${formatDate(status.updatedAt)}.` : 'Ce fournisseur n’est pas encore configuré. Contactez le Fondateur de VERTEX AI.'}</div>
                )}
                {keyStatus[provider.id] && <div className={`provider-key-status ${/impossible|erreur|401|403|404|429|invalide|introuvable/i.test(keyStatus[provider.id]) ? 'is-error' : 'is-ok'}`}>{keyStatus[provider.id]}</div>}
              </div>;
            })}
            <div className="provider-security-note"><Icon name="shield" size={15}/><span>Les clés API Groq, Gemini et OpenRouter sont saisies uniquement par le Fondateur. Tous les membres consomment les quotas et crédits de ces comptes fournisseur. Les clés sont chiffrées avec AES-256-GCM dans la fonction Supabase avant stockage en base. Le navigateur ne reçoit jamais les clés ni leur texte chiffré ; les membres ne voient que l’état configuré / non configuré. Les clés sont utilisées côté serveur pour charger les catalogues et transmettre les requêtes aux fournisseurs.</span></div>
          </section>

          <section className="settings-section"><div className="settings-section-title"><span className="settings-section-icon"><Icon name="spark" size={16}/></span><div><strong>Instructions de l'assistant</strong><small>Consignes ajoutées à chaque conversation, quel que soit le fournisseur</small></div></div><textarea className="system-prompt-input" value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={7}/><div className="settings-tip">Ces préférences sont enregistrées dans ce navigateur. Elles ne remplacent pas les règles de sécurité de l'application.</div></section>

          <section className="settings-section"><div className="settings-section-title"><span className="settings-section-icon"><Icon name="shield" size={16}/></span><div><strong>Confidentialité et journalisation</strong><small>Information importante sur les comptes de cette instance</small></div></div><ul className="privacy-list"><li>Chaque membre ne peut consulter que ses propres conversations dans l'interface.</li><li>Le Fondateur peut consulter les conversations complètes de tous les comptes en lecture seule. Les administrateurs secondaires ne disposent pas de cet accès.</li><li>Les prompts, réponses, fournisseur et modèle utilisés sont journalisés dans Supabase. Les messages sont transmis au fournisseur sélectionné pour générer la réponse.</li><li>Les clés API Groq, Gemini et OpenRouter sont des clés globales fournies par le Fondateur. Elles sont chiffrées et utilisées côté serveur ; aucun membre ne peut les consulter.</li><li>Changer de fournisseur conserve l’historique du chat : jusqu’aux 80 derniers messages, y compris les fichiers texte/code joints, sont transmis au nouveau modèle.</li><li>Ne transmettez jamais de mots de passe, clés API ou secrets dans le chat.</li><li>Le site ne peut pas modifier les fichiers de votre ordinateur : il s'agit d'un chatbot web.</li></ul></section>

          <section className="settings-section"><div className="settings-section-title"><span className="settings-section-icon"><Icon name="download" size={16}/></span><div><strong>Sauvegarde</strong><small>Exporter ou importer vos conversations</small></div></div><div className="backup-actions"><button className="secondary-button" onClick={onExportAll}><Icon name="download" size={14}/> Exporter JSON</button><button className="secondary-button" onClick={onImport}><Icon name="external" size={14}/> Importer JSON</button></div></section>
        </div>
        <footer className="modal-footer"><button className="secondary-button" onClick={onClose}>Fermer</button><button className="primary-button" onClick={save}><Icon name={saved ? 'check' : 'checkCircle'} size={15}/>{saved ? 'Enregistré' : 'Enregistrer les paramètres'}</button></footer>
      </section>
    </div>
  );
}
