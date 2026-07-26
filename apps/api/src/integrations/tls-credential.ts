import { BadRequestException } from '@nestjs/common';
import { X509Certificate } from 'node:crypto';

/**
 * Клиентский сертификат mTLS подключения (Ф2, мультитенантность).
 *
 * Банк выдаёт сертификат на компанию по договору, поэтому у разных пространств
 * (разные ИП) он разный — держать один общий в env сервера нельзя. Пара
 * cert+key хранится в подключении зашифрованной; здесь только разбор и
 * валидация того, что пользователь загрузил.
 *
 * Приватный ключ в логи, ответы API и аудит не попадает никогда — наружу идут
 * только отпечаток и срок действия (публичная часть сертификата).
 */
export interface TlsCredential {
  /** PEM сертификата (открытая часть). */
  cert: string;
  /** PEM закрытого ключа. */
  key: string;
  /** Пароль закрытого ключа, если он зашифрован. */
  passphrase?: string;
}

export interface TlsCredentialMeta {
  /** Отпечаток SHA-256 — какой именно сертификат стоит на подключении. */
  fingerprint: string | null;
  /** Срок действия: предупредить заранее, а не ловить отказ рукопожатия. */
  expiresAt: Date | null;
}

const CERT_HEADER = '-----BEGIN CERTIFICATE-----';
const KEY_HEADER = /-----BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY-----/;

/**
 * Проверяет загруженную пару и достаёт метаданные сертификата.
 *
 * Формат проверяем строго: молча принять мусор — значит получить непонятный
 * отказ TLS при первом синке, когда владелец уже забудет, что именно загружал.
 * Метаданные (отпечаток/срок) — best-effort: если Node не смог разобрать
 * сертификат, это само по себе сигнал, что банк его тоже не примет, поэтому
 * тоже отклоняем.
 */
export function parseTlsCredential(input: TlsCredential): TlsCredentialMeta {
  const cert = input.cert.trim();
  const key = input.key.trim();

  // Перепутанные местами файлы проверяем ПЕРВЫМИ: иначе владелец получит
  // формально верное «это не сертификат» вместо подсказки, что делать. Ошибка
  // частая, а диагностика у неё скверная — рукопожатие падает в недрах TLS.
  if (KEY_HEADER.test(cert) && key.includes(CERT_HEADER)) {
    throw new BadRequestException(
      'Похоже, файлы перепутаны местами: в поле сертификата загружен закрытый ключ, а в поле ключа — сертификат',
    );
  }
  if (!cert.includes(CERT_HEADER)) {
    throw new BadRequestException(
      'Файл сертификата не похож на PEM: внутри должен быть блок «BEGIN CERTIFICATE». Если банк выдал .p12/.pfx — экспортируйте из него пару .cer и .key',
    );
  }
  if (!KEY_HEADER.test(key)) {
    throw new BadRequestException(
      'Файл закрытого ключа не похож на PEM: внутри должен быть блок «BEGIN PRIVATE KEY»',
    );
  }

  let parsed: X509Certificate;
  try {
    parsed = new X509Certificate(cert);
  } catch {
    throw new BadRequestException('Сертификат не удалось разобрать — проверьте, что файл не повреждён');
  }

  const expiresAt = new Date(parsed.validTo);
  return {
    fingerprint: parsed.fingerprint256,
    expiresAt: Number.isNaN(expiresAt.getTime()) ? null : expiresAt,
  };
}

/** Сериализация для шифрования: ровно три поля, ничего лишнего. */
export function serializeTlsCredential(input: TlsCredential): string {
  return JSON.stringify({
    cert: input.cert.trim(),
    key: input.key.trim(),
    ...(input.passphrase ? { passphrase: input.passphrase } : {}),
  });
}

/** Разбор расшифрованного значения из БД. */
export function deserializeTlsCredential(raw: string): TlsCredential {
  const parsed = JSON.parse(raw) as Partial<TlsCredential>;
  if (typeof parsed.cert !== 'string' || typeof parsed.key !== 'string') {
    throw new Error('Сертификат подключения повреждён: нет cert/key');
  }
  return {
    cert: parsed.cert,
    key: parsed.key,
    ...(typeof parsed.passphrase === 'string' ? { passphrase: parsed.passphrase } : {}),
  };
}
