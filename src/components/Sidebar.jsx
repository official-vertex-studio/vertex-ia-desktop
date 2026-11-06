import React from 'react';
import Icon from './Icon';

function formatGroup(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (sameDay) return "Aujourd'hui";
  if (date.toDateString() === yesterday.toDateString()) return 'Hier';
  return 'Précédemment';
}

export default function Sidebar({ conversations, activeId, onNew, onSelect, onSearch, search, onRename, onDelete, onSettings, user, onSignOut, signedIn, mobileOpen, onClose, isAdmin, onAdmin }) {
  const filtered = conversations.filter((chat) => chat.title.toLowerCase().includes(search.toLowerCase()));
  const groups = ["Aujourd'hui", 'Hier', 'Précédemment'];
  const displayName = user?.display_name || user?.email?.split('@')[0] || 'Compte';
  return <>
    {mobileOpen && <button className="mobile-scrim" aria-label="Fermer le menu" onClick={onClose}/>}
    <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
      <div className="sidebar-top"><a className="brand" href="#home" onClick={(event) => { event.preventDefault(); onNew(); }}><span className="brand-mark"><Icon name="logo" size={22} strokeWidth={2.1}/></span><span className="brand-copy"><strong>VERTEX<span>AI</span></strong><small>YOUR INTELLIGENCE SPACE</small></span></a><button className="icon-button sidebar-close" onClick={onClose} aria-label="Fermer le menu"><Icon name="close"/></button></div>
      <button className="new-chat-button" onClick={() => { onNew(); onClose(); }}><Icon name="plus" size={17}/> Nouvelle conversation <span>⌘ K</span></button>
      <label className="search-box"><Icon name="search" size={16}/><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Rechercher une conversation"/><kbd>⌘ F</kbd></label>
      <div className="history-area"><div className="section-label">ESPACE PERSONNEL <span>{filtered.length}</span></div>
        {filtered.length === 0 ? <div className="empty-history">{search ? 'Aucun résultat.' : 'Vos conversations apparaîtront ici.'}</div> : groups.map((group) => {
          const items = filtered.filter((chat) => formatGroup(chat.updatedAt) === group).sort((a, b) => b.updatedAt - a.updatedAt);
          if (!items.length) return null;
          return <div className="history-group" key={group}><div className="history-group-label">{group}</div>{items.map((chat) => <div className={`history-item ${chat.id === activeId ? 'active' : ''}`} key={chat.id}><button className="history-select" onClick={() => { onSelect(chat.id); onClose(); }} title={chat.title}><Icon name="message" size={15}/><span>{chat.title}</span></button><div className="history-actions"><button title="Renommer" onClick={() => onRename(chat.id)}><Icon name="edit" size={13}/></button><button title="Supprimer" onClick={() => onDelete(chat.id)}><Icon name="trash" size={13}/></button></div></div>)}</div>;
        })}
      </div>
      <div className="sidebar-bottom">
        <div className="provider-card"><span className="provider-dot"/><div><strong>Puter AI</strong><small>Modèle IA hébergé</small></div><span className="provider-status">CLOUD</span></div>
        {isAdmin && <button className="sidebar-link admin-sidebar-link" onClick={() => { onAdmin(); onClose(); }}><Icon name="shield" size={17}/> Administration <span>ADMIN</span></button>}
        <button className="sidebar-link" onClick={onSettings}><Icon name="settings" size={17}/> Paramètres <span>⌘ ,</span></button>
        <div className="account-row"><div className="avatar-small">{displayName?.[0]?.toUpperCase() || 'V'}</div><div className="account-copy"><strong>{displayName}</strong><small>{user?.role === 'owner' ? 'Fondateur' : user?.role === 'admin' ? 'Administrateur' : 'Compte utilisateur'}</small></div><button className="account-action" onClick={onSignOut} title={signedIn ? 'Se déconnecter' : 'Compte'}><Icon name="external" size={16}/></button></div>
      </div>
    </aside>
  </>;
}
