// Stands in for JSZip inside mammoth (build.mjs and test/run.mjs resolve "jszip" here; package.json points the real
// package at an empty stub). mammoth needs only `JSZip.loadAsync(bytes)` and, per part, `zip.file(name)?.async(type)`;
// this answers them from ZipReader, whose directory checks and bounded inflating stop zip bombs (zip.ts). So no other
// zip code ever reads a .docx in the page.
import { ZIP_LIMITS, ZipError, ZipReader, type ZipLimits } from './zip';

let limits: ZipLimits & { xml?: number } = ZIP_LIMITS;
/** The caps the next loadAsync applies (the DOCX worker sets them); `xml`: the largest part read, whatever its name
 *  (mammoth finds its parts by the relationships' targets, which may name a "document" anything). */
export function setLimits(l: ZipLimits & { xml?: number }): void {
  limits = l;
}

interface ShimFile {
  async(type: string): Promise<Uint8Array | string | ArrayBuffer>;
}

export function loadAsync(data: ArrayBuffer | Uint8Array): Promise<{ file(name: string): ShimFile | null }> {
  try {
    const z = new ZipReader(data instanceof Uint8Array ? data : new Uint8Array(data), limits);
    return Promise.resolve({
      file(name: string): ShimFile | null {
        if (typeof name !== 'string' || !z.has(name)) return null;
        return {
          async(type: string) {
            try {
              const xml = limits.xml;
              if (xml !== undefined && (z.size(name) ?? 0) > xml) {
                throw new ZipError(`${name.slice(0, 100)} unpacks to more than ${Math.round(xml / 1048576)} MB (previews stop there)`);
              }
              const b = z.bytesOf(name);
              if (type === 'string' || type === 'text') return Promise.resolve(new TextDecoder('utf-8').decode(b));
              if (type === 'arraybuffer') return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
              return Promise.resolve(b);
            } catch (e) {
              return Promise.reject(e);
            }
          },
        };
      },
    });
  } catch (e) {
    return Promise.reject(e);
  }
}

export default { loadAsync };
