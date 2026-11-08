export const releasedV3SessionFormatCodec = {};
export const releasedV2SessionFormatCodec = { decodeHeader: (v) => v, encodeHeader: (v) => v, encodeEvent: (v) => v };
export function assertReleasedV3Header(header) {
    if (typeof header !== 'object' || header === null || header.version !== 3)
        throw new Error('expected format v3 header');
}
