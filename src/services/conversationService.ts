import { Conversation, Message } from '@/types';

const mockConversations: Conversation[] = [
  {
    id: 'conv1',
    organization_id: 'org1',
    customer_id: 'c1',
    platform: 'instagram',
    status: 'open',
    last_message_at: new Date().toISOString(),
  }
];

const mockMessages: Message[] = [
  {
    id: 'm1',
    conversation_id: 'conv1',
    sender_type: 'customer',
    content: 'Hello, do you deliver to Oran?',
    created_at: new Date().toISOString(),
  }
];

export const conversationService = {
  async getConversations(organizationId: string): Promise<Conversation[]> {
    await new Promise(resolve => setTimeout(resolve, 500));
    return mockConversations.filter(c => c.organization_id === organizationId);
  },
  async getMessages(conversationId: string): Promise<Message[]> {
    await new Promise(resolve => setTimeout(resolve, 500));
    return mockMessages.filter(m => m.conversation_id === conversationId);
  }
};

