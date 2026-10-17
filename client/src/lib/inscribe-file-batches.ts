export type InscribeFileMetadata = { name: string; size: number };

export const DEFAULT_INSCRIBE_BATCH_MAX_FILES = 100;
export const DEFAULT_INSCRIBE_BATCH_MAX_BYTES = 95_000_000;
export const DEFAULT_INSCRIBE_FILE_MAX_BYTES = 365 * 1024;
const JSON_REQUEST_OVERHEAD_BYTES = 4_096;

function estimatedFileRequestBytes(file: InscribeFileMetadata) {
  // Base64 expansion plus conservative per-file filename/JSON allowance.
  return Math.ceil(file.size * 4 / 3) + 512 + file.name.length;
}

export function estimateInscribeRequestBytes(files: InscribeFileMetadata[]) {
  return files.reduce((total, file) => total + estimatedFileRequestBytes(file), JSON_REQUEST_OVERHEAD_BYTES);
}

/** Keep all selected files but split them into sequential UniSat orders that fit the Worker body limit. */
export function splitInscribeFilesIntoBatches<T extends InscribeFileMetadata>(
  files: T[],
  maxRequestBytes = DEFAULT_INSCRIBE_BATCH_MAX_BYTES,
  maxFiles = DEFAULT_INSCRIBE_BATCH_MAX_FILES,
  maxFileBytes = DEFAULT_INSCRIBE_FILE_MAX_BYTES,
): T[][] {
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= JSON_REQUEST_OVERHEAD_BYTES) throw new Error("La limite de taille d’une commande Inscribe est invalide.");
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || files.length > maxFiles) throw new Error(`La limite est de ${maxFiles} fichiers sélectionnés au total.`);
  const batches: T[][] = [];
  let current: T[] = [];
  let estimatedBytes = JSON_REQUEST_OVERHEAD_BYTES;
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > maxFileBytes) throw new Error(`Chaque fichier doit mesurer entre 1 octet et ${maxFileBytes} octets.`);
    const fileBytes = estimatedFileRequestBytes(file);
    if (current.length && estimatedBytes + fileBytes > maxRequestBytes) {
      batches.push(current);
      current = [];
      estimatedBytes = JSON_REQUEST_OVERHEAD_BYTES;
    }
    if (estimatedBytes + fileBytes > maxRequestBytes) throw new Error(`Le fichier « ${file.name} » dépasse à lui seul la taille maximale d’une commande UniSat.`);
    current.push(file);
    estimatedBytes += fileBytes;
  }
  if (current.length) batches.push(current);
  return batches;
}
