import { chmodSync, unlinkSync } from 'node:fs';
import { type Server, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A local socket that lets the VS Code extension hand a quoted reply to this Quote session,
 * which then delivers it with all of its usual safety checks. Only the user's own processes can
 * connect: the socket lives in the per-user temp directory with mode 0600. It accepts one kind of
 * request and never runs anything.
 */

export type RemoteResult = 'accepted' | 'busy' | 'invalid';

export interface RemoteTarget {
  remoteReply(quote: string, reply: string): RemoteResult;
}

const MAX_REQUEST_BYTES = 1_000_000;

/**
 * Where a session listens. On Windows that is a named pipe. Its default access lets only its
 * creator, administrators and the system account write to it, and a request has to be written, so
 * other ordinary users can't send one.
 */
export function socketPathFor(pid = process.pid, dir = tmpdir(), platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `\\\\.\\pipe\\quote-${pid}` : join(dir, `quote-${pid}.sock`);
}

const isPipe = (path: string) => path.startsWith('\\\\.\\pipe\\');

const MESSAGES: Record<RemoteResult, string> = {
  accepted: 'Sending. Quote shows progress in the terminal.',
  busy: 'Quote is already showing a reply or selection in that terminal. Finish or cancel it first.',
  invalid: 'Both the quote and the reply must contain text.',
};

/** Answers one request line. Exported for tests that can't open sockets. */
export function handleRequest(target: RemoteTarget, line: string): { ok: boolean; message: string } {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    return { ok: false, message: 'Malformed request.' };
  }
  const r = request as { type?: unknown; quote?: unknown; reply?: unknown };
  if (r.type !== 'reply' || typeof r.quote !== 'string' || typeof r.reply !== 'string') {
    return { ok: false, message: 'Unsupported request.' };
  }
  const result = target.remoteReply(r.quote, r.reply);
  return { ok: result === 'accepted', message: MESSAGES[result] };
}

export function startReplyServer(target: RemoteTarget, socketPath = socketPathFor()): Promise<Server> {
  const pipe = isPipe(socketPath);
  if (!pipe) {
    try {
      unlinkSync(socketPath);
    } catch {
      // Nothing left over from an earlier run.
    }
  }
  const server = createServer((conn) => {
    let buffer = '';
    conn.setEncoding('utf8');
    conn.on('error', () => undefined);
    conn.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        conn.destroy();
        return;
      }
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      conn.end(`${JSON.stringify(handleRequest(target, buffer.slice(0, end)))}\n`);
    });
  });
  return new Promise((resolve, reject) => {
    // Create the socket file owner-only from the start, not just after a chmod. Named pipes have
    // no file mode; Windows sets their access from the creating user.
    const previous = pipe ? null : process.umask(0o177);
    const restore = () => {
      if (previous !== null) process.umask(previous);
    };
    server.once('error', (error) => {
      restore();
      reject(error);
    });
    server.listen(socketPath, () => {
      restore();
      if (!pipe) chmodSync(socketPath, 0o600);
      resolve(server);
    });
  });
}

export function stopReplyServer(server: Server, socketPath = socketPathFor()): void {
  server.close();
  if (isPipe(socketPath)) return;
  try {
    unlinkSync(socketPath);
  } catch {
    // Already gone.
  }
}
