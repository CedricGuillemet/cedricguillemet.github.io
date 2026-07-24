// MeshLoD Browser Converter -- dedicated worker (tasks 12.2-12.4).
//
// Owns: Emscripten module initialization, the virtual file set, the ABI
// session, inspection, conversion, and atomic download packaging (direct
// deterministic self-contained ZIP32 STORE package -- architecture 7.15).
// Conversion progress is relayed from the module's imported `onProgress`
// hook (wasm_api.cpp's `mlod_report_progress_js`), throttled per
// architecture 7.14. There is no cooperative in-flight cancellation here --
// `mlod_session_convert` is one synchronous call, so the only real browser
// cancellation path is the main thread terminating this worker outright (see
// app.js's terminateWorker). This worker never touches the DOM and never
// fetches a remote resource; every byte it reads comes from a `File`/`Blob`
// the user already selected locally (architecture sections 7.10-7.13).

import { buildZipStore, verifyZipStore } from "./zip-store.js";

const PROTOCOL_VERSION = 1;

// ---- Naming (architecture section 7.15) ----
//
// Inlined here (not a shared naming.js module) because architecture 7.17
// fixes the browser runtime's file set at exactly seven assets; app.js
// currently has no runtime need for these, so duplication is avoided rather
// than adding an eighth file.

/**
 * Sanitizes an entry file name into the deterministic output stem: strips
 * the final .glb/.gltf extension, replaces non [A-Za-z0-9._-] characters
 * with "_", collapses repeats, trims stray separators, and falls back to
 * "mesh-lod" when empty. Every substitution is ASCII-only, so slicing at 96
 * JS UTF-16 code units is exactly slicing at 96 UTF-8 bytes -- no code point
 * can ever be split. Pure string logic -- no filesystem/DOM.
 * @param {string} entryFileName
 */
function deriveOutputStem(entryFileName) {
    const withoutExtension = entryFileName.replace(/\.(glb|gltf)$/i, "");
    let stem = withoutExtension.replace(/[^A-Za-z0-9._-]/g, "_").replace(/_+/g, "_");
    stem = stem.replace(/^[._\s]+|[._\s]+$/g, "");
    return stem.length > 0 ? stem.slice(0, 96) : "mesh-lod";
}

/**
 * Builds the deterministic `<stem>.meshNNN.primNNN.mlod` name for one
 * primitive output, including the single-output case (architecture 7.15
 * step 5 -- deliberately different from the native CLI, which omits the
 * suffix when there is exactly one output).
 */
function primitiveOutputName(stem, meshIndex, primitiveIndex) {
    const meshPart = String(meshIndex).padStart(3, "0");
    const primPart = String(primitiveIndex).padStart(3, "0");
    return `${stem}.mesh${meshPart}.prim${primPart}.mlod`;
}

/** Deterministic multi-output package name (architecture 7.15). */
function packageZipName(stem) {
    return `${stem}.mesh-lod.zip`;
}

/** conversion-metadata.json's fixed entry name inside the ZIP. */
const METADATA_ENTRY_NAME = "conversion-metadata.json";

// mlod_conversion_options field layout (mlod_browser_api.h) -- all uint32_t
// except two trailing floats. Keeping this list in one place means the byte
// offsets below are computed once, not hand-counted at every call site.
const OPTIONS_FIELDS = [
    "structSize",
    "abiVersion",
    "selectionMode",
    "meshIndex",
    "primitiveIndex",
    "meshletMaxVertices",
    "meshletMinTriangles",
    "meshletMaxTriangles",
    "partitionSize",
    "simplifyRatio", // float
    "simplifyThreshold", // float
    "pageMinKiB",
    "pageTargetKiB",
    "pageMaxKiB",
];
const OPTIONS_FLOAT_FIELDS = new Set(["simplifyRatio", "simplifyThreshold"]);
const OPTIONS_STRUCT_SIZE = OPTIONS_FIELDS.length * 4;

const MLOD_FILE_FLAG_ENTRY = 0x1;

// mlod_result values (mlod_browser_api.h).
const MLOD_RESULT_SUCCESS = 0;
const MLOD_RESULT_OUT_OF_MEMORY = 11;

// Architecture section 7.14: stage boundaries always emit; intermediate
// events are throttled to at most one every 50ms or one percentage point.
const PROGRESS_THROTTLE_MS = 50;

// Narrow, conservative signature match for recognized Emscripten
// allocation/grow-memory failures (gotcha: "do not misclassify arbitrary
// abort text as OOM" -- any other uncaught failure stays
// MLOD-WORKER-UNEXPECTED).
const OOM_MESSAGE_PATTERN = /cannot enlarge memory arrays|memory growth|allocation failed|requested allocation size/i;

let modulePromise = null;
let session = {
    handle: 0,
    // Path -> { path, isEntry, blob } awaiting byte materialization.
    files: new Map(),
    entryName: null,
    options: null,
    versionReport: null,
};
let operationQueue = Promise.resolve();

async function loadModule() {
    if (modulePromise) {
        return modulePromise;
    }
    modulePromise = (async () => {
        const factory = (await import("./mesh-lod-converter.js")).default;
        return factory();
    })();
    return modulePromise;
}

function encodeUtf8(text) {
    return new TextEncoder().encode(text);
}

function allocateBytes(Module, bytes) {
    const ptr = Module._malloc(bytes.length || 1);
    Module.writeArrayToMemory(bytes, ptr);
    return ptr;
}

function allocateOptionsStruct(Module, options) {
    const ptr = Module._malloc(OPTIONS_STRUCT_SIZE);
    let offset = 0;
    for (const field of OPTIONS_FIELDS) {
        const value = field === "structSize" ? OPTIONS_STRUCT_SIZE : field === "abiVersion" ? 1 : (options[field] ?? 0);
        Module.setValue(ptr + offset, value, OPTIONS_FLOAT_FIELDS.has(field) ? "float" : "i32");
        offset += 4;
    }
    return ptr;
}

function readReportJson(Module, handle) {
    const outDataPtr = Module._malloc(4);
    const outLengthPtr = Module._malloc(4);
    try {
        const rc = Module.ccall("mlod_session_report_json", "number", ["number", "number", "number"], [handle, outDataPtr, outLengthPtr]);
        if (rc !== MLOD_RESULT_SUCCESS) {
            return null;
        }
        const dataPtr = Module.getValue(outDataPtr, "i32");
        const length = Module.getValue(outLengthPtr, "i32");
        const text = Module.UTF8ToString(dataPtr, length);
        return JSON.parse(text);
    } finally {
        Module._free(outDataPtr);
        Module._free(outLengthPtr);
    }
}

/**
 * Registers one file with the ABI session, freeing its staging allocations
 * immediately after the call (session-owned copies remain valid regardless).
 */
function addFile(Module, handle, path, bytes, isEntry) {
    const pathBytes = encodeUtf8(path);
    const pathPtr = allocateBytes(Module, pathBytes);
    const dataPtr = bytes ? allocateBytes(Module, bytes) : 0;
    try {
        return Module.ccall(
            "mlod_session_add_file",
            "number",
            ["number", "number", "number", "bigint", "number", "number", "number"],
            [handle, pathPtr, pathBytes.length, BigInt(bytes ? bytes.length : 0), isEntry ? MLOD_FILE_FLAG_ENTRY : 0, dataPtr, bytes ? bytes.length : 0]
        );
    } finally {
        Module._free(pathPtr);
        if (dataPtr) {
            Module._free(dataPtr);
        }
    }
}

function destroySession(Module) {
    if (session.handle !== 0) {
        Module.ccall("mlod_session_destroy", null, ["number"], [session.handle]);
    }
    // versionReport is set once in handleInitialize and never changes for
    // the worker's lifetime; every other field is per-inspection state.
    session = { handle: 0, files: new Map(), entryName: null, options: null, versionReport: session.versionReport };
}

function post(message) {
    self.postMessage(message);
}

/**
 * Builds a throttled relay from the module's imported `onProgress` hook
 * (wasm_api.cpp's `mlod_report_progress_js`) to `postMessage`. Stage
 * boundaries always emit; otherwise at most one message every 50ms or one
 * whole percentage point, per architecture section 7.14.
 */
function makeProgressRelay(attemptId) {
    let lastPostAt = -Infinity;
    let lastPercent = -1;
    let lastStage = -1;
    return (event) => {
        const percent = Math.round(Math.max(0, Math.min(1, event.overallFraction)) * 100);
        const isStageBoundary = event.stage !== lastStage;
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        if (!isStageBoundary && now - lastPostAt < PROGRESS_THROTTLE_MS && percent === lastPercent) {
            return;
        }
        lastStage = event.stage;
        lastPercent = percent;
        lastPostAt = now;
        post({
            type: "progress",
            protocolVersion: PROTOCOL_VERSION,
            attemptId,
            stage: event.stage,
            activityCode: event.activityCode,
            completedUnits: event.completedUnits,
            totalUnits: event.totalUnits,
            percent,
            trackedBytes: event.trackedBytes,
            estimatedPeakBytes: event.estimatedPeakBytes,
            context: event.context,
        });
    };
}

/**
 * Classifies an uncaught JS-level failure from a ccall (an Emscripten abort,
 * not an ABI-returned result code) into one of the two recognized worker
 * failure codes. Conservative by design: only a known allocation/growth
 * signature is ever reported as `MLOD-MEMORY-OOM`.
 */
function classifyThrownFailure(error) {
    const message = error && error.message ? error.message : String(error);
    if (OOM_MESSAGE_PATTERN.test(message)) {
        return { code: "MLOD-MEMORY-OOM", message: "the converter ran out of memory while converting" };
    }
    return { code: "MLOD-WORKER-UNEXPECTED", message: `the converter worker failed unexpectedly: ${message}` };
}

async function handleInitialize() {
    try {
        const Module = await loadModule();
        const outDataPtr = Module._malloc(4);
        const outLengthPtr = Module._malloc(4);
        let report = null;
        try {
            const rc = Module.ccall("mlod_version_report_json", "number", ["number", "number"], [outDataPtr, outLengthPtr]);
            if (rc === MLOD_RESULT_SUCCESS) {
                const dataPtr = Module.getValue(outDataPtr, "i32");
                const length = Module.getValue(outLengthPtr, "i32");
                report = JSON.parse(Module.UTF8ToString(dataPtr, length));
            }
        } finally {
            Module._free(outDataPtr);
            Module._free(outLengthPtr);
        }
        post({ type: "ready", protocolVersion: PROTOCOL_VERSION, version: report });
        session.versionReport = report;
    } catch (error) {
        post({
            type: "fatal",
            protocolVersion: PROTOCOL_VERSION,
            code: "MLOD-STARTUP-ASSET",
            message: `The converter module failed to load: ${error && error.message ? error.message : String(error)}`,
        });
    }
}

/**
 * @param {{attemptId:number, entryPath:string, files:{path:string,isEntry:boolean,blob:Blob}[], options:object}} payload
 */
async function handleInspect(payload) {
    const { attemptId, files, options } = payload;
    let Module;
    try {
        Module = await loadModule();
    } catch (error) {
        post({ type: "fatal", protocolVersion: PROTOCOL_VERSION, code: "MLOD-STARTUP-ASSET", message: String(error) });
        return;
    }

    destroySession(Module);
    session.handle = Module.ccall("mlod_session_create", "number", [], []);
    session.files = new Map(files.map((file) => [file.path, file]));
    session.entryName = files.find((file) => file.isEntry)?.path ?? null;
    session.options = options;
    if (session.handle === 0) {
        post({
            type: "error",
            protocolVersion: PROTOCOL_VERSION,
            attemptId,
            code: "MLOD-MEMORY-OOM",
            message: "could not allocate a converter session",
        });
        return;
    }

    // Every selected local file's bytes are read eagerly: everything was
    // already selected from disk (no network), so there is no benefit to a
    // lazy two-pass fetch the way a remote resource would need.
    for (const file of files) {
        const bytes = new Uint8Array(await file.blob.arrayBuffer());
        const rc = addFile(Module, session.handle, file.path, bytes, file.isEntry);
        if (rc !== MLOD_RESULT_SUCCESS) {
            post({
                type: "error",
                protocolVersion: PROTOCOL_VERSION,
                attemptId,
                code: "MLOD-INPUT-DUPLICATE-PATH",
                message: `could not register '${file.path}' (ABI result ${rc})`,
            });
            return;
        }
    }

    const optionsPtr = allocateOptionsStruct(Module, options);
    let rc;
    try {
        rc = Module.ccall("mlod_session_inspect", "number", ["number", "number"], [session.handle, optionsPtr]);
    } finally {
        Module._free(optionsPtr);
    }

    const report = readReportJson(Module, session.handle);
    if (rc !== MLOD_RESULT_SUCCESS || !report || !report.success) {
        post({
            type: "error",
            protocolVersion: PROTOCOL_VERSION,
            attemptId,
            code: report?.diagnostics?.[0]?.code ?? "MLOD-INPUT-MALFORMED",
            message: report?.diagnostics?.[0]?.message ?? "inspection failed",
            report,
        });
        return;
    }

    post({ type: "inspected", protocolVersion: PROTOCOL_VERSION, attemptId, report });
}

/**
 * Copies one validated `.mlod` output out of WASM linear memory into a
 * worker-owned `Uint8Array` immediately (gotcha: never expose a typed-array
 * view backed by WASM memory as the final result -- that view would go
 * stale, or point at reused memory, the instant any later mutating ABI call
 * runs).
 */
function copyOutputBytes(Module, handle, index) {
    const outDataPtr = Module._malloc(4);
    const outLengthPtr = Module._malloc(4);
    try {
        const rc = Module.ccall("mlod_session_output_data", "number", ["number", "number", "number", "number"], [handle, index, outDataPtr, outLengthPtr]);
        if (rc !== MLOD_RESULT_SUCCESS) {
            throw new Error(`mlod_session_output_data failed for output ${index} (ABI result ${rc})`);
        }
        const dataPtr = Module.getValue(outDataPtr, "i32");
        const length = Module.getValue(outLengthPtr, "i32");
        return Module.HEAPU8.slice(dataPtr, dataPtr + length);
    } finally {
        Module._free(outDataPtr);
        Module._free(outLengthPtr);
    }
}

/**
 * Builds `conversion-metadata.json`'s contents (architecture 7.15): source
 * identity, effective options, tool/format/dependency versions, source
 * digest, output names/byte sizes, and canonical aggregate counts. Detailed
 * per-output statistics (from the shared core's own statistics JSON, already
 * embedded in the conversion report) are included only when `includeStats`
 * is true; the minimal mapping/provenance fields are always present.
 */
function buildMetadataObject({ sourceEntryName, options, includeStats, versionReport, report, entries, sourceEntries }) {
    const detailedOutputs = includeStats && report.metadata && Array.isArray(report.metadata.outputs) ? report.metadata.outputs : null;
    const outputs = entries.map((entry, index) => {
        const base = {
            name: entry.name,
            meshIndex: entry.meshIndex,
            primitiveIndex: entry.primitiveIndex,
            byteSize: entry.byteSize,
        };
        if (detailedOutputs && detailedOutputs[index]) {
            base.statistics = detailedOutputs[index];
        }
        return base;
    });
    const totalByteSize = entries.reduce((sum, entry) => sum + entry.byteSize, 0);
    return {
        packageVersion: 1,
        formatVersion: versionReport?.formatVersion ?? null,
        toolVersion: versionReport?.toolVersion ?? null,
        dependencies: versionReport?.dependencies ?? null,
        sourceEntryName: sourceEntryName ? `source/${sourceEntryName}` : null,
        sourceFiles: sourceEntries.map((entry) => ({ name: entry.name, byteSize: entry.bytes.length })),
        sourceDigestHex: report.sourceDigestHex ?? null,
        options: options ?? null,
        outputs,
        aggregate: {
            outputCount: entries.length,
            totalByteSize,
            primitiveCount: report.metadata?.primitiveCount ?? entries.length,
        },
    };
}

/**
 * Assembles a self-contained deterministic ZIP32 STORE package containing the
 * original source glTF resources, source-order `.mlod` entries, and
 * `conversion-metadata.json`. The package is self-verified before it is offered
 * for download and can be dropped directly into the MeshLoD viewer demo.
 */
async function buildDownloadPackage(Module, handle, { entryName, sourceEntryName, options, includeStats, versionReport, report }) {
    const stem = deriveOutputStem(entryName || "mesh-lod");
    const entries = report.outputs.map((output, index) => ({
        name: primitiveOutputName(stem, output.meshIndex, output.primitiveIndex),
        bytes: copyOutputBytes(Module, handle, index),
        meshIndex: output.meshIndex,
        primitiveIndex: output.primitiveIndex,
        byteSize: output.byteSize,
    }));
    const sourceEntries = await Promise.all(
        [...session.files.values()]
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
            .map(async (file) => ({ name: `source/${file.path}`, bytes: new Uint8Array(await file.blob.arrayBuffer()) }))
    );
    const metadata = buildMetadataObject({ sourceEntryName, options, includeStats, versionReport, report, entries, sourceEntries });
    const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata, null, 2));
    const zipEntries = [...sourceEntries, ...entries.map((entry) => ({ name: entry.name, bytes: entry.bytes })), { name: METADATA_ENTRY_NAME, bytes: metadataBytes }];
    const zipBytes = buildZipStore(zipEntries);
    verifyZipStore(zipBytes, zipEntries); // throws on any mismatch -- never offered if this fails
    return {
        name: packageZipName(stem),
        mimeType: "application/zip",
        blob: new Blob([zipBytes], { type: "application/zip" }),
    };
}

async function handleConvert(payload) {
    const { attemptId, entryName, includeStats } = payload;
    let Module;
    try {
        Module = await loadModule();
    } catch (error) {
        post({ type: "fatal", protocolVersion: PROTOCOL_VERSION, code: "MLOD-STARTUP-ASSET", message: String(error) });
        return;
    }
    if (session.handle === 0) {
        post({
            type: "error",
            protocolVersion: PROTOCOL_VERSION,
            attemptId,
            code: "MLOD-WORKER-PROTOCOL",
            message: "convert requested without a prior successful inspect",
        });
        return;
    }

    Module.onProgress = makeProgressRelay(attemptId);
    let rc;
    try {
        rc = Module.ccall("mlod_session_convert", "number", ["number"], [session.handle]);
    } catch (error) {
        // An uncaught JS-level exception here means the WASM runtime itself
        // aborted (not an ABI-returned result code) -- recognized
        // allocation/grow-memory failures classify as MLOD-MEMORY-OOM,
        // everything else stays MLOD-WORKER-UNEXPECTED.
        const failure = classifyThrownFailure(error);
        post({ type: "error", protocolVersion: PROTOCOL_VERSION, attemptId, ...failure });
        return;
    } finally {
        Module.onProgress = null;
    }

    if (rc === MLOD_RESULT_OUT_OF_MEMORY) {
        post({
            type: "error",
            protocolVersion: PROTOCOL_VERSION,
            attemptId,
            code: "MLOD-MEMORY-OOM",
            message: "the converter ran out of memory while converting",
        });
        return;
    }

    const report = readReportJson(Module, session.handle);
    if (rc !== MLOD_RESULT_SUCCESS || !report || !report.success) {
        post({
            type: "error",
            protocolVersion: PROTOCOL_VERSION,
            attemptId,
            code: report?.diagnostics?.[0]?.code ?? "MLOD-OUTPUT-VALIDATION",
            message: report?.diagnostics?.[0]?.message ?? "conversion failed",
        });
        return;
    }

    let download;
    try {
        download = await buildDownloadPackage(Module, session.handle, {
            entryName: entryName ?? session.entryName,
            sourceEntryName: session.entryName,
            options: session.options,
            includeStats: Boolean(includeStats),
            versionReport: session.versionReport,
            report,
        });
    } catch (error) {
        // Naming/copy/metadata/ZIP/verification failure: atomic packaging
        // failure with zero published Blob, even though the core conversion
        // itself already validated every primitive (architecture 7.15).
        post({
            type: "error",
            protocolVersion: PROTOCOL_VERSION,
            attemptId,
            code: "MLOD-PACKAGE-ZIP",
            message: `packaging the converted output failed: ${error && error.message ? error.message : String(error)}`,
        });
        return;
    }

    post({ type: "success", protocolVersion: PROTOCOL_VERSION, attemptId, report, download });
}

async function handleClear() {
    try {
        destroySession(await loadModule());
    } catch {
        session = { handle: 0, files: new Map(), entryName: null, options: null, versionReport: session.versionReport };
    }
}

function enqueueOperation(operation) {
    operationQueue = operationQueue.then(operation, operation);
}

self.addEventListener("message", (event) => {
    const message = event.data ?? {};
    enqueueOperation(async () => {
        switch (message.type) {
            case "initialize":
                await handleInitialize();
                break;
            case "inspect":
                await handleInspect(message);
                break;
            case "convert":
                await handleConvert(message);
                break;
            case "clear":
                await handleClear();
                break;
            default:
                break;
        }
    });
});
