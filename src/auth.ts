import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import { DEFAULTS } from './constants.js';

export function generatePassword(length = DEFAULTS.passwordLength): string {
  return crypto.randomBytes(length).toString('hex');
}

// Constant-time comparison — hashing both sides first handles length
// mismatch without leaking anything via timing.
function passwordsMatch(candidate: unknown, password: string): boolean {
  const a = crypto.createHash('sha256').update(String(candidate ?? '')).digest();
  const b = crypto.createHash('sha256').update(password).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createAuthHandler(password: string, { timeout = DEFAULTS.authTimeout } = {}) {
  return function authenticateSocket(ws: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close(4001, 'Auth timeout');
        reject(new Error('Auth timeout'));
      }, timeout);

      ws.once('message', (data) => {
        clearTimeout(timer);
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'auth' && passwordsMatch(msg.password, password)) {
            ws.send(JSON.stringify({ type: 'auth', success: true }));
            resolve();
          } else {
            ws.send(JSON.stringify({ type: 'auth', success: false }));
            ws.close(4003, 'Wrong password');
            reject(new Error('Wrong password'));
          }
        } catch {
          ws.close(4002, 'Invalid message');
          reject(new Error('Invalid auth message'));
        }
      });
    });
  };
}
