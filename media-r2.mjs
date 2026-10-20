// KERO 20/10/2026 (CRM etapa 5): mídia completa das mensagens novas vai ao R2 (Worker /crm/media, bucket privado).
// Desligado por padrão (CRM_MEDIA_R2=1 liga). Uma por vez, fila curta, tetos abaixo da franquia grátis. Falha nunca afeta o WhatsApp.
import { createHash } from 'node:crypto';

export const MEDIA_MAX_BYTES = 16 * 1024 * 1024;
export const mediaKey = (jid, id) =>
  createHash('sha256').update(String(jid)).digest('hex').slice(0, 16) + '/' + String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);

export function createMediaUploader({
  queueUrl,
  queueToken,
  download,
  fetchImpl = globalThis.fetch,
  dailyCap = 1500,
  maxQueue = 200,
  logger = console,
  clock = () => Date.now()
}) {
  const base = String(queueUrl || '').replace(/\/+$/, '');
  const queue = [];
  let busy = false, day = '', today = 0, stopUntil = 0;

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        const d = new Date(clock()).toISOString().slice(0, 10);
        if (d !== day) { day = d; today = 0; }
        if (today >= dailyCap || clock() < stopUntil) continue;
        try {
          const buf = await download(job.raw);
          if (!buf?.length || buf.length > MEDIA_MAX_BYTES) continue;
          const res = await fetchImpl(`${base}/crm/media?key=${encodeURIComponent(job.key)}`, {
            method: 'PUT',
            signal: AbortSignal.timeout(60000),
            headers: { Authorization: `Bearer ${queueToken}`, 'Content-Type': job.mimetype || 'application/octet-stream' },
            body: buf
          });
          today++;
          // teto do Worker (dia ou total): para de tentar por 1 h, sem insistir
          if (res.status === 429 || res.status === 507) stopUntil = clock() + 3600000;
          else if (!res.ok) logger.error('[media-r2] envio falhou', res.status);
        } catch (e) {
          logger.error('[media-r2] erro', e?.message || String(e));
        }
      }
    } finally {
      busy = false;
    }
  }

  // Recebe a mensagem crua do Baileys e a mídia já resumida pelo CRM (media.size, media.mimetype).
  const enqueue = (raw, jid, media) => {
    if (!base || !raw?.key?.id || !media) return null;
    if (Number(media.size || 0) > MEDIA_MAX_BYTES) return null;
    if (queue.length >= maxQueue) return null;
    const key = mediaKey(jid, raw.key.id);
    queue.push({ raw, key, mimetype: media.mimetype || null });
    pump();
    return key;
  };

  return { enqueue, pending: () => queue.length, idle: () => !busy && !queue.length };
}
