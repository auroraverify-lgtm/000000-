import { checkOutgoingContent } from './security-client.js';

export async function assertOutgoingContent({ chat, userId, text }) {
  const content = String(text || '');
  if (!content.trim()) return;
  const result = await checkOutgoingContent({
    chatId: chat.id,
    userId,
    context: chat.type,
    text: content,
  });
  if (result.blocked) {
    throw Object.assign(new Error(result.message || 'Сообщение заблокировано правилами Aurora Security'), {
      status: 403,
      code: 'blocked_content',
    });
  }
}
