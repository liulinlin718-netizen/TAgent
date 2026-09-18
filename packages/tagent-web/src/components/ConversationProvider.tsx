'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createConversationStore, type ConversationStore } from '../lib/conversations';

const ConversationContext = createContext<ConversationStore | null>(null);

export function ConversationProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createConversationStore);
  useEffect(() => () => store.dispose(), [store]);
  return <ConversationContext.Provider value={store}>{children}</ConversationContext.Provider>;
}

export function useConversations() {
  const store = useContext(ConversationContext);
  if (!store) throw new Error('ConversationProvider is required');
  return store;
}
