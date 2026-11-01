/**
 * This browser's device key for the relay HELLO (protocol 5, decision 0036):
 * an ECDSA P-256 key pair made once and kept beside the saved pairing. The
 * computer enrolls its public half with the pairing code and requires every
 * later HELLO to be signed with it.
 */

const STORAGE_KEY = 'nekko_hello_key';

interface Stored {
  privateKey: JsonWebKey;
  publicKey: JsonWebKey;
}

const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;

export async function loadHelloKeys(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): Promise<CryptoKeyPair> {
  try {
    const saved = JSON.parse(storage.getItem(STORAGE_KEY) || 'null') as Stored | null;
    if (saved?.privateKey && saved?.publicKey) {
      const [privateKey, publicKey] = await Promise.all([
        crypto.subtle.importKey('jwk', saved.privateKey, ALG, false, ['sign']),
        crypto.subtle.importKey('jwk', saved.publicKey, ALG, true, ['verify']),
      ]);
      return { privateKey, publicKey };
    }
  } catch {
    /* unreadable: make a new one; the computer then asks to pair again */
  }
  const keys = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const stored: Stored = {
    privateKey: await crypto.subtle.exportKey('jwk', keys.privateKey),
    publicKey: await crypto.subtle.exportKey('jwk', keys.publicKey),
  };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* private mode: this session only */
  }
  return keys;
}
