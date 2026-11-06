import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import DesktopApp from './desktop/DesktopApp';
import './styles.css';

const isTauriDesktop = Boolean(window.__TAURI_INTERNALS__);

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isTauriDesktop ? <DesktopApp /> : <App />}
  </React.StrictMode>,
);
