const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Reads the filename from Content-Disposition, falling back to the supplied name. */
export function filenameFrom(res, fallback) {
  const m = /filename="?([^";]+)"?/i.exec(res.headers.get('content-disposition') || '');
  return m ? m[1] : fallback;
}

/** Saves a fetch Response as a file; throws a readable error if the body is not a real .xlsx. */
export async function saveXlsx(res, fallbackName, doc = document, urlApi = URL) {
  const blob = await res.blob();
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (blob.size === 0 || head[0] !== 0x50 || head[1] !== 0x4b) {
    throw new Error('The server did not return a valid Excel file. Please try again or contact the administrator.');
  }
  const url = urlApi.createObjectURL(new Blob([blob], { type: XLSX_MIME }));
  const a = doc.createElement('a');
  a.href = url;
  a.download = filenameFrom(res, fallbackName);
  doc.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => urlApi.revokeObjectURL(url), 10000);
  return a.download;
}
