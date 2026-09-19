/**
 * Telegram Mini App haptics (решение №36 блица): лёгкая вибрация на успех/
 * ошибку мутаций. Вне Telegram (обычный браузер) — тихий no-op.
 *
 * С 19.09.2026 SDK Mini App (telegram-web-app.js) не подключается: он грузился
 * с strategy="beforeInteractive", и у провайдеров, режущих telegram.org, из-за
 * него не стартовала гидрация — страница входа была мёртвой. Пока SDK нет,
 * window.Telegram отсутствует и вибрация молча не срабатывает; вернуть её можно,
 * подключив SDK со своего домена только внутри Telegram-вебвью.
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
