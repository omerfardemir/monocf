/**
 * Sanitizes a worker name
 * @param workerName Worker name
 * @returns Sanitized worker name
 */
export function sanitizeWorkerName(workerName: string): string {
  if (!/^[a-z0-9-]+$/.test(workerName)) {
    return workerName.replaceAll(/[^a-z0-9-]/g, "-");
  }

  return workerName;
}