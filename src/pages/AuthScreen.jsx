import React, { useState } from 'react';
import Icon from '../components/Icon';

export default function AuthScreen({ supabase, onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [resetMode, setResetMode] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError(''); setNotice(''); setBusy(true);
    try {
      if (resetMode) {
        const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/auth/accept-invite?flow=recovery` });
        if (resetError) throw resetError;
        setNotice('Un lien de réinitialisation a été envoyé si cette adresse est connue.');
      } else {
        const { data, error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (signInError) throw signInError;
        if (!data.session) throw new Error('Aucune session active. Vérifiez votre adresse e-mail si une confirmation est requise.');
        await onSignedIn(data.session);
      }
    } catch (err) { setError(err?.message || 'Connexion impossible.'); }
    finally { setBusy(false); }
  }

  return <main className="auth-screen">
    <div className="auth-glow auth-glow-one"/><div className="auth-glow auth-glow-two"/>
    <section className="auth-card">
      <div className="auth-brand"><span className="brand-mark"><Icon name="logo" size={24}/></span><span><strong>VERTEX<span>AI</span></strong><small>PRIVATE INTELLIGENCE WORKSPACE</small></span></div>
      <div className="auth-heading"><div className="auth-icon"><Icon name="shield" size={22}/></div><span className="eyebrow">ESPACE PRIVÉ</span><h1>{resetMode ? 'Réinitialiser le mot de passe' : 'Content de vous revoir.'}</h1><p>{resetMode ? 'Indiquez votre adresse e-mail pour recevoir un lien sécurisé.' : 'Connectez-vous à votre espace de travail VERTEX AI.'}</p></div>
      <form className="auth-form" onSubmit={submit}>
        <label>Adresse e-mail<input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="vous@exemple.fr" required/></label>
        {!resetMode && <label>Mot de passe<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Votre mot de passe" minLength={8} required/></label>}
        {error && <div className="auth-alert auth-alert-error"><Icon name="info" size={15}/>{error}</div>}
        {notice && <div className="auth-alert auth-alert-success"><Icon name="checkCircle" size={15}/>{notice}</div>}
        <button className="auth-submit" disabled={busy}>{busy ? 'Veuillez patienter…' : resetMode ? 'Envoyer le lien' : 'Se connecter'}<Icon name="arrowUp" size={16}/></button>
      </form>
      <button className="auth-link" onClick={() => { setResetMode((value) => !value); setError(''); setNotice(''); }}>{resetMode ? 'Retour à la connexion' : 'Mot de passe oublié ?'}</button>
      <div className="auth-invite-note"><Icon name="lock" size={15}/><span>Les comptes sont créés sur invitation par le propriétaire de VERTEX AI. Contactez votre administrateur pour obtenir un accès.</span></div>
      <div className="auth-footer">VERTEX STUDIO · ACCÈS SÉCURISÉ</div>
    </section>
  </main>;
}

export function AuditConsent({ onAccept, busy }) {
  const [checked, setChecked] = useState(false);
  return <main className="auth-screen"><div className="auth-glow auth-glow-one"/><section className="auth-card consent-card">
    <div className="auth-brand"><span className="brand-mark"><Icon name="logo" size={24}/></span><span><strong>VERTEX<span>AI</span></strong><small>TRANSPARENCE & CONFIDENTIALITÉ</small></span></div>
    <div className="auth-heading"><div className="auth-icon"><Icon name="shield" size={22}/></div><span className="eyebrow">AVANT DE COMMENCER</span><h1>Journalisation des activités</h1><p>Ce service est administré par un compte propriétaire. Pour la sécurité et le suivi de l'utilisation, certaines activités sont consignées.</p></div>
    <div className="consent-details"><strong>Ce qui est enregistré</strong><ul><li>Le contenu intégral des prompts envoyés et les extraits des réponses enregistrées (jusqu’à 4 000 caractères).</li><li>Le modèle utilisé, les dates, la durée et les erreurs éventuelles.</li><li>La création, le renommage, l’export et la suppression des conversations.</li><li>Les événements de compte : connexion, invitation, changement de rôle, suspension et suppression.</li></ul><strong>Qui peut consulter ces journaux ?</strong><p>Seul le compte Fondateur (propriétaire) peut consulter les conversations complètes de tous les comptes, y compris les prompts et les réponses. Les rôles Administrateur et Utilisateur ne disposent pas de cet accès transversal. Les messages sont également transmis au fournisseur sélectionné (Puter, Groq, Google Gemini ou OpenRouter) pour générer les réponses. Les clés API directes sont utilisées en mémoire de session et ne sont pas conservées dans la base VERTEX. N’envoyez pas de mots de passe, clés API ou informations confidentielles.</p><strong>Conservation</strong><p>La durée par défaut est de 90 jours. Le propriétaire peut ajuster la durée et purger les journaux anciens. Contactez le responsable de VERTEX AI pour exercer vos droits concernant vos données.</p></div>
    <label className="consent-check"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)}/><span>J'ai lu et compris que le Fondateur peut consulter mes conversations complètes et que mes prompts et activités sont journalisés.</span></label>
    <button className="auth-submit" disabled={!checked || busy} onClick={onAccept}>{busy ? 'Enregistrement…' : 'Accepter et continuer'}<Icon name="arrowUp" size={16}/></button>
    <div className="auth-footer">Vous pouvez demander des informations sur le traitement de vos données au propriétaire du service.</div>
  </section></main>;
}

export function PasswordSetup({ supabase, onComplete }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault(); setError('');
    if (password.length < 10) { setError('Choisissez un mot de passe d’au moins 10 caractères.'); return; }
    if (password !== confirm) { setError('Les deux mots de passe ne correspondent pas.'); return; }
    setBusy(true);
    try { const { error: updateError } = await supabase.auth.updateUser({ password }); if (updateError) throw updateError; await onComplete(); }
    catch (err) { setError(err?.message || 'Impossible de définir le mot de passe.'); }
    finally { setBusy(false); }
  }
  return <main className="auth-screen"><section className="auth-card"><div className="auth-brand"><span className="brand-mark"><Icon name="logo" size={24}/></span><span><strong>VERTEX<span>AI</span></strong><small>ACTIVATION DU COMPTE</small></span></div><div className="auth-heading"><div className="auth-icon"><Icon name="lock" size={22}/></div><span className="eyebrow">BIENVENUE</span><h1>Définissez votre mot de passe.</h1><p>Choisissez un mot de passe robuste pour terminer l’activation de votre compte.</p></div><form className="auth-form" onSubmit={submit}><label>Nouveau mot de passe<input type="password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required/></label><label>Confirmer le mot de passe<input type="password" autoComplete="new-password" minLength={10} value={confirm} onChange={(e) => setConfirm(e.target.value)} required/></label>{error && <div className="auth-alert auth-alert-error"><Icon name="info" size={15}/>{error}</div>}<button className="auth-submit" disabled={busy}>{busy ? 'Enregistrement…' : 'Activer mon compte'}<Icon name="arrowUp" size={16}/></button></form><div className="auth-footer">VERTEX STUDIO · ACCÈS SÉCURISÉ</div></section></main>;
}
