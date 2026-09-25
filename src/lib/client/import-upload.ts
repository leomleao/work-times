export type UploadSummary = {
  dryRun: boolean;
  alreadyImported: boolean;
  rangeStartDate: string;
  rangeEndDate: string;
  dayCount: number;
  heartbeatCount: number;
  warningCount: number;
};

export type UploadKind = 'daily' | 'heartbeats';

const endpoint = '/api/admin/imports/uploads';

export async function uploadRequest<T>(csrfToken: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(endpoint, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error ?? `Upload request failed (HTTP ${response.status}).`);
  }
  return payload as T;
}

export async function cancelUpload(csrfToken: string, id: string): Promise<void> {
  await fetch(`${endpoint}?id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'x-csrf-token': csrfToken }
  });
}

export async function uploadFileChunks(
  file: File,
  kind: UploadKind,
  id: string,
  chunkBytes: number,
  csrfToken: string,
  onProgress: (percent: number) => void
): Promise<void> {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 4 * 1024 * 1024) {
    throw new Error('The server returned an invalid upload chunk size.');
  }
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    const end = Math.min(offset + chunkBytes, file.size);
    await sendChunk(file.slice(offset, end), kind, id, offset, csrfToken, (sent) => {
      onProgress(Math.min(99, Math.floor(((offset + sent) / file.size) * 100)));
    });
    onProgress(Math.floor((end / file.size) * 100));
  }
}

function sendChunk(
  chunk: Blob,
  kind: UploadKind,
  id: string,
  offset: number,
  csrfToken: string,
  onProgress: (sent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const query = new URLSearchParams({ id, kind, offset: String(offset) });
    xhr.open('PUT', `${endpoint}?${query}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-csrf-token', csrfToken);
    xhr.upload.onprogress = (event) => onProgress(Math.min(event.loaded, chunk.size));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      let message = `Upload failed (HTTP ${xhr.status}).`;
      try {
        message = JSON.parse(xhr.responseText).error ?? message;
      } catch {
        // A proxy may return HTML for a rejected request.
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error('The upload connection was interrupted. Please retry.'));
    xhr.onabort = () => reject(new Error('The upload was interrupted. Please retry.'));
    xhr.send(chunk);
  });
}
