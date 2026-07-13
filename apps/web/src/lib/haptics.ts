/**
 * Telegram Mini App haptics (решение №36 блица): лёгкая вибрация на успех/
 * ошибку мутаций. Вне Telegram (обычный браузер) — тихий no-op.
 */

type TelegramHaptics = {
  notificationOccurred?: (type: 'success' | 'error' | 'warning') => void;
};

function haptics(): TelegramHaptics | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as {
    Telegram?: { WebApp?: { HapticFeedback?: TelegramHaptics } };
  };
  return w.Telegram?.WebApp?.HapticFeedback;
}

export function hapticSuccess(): void {
  try {
    haptics()?.notificationOccurred?.('success');
  } catch {
    // Версия Telegram без HapticFeedback — молча пропускаем.
  }
}

export function hapticError(): void {
  try {
    haptics()?.notificationOccurred?.('error');
  } catch {
    // см. выше
  }
}
