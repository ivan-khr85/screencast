import crypto from 'node:crypto';
import { DEFAULTS } from './constants.js';

export function generatePassword(length = DEFAULTS.passwordLength) {
  return crypto.randomBytes(length).toString('hex');
}

export function createAuthHandler(password, { timeout = DEFAULTS.authTimeout } = {}) {
  return function authenticateSocket(ws) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close(4001, 'Auth timeout');
        reject(new Error('Auth timeout'));
      }, timeout);

      ws.once('message', (data) => {
        clearTimeout(timer);
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'auth' && msg.password === password) {
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
