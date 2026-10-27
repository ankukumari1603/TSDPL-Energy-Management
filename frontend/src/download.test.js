import { describe, it, expect, vi } from 'vitest';
import { saveXlsx, filenameFrom } from './download.js';

const res = (bytes, disposition) => ({
  blob: async () => new Blob([new Uint8Array(bytes)]),
  headers: { get: (k) => (k.toLowerCase() === 'content-disposition' ? disposition : null) },
});

function fakeDoc() {
  const a = { click: vi.fn(), remove: vi.fn() };
  return { a, doc: { createElement: () => a, body: { appendChild: vi.fn() } } };
}
const urlApi = { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() };

describe('saveXlsx', () => {
  it('clicks a download link using the server filename for a valid xlsx (zip) body', async () => {
    const { a, doc } = fakeDoc();
    const name = await saveXlsx(res([0x50, 0x4b, 3, 4], 'attachment; filename="TSDPL-Energy-FY26-27-Q1.xlsx"'), 'fallback.xlsx', doc, urlApi);
    expect(name).toBe('TSDPL-Energy-FY26-27-Q1.xlsx');
    expect(a.click).toHaveBeenCalledOnce();
    expect(a.download).toBe('TSDPL-Energy-FY26-27-Q1.xlsx');
  });
  it('rejects a body that is not a zip/xlsx instead of silently saving it', async () => {
    const { a, doc } = fakeDoc();
    await expect(saveXlsx(res([0x7b, 0x22], null), 'f.xlsx', doc, urlApi)).rejects.toThrow(/valid Excel/);
    expect(a.click).not.toHaveBeenCalled();
  });
  it('falls back to the supplied filename', () => {
    expect(filenameFrom(res([], null), 'fallback.xlsx')).toBe('fallback.xlsx');
  });
});
