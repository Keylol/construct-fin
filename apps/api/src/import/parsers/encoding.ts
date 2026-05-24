import iconv from 'iconv-lite';
import jschardet from 'jschardet';

const SAMPLE_SIZE = 65536;

export function detectEncoding(buffer: Buffer): string {
  const sample = buffer.subarray(0, Math.min(buffer.length, SAMPLE_SIZE));
  const binary = sample.toString('binary');
  const detected = jschardet.detect(binary);
  const raw = (detected?.encoding ?? 'utf-8').toLowerCase();
  if (raw === 'ascii') return 'utf-8';
  return raw;
}

export function decodeBuffer(buffer: Buffer, encoding?: string): { text: string; encoding: string } {
  const enc = encoding ?? detectEncoding(buffer);
  if (!iconv.encodingExists(enc)) {
    return { text: buffer.toString('utf-8'), encoding: 'utf-8' };
  }
  return { text: iconv.decode(buffer, enc), encoding: enc };
}
