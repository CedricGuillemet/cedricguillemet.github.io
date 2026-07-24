// Project-owned, store-only ZIP32 writer/verifier (architecture section
// 7.15). Deliberately narrow: STORE only (no deflate), UTF-8 names, a fixed
// 1980-01-01 00:00 DOS timestamp, IEEE CRC-32 (distinct from `.mlod`'s own
// CRC32C -- see crc32c.cpp), no extra fields/comments/data
// descriptors/permissions, and explicit ZIP64 rejection (the 512 MiB
// working-set policy limit is far below ZIP32's 4 GiB/65535-entry
// boundaries, so ZIP64 support would be untested dead code). No npm
// package, CDN, network fetch, `CompressionStream`, or additional
// C/C++ dependency is used -- see architecture 7.15 for the rejected
// alternatives and rationale.

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 20; // 2.0: STORE + long names, no extra features
const GENERAL_PURPOSE_FLAG_UTF8 = 0x0800; // language encoding flag (EFS)
const COMPRESSION_METHOD_STORE = 0;
// DOS date/time for 1980-01-01 00:00:00 (the earliest representable DOS
// timestamp): date = ((year-1980)<<9)|(month<<5)|day, time = 0.
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = (0 << 9) | (1 << 5) | 1;

const ZIP32_MAX_UINT32 = 0xffffffff;
const ZIP32_MAX_ENTRIES = 0xffff;

let crcTable = null;

/** Lazily builds the standard (reversed) IEEE CRC-32 lookup table. */
function getCrcTable() {
    if (crcTable) {
        return crcTable;
    }
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    crcTable = table;
    return table;
}

/**
 * Computes the standard IEEE CRC-32 (the ZIP/zlib polynomial 0xEDB88320) of
 * `bytes`. This is NOT the same algorithm as `.mlod`'s CRC32C -- do not
 * reuse this for `.mlod` container integrity.
 * @param {Uint8Array} bytes
 */
export function crc32(bytes) {
    const table = getCrcTable();
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function utf8Encode(text) {
    return new TextEncoder().encode(text);
}

function utf8Decode(bytes) {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

class ByteWriter {
    constructor() {
        this.chunks = [];
        this.length = 0;
    }
    pushBytes(bytes) {
        this.chunks.push(bytes);
        this.length += bytes.length;
    }
    pushUint16(value) {
        const buffer = new Uint8Array(2);
        new DataView(buffer.buffer).setUint16(0, value, true);
        this.pushBytes(buffer);
    }
    pushUint32(value) {
        const buffer = new Uint8Array(4);
        new DataView(buffer.buffer).setUint32(0, value >>> 0, true);
        this.pushBytes(buffer);
    }
    toUint8Array() {
        const out = new Uint8Array(this.length);
        let offset = 0;
        for (const chunk of this.chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        return out;
    }
}

/**
 * Builds a deterministic, store-only ZIP32 archive from `entries`
 * (`{name: string, bytes: Uint8Array}[]`, in the exact order they must
 * appear -- architecture 7.15 requires source-primitive order followed by
 * `conversion-metadata.json`). Throws (never returns a partial buffer) if
 * any entry's UTF-8 name/byte length would require ZIP64, or if there are
 * more than 65535 entries.
 * @param {{name:string, bytes:Uint8Array}[]} entries
 * @returns {Uint8Array}
 */
export function buildZipStore(entries) {
    if (entries.length === 0) {
        throw new Error("buildZipStore requires at least one entry");
    }
    if (entries.length > ZIP32_MAX_ENTRIES) {
        throw new Error("buildZipStore: entry count exceeds ZIP32's 65535-entry limit (ZIP64 is rejected)");
    }

    const writer = new ByteWriter();
    const centralDirectory = new ByteWriter();
    const localHeaderOffsets = [];

    for (const entry of entries) {
        const nameBytes = utf8Encode(entry.name);
        const crc = crc32(entry.bytes);
        if (entry.bytes.length > ZIP32_MAX_UINT32 || nameBytes.length > ZIP32_MAX_UINT32) {
            throw new Error(`buildZipStore: entry '${entry.name}' exceeds ZIP32 size limits (ZIP64 is rejected)`);
        }

        localHeaderOffsets.push(writer.length);
        writer.pushUint32(LOCAL_FILE_HEADER_SIGNATURE);
        writer.pushUint16(VERSION_NEEDED);
        writer.pushUint16(GENERAL_PURPOSE_FLAG_UTF8);
        writer.pushUint16(COMPRESSION_METHOD_STORE);
        writer.pushUint16(FIXED_DOS_TIME);
        writer.pushUint16(FIXED_DOS_DATE);
        writer.pushUint32(crc);
        writer.pushUint32(entry.bytes.length); // compressed size == uncompressed (STORE)
        writer.pushUint32(entry.bytes.length);
        writer.pushUint16(nameBytes.length);
        writer.pushUint16(0); // extra field length
        writer.pushBytes(nameBytes);
        writer.pushBytes(entry.bytes);
    }

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const nameBytes = utf8Encode(entry.name);
        const crc = crc32(entry.bytes);

        centralDirectory.pushUint32(CENTRAL_DIRECTORY_SIGNATURE);
        centralDirectory.pushUint16(VERSION_NEEDED); // version made by
        centralDirectory.pushUint16(VERSION_NEEDED); // version needed to extract
        centralDirectory.pushUint16(GENERAL_PURPOSE_FLAG_UTF8);
        centralDirectory.pushUint16(COMPRESSION_METHOD_STORE);
        centralDirectory.pushUint16(FIXED_DOS_TIME);
        centralDirectory.pushUint16(FIXED_DOS_DATE);
        centralDirectory.pushUint32(crc);
        centralDirectory.pushUint32(entry.bytes.length);
        centralDirectory.pushUint32(entry.bytes.length);
        centralDirectory.pushUint16(nameBytes.length);
        centralDirectory.pushUint16(0); // extra field length
        centralDirectory.pushUint16(0); // file comment length
        centralDirectory.pushUint16(0); // disk number start
        centralDirectory.pushUint16(0); // internal file attributes
        centralDirectory.pushUint32(0); // external file attributes (no host-specific permissions)
        centralDirectory.pushUint32(localHeaderOffsets[i]);
        centralDirectory.pushBytes(nameBytes);
    }

    const centralDirectoryOffset = writer.length;
    writer.pushBytes(centralDirectory.toUint8Array());
    const centralDirectorySize = writer.length - centralDirectoryOffset;

    if (centralDirectoryOffset > ZIP32_MAX_UINT32 || centralDirectorySize > ZIP32_MAX_UINT32) {
        throw new Error("buildZipStore: archive exceeds ZIP32's 4 GiB limit (ZIP64 is rejected)");
    }

    writer.pushUint32(END_OF_CENTRAL_DIRECTORY_SIGNATURE);
    writer.pushUint16(0); // this disk number
    writer.pushUint16(0); // disk where central directory starts
    writer.pushUint16(entries.length); // entries on this disk
    writer.pushUint16(entries.length); // total entries
    writer.pushUint32(centralDirectorySize);
    writer.pushUint32(centralDirectoryOffset);
    writer.pushUint16(0); // comment length (no comment)

    return writer.toUint8Array();
}

/**
 * Reparses a ZIP32 archive's End Of Central Directory + central directory
 * into a plain list of `{name, method, crc, compressedSize, uncompressedSize}`
 * records, in entry order. Used by both `verifyZipStore` (which additionally
 * cross-checks against expected content) and any read-only caller that just
 * needs to know what a package contains. Throws on any structural
 * malformation (missing/misplaced EOCD, a comment, a bad signature, or a
 * central directory that doesn't exactly span its declared size).
 * @param {Uint8Array} zipBytes
 */
export function listZipEntries(zipBytes) {
    const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);

    // Locate the End Of Central Directory record by scanning backward for
    // its signature (it is always the last fixed-size record because this
    // writer never emits a comment).
    const eocdSize = 22;
    if (zipBytes.length < eocdSize) {
        throw new Error("listZipEntries: archive is smaller than a minimal EOCD record");
    }
    const eocdOffset = zipBytes.length - eocdSize;
    if (view.getUint32(eocdOffset, true) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
        throw new Error("listZipEntries: End Of Central Directory signature not found at the expected offset (comments/trailing data are rejected)");
    }
    const totalEntries = view.getUint16(eocdOffset + 10, true);
    const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
    const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
    const commentLength = view.getUint16(eocdOffset + 20, true);
    if (commentLength !== 0) {
        throw new Error("listZipEntries: unexpected ZIP comment");
    }
    if (centralDirectoryOffset + centralDirectorySize !== eocdOffset) {
        throw new Error("listZipEntries: central directory does not end exactly where the EOCD begins");
    }

    const entries = [];
    let offset = centralDirectoryOffset;
    for (let i = 0; i < totalEntries; i++) {
        if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
            throw new Error(`listZipEntries: central directory entry ${i} has a bad signature`);
        }
        const method = view.getUint16(offset + 10, true);
        const crc = view.getUint32(offset + 16, true);
        const compressedSize = view.getUint32(offset + 20, true);
        const uncompressedSize = view.getUint32(offset + 24, true);
        const nameLength = view.getUint16(offset + 28, true);
        const extraLength = view.getUint16(offset + 30, true);
        const commentEntryLength = view.getUint16(offset + 32, true);
        const nameBytes = zipBytes.subarray(offset + 46, offset + 46 + nameLength);
        const name = utf8Decode(nameBytes);

        entries.push({ name, method, crc, compressedSize, uncompressedSize });
        offset += 46 + nameLength + extraLength + commentEntryLength;
    }
    if (offset !== eocdOffset) {
        throw new Error("listZipEntries: central directory entries did not exactly consume the declared central directory size");
    }
    return entries;
}

/**
 * Reparses a ZIP32 archive's central directory and asserts that its entry
 * names, sizes, and CRCs exactly match `expectedEntries` in order (the
 * "narrow verifier" architecture 7.15 requires before a package is ever
 * offered for download). Throws with a descriptive message on any mismatch;
 * returns nothing on success.
 * @param {Uint8Array} zipBytes
 * @param {{name:string, bytes:Uint8Array}[]} expectedEntries
 */
export function verifyZipStore(zipBytes, expectedEntries) {
    const entries = listZipEntries(zipBytes);
    if (entries.length !== expectedEntries.length) {
        throw new Error(`verifyZipStore: entry count mismatch (archive has ${entries.length}, expected ${expectedEntries.length})`);
    }
    for (let i = 0; i < expectedEntries.length; i++) {
        const entry = entries[i];
        const expected = expectedEntries[i];
        if (entry.method !== COMPRESSION_METHOD_STORE) {
            throw new Error(`verifyZipStore: entry ${i} is not STORE-compressed`);
        }
        if (entry.name !== expected.name) {
            throw new Error(`verifyZipStore: entry ${i} name mismatch (archive '${entry.name}', expected '${expected.name}')`);
        }
        if (entry.compressedSize !== expected.bytes.length || entry.uncompressedSize !== expected.bytes.length) {
            throw new Error(`verifyZipStore: entry '${entry.name}' size mismatch`);
        }
        const expectedCrc = crc32(expected.bytes);
        if (entry.crc !== expectedCrc) {
            throw new Error(`verifyZipStore: entry '${entry.name}' CRC-32 mismatch`);
        }
    }
}
