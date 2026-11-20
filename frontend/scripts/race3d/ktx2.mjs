import { encodeToKTX2 } from "ktx2-encoder";

/**
 * Raw RGBA → KTX2 (Basis Universal) with mipmaps, via ktx2-encoder's WASM build of
 * basis_universal. No system tools. The pixels come straight from the bakers, so the
 * decoder hook hands them over instead of decoding an image file.
 *
 * uastc: true for the number atlas (crisp edges); false for ETC1S (smaller) everywhere else.
 */
export async function encodeKtx2(rgba, width, height, { uastc, srgb }) {
  const bytes = await encodeToKTX2(new Uint8Array(0), {
    imageDecoder: async () => ({ data: rgba, width, height }),
    isKTX2File: true,
    isUASTC: uastc,
    needSupercompression: uastc, // zstd for UASTC; ETC1S is already supercompressed
    generateMipmap: true,
    isSetKTX2SRGBTransferFunc: srgb,
    isPerceptual: srgb,
    qualityLevel: 160,
    compressionLevel: 2,
    enableDebug: false,
  });
  return new Uint8Array(bytes);
}
