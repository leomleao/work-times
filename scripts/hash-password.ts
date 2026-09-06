import { stdin, stderr, stdout } from 'node:process';
import { hashPassword } from '../src/lib/server/security/password';

async function readPipedPassword(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+$/, '');
}

async function readHiddenPassword(): Promise<string> {
  return new Promise((resolve, reject) => {
    let password = '';
    const wasRaw = stdin.isRaw;

    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
    };

    const onData = (chunk: Buffer) => {
      const value = chunk.toString('utf8');
      if (value === '\u0003') {
        cleanup();
        stderr.write('\n');
        reject(new Error('Cancelled'));
        return;
      }
      if (value === '\r' || value === '\n') {
        cleanup();
        stderr.write('\n');
        resolve(password);
        return;
      }
      if (value === '\u007f' || value === '\b') {
        password = Array.from(password).slice(0, -1).join('');
        return;
      }
      if (!value.includes('\u001b')) password += value;
    };

    stderr.write('Admin password: ');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

const password = stdin.isTTY ? await readHiddenPassword() : await readPipedPassword();
stdout.write(`${hashPassword(password)}\n`);
