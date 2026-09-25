import { getSession } from '../session';
import { DECLINE_CALLBACK_PREFIX, JOIN_CALLBACK_PREFIX, SYSTEM_CHAT_ID } from '../telegram';

// The Join / Decline buttons under an invitation in the Onym system chat
export async function answerCallbackButton({ chatId, data }: {
  chatId: string; accessHash?: string; messageId: number; data?: string; isGame?: boolean;
}) {
  const current = getSession();
  if (!current || chatId !== SYSTEM_CHAT_ID || !data) return undefined;

  if (data.startsWith(JOIN_CALLBACK_PREFIX)) {
    const message = await current.messenger.acceptOffer(data.slice(JOIN_CALLBACK_PREFIX.length));
    return { message, cacheTime: 0 };
  }

  if (data.startsWith(DECLINE_CALLBACK_PREFIX)) {
    current.messenger.declineOffer(data.slice(DECLINE_CALLBACK_PREFIX.length));
    return { message: 'Invitation declined. Nothing was sent to the inviter.', cacheTime: 0 };
  }

  return undefined;
}
