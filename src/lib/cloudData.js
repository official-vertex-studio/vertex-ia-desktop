export function toConversation(row, messages = []) {
  return {
    id: row.id,
    title: row.title,
    provider: row.provider || 'puter',
    model: row.model,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      provider: message.provider || 'puter',
      model: message.model,
      timestamp: new Date(message.created_at).getTime(),
      usage: message.metadata?.usage || null,
      error: Boolean(message.metadata?.error),
    })),
  };
}

export async function fetchWorkspace(supabase, userId) {
  const { data: conversationRows, error: conversationsError } = await supabase
    .from('conversations')
    .select('id,title,provider,model,created_at,updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (conversationsError) throw conversationsError;
  if (!conversationRows?.length) return [];

  const ids = conversationRows.map((item) => item.id);
  const { data: messageRows, error: messagesError } = await supabase
    .from('messages')
    .select('id,conversation_id,role,content,provider,model,metadata,created_at')
    .in('conversation_id', ids)
    .order('created_at', { ascending: true });
  if (messagesError) throw messagesError;

  const grouped = new Map();
  for (const message of messageRows || []) {
    if (!grouped.has(message.conversation_id)) grouped.set(message.conversation_id, []);
    grouped.get(message.conversation_id).push(message);
  }
  return conversationRows.map((row) => toConversation(row, grouped.get(row.id) || []));
}

export async function logActivity(supabase, action, entityType = 'app', entityId = null, details = {}) {
  const { error } = await supabase.rpc('log_activity', {
    p_action: action,
    p_entity_type: entityType,
    p_entity_id: entityId,
    p_details: details,
  });
  if (error) console.warn('[VERTEX audit]', error.message);
}
