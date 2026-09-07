import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const CONTEXT = 'work-times/wakatime-oauth-token/v1';

function deriveKey(secret: string): Buffer {
  if (secret.length < 32) throw new Error('A persistent secret of at least 32 characters is required');
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), CONTEXT, 32));
}

export function sealWakaTimeToken(token: string, secret: string): string {
  if (!token) throw new Error('Cannot seal an empty WakaTime token');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.');
}

export function openWakaTimeToken(sealed: string, secret: string): string {
  const [version, ivText, ciphertextText, tagText, extra] = sealed.split('.');
  if (version !== VERSION || !ivText || !ciphertextText || !tagText || extra !== undefined) {
    throw new Error('Stored WakaTime token has an unsupported format');
  }

  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      deriveKey(secret),
      Buffer.from(ivText, 'base64url')
    );
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    throw new Error('Stored WakaTime token could not be decrypted');
  }
}

