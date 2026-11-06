import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseConfigured = Boolean(url && anonKey);
export const supabase = supabaseConfigured
  ? createClient(url, anonKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
      global: { headers: { 'x-application-name': 'vertex-ai' } },
    })
  : null;

export function getSupabaseConfigError() {
  if (supabaseConfigured) return '';
  return 'Supabase n’est pas configuré. Copiez .env.example vers .env.local et renseignez VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY.';
}
