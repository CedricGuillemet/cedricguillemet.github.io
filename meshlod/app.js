// MeshLoD Browser Converter -- main-thread UI shell (tasks 12.1-12.4).
//
// This module owns: file/drop acquisition (structural only -- no parsing),
// pure option parsing/validation/preset logic, the UI state machine, render
// helpers, and the worker connection (progress/success/error, download Blob
// URL lifecycle). It never touches the WASM module directly -- all
// conversion work (including deterministic output naming) happens in
// converter-worker.js.

// ---- Pure option model (architecture section 7.12) ----

/** @typedef {{meshletMaxVertices:number,meshletMinTriangles:number,meshletMaxTriangles:number,partitionSize:number,simplifyRatio:number,simplifyThreshold:number,pageMinKiB:number,pageTargetKiB:number,pageMaxKiB:number}} ConversionOptions */

/** @type {ConversionOptions} */
export const CANONICAL_OPTIONS = Object.freeze({
    meshletMaxVertices: 64,
    meshletMinTriangles: 40,
    meshletMaxTriangles: 124,
    partitionSize: 8,
    simplifyRatio: 0.5,
    simplifyThreshold: 0.85,
    pageMinKiB: 64,
    pageTargetKiB: 128,
    pageMaxKiB: 256,
});

/** @type {Record<'canonical'|'compact'|'fine', ConversionOptions>} */
export const PRESETS = Object.freeze({
    canonical: CANONICAL_OPTIONS,
    compact: Object.freeze({
        meshletMaxVertices: 64,
        meshletMinTriangles: 40,
        meshletMaxTriangles: 96,
        partitionSize: 8,
        simplifyRatio: 0.4,
        simplifyThreshold: 0.8,
        pageMinKiB: 64,
        pageTargetKiB: 128,
        pageMaxKiB: 256,
    }),
    fine: Object.freeze({
        meshletMaxVertices: 96,
        meshletMinTriangles: 64,
        meshletMaxTriangles: 160,
        partitionSize: 12,
        simplifyRatio: 0.65,
        simplifyThreshold: 0.9,
        pageMinKiB: 64,
        pageTargetKiB: 192,
        pageMaxKiB: 256,
    }),
});

const RANGES = Object.freeze({
    meshletMaxVertices: [4, 256],
    meshletMinTriangles: [4, 256],
    meshletMaxTriangles: [4, 256],
    partitionSize: [2, 32],
    simplifyRatio: [0, 1],
    simplifyThreshold: [0, 1],
    pageMinKiB: [64, 256],
    pageTargetKiB: [64, 256],
    pageMaxKiB: [64, 256],
});

/**
 * Validates a ConversionOptions value exactly like the native CLI /
 * ConversionSettings (conversion_types.h): every field in range, page sizes
 * 64 KiB multiples with min<=target<=max, and meshletMinTriangles<=
 * meshletMaxTriangles. Pure -- no DOM access. Returns the first violation
 * found (matching the native parser's ordering) or null when valid.
 * @param {ConversionOptions} options
 * @returns {{field:string,message:string}|null}
 */
export function validateOptions(options) {
    for (const [field, [low, high]] of Object.entries(RANGES)) {
        const value = options[field];
        if (typeof value !== "number" || Number.isNaN(value) || value < low || value > high) {
            return { field, message: `${field} must be between ${low} and ${high}` };
        }
    }
    for (const field of ["pageMinKiB", "pageTargetKiB", "pageMaxKiB"]) {
        if (options[field] % 64 !== 0) {
            return { field, message: `${field} must be a multiple of 64 KiB` };
        }
    }
    if (!(options.pageMinKiB <= options.pageTargetKiB && options.pageTargetKiB <= options.pageMaxKiB)) {
        return { field: "pageTargetKiB", message: "page sizes must satisfy minimum \u2264 target \u2264 maximum" };
    }
    if (options.meshletMinTriangles > options.meshletMaxTriangles) {
        return { field: "meshletMinTriangles", message: "min triangles must not exceed max triangles" };
    }
    return null;
}

/**
 * Selection mode/mesh/primitive, mirroring PrimitiveSelection
 * (conversion_types.h): a primitive always carries its owning mesh, so "a
 * primitive without a mesh" cannot be represented.
 * @param {string} meshValue "all" or a mesh index string
 * @param {string} primitiveValue "all" or a primitive index string
 */
export function parseSelection(meshValue, primitiveValue) {
    if (meshValue === "all" || meshValue === undefined) {
        return { mode: "all" };
    }
    const meshIndex = Number.parseInt(meshValue, 10);
    if (primitiveValue === "all" || primitiveValue === undefined) {
        return { mode: "mesh", meshIndex };
    }
    return { mode: "primitive", meshIndex, primitiveIndex: Number.parseInt(primitiveValue, 10) };
}

// ---- UI state machine ----

export const STATUS = Object.freeze({
    STARTING: "STARTING",
    EMPTY: "EMPTY",
    INSPECTING: "INSPECTING",
    READY: "READY",
    INPUT_ERROR: "INPUT_ERROR",
    PREFLIGHT_BLOCKED: "PREFLIGHT_BLOCKED",
    CONVERTING: "CONVERTING",
    PACKAGING: "PACKAGING",
    SUCCESS: "SUCCESS",
    CANCELLED: "CANCELLED",
    CONVERSION_ERROR: "CONVERSION_ERROR",
    WORKER_FATAL: "WORKER_FATAL",
});

function formatBytes(bytes) {
    if (typeof bytes !== "number" || Number.isNaN(bytes)) {
        return "\u2014";
    }
    const units = ["B", "KiB", "MiB", "GiB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

/**
 * Escapes text for safe insertion into innerHTML (file names and diagnostic
 * messages are attacker-influenced -- never trust them as markup).
 * @param {string} value
 */
function escapeHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---- Application state (single mutable source of truth) ----

// Stage labels shown in the progress card, indexed by ConversionStage
// (conversion_types.h): Validate resources, Normalize geometry, Build
// hierarchy, Pack streaming pages, Validate outputs, Prepare download.
const STAGE_LABELS = ["Validating resources", "Normalizing geometry", "Building hierarchy", "Packing streaming pages", "Validating outputs", "Preparing download"];

/**
 * @typedef {{
 *   status: string,
 *   files: File[],
 *   entryName: string|null,
 *   options: ConversionOptions,
 *   selection: {mode:string, meshIndex?:number, primitiveIndex?:number},
 *   includeStats: boolean,
 *   optionError: {field:string,message:string}|null,
 *   preflight: {selectedBytes:number, estimatedPeakBytes:number, policyLimitBytes:number, withinPolicyLimit:boolean}|null,
 *   diagnostics: {code:string,message:string}[],
 *   attemptId: number,
 *   progress: {stage:number, activityCode:string, percent:number, trackedBytes:number, estimatedPeakBytes:number, context:string}|null,
 *   download: {name:string, mimeType:string, blobUrl:string}|null,
 * }} AppState
 */

/** @type {AppState} */
const state = {
    status: STATUS.STARTING,
    files: [],
    entryName: null,
    options: { ...CANONICAL_OPTIONS },
    selection: { mode: "all" },
    includeStats: true,
    optionError: null,
    preflight: null,
    diagnostics: [],
    attemptId: 0,
    progress: null,
    download: null,
};

/**
 * Revokes the currently retained download's object URL (if any) and clears
 * `state.download`. Must run on every replacement path -- clear, new
 * selection, new conversion attempt, failure, cancel, or a new success
 * replacing an old one (architecture 7.15: "no automatic or repeated
 * downloads", REQ-BROWSER-7/8).
 */
function revokeDownload() {
    if (state.download) {
        URL.revokeObjectURL(state.download.blobUrl);
        state.download = null;
    }
}

// Extension points for the worker (tasks 12.2-12.3). `requestInspection` and
// `requestConversion` drive the real converter-worker.js with progress
// relaying; `requestCancel` performs a hard worker-termination cancel since a
// queued message cannot interrupt synchronous WASM execution (architecture
// 7.14). Kept as mutable bindings so a test harness can still substitute a
// fake.
export const hooks = {
    /** @param {File[]} files */
    requestInspection: async (files) => {
        await inspectWithWorker(files);
    },
    requestConversion: async () => {
        state.progress = null;
        revokeDownload(); // a new attempt always replaces any prior download
        workerClient()?.postMessage({
            type: "convert",
            attemptId: state.attemptId,
            entryName: state.entryName,
            includeStats: state.includeStats,
        });
    },
    requestCancel: () => {
        // Hard cancellation terminates the worker (architecture 7.14): a
        // queued message cannot interrupt synchronous WASM execution.
        terminateWorker();
    },
};

function byId(id) {
    return document.getElementById(id);
}

function announce(message) {
    const announcer = byId("announcer");
    if (announcer) {
        announcer.textContent = message;
    }
}

// ---- Worker connection ----

let worker = null;

function workerClient() {
    return worker;
}

// Same conservative signature match as converter-worker.js's classifier
// (architecture 7.14/7.16): only a recognized allocation/grow-memory message
// is ever reported as MLOD-MEMORY-OOM; everything else -- including a plain
// `error`/`messageerror` event with no message -- stays MLOD-WORKER-UNEXPECTED.
const OOM_MESSAGE_PATTERN = /cannot enlarge memory arrays|memory growth|allocation failed|requested allocation size|out of memory/i;

function classifyWorkerFailure(rawMessage) {
    if (OOM_MESSAGE_PATTERN.test(rawMessage || "")) {
        return { code: "MLOD-MEMORY-OOM", message: "the converter ran out of memory" };
    }
    return { code: "MLOD-WORKER-UNEXPECTED", message: rawMessage || "the converter worker failed unexpectedly" };
}

function createWorker() {
    // Test-only injection seam (mesh-lod-tool/tests/fixtures/browser/worker-failures.js):
    // a fixture may set this global before app.js runs to substitute a fake
    // worker-like object for deterministic failure/progress/cancel testing.
    const factory = typeof globalThis !== "undefined" ? globalThis.__MLOD_TEST_WORKER_FACTORY__ : null;
    worker = factory ? factory() : new Worker("./converter-worker.js", { type: "module" });
    worker.addEventListener("message", (event) => onWorkerMessage(event.data ?? {}));
    worker.addEventListener("error", (event) => onWorkerFatal(classifyWorkerFailure(event?.message)));
    worker.addEventListener("messageerror", () => onWorkerFatal(classifyWorkerFailure("")));
    worker.postMessage({ type: "initialize" });
    return worker;
}

function terminateWorker() {
    if (worker) {
        worker.terminate();
    }
    state.attemptId += 1; // invalidate any in-flight reply
    state.progress = null;
    createWorker();
}

function onWorkerFatal(failure) {
    const { code, message } = typeof failure === "string" ? { code: "MLOD-WORKER-UNEXPECTED", message: failure } : failure;
    state.status = STATUS.WORKER_FATAL;
    state.diagnostics = [{ code, message }];
    state.progress = null;
    render();
    announce(message);
    // A startup-asset failure (the module/wasm itself failed to load) will
    // fail identically on every retry with no state change -- recreating the
    // worker here would spin forever (each new worker immediately re-fails
    // "initialize", triggering another onWorkerFatal). Only transient
    // mid-operation crashes (error/messageerror DOM events, both reported as
    // MLOD-WORKER-UNEXPECTED/MLOD-MEMORY-OOM) get an automatic fresh worker
    // so the next user attempt has something to talk to.
    if (code !== "MLOD-STARTUP-ASSET") {
        createWorker();
    }
}

function onWorkerMessage(message) {
    switch (message.type) {
        case "ready":
            onWorkerReady(message);
            return;
        case "inspected":
            onInspected(message);
            return;
        case "progress":
            onProgress(message);
            return;
        case "error":
            onWorkerError(message);
            return;
        case "success":
            onConversionSuccess(message);
            return;
        case "fatal":
            onWorkerFatal({ code: "MLOD-STARTUP-ASSET", message: message.message || "the converter worker failed to start" });
            return;
        default:
    }
}

function onWorkerReady(message) {
    const badge = byId("buildBadge");
    if (badge && message.version) {
        badge.textContent = `format ${message.version.formatVersion} \u00b7 local files only \u00b7 single-threaded`;
    }
    if (state.status === STATUS.STARTING) {
        state.status = STATUS.EMPTY;
        render();
    }
}

function populateSelectionOptions(primitives) {
    const meshSelect = byId("meshSelect");
    const primitiveSelect = byId("primitiveSelect");
    if (!meshSelect || !primitiveSelect) {
        return;
    }
    const meshIndices = [...new Set(primitives.map((p) => p.meshIndex))].sort((a, b) => a - b);
    meshSelect.innerHTML = `<option value="all">All meshes</option>` + meshIndices.map((index) => `<option value="${index}">${index}</option>`).join("");
    primitiveSelect.innerHTML = `<option value="all">All primitives</option>`;
    primitiveSelect.disabled = true;
}

function onInspected(message) {
    if (message.attemptId !== state.attemptId) {
        return; // superseded
    }
    const report = message.report;
    state.diagnostics = [];
    populateSelectionOptions(report.primitives || []);
    state.preflight = report.preflight
        ? {
              selectedBytes: report.preflight.selectedBytes,
              estimatedPeakBytes: report.preflight.estimatedPeakBytes,
              policyLimitBytes: report.preflight.policyLimitBytes,
              withinPolicyLimit: report.preflight.withinPolicyLimit,
          }
        : null;
    // "Does not start the worker" (REQ-BROWSER-5) means "does not start a
    // conversion job" -- the worker itself is already running and only
    // performed lightweight inspection here.
    state.status = state.preflight && !state.preflight.withinPolicyLimit ? STATUS.PREFLIGHT_BLOCKED : STATUS.READY;
    render();
    announce(state.status === STATUS.PREFLIGHT_BLOCKED ? "Estimated peak memory exceeds the browser limit" : "Ready");
}

function onProgress(message) {
    if (message.attemptId !== state.attemptId) {
        return; // superseded by cancellation or a newer attempt
    }
    if (state.status !== STATUS.CONVERTING && state.status !== STATUS.PACKAGING) {
        return; // stray progress arriving after cancel/error/success settled
    }
    // Stage 5 (kPrepareDownload) is the only stage the UI labels "Preparing
    // download" (STATUS.PACKAGING); every earlier stage is "Converting".
    state.status = message.stage === 5 ? STATUS.PACKAGING : STATUS.CONVERTING;
    state.progress = {
        stage: message.stage,
        activityCode: message.activityCode,
        percent: message.percent,
        trackedBytes: message.trackedBytes,
        estimatedPeakBytes: message.estimatedPeakBytes,
        context: message.context,
    };
    render();
}

function onWorkerError(message) {
    if (message.attemptId !== state.attemptId) {
        return; // superseded
    }
    revokeDownload();
    state.diagnostics = [{ code: message.code, message: message.message }];
    state.status = state.status === STATUS.CONVERTING || state.status === STATUS.PACKAGING ? STATUS.CONVERSION_ERROR : STATUS.INPUT_ERROR;
    state.progress = null;
    render();
    announce(message.message);
}

function onConversionSuccess(message) {
    if (message.attemptId !== state.attemptId) {
        return; // superseded
    }
    revokeDownload();
    const download = message.download;
    state.download = download ? { name: download.name, mimeType: download.mimeType, blobUrl: URL.createObjectURL(download.blob) } : null;
    state.status = STATUS.SUCCESS;
    state.progress = null;
    render();
    announce("Conversion succeeded");
    // Release the worker's linear memory now that the final immutable Blob
    // has been transferred to the main thread (architecture 7.15 step 5) --
    // Emscripten memory only grows, so a large conversion's WASM instance is
    // never shrunk; the only way to reclaim it is a fresh worker.
    terminateWorker();
}

// ---- Rendering ----

function renderResourceList() {
    const list = byId("resourceList");
    const count = byId("resourceCount");
    const summary = byId("inputSummary");
    if (!list || !count || !summary) {
        return;
    }
    count.textContent = `${state.files.length} file${state.files.length === 1 ? "" : "s"}`;
    if (state.files.length === 0) {
        list.innerHTML = "";
        summary.innerHTML = "";
        return;
    }
    list.innerHTML = state.files
        .map((file) => {
            const name = escapeHtml(file.webkitRelativePath || file.name);
            const isEntry = file.name === state.entryName;
            return (
                `<div class="resource-item" data-testid="resource-item">` +
                `<div class="file-type">${isEntry ? "entry" : "file"}</div>` +
                `<div><div class="resource-name" title="${name}">${name}</div>` +
                `<div class="resource-meta">${formatBytes(file.size)}</div></div>` +
                `</div>`
            );
        })
        .join("");
    const totalBytes = state.files.reduce((sum, file) => sum + file.size, 0);
    summary.innerHTML =
        `<div class="summary-cell"><span>Entry</span><strong>${escapeHtml(state.entryName || "\u2014")}</strong></div>` +
        `<div class="summary-cell"><span>Total size</span><strong>${formatBytes(totalBytes)}</strong></div>`;
}

function renderOptionError() {
    const el = byId("optionError");
    if (!el) {
        return;
    }
    if (state.optionError) {
        el.hidden = false;
        el.textContent = state.optionError.message;
    } else {
        el.hidden = true;
        el.textContent = "";
    }
}

function renderPreflight() {
    const el = byId("preflight");
    if (!el) {
        return;
    }
    if (!state.preflight) {
        el.textContent = state.files.length === 0 ? "Select a local asset to estimate the peak working set." : "Preflight becomes available once inspection completes.";
        el.classList.remove("warning", "error");
        return;
    }
    const { estimatedPeakBytes, policyLimitBytes, withinPolicyLimit } = state.preflight;
    el.textContent = `Preflight estimate: ${formatBytes(estimatedPeakBytes)} peak working set of the ${formatBytes(policyLimitBytes)} browser limit.`;
    el.classList.toggle("error", !withinPolicyLimit);
    el.classList.toggle("warning", false);
}

function renderConvertButton() {
    const convertButton = byId("convertButton");
    const cancelButton = byId("cancelButton");
    if (!convertButton || !cancelButton) {
        return;
    }
    const converting = state.status === STATUS.CONVERTING || state.status === STATUS.PACKAGING;
    convertButton.hidden = converting;
    cancelButton.hidden = !converting;
    // Convert is only ever enabled from READY (mirrors "only SUCCESS enables
    // Download" -- every other status, including INPUT_ERROR/PREFLIGHT_BLOCKED/
    // INSPECTING, must keep it disabled).
    const blocked = state.status !== STATUS.READY || Boolean(state.optionError);
    convertButton.disabled = blocked;
    convertButton.textContent = state.selection.mode === "all" && state.files.length > 0 ? "Convert" : "Convert selection";
}

function statusCardHtml() {
    switch (state.status) {
        case STATUS.STARTING:
            return `<div class="empty-state" data-testid="status-starting"><p>Loading the MeshLoD converter\u2026</p></div>`;
        case STATUS.EMPTY:
            return `<div class="empty-state" data-testid="status-empty"><p>Select or drop a local glTF asset to begin.</p></div>`;
        case STATUS.INSPECTING:
            return `<div class="empty-state" data-testid="status-inspecting"><p>Validating the selected resources\u2026</p></div>`;
        case STATUS.INPUT_ERROR:
            return (
                `<div class="alert error" role="alert" data-testid="status-input-error">` +
                `${escapeHtml(state.diagnostics[0]?.message || "The selected resources could not be validated.")}` +
                `</div>`
            );
        case STATUS.READY:
            return `<div class="empty-state" data-testid="status-ready"><p>Ready. Adjust options, then Convert.</p></div>`;
        case STATUS.PREFLIGHT_BLOCKED:
            return (
                `<div class="alert error" role="alert" data-testid="status-preflight-blocked">` +
                `Estimated peak memory exceeds the browser limit. Reduce the selection, use a smaller asset, or use the native CLI.` +
                `</div>`
            );
        case STATUS.CONVERTING:
        case STATUS.PACKAGING: {
            const progress = state.progress;
            const percent = progress ? progress.percent : 0;
            const stageLabel = progress ? (STAGE_LABELS[progress.stage] ?? "Converting") : state.status === STATUS.PACKAGING ? "Preparing download" : "Converting";
            const memoryLine = progress
                ? `<p data-testid="progress-memory">${formatBytes(progress.trackedBytes)} tracked of an estimated ${formatBytes(progress.estimatedPeakBytes)} peak.</p>`
                : "";
            const activityLine =
                progress && progress.context ? `<p data-testid="progress-activity">${escapeHtml(progress.context)} \u00b7 ${escapeHtml(progress.activityCode)}</p>` : "";
            return (
                `<div class="progress-wrap" data-testid="status-progress">` +
                `<div class="progress-labels"><span data-testid="progress-stage">${escapeHtml(stageLabel)}</span><span data-testid="progress-percent">${percent}%</span></div>` +
                `<div class="progress-track"><div class="progress-fill" data-testid="progress-fill" style="width:${percent}%"></div></div>` +
                `${activityLine}` +
                `${memoryLine}` +
                `<p>No partial output is downloadable while conversion is active.</p>` +
                `</div>`
            );
        }
        case STATUS.SUCCESS: {
            const download = state.download;
            const nameLine = download ? `<p data-testid="download-name">${escapeHtml(download.name)}</p>` : "";
            return (
                `<div class="result-summary" data-testid="status-success">` +
                `<p>Conversion succeeded.</p>` +
                `${nameLine}` +
                `<button id="downloadButton" class="button primary" type="button" data-testid="download-button" ${download ? "" : "disabled"}>Download</button>` +
                `<button id="clearResultButton" class="button ghost" type="button" data-testid="clear-result-button">Clear result</button>` +
                `</div>`
            );
        }
        case STATUS.CANCELLED:
            return `<div class="alert warning" data-testid="status-cancelled">Conversion cancelled. No output was retained.</div>`;
        case STATUS.CONVERSION_ERROR:
            return (
                `<div class="alert error" role="alert" data-testid="status-conversion-error">` + `${escapeHtml(state.diagnostics[0]?.message || "Conversion failed.")}` + `</div>`
            );
        case STATUS.WORKER_FATAL:
            return `<div class="alert error" role="alert" data-testid="status-worker-fatal">The converter stopped unexpectedly and is restarting.</div>`;
        default:
            return "";
    }
}

function renderStatusCard() {
    const card = byId("statusCard");
    if (card) {
        card.innerHTML = statusCardHtml();
    }
}

function render() {
    renderResourceList();
    renderOptionError();
    renderPreflight();
    renderConvertButton();
    renderStatusCard();
}

// ---- Option form <-> state ----

function readOptionsFromForm() {
    return {
        meshletMaxVertices: Number(byId("maxVertices").value),
        meshletMinTriangles: Number(byId("minTriangles").value),
        meshletMaxTriangles: Number(byId("maxTriangles").value),
        partitionSize: Number(byId("partitionSize").value),
        simplifyRatio: Number(byId("simplifyRatio").value),
        simplifyThreshold: Number(byId("simplifyThreshold").value),
        pageMinKiB: Number(byId("pageMin").value),
        pageTargetKiB: Number(byId("pageTarget").value),
        pageMaxKiB: Number(byId("pageMax").value),
    };
}

function writeOptionsToForm(options) {
    byId("maxVertices").value = String(options.meshletMaxVertices);
    byId("minTriangles").value = String(options.meshletMinTriangles);
    byId("maxTriangles").value = String(options.meshletMaxTriangles);
    byId("partitionSize").value = String(options.partitionSize);
    byId("simplifyRatio").value = String(options.simplifyRatio);
    byId("simplifyThreshold").value = String(options.simplifyThreshold);
    byId("pageMin").value = String(options.pageMinKiB);
    byId("pageTarget").value = String(options.pageTargetKiB);
    byId("pageMax").value = String(options.pageMaxKiB);
}

function onOptionsChanged() {
    state.options = readOptionsFromForm();
    state.optionError = validateOptions(state.options);
    render();
}

function setActivePreset(name) {
    for (const button of document.querySelectorAll("[data-preset]")) {
        button.classList.toggle("is-active", button.dataset.preset === name);
    }
}

function applyPreset(name) {
    const preset = PRESETS[name];
    if (!preset) {
        return;
    }
    writeOptionsToForm(preset);
    setActivePreset(name);
    onOptionsChanged();
    announce(`${name} preset applied`);
}

// ---- File selection ----

function isSupportedEntryCandidate(file) {
    return /\.(glb|gltf)$/i.test(file.name);
}

/**
 * Derives the canonical virtual path for one selected File: directory-drop
 * entries and `<input webkitdirectory>` selections carry `webkitRelativePath`
 * relative to the dropped/selected root; otherwise the bare file name is
 * used. Platform backslashes are normalized to `/` (architecture 7.11 point
 * 1) -- this is the SELECTED FILE's path, distinct from a glTF document's
 * buffer/image URI strings, which the worker/ABI validate separately.
 * @param {File} file
 */
export function canonicalFilePath(file) {
    const relative = file.webkitRelativePath && file.webkitRelativePath.length > 0 ? file.webkitRelativePath : file.name;
    return relative.replace(/\\/g, "/");
}

function selectionModeNumber(selection) {
    if (selection.mode === "primitive") {
        return 2;
    }
    if (selection.mode === "mesh") {
        return 1;
    }
    return 0;
}

function optionsForWorker() {
    return {
        selectionMode: selectionModeNumber(state.selection),
        meshIndex: state.selection.meshIndex ?? 0,
        primitiveIndex: state.selection.primitiveIndex ?? 0,
        ...state.options,
    };
}

async function inspectWithWorker(files) {
    if (!worker) {
        createWorker();
    }
    const attemptId = state.attemptId;
    const descriptors = files.map((file) => ({
        path: canonicalFilePath(file),
        isEntry: file.name === state.entryName,
        blob: file,
    }));

    // Ambiguous selected paths (two files canonicalizing to the same virtual
    // path) fail before any worker round-trip.
    const seen = new Set();
    for (const descriptor of descriptors) {
        if (seen.has(descriptor.path)) {
            state.status = STATUS.INPUT_ERROR;
            state.diagnostics = [{ code: "MLOD-INPUT-DUPLICATE-PATH", message: `Duplicate selected path '${descriptor.path}'.` }];
            render();
            announce(state.diagnostics[0].message);
            return;
        }
        seen.add(descriptor.path);
    }

    workerClient().postMessage({ type: "inspect", attemptId, files: descriptors, options: optionsForWorker() });
}

function handleFileSelection(fileList) {
    const files = Array.from(fileList);
    const entries = files.filter(isSupportedEntryCandidate);

    state.attemptId += 1; // invalidate any in-flight inspect/convert reply
    state.files = files;
    state.preflight = null;
    state.diagnostics = [];
    revokeDownload(); // a new selection always replaces any prior download

    if (files.length === 0) {
        state.entryName = null;
        state.status = STATUS.EMPTY;
        render();
        return;
    }

    if (entries.length !== 1) {
        state.entryName = null;
        state.status = STATUS.INPUT_ERROR;
        state.diagnostics = [
            {
                code: "MLOD-INPUT-ENTRY-COUNT",
                message: entries.length === 0 ? "Select exactly one .glb or .gltf entry file." : "Multiple .glb/.gltf entry candidates were selected; choose exactly one.",
            },
        ];
        render();
        announce(state.diagnostics[0].message);
        return;
    }

    state.entryName = entries[0].name;
    state.status = STATUS.INSPECTING;
    render();
    announce("Validating selected resources");

    void hooks.requestInspection(state.files);
}

function clearSelection() {
    state.attemptId += 1;
    state.files = [];
    state.entryName = null;
    state.preflight = null;
    state.diagnostics = [];
    state.status = STATUS.EMPTY;
    revokeDownload();
    byId("filePicker").value = "";
    workerClient()?.postMessage({ type: "clear" });
    render();
    announce("Selection cleared");
}

// ---- Wiring ----

// Recursively reads a dropped FileSystemEntry tree, preserving each file's
// path relative to the dropped root by defining `webkitRelativePath` on it
// (matching what `<input webkitdirectory>` already provides natively) so
// canonicalFilePath() has one single code path for both. Falls back to the
// flat `DataTransfer.files` list when the browser lacks entry APIs.
async function readEntry(entry, prefix) {
    if (entry.isFile) {
        const file = await new Promise((resolvePromise, reject) => entry.file(resolvePromise, reject));
        const relativePath = prefix + entry.name;
        try {
            Object.defineProperty(file, "webkitRelativePath", { value: relativePath, configurable: true });
        } catch {
            // Some engines disallow redefining this property; canonicalFilePath()
            // then falls back to file.name (loses nested-directory structure).
        }
        return [file];
    }
    if (entry.isDirectory) {
        const reader = entry.createReader();
        const entries = await new Promise((resolvePromise, reject) => reader.readEntries(resolvePromise, reject));
        const nested = await Promise.all(entries.map((child) => readEntry(child, prefix + entry.name + "/")));
        return nested.flat();
    }
    return [];
}

async function filesFromDataTransfer(dataTransfer) {
    const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
    const entries = items.map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null)).filter(Boolean);
    if (entries.length === 0) {
        return Array.from(dataTransfer.files || []);
    }
    const nested = await Promise.all(entries.map((entry) => readEntry(entry, "")));
    return nested.flat();
}

function wireEvents() {
    const dropZone = byId("dropZone");
    const filePicker = byId("filePicker");

    byId("pickFiles").addEventListener("click", () => filePicker.click());
    filePicker.addEventListener("change", () => handleFileSelection(filePicker.files));

    dropZone.addEventListener("dragover", (event) => {
        event.preventDefault();
        dropZone.classList.add("is-dragging");
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-dragging"));
    dropZone.addEventListener("drop", (event) => {
        event.preventDefault();
        dropZone.classList.remove("is-dragging");
        if (event.dataTransfer) {
            void filesFromDataTransfer(event.dataTransfer).then(handleFileSelection);
        }
    });

    byId("clearFiles").addEventListener("click", clearSelection);

    for (const id of ["maxVertices", "minTriangles", "maxTriangles", "partitionSize", "simplifyRatio", "simplifyThreshold", "pageMin", "pageTarget", "pageMax"]) {
        byId(id).addEventListener("input", () => {
            setActivePreset(null);
            onOptionsChanged();
        });
    }

    byId("includeStats").addEventListener("change", (event) => {
        state.includeStats = event.target.checked;
    });

    byId("meshSelect").addEventListener("change", () => {
        const primitiveSelect = byId("primitiveSelect");
        primitiveSelect.disabled = byId("meshSelect").value === "all";
        state.selection = parseSelection(byId("meshSelect").value, primitiveSelect.value);
        renderConvertButton();
    });
    byId("primitiveSelect").addEventListener("change", () => {
        state.selection = parseSelection(byId("meshSelect").value, byId("primitiveSelect").value);
        renderConvertButton();
    });

    for (const button of document.querySelectorAll("[data-preset]")) {
        button.addEventListener("click", () => applyPreset(button.dataset.preset));
    }

    byId("resetOptions").addEventListener("click", () => applyPreset("canonical"));

    byId("convertButton").addEventListener("click", async () => {
        if (state.optionError || !state.entryName) {
            return;
        }
        state.status = STATUS.CONVERTING;
        render();
        announce("Conversion started");
        await Promise.resolve(hooks.requestConversion());
    });

    byId("cancelButton").addEventListener("click", () => {
        revokeDownload();
        hooks.requestCancel();
        state.status = STATUS.CANCELLED;
        render();
        announce("Conversion cancelled");
    });

    // downloadButton/clearResultButton only exist inside the SUCCESS status
    // card's innerHTML (recreated on every render), so they are wired via
    // delegation on the stable statusCard container instead of a
    // direct listener that would be destroyed on the next render.
    byId("statusCard").addEventListener("click", (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        if (target.id === "downloadButton") {
            triggerDownload();
        } else if (target.id === "clearResultButton") {
            clearResult();
        }
    });
}

/** Triggers the browser's save dialog for the currently retained download. Never called except from the explicit Download button click (architecture 7.15: "Download starts only from the accepted mock's explicit Download button"). */
function triggerDownload() {
    if (!state.download) {
        return;
    }
    const link = document.createElement("a");
    link.href = state.download.blobUrl;
    link.download = state.download.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
}

/** "Clear result": releases the retained download and re-inspects the current selection against the freshly replaced worker (its ABI session was reset when the worker was recreated after success), returning to READY/PREFLIGHT_BLOCKED once that completes. */
function clearResult() {
    revokeDownload();
    state.status = STATUS.INSPECTING;
    render();
    announce("Re-validating the current selection");
    void hooks.requestInspection(state.files);
}

function init() {
    state.status = STATUS.STARTING;
    wireEvents();
    render();
    createWorker();
}

if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
}
