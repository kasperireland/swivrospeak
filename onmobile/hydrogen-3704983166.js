// @license magnet:?xt=urn:btih:8e4f440f4c65981c5bf93c76d35135ba5064d8b7&dn=apache-2.0.txt Apache-2.0
class AbortError extends Error {
    get name() {
        return "AbortError";
    }
}

class WrappedError extends Error {
    constructor(message, cause) {
        super(`${message}: ${cause.message}`);
        this.cause = cause;
    }
    get name() {
        return "WrappedError";
    }
}
class HomeServerError extends Error {
    constructor(method, url, body, status) {
        super(`${body ? body.error : status} on ${method} ${url}`);
        this.errcode = body ? body.errcode : null;
        this.retry_after_ms = body ? body.retry_after_ms : 0;
        this.statusCode = status;
    }
    get name() {
        return "HomeServerError";
    }
}
class ConnectionError extends Error {
    constructor(message, isTimeout) {
        super(message || "ConnectionError");
        this.isTimeout = isTimeout;
    }
    get name() {
        return "ConnectionError";
    }
}

class BaseObservable {
    constructor() {
        this._handlers = new Set();
    }
    onSubscribeFirst() {
    }
    onUnsubscribeLast() {
    }
    subscribe(handler) {
        this._handlers.add(handler);
        if (this._handlers.size === 1) {
            this.onSubscribeFirst();
        }
        return () => {
            return this.unsubscribe(handler);
        };
    }
    unsubscribe(handler) {
        if (handler) {
            this._handlers.delete(handler);
            if (this._handlers.size === 0) {
                this.onUnsubscribeLast();
            }
            handler = null;
        }
        return null;
    }
    unsubscribeAll() {
        if (this._handlers.size !== 0) {
            this._handlers.clear();
            this.onUnsubscribeLast();
        }
    }
    get hasSubscriptions() {
        return this._handlers.size !== 0;
    }
}

class BaseObservableValue extends BaseObservable {
    emit(argument) {
        for (const h of this._handlers) {
            h(argument);
        }
    }
    get() {
        throw new Error("unimplemented");
    }
    waitFor(predicate) {
        if (predicate(this.get())) {
            return new ResolvedWaitForHandle(Promise.resolve(this.get()));
        } else {
            return new WaitForHandle(this, predicate);
        }
    }
}
class WaitForHandle {
    constructor(observable, predicate) {
        this._promise = new Promise((resolve, reject) => {
            this._reject = reject;
            this._subscription = observable.subscribe(v => {
                if (predicate(v)) {
                    this._reject = null;
                    resolve(v);
                    this.dispose();
                }
            });
        });
    }
    get promise() {
        return this._promise;
    }
    dispose() {
        if (this._subscription) {
            this._subscription();
            this._subscription = null;
        }
        if (this._reject) {
            this._reject(new AbortError());
            this._reject = null;
        }
    }
}
class ResolvedWaitForHandle {
    constructor(promise) {
        this.promise = promise;
    }
    dispose() {}
}
class ObservableValue extends BaseObservableValue {
    constructor(initialValue) {
        super();
        this._value = initialValue;
    }
    get() {
        return this._value;
    }
    set(value) {
        if (value !== this._value) {
            this._value = value;
            this.emit(this._value);
        }
    }
}
class RetainedObservableValue extends ObservableValue {
    constructor(initialValue, freeCallback) {
        super(initialValue);
        this._freeCallback = freeCallback;
    }
    onUnsubscribeLast() {
        super.onUnsubscribeLast();
        this._freeCallback();
    }
}

function abortOnTimeout(createTimeout, timeoutAmount, requestResult, responsePromise) {
    const timeout = createTimeout(timeoutAmount);
    let timedOut = false;
    timeout.elapsed().then(
        () => {
            timedOut = true;
            requestResult.abort();
        },
        () => {}
    );
    return responsePromise.then(
        response => {
            timeout.abort();
            return response;
        },
        err => {
            timeout.abort();
            if (err.name === "AbortError" && timedOut) {
                throw new ConnectionError(`Request timed out after ${timeoutAmount}ms`, true);
            } else {
                throw err;
            }
        }
    );
}

function addCacheBuster(urlStr, random = Math.random) {
    if (urlStr.includes("?")) {
        urlStr = urlStr + "&";
    } else {
        urlStr = urlStr + "?";
    }
    return urlStr + `_cacheBuster=${Math.ceil(random() * Number.MAX_SAFE_INTEGER)}`;
}

class RequestResult {
    constructor(promise, xhr) {
        this._promise = promise;
        this._xhr = xhr;
    }
    abort() {
        this._xhr.abort();
    }
    response() {
        return this._promise;
    }
}
function createXhr(url, {method, headers, timeout, format, uploadProgress}) {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    if (format === "buffer") {
        xhr.responseType = "arraybuffer";
    }
    if (headers) {
        for(const [name, value] of headers.entries()) {
            try {
                xhr.setRequestHeader(name, value);
            } catch (err) {
                console.info(`Could not set ${name} header: ${err.message}`);
            }
        }
    }
    if (timeout) {
        xhr.timeout = timeout;
    }
    if (uploadProgress) {
        xhr.upload.addEventListener("progress", evt => uploadProgress(evt.loaded));
    }
    return xhr;
}
function xhrAsPromise(xhr, method, url) {
    return new Promise((resolve, reject) => {
        xhr.addEventListener("load", () => resolve(xhr));
        xhr.addEventListener("abort", () => reject(new AbortError()));
        xhr.addEventListener("error", () => reject(new ConnectionError(`Error ${method} ${url}`)));
        xhr.addEventListener("timeout", () => reject(new ConnectionError(`Timeout ${method} ${url}`, true)));
    });
}
function xhrRequest(url, options) {
    let {cache, format, body, method} = options;
    if (!cache) {
        url = addCacheBuster(url);
    }
    const xhr = createXhr(url, options);
    const promise = xhrAsPromise(xhr, method, url).then(xhr => {
        const {status} = xhr;
        let body = null;
        if (format === "buffer") {
            body = xhr.response;
        } else if (xhr.getResponseHeader("Content-Type") === "application/json") {
            body = JSON.parse(xhr.responseText);
        }
        return {status, body};
    });
    if (body?.nativeBlob) {
        body = body.nativeBlob;
    }
    xhr.send(body || null);
    return new RequestResult(promise, xhr);
}

class RequestResult$1 {
    constructor(promise, controller) {
        if (!controller) {
            const abortPromise = new Promise((_, reject) => {
                this._controller = {
                    abort() {
                        const err = new Error("fetch request aborted");
                        err.name = "AbortError";
                        reject(err);
                    }
                };
            });
            this.promise = Promise.race([promise, abortPromise]);
        } else {
            this.promise = promise;
            this._controller = controller;
        }
    }
    abort() {
        this._controller.abort();
    }
    response() {
        return this.promise;
    }
}
function createFetchRequest(createTimeout, serviceWorkerHandler) {
    return function fetchRequest(url, requestOptions) {
        if (serviceWorkerHandler?.haltRequests) {
            return new RequestResult$1(new Promise(() => {}), {});
        }
        if (requestOptions?.uploadProgress) {
            return xhrRequest(url, requestOptions);
        }
        let {method, headers, body, timeout, format, cache = false} = requestOptions;
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        if (body?.nativeBlob) {
            body = body.nativeBlob;
        }
        let options = {method, body};
        if (controller) {
            options = Object.assign(options, {
                signal: controller.signal
            });
        }
        if (!cache) {
            url = addCacheBuster(url);
        }
        options = Object.assign(options, {
            mode: "cors",
            credentials: "omit",
            referrer: "no-referrer",
            cache: "default",
        });
        if (headers) {
            const fetchHeaders = new Headers();
            for(const [name, value] of headers.entries()) {
                fetchHeaders.append(name, value);
            }
            options.headers = fetchHeaders;
        }
        const promise = fetch(url, options).then(async response => {
            const {status} = response;
            let body;
            try {
                if (format === "json") {
                    body = await response.json();
                } else if (format === "buffer") {
                    body = await response.arrayBuffer();
                }
            } catch (err) {
                if (!(err.name === "SyntaxError" && status >= 400)) {
                    throw err;
                }
            }
            return {status, body};
        }, err => {
            if (err.name === "AbortError") {
                throw new AbortError();
            } else if (err instanceof TypeError) {
                throw new ConnectionError(`${method} ${url}: ${err.message}`);
            }
            throw err;
        });
        const result = new RequestResult$1(promise, controller);
        if (timeout) {
            result.promise = abortOnTimeout(createTimeout, timeout, result, result.promise);
        }
        return result;
    }
}

const STORE_NAMES = Object.freeze([
    "session",
    "roomState",
    "roomSummary",
    "archivedRoomSummary",
    "invites",
    "roomMembers",
    "timelineEvents",
    "timelineRelations",
    "timelineFragments",
    "pendingEvents",
    "userIdentities",
    "deviceIdentities",
    "olmSessions",
    "inboundGroupSessions",
    "outboundGroupSessions",
    "groupSessionDecryptions",
    "operations",
    "accountData",
]);
const STORE_MAP = Object.freeze(STORE_NAMES.reduce((nameMap, name) => {
    nameMap[name] = name;
    return nameMap;
}, {}));
class StorageError extends Error {
    constructor(message, cause) {
        super(message);
        if (cause) {
            this.errcode = cause.name;
        }
        this.cause = cause;
    }
    get name() {
        return "StorageError";
    }
}
const KeyLimits = {
    get minStorageKey() {
        return 0;
    },
    get middleStorageKey() {
        return 0x7FFFFFFF;
    },
    get maxStorageKey() {
        return 0xFFFFFFFF;
    }
};

class IDBError extends StorageError {
    constructor(message, source, cause) {
        const storeName = source?.name || "<unknown store>";
        const databaseName = source?.transaction?.db?.name || "<unknown db>";
        let fullMessage = `${message} on ${databaseName}.${storeName}`;
        if (cause) {
            fullMessage += ": ";
            if (typeof cause.name === "string") {
                fullMessage += `(name: ${cause.name}) `;
            }
            if (typeof cause.code === "number") {
                fullMessage += `(code: ${cause.code}) `;
            }
        }
        if (cause) {
            fullMessage += cause.message;
        }
        super(fullMessage, cause);
        this.storeName = storeName;
        this.databaseName = databaseName;
    }
}
class IDBRequestError extends IDBError {
    constructor(request, message = "IDBRequest failed") {
        const source = request.source;
        const cause = request.error;
        super(message, source, cause);
    }
}
class IDBRequestAttemptError extends IDBError {
    constructor(method, source, cause, params) {
        super(`${method}(${params.map(p => JSON.stringify(p)).join(", ")}) failed`, source, cause);
    }
}

function encodeUint32(n) {
    const hex = n.toString(16);
    return "0".repeat(8 - hex.length) + hex;
}
function decodeUint32(str) {
    return parseInt(str, 16);
}
function openDatabase(name, createObjectStore, version, idbFactory = window.indexedDB) {
    const req = idbFactory.open(name, version);
    req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        const txn = ev.target.transaction;
        const oldVersion = ev.oldVersion;
        createObjectStore(db, txn, oldVersion, version);
    };
    return reqAsPromise(req);
}
function reqAsPromise(req) {
    return new Promise((resolve, reject) => {
        req.addEventListener("success", event => {
            resolve(event.target.result);
        });
        req.addEventListener("error", event => {
            const error = new IDBRequestError(event.target);
            reject(error);
        });
    });
}
function txnAsPromise(txn) {
    let error;
    return new Promise((resolve, reject) => {
        txn.addEventListener("complete", () => {
            resolve();
        });
        txn.addEventListener("error", event => {
            const request = event.target;
            if (!error && request) {
                error = new IDBRequestError(request);
            }
        });
        txn.addEventListener("abort", event => {
            if (!error) {
                const txn = event.target;
                const dbName = txn.db.name;
                const storeNames = Array.from(txn.objectStoreNames).join(", ");
                error = new StorageError(`Transaction on ${dbName} with stores ${storeNames} was aborted.`);
            }
            reject(error);
        });
    });
}
function iterateCursor(cursorRequest, processValue) {
    return new Promise((resolve, reject) => {
        cursorRequest.onerror = () => {
            reject(new IDBRequestError(cursorRequest));
        };
        cursorRequest.onsuccess = (event) => {
            const cursor = event.target.result;
            if (!cursor) {
                resolve(false);
                return;
            }
            const result = processValue(cursor.value, cursor.key, cursor);
            const done = result?.done;
            const jumpTo = result?.jumpTo;
            if (done) {
                resolve(true);
            } else if(jumpTo) {
                cursor.continue(jumpTo);
            } else {
                cursor.continue();
            }
        };
    }).catch(err => {
        throw new StorageError("iterateCursor failed", err);
    });
}
async function fetchResults(cursor, isDone) {
    const results = [];
    await iterateCursor(cursor, (value) => {
        results.push(value);
        return {done: isDone(results)};
    });
    return results;
}

class QueryTarget {
    constructor(target) {
        this._target = target;
    }
    _openCursor(range, direction) {
        if (range && direction) {
            return this._target.openCursor(range, direction);
        } else if (range) {
            return this._target.openCursor(range);
        } else if (direction) {
            return this._target.openCursor(null, direction);
        } else {
            return this._target.openCursor();
        }
    }
    supports(methodName) {
        return this._target.supports(methodName);
    }
    get(key) {
        return reqAsPromise(this._target.get(key));
    }
    getKey(key) {
        if (this._target.supports("getKey")) {
            return reqAsPromise(this._target.getKey(key));
        } else {
            return reqAsPromise(this._target.get(key)).then(value => {
                if (value) {
                    return value[this._target.keyPath];
                }
            });
        }
    }
    reduce(range, reducer, initialValue) {
        return this._reduce(range, reducer, initialValue, "next");
    }
    reduceReverse(range, reducer, initialValue) {
        return this._reduce(range, reducer, initialValue, "prev");
    }
    selectLimit(range, amount) {
        return this._selectLimit(range, amount, "next");
    }
    selectLimitReverse(range, amount) {
        return this._selectLimit(range, amount, "prev");
    }
    selectWhile(range, predicate) {
        return this._selectWhile(range, predicate, "next");
    }
    selectWhileReverse(range, predicate) {
        return this._selectWhile(range, predicate, "prev");
    }
    async selectAll(range, direction) {
        const cursor = this._openCursor(range, direction);
        const results = [];
        await iterateCursor(cursor, (value) => {
            results.push(value);
            return {done: false};
        });
        return results;
    }
    selectFirst(range) {
        return this._find(range, () => true, "next");
    }
    selectLast(range) {
        return this._find(range, () => true, "prev");
    }
    find(range, predicate) {
        return this._find(range, predicate, "next");
    }
    findReverse(range, predicate) {
        return this._find(range, predicate, "prev");
    }
    async findMaxKey(range) {
        const cursor = this._target.openKeyCursor(range, "prev");
        let maxKey;
        await iterateCursor(cursor, (_, key) => {
            maxKey = key;
            return {done: true};
        });
        return maxKey;
    }
    async iterateValues(range, callback) {
        const cursor = this._target.openCursor(range, "next");
        await iterateCursor(cursor, (value, key, cur) => {
            return {done: callback(value, key, cur)};
        });
    }
    async iterateKeys(range, callback) {
        const cursor = this._target.openKeyCursor(range, "next");
        await iterateCursor(cursor, (_, key, cur) => {
            return {done: callback(key, cur)};
        });
    }
    async findExistingKeys(keys, backwards, callback) {
        const direction = backwards ? "prev" : "next";
        const compareKeys = (a, b) => backwards ? -indexedDB.cmp(a, b) : indexedDB.cmp(a, b);
        const sortedKeys = keys.slice().sort(compareKeys);
        const firstKey = backwards ? sortedKeys[sortedKeys.length - 1] : sortedKeys[0];
        const lastKey = backwards ? sortedKeys[0] : sortedKeys[sortedKeys.length - 1];
        const cursor = this._target.openKeyCursor(IDBKeyRange.bound(firstKey, lastKey), direction);
        let i = 0;
        let consumerDone = false;
        await iterateCursor(cursor, (value, key) => {
            while(i < sortedKeys.length && compareKeys(sortedKeys[i], key) < 0 && !consumerDone) {
                consumerDone = callback(sortedKeys[i], false);
                ++i;
            }
            if (i < sortedKeys.length && compareKeys(sortedKeys[i], key) === 0 && !consumerDone) {
                consumerDone = callback(sortedKeys[i], true);
                ++i;
            }
            const done = consumerDone || i >= sortedKeys.length;
            const jumpTo = !done && sortedKeys[i];
            return {done, jumpTo};
        });
        while (!consumerDone && i < sortedKeys.length) {
            consumerDone = callback(sortedKeys[i], false);
            ++i;
        }
    }
    _reduce(range, reducer, initialValue, direction) {
        let reducedValue = initialValue;
        const cursor = this._openCursor(range, direction);
        return iterateCursor(cursor, (value) => {
            reducedValue = reducer(reducedValue, value);
            return {done: false};
        });
    }
    _selectLimit(range, amount, direction) {
        return this._selectUntil(range, (results) => {
            return results.length === amount;
        }, direction);
    }
    async _selectUntil(range, predicate, direction) {
        const cursor = this._openCursor(range, direction);
        const results = [];
        await iterateCursor(cursor, (value) => {
            results.push(value);
            return {done: predicate(results, value)};
        });
        return results;
    }
    async _selectWhile(range, predicate, direction) {
        const cursor = this._openCursor(range, direction);
        const results = [];
        await iterateCursor(cursor, (value) => {
            const passesPredicate = predicate(value);
            if (passesPredicate) {
                results.push(value);
            }
            return {done: !passesPredicate};
        });
        return results;
    }
    async iterateWhile(range, predicate) {
        const cursor = this._openCursor(range, "next");
        await iterateCursor(cursor, (value) => {
            const passesPredicate = predicate(value);
            return {done: !passesPredicate};
        });
    }
    async _find(range, predicate, direction) {
        const cursor = this._openCursor(range, direction);
        let result;
        const found = await iterateCursor(cursor, (value) => {
            const found = predicate(value);
            if (found) {
                result = value;
            }
            return {done: found};
        });
        if (found) {
            return result;
        }
    }
}

const LOG_REQUESTS = false;
function logRequest(method, params, source) {
    const storeName = source?.name;
    const databaseName = source?.transaction?.db?.name;
    console.info(`${databaseName}.${storeName}.${method}(${params.map(p => JSON.stringify(p)).join(", ")})`);
}
class QueryTargetWrapper {
    constructor(qt) {
        this._qt = qt;
    }
    get keyPath() {
        if (this._qt.objectStore) {
            return this._qt.objectStore.keyPath;
        } else {
            return this._qt.keyPath;
        }
    }
    supports(methodName) {
        return !!this._qt[methodName];
    }
    openKeyCursor(...params) {
        try {
            if (!this._qt.openKeyCursor) {
                LOG_REQUESTS && logRequest("openCursor", params, this._qt);
                return this.openCursor(...params);
            }
            LOG_REQUESTS && logRequest("openKeyCursor", params, this._qt);
            return this._qt.openKeyCursor(...params);
        } catch(err) {
            throw new IDBRequestAttemptError("openKeyCursor", this._qt, err, params);
        }
    }
    openCursor(...params) {
        try {
            LOG_REQUESTS && logRequest("openCursor", params, this._qt);
            return this._qt.openCursor(...params);
        } catch(err) {
            throw new IDBRequestAttemptError("openCursor", this._qt, err, params);
        }
    }
    put(...params) {
        try {
            LOG_REQUESTS && logRequest("put", params, this._qt);
            return this._qt.put(...params);
        } catch(err) {
            throw new IDBRequestAttemptError("put", this._qt, err, params);
        }
    }
    add(...params) {
        try {
            LOG_REQUESTS && logRequest("add", params, this._qt);
            return this._qt.add(...params);
        } catch(err) {
            throw new IDBRequestAttemptError("add", this._qt, err, params);
        }
    }
    get(...params) {
        try {
            LOG_REQUESTS && logRequest("get", params, this._qt);
            return this._qt.get(...params);
        } catch(err) {
            throw new IDBRequestAttemptError("get", this._qt, err, params);
        }
    }
    getKey(...params) {
        try {
            LOG_REQUESTS && logRequest("getKey", params, this._qt);
            return this._qt.getKey(...params);
        } catch(err) {
            throw new IDBRequestAttemptError("getKey", this._qt, err, params);
        }
    }
    delete(...params) {
        try {
            LOG_REQUESTS && logRequest("delete", params, this._qt);
            return this._qt.delete(...params);
        } catch(err) {
            throw new IDBRequestAttemptError("delete", this._qt, err, params);
        }
    }
    index(...params) {
        try {
            return this._qt.index(...params);
        } catch(err) {
            throw new IDBRequestAttemptError("index", this._qt, err, params);
        }
    }
}
class Store extends QueryTarget {
    constructor(idbStore, transaction) {
        super(new QueryTargetWrapper(idbStore));
        this._transaction = transaction;
    }
    get IDBKeyRange() {
        return this._transaction.IDBKeyRange;
    }
    get _idbStore() {
        return this._target;
    }
    index(indexName) {
        return new QueryTarget(new QueryTargetWrapper(this._idbStore.index(indexName)));
    }
    put(value) {
        this._idbStore.put(value);
    }
    add(value) {
        this._idbStore.add(value);
    }
    delete(keyOrKeyRange) {
        this._idbStore.delete(keyOrKeyRange);
    }
}

class SessionStore {
	constructor(sessionStore) {
		this._sessionStore = sessionStore;
	}
	async get(key) {
		const entry = await this._sessionStore.get(key);
		if (entry) {
			return entry.value;
		}
	}
	set(key, value) {
		this._sessionStore.put({key, value});
	}
    add(key, value) {
        this._sessionStore.add({key, value});
    }
    remove(key) {
        this._sessionStore.delete(key);
    }
}

class RoomSummaryStore {
	constructor(summaryStore) {
		this._summaryStore = summaryStore;
	}
	getAll() {
		return this._summaryStore.selectAll();
	}
	set(summary) {
		return this._summaryStore.put(summary);
	}
	get(roomId) {
		return this._summaryStore.get(roomId);
	}
	async has(roomId) {
        const fetchedKey = await this._summaryStore.getKey(roomId);
        return roomId === fetchedKey;
	}
	remove(roomId) {
		return this._summaryStore.delete(roomId);
	}
}

class InviteStore {
    constructor(inviteStore) {
        this._inviteStore = inviteStore;
    }
    getAll() {
        return this._inviteStore.selectAll();
    }
    set(invite) {
        return this._inviteStore.put(invite);
    }
    remove(roomId) {
        this._inviteStore.delete(roomId);
    }
}

class EventKey {
    constructor(fragmentId, eventIndex) {
        this.fragmentId = fragmentId;
        this.eventIndex = eventIndex;
    }
    nextFragmentKey() {
        return new EventKey(this.fragmentId + 1, KeyLimits.middleStorageKey);
    }
    nextKeyForDirection(direction) {
        if (direction.isForward) {
            return this.nextKey();
        } else {
            return this.previousKey();
        }
    }
    previousKey() {
        return new EventKey(this.fragmentId, this.eventIndex - 1);
    }
    nextKey() {
        return new EventKey(this.fragmentId, this.eventIndex + 1);
    }
    static get maxKey() {
        return new EventKey(KeyLimits.maxStorageKey, KeyLimits.maxStorageKey);
    }
    static get minKey() {
        return new EventKey(KeyLimits.minStorageKey, KeyLimits.minStorageKey);
    }
    static get defaultLiveKey() {
        return EventKey.defaultFragmentKey(KeyLimits.minStorageKey);
    }
    static defaultFragmentKey(fragmentId) {
        return new EventKey(fragmentId, KeyLimits.middleStorageKey);
    }
    toString() {
        return `[${this.fragmentId}/${this.eventIndex}]`;
    }
    equals(other) {
        return this.fragmentId === other?.fragmentId && this.eventIndex === other?.eventIndex;
    }
}

function encodeKey(roomId, fragmentId, eventIndex) {
    return `${roomId}|${encodeUint32(fragmentId)}|${encodeUint32(eventIndex)}`;
}
function encodeEventIdKey(roomId, eventId) {
    return `${roomId}|${eventId}`;
}
function decodeEventIdKey(eventIdKey) {
    const [roomId, eventId] = eventIdKey.split("|");
    return {roomId, eventId};
}
class Range {
    constructor(IDBKeyRange, only, lower, upper, lowerOpen, upperOpen) {
        this._IDBKeyRange = IDBKeyRange;
        this._only = only;
        this._lower = lower;
        this._upper = upper;
        this._lowerOpen = lowerOpen;
        this._upperOpen = upperOpen;
    }
    asIDBKeyRange(roomId) {
        try {
            if (this._only) {
                return this._IDBKeyRange.only(encodeKey(roomId, this._only.fragmentId, this._only.eventIndex));
            }
            if (this._lower && !this._upper) {
                return this._IDBKeyRange.bound(
                    encodeKey(roomId, this._lower.fragmentId, this._lower.eventIndex),
                    encodeKey(roomId, this._lower.fragmentId, KeyLimits.maxStorageKey),
                    this._lowerOpen,
                    false
                );
            }
            if (!this._lower && this._upper) {
                return this._IDBKeyRange.bound(
                    encodeKey(roomId, this._upper.fragmentId, KeyLimits.minStorageKey),
                    encodeKey(roomId, this._upper.fragmentId, this._upper.eventIndex),
                    false,
                    this._upperOpen
                );
            }
            if (this._lower && this._upper) {
                return this._IDBKeyRange.bound(
                    encodeKey(roomId, this._lower.fragmentId, this._lower.eventIndex),
                    encodeKey(roomId, this._upper.fragmentId, this._upper.eventIndex),
                    this._lowerOpen,
                    this._upperOpen
                );
            }
        } catch(err) {
            throw new StorageError(`IDBKeyRange failed with data: ` + JSON.stringify(this), err);
        }
    }
}
class TimelineEventStore {
    constructor(timelineStore) {
        this._timelineStore = timelineStore;
    }
    onlyRange(eventKey) {
        return new Range(this._timelineStore.IDBKeyRange, eventKey);
    }
    upperBoundRange(eventKey, open=false) {
        return new Range(this._timelineStore.IDBKeyRange, undefined, undefined, eventKey, undefined, open);
    }
    lowerBoundRange(eventKey, open=false) {
        return new Range(this._timelineStore.IDBKeyRange, undefined, eventKey, undefined, open);
    }
    boundRange(lower, upper, lowerOpen=false, upperOpen=false) {
        return new Range(this._timelineStore.IDBKeyRange, undefined, lower, upper, lowerOpen, upperOpen);
    }
    async lastEvents(roomId, fragmentId, amount) {
        const eventKey = EventKey.maxKey;
        eventKey.fragmentId = fragmentId;
        return this.eventsBefore(roomId, eventKey, amount);
    }
    async firstEvents(roomId, fragmentId, amount) {
        const eventKey = EventKey.minKey;
        eventKey.fragmentId = fragmentId;
        return this.eventsAfter(roomId, eventKey, amount);
    }
    eventsAfter(roomId, eventKey, amount) {
        const idbRange = this.lowerBoundRange(eventKey, true).asIDBKeyRange(roomId);
        return this._timelineStore.selectLimit(idbRange, amount);
    }
    async eventsBefore(roomId, eventKey, amount) {
        const range = this.upperBoundRange(eventKey, true).asIDBKeyRange(roomId);
        const events = await this._timelineStore.selectLimitReverse(range, amount);
        events.reverse();
        return events;
    }
    async findFirstOccurringEventId(roomId, eventIds) {
        const byEventId = this._timelineStore.index("byEventId");
        const keys = eventIds.map(eventId => encodeEventIdKey(roomId, eventId));
        const results = new Array(keys.length);
        let firstFoundKey;
        function firstFoundAndPrecedingResolved() {
            for(let i = 0; i < results.length; ++i) {
                if (results[i] === undefined) {
                    return;
                } else if(results[i] === true) {
                    return keys[i];
                }
            }
        }
        await byEventId.findExistingKeys(keys, false, (key, found) => {
            const index = keys.indexOf(key);
            results[index] = found;
            firstFoundKey = firstFoundAndPrecedingResolved();
            return !!firstFoundKey;
        });
        return firstFoundKey && decodeEventIdKey(firstFoundKey).eventId;
    }
    insert(entry) {
        entry.key = encodeKey(entry.roomId, entry.fragmentId, entry.eventIndex);
        entry.eventIdKey = encodeEventIdKey(entry.roomId, entry.event.event_id);
        this._timelineStore.add(entry);
    }
    update(entry) {
        this._timelineStore.put(entry);
    }
    get(roomId, eventKey) {
        return this._timelineStore.get(encodeKey(roomId, eventKey.fragmentId, eventKey.eventIndex));
    }
    getByEventId(roomId, eventId) {
        return this._timelineStore.index("byEventId").get(encodeEventIdKey(roomId, eventId));
    }
    removeAllForRoom(roomId) {
        const minKey = encodeKey(roomId, KeyLimits.minStorageKey, KeyLimits.minStorageKey);
        const maxKey = encodeKey(roomId, KeyLimits.maxStorageKey, KeyLimits.maxStorageKey);
        const range = this._timelineStore.IDBKeyRange.bound(minKey, maxKey);
        this._timelineStore.delete(range);
    }
}

const MIN_UNICODE = "\u{0}";
const MAX_UNICODE = "\u{10FFFF}";

function encodeKey$1(roomId, targetEventId, relType, sourceEventId) {
    return `${roomId}|${targetEventId}|${relType}|${sourceEventId}`;
}
function decodeKey(key) {
    const [roomId, targetEventId, relType, sourceEventId] = key.split("|");
    return {roomId, targetEventId, relType, sourceEventId};
}
class TimelineRelationStore {
    constructor(store) {
        this._store = store;
    }
    add(roomId, targetEventId, relType, sourceEventId) {
        return this._store.add({key: encodeKey$1(roomId, targetEventId, relType, sourceEventId)});
    }
    remove(roomId, targetEventId, relType, sourceEventId) {
        return this._store.delete(encodeKey$1(roomId, targetEventId, relType, sourceEventId));
    }
    removeAllForTarget(roomId, targetId) {
        const range = this._store.IDBKeyRange.bound(
            encodeKey$1(roomId, targetId, MIN_UNICODE, MIN_UNICODE),
            encodeKey$1(roomId, targetId, MAX_UNICODE, MAX_UNICODE),
            true,
            true
        );
        return this._store.delete(range);
    }
    async getForTargetAndType(roomId, targetId, relType) {
        const range = this._store.IDBKeyRange.bound(
            encodeKey$1(roomId, targetId, relType, MIN_UNICODE),
            encodeKey$1(roomId, targetId, relType, MAX_UNICODE),
            true,
            true
        );
        const items = await this._store.selectAll(range);
        return items.map(i => decodeKey(i.key));
    }
    async getAllForTarget(roomId, targetId) {
        const range = this._store.IDBKeyRange.bound(
            encodeKey$1(roomId, targetId, MIN_UNICODE, MIN_UNICODE),
            encodeKey$1(roomId, targetId, MAX_UNICODE, MAX_UNICODE),
            true,
            true
        );
        const items = await this._store.selectAll(range);
        return items.map(i => decodeKey(i.key));
    }
}

function encodeKey$2(roomId, eventType, stateKey) {
     return `${roomId}|${eventType}|${stateKey}`;
}
class RoomStateStore {
    constructor(idbStore) {
        this._roomStateStore = idbStore;
    }
    get(roomId, type, stateKey) {
        const key = encodeKey$2(roomId, type, stateKey);
        return this._roomStateStore.get(key);
    }
    set(roomId, event) {
        const key = encodeKey$2(roomId, event.type, event.state_key);
        const entry = {roomId, event, key};
        return this._roomStateStore.put(entry);
    }
    removeAllForRoom(roomId) {
        const range = this._roomStateStore.IDBKeyRange.bound(roomId, `${roomId}|${MAX_UNICODE}`, true, true);
        this._roomStateStore.delete(range);
    }
}

function encodeKey$3(roomId, userId) {
    return `${roomId}|${userId}`;
}
function decodeKey$1(key) {
    const [roomId, userId] = key.split("|");
    return {roomId, userId};
}
class RoomMemberStore {
    constructor(roomMembersStore) {
        this._roomMembersStore = roomMembersStore;
    }
	get(roomId, userId) {
        return this._roomMembersStore.get(encodeKey$3(roomId, userId));
	}
	async set(member) {
        member.key = encodeKey$3(member.roomId, member.userId);
        return this._roomMembersStore.put(member);
	}
    getAll(roomId) {
        const range = this._roomMembersStore.IDBKeyRange.lowerBound(encodeKey$3(roomId, ""));
        return this._roomMembersStore.selectWhile(range, member => {
            return member.roomId === roomId;
        });
    }
    async getAllUserIds(roomId) {
        const userIds = [];
        const range = this._roomMembersStore.IDBKeyRange.lowerBound(encodeKey$3(roomId, ""));
        await this._roomMembersStore.iterateKeys(range, key => {
            const decodedKey = decodeKey$1(key);
            if (decodedKey.roomId === roomId) {
                userIds.push(decodedKey.userId);
                return false;
            }
            return true;
        });
        return userIds;
    }
    removeAllForRoom(roomId) {
        const range = this._roomMembersStore.IDBKeyRange.bound(roomId, `${roomId}|${MAX_UNICODE}`, true, true);
        this._roomMembersStore.delete(range);
    }
}

function encodeKey$4(roomId, fragmentId) {
    return `${roomId}|${encodeUint32(fragmentId)}`;
}
class TimelineFragmentStore {
    constructor(store) {
        this._store = store;
    }
    _allRange(roomId) {
        try {
            return this._store.IDBKeyRange.bound(
                encodeKey$4(roomId, KeyLimits.minStorageKey),
                encodeKey$4(roomId, KeyLimits.maxStorageKey)
            );
        } catch (err) {
            throw new StorageError(`error from IDBKeyRange with roomId ${roomId}`, err);
        }
    }
    all(roomId) {
        return this._store.selectAll(this._allRange(roomId));
    }
    liveFragment(roomId) {
        return this._store.findReverse(this._allRange(roomId), fragment => {
            return typeof fragment.nextId !== "number" && typeof fragment.nextToken !== "string";
        });
    }
    add(fragment) {
        fragment.key = encodeKey$4(fragment.roomId, fragment.id);
        this._store.add(fragment);
    }
    update(fragment) {
        this._store.put(fragment);
    }
    get(roomId, fragmentId) {
        return this._store.get(encodeKey$4(roomId, fragmentId));
    }
    removeAllForRoom(roomId) {
        this._store.delete(this._allRange(roomId));
    }
}

function encodeKey$5(roomId, queueIndex) {
    return `${roomId}|${encodeUint32(queueIndex)}`;
}
function decodeKey$2(key) {
    const [roomId, encodedQueueIndex] = key.split("|");
    const queueIndex = decodeUint32(encodedQueueIndex);
    return {roomId, queueIndex};
}
class PendingEventStore {
    constructor(eventStore) {
        this._eventStore = eventStore;
    }
    async getMaxQueueIndex(roomId) {
        const range = this._eventStore.IDBKeyRange.bound(
            encodeKey$5(roomId, KeyLimits.minStorageKey),
            encodeKey$5(roomId, KeyLimits.maxStorageKey),
            false,
            false,
        );
        const maxKey = await this._eventStore.findMaxKey(range);
        if (maxKey) {
            return decodeKey$2(maxKey).queueIndex;
        }
    }
    remove(roomId, queueIndex) {
        const keyRange = this._eventStore.IDBKeyRange.only(encodeKey$5(roomId, queueIndex));
        this._eventStore.delete(keyRange);
    }
    async exists(roomId, queueIndex) {
        const keyRange = this._eventStore.IDBKeyRange.only(encodeKey$5(roomId, queueIndex));
        const key = await this._eventStore.getKey(keyRange);
        return !!key;
    }
    add(pendingEvent) {
        pendingEvent.key = encodeKey$5(pendingEvent.roomId, pendingEvent.queueIndex);
        this._eventStore.add(pendingEvent);
    }
    update(pendingEvent) {
        this._eventStore.put(pendingEvent);
    }
    getAll() {
        return this._eventStore.selectAll();
    }
    removeAllForRoom(roomId) {
        const minKey = encodeKey$5(roomId, KeyLimits.minStorageKey);
        const maxKey = encodeKey$5(roomId, KeyLimits.maxStorageKey);
        const range = this._eventStore.IDBKeyRange.bound(minKey, maxKey);
        this._eventStore.delete(range);
    }
}

class UserIdentityStore {
    constructor(store) {
        this._store = store;
    }
    get(userId) {
        return this._store.get(userId);
    }
    set(userIdentity) {
        this._store.put(userIdentity);
    }
    remove(userId) {
        return this._store.delete(userId);
    }
}

function encodeKey$6(userId, deviceId) {
    return `${userId}|${deviceId}`;
}
function decodeKey$3(key) {
    const [userId, deviceId] = key.split("|");
    return {userId, deviceId};
}
class DeviceIdentityStore {
    constructor(store) {
        this._store = store;
    }
    getAllForUserId(userId) {
        const range = this._store.IDBKeyRange.lowerBound(encodeKey$6(userId, ""));
        return this._store.selectWhile(range, device => {
            return device.userId === userId;
        });
    }
    async getAllDeviceIds(userId) {
        const deviceIds = [];
        const range = this._store.IDBKeyRange.lowerBound(encodeKey$6(userId, ""));
        await this._store.iterateKeys(range, key => {
            const decodedKey = decodeKey$3(key);
            if (decodedKey.userId === userId) {
                deviceIds.push(decodedKey.deviceId);
                return false;
            }
            return true;
        });
        return deviceIds;
    }
    get(userId, deviceId) {
        return this._store.get(encodeKey$6(userId, deviceId));
    }
    set(deviceIdentity) {
        deviceIdentity.key = encodeKey$6(deviceIdentity.userId, deviceIdentity.deviceId);
        this._store.put(deviceIdentity);
    }
    getByCurve25519Key(curve25519Key) {
        return this._store.index("byCurve25519Key").get(curve25519Key);
    }
    remove(userId, deviceId) {
        this._store.delete(encodeKey$6(userId, deviceId));
    }
    removeAllForUser(userId) {
        const range = this._store.IDBKeyRange.bound(encodeKey$6(userId, MIN_UNICODE), encodeKey$6(userId, MAX_UNICODE), true, true);
        this._store.delete(range);
    }
}

function encodeKey$7(senderKey, sessionId) {
    return `${senderKey}|${sessionId}`;
}
function decodeKey$4(key) {
    const [senderKey, sessionId] = key.split("|");
    return {senderKey, sessionId};
}
class OlmSessionStore {
    constructor(store) {
        this._store = store;
    }
    async getSessionIds(senderKey) {
        const sessionIds = [];
        const range = this._store.IDBKeyRange.lowerBound(encodeKey$7(senderKey, ""));
        await this._store.iterateKeys(range, key => {
            const decodedKey = decodeKey$4(key);
            if (decodedKey.senderKey === senderKey) {
                sessionIds.push(decodedKey.sessionId);
                return false;
            }
            return true;
        });
        return sessionIds;
    }
    getAll(senderKey) {
        const range = this._store.IDBKeyRange.lowerBound(encodeKey$7(senderKey, ""));
        return this._store.selectWhile(range, session => {
            return session.senderKey === senderKey;
        });
    }
    get(senderKey, sessionId) {
        return this._store.get(encodeKey$7(senderKey, sessionId));
    }
    set(session) {
        session.key = encodeKey$7(session.senderKey, session.sessionId);
        return this._store.put(session);
    }
    remove(senderKey, sessionId) {
        return this._store.delete(encodeKey$7(senderKey, sessionId));
    }
}

function encodeKey$8(roomId, senderKey, sessionId) {
    return `${roomId}|${senderKey}|${sessionId}`;
}
class InboundGroupSessionStore {
    constructor(store) {
        this._store = store;
    }
    async has(roomId, senderKey, sessionId) {
        const key = encodeKey$8(roomId, senderKey, sessionId);
        const fetchedKey = await this._store.getKey(key);
        return key === fetchedKey;
    }
    get(roomId, senderKey, sessionId) {
        return this._store.get(encodeKey$8(roomId, senderKey, sessionId));
    }
    set(session) {
        session.key = encodeKey$8(session.roomId, session.senderKey, session.sessionId);
        this._store.put(session);
    }
    removeAllForRoom(roomId) {
        const range = this._store.IDBKeyRange.bound(
            encodeKey$8(roomId, MIN_UNICODE, MIN_UNICODE),
            encodeKey$8(roomId, MAX_UNICODE, MAX_UNICODE)
        );
        this._store.delete(range);
    }
}

class OutboundGroupSessionStore {
    constructor(store) {
        this._store = store;
    }
    remove(roomId) {
        this._store.delete(roomId);
    }
    get(roomId) {
        return this._store.get(roomId);
    }
    set(session) {
        this._store.put(session);
    }
}

function encodeKey$9(roomId, sessionId, messageIndex) {
    return `${roomId}|${sessionId}|${messageIndex}`;
}
class GroupSessionDecryptionStore {
    constructor(store) {
        this._store = store;
    }
    get(roomId, sessionId, messageIndex) {
        return this._store.get(encodeKey$9(roomId, sessionId, messageIndex));
    }
    set(roomId, sessionId, messageIndex, decryption) {
        decryption.key = encodeKey$9(roomId, sessionId, messageIndex);
        this._store.put(decryption);
    }
    removeAllForRoom(roomId) {
        const range = this._store.IDBKeyRange.bound(
            encodeKey$9(roomId, MIN_UNICODE, MIN_UNICODE),
            encodeKey$9(roomId, MAX_UNICODE, MAX_UNICODE)
        );
        this._store.delete(range);
    }
}

function encodeScopeTypeKey(scope, type) {
    return `${scope}|${type}`;
}
class OperationStore {
    constructor(store) {
        this._store = store;
    }
    getAll() {
        return this._store.selectAll();
    }
    async getAllByTypeAndScope(type, scope) {
        const key = encodeScopeTypeKey(scope, type);
        const results = [];
        await this._store.index("byScopeAndType").iterateWhile(key, value => {
            if (value.scopeTypeKey !== key) {
                return false;
            }
            results.push(value);
            return true;
        });
        return results;
    }
    add(operation) {
        operation.scopeTypeKey = encodeScopeTypeKey(operation.scope, operation.type);
        this._store.add(operation);
    }
    update(operation) {
        this._store.put(operation);
    }
    remove(id) {
        this._store.delete(id);
    }
    async removeAllForScope(scope) {
        const range = this._store.IDBKeyRange.bound(
            encodeScopeTypeKey(scope, MIN_UNICODE),
            encodeScopeTypeKey(scope, MAX_UNICODE)
        );
        const index = this._store.index("byScopeAndType");
        await index.iterateValues(range, (_, __, cur) => {
            cur.delete();
            return true;
        });
    }
}

class AccountDataStore {
	constructor(store) {
		this._store = store;
	}
	async get(type) {
		return await this._store.get(type);
	}
	set(event) {
		return this._store.put(event);
	}
}

class Transaction {
    constructor(txn, allowedStoreNames, IDBKeyRange) {
        this._txn = txn;
        this._allowedStoreNames = allowedStoreNames;
        this._stores = {};
        this.IDBKeyRange = IDBKeyRange;
    }
    _idbStore(name) {
        if (!this._allowedStoreNames.includes(name)) {
            throw new StorageError(`Invalid store for transaction: ${name}, only ${this._allowedStoreNames.join(", ")} are allowed.`);
        }
        return new Store(this._txn.objectStore(name), this);
    }
    _store(name, mapStore) {
        if (!this._stores[name]) {
            const idbStore = this._idbStore(name);
            this._stores[name] = mapStore(idbStore);
        }
        return this._stores[name];
    }
    get session() {
        return this._store("session", idbStore => new SessionStore(idbStore));
    }
    get roomSummary() {
        return this._store("roomSummary", idbStore => new RoomSummaryStore(idbStore));
    }
    get archivedRoomSummary() {
        return this._store("archivedRoomSummary", idbStore => new RoomSummaryStore(idbStore));
    }
    get invites() {
        return this._store("invites", idbStore => new InviteStore(idbStore));
    }
    get timelineFragments() {
        return this._store("timelineFragments", idbStore => new TimelineFragmentStore(idbStore));
    }
    get timelineEvents() {
        return this._store("timelineEvents", idbStore => new TimelineEventStore(idbStore));
    }
    get timelineRelations() {
        return this._store("timelineRelations", idbStore => new TimelineRelationStore(idbStore));
    }
    get roomState() {
        return this._store("roomState", idbStore => new RoomStateStore(idbStore));
    }
    get roomMembers() {
        return this._store("roomMembers", idbStore => new RoomMemberStore(idbStore));
    }
    get pendingEvents() {
        return this._store("pendingEvents", idbStore => new PendingEventStore(idbStore));
    }
    get userIdentities() {
        return this._store("userIdentities", idbStore => new UserIdentityStore(idbStore));
    }
    get deviceIdentities() {
        return this._store("deviceIdentities", idbStore => new DeviceIdentityStore(idbStore));
    }
    get olmSessions() {
        return this._store("olmSessions", idbStore => new OlmSessionStore(idbStore));
    }
    get inboundGroupSessions() {
        return this._store("inboundGroupSessions", idbStore => new InboundGroupSessionStore(idbStore));
    }
    get outboundGroupSessions() {
        return this._store("outboundGroupSessions", idbStore => new OutboundGroupSessionStore(idbStore));
    }
    get groupSessionDecryptions() {
        return this._store("groupSessionDecryptions", idbStore => new GroupSessionDecryptionStore(idbStore));
    }
    get operations() {
        return this._store("operations", idbStore => new OperationStore(idbStore));
    }
    get accountData() {
        return this._store("accountData", idbStore => new AccountDataStore(idbStore));
    }
    complete() {
        return txnAsPromise(this._txn);
    }
    abort() {
        this._txn.abort();
    }
}

const WEBKITEARLYCLOSETXNBUG_BOGUS_KEY = "782rh281re38-boguskey";
class Storage {
    constructor(idbDatabase, IDBKeyRange, hasWebkitEarlyCloseTxnBug) {
        this._db = idbDatabase;
        this._IDBKeyRange = IDBKeyRange;
        this._hasWebkitEarlyCloseTxnBug = hasWebkitEarlyCloseTxnBug;
        const nameMap = STORE_NAMES.reduce((nameMap, name) => {
            nameMap[name] = name;
            return nameMap;
        }, {});
        this.storeNames = Object.freeze(nameMap);
    }
    _validateStoreNames(storeNames) {
        const idx = storeNames.findIndex(name => !STORE_NAMES.includes(name));
        if (idx !== -1) {
            throw new StorageError(`Tried top, a transaction unknown store ${storeNames[idx]}`);
        }
    }
    async readTxn(storeNames) {
        this._validateStoreNames(storeNames);
        try {
            const txn = this._db.transaction(storeNames, "readonly");
            if (this._hasWebkitEarlyCloseTxnBug) {
                await reqAsPromise(txn.objectStore(storeNames[0]).get(WEBKITEARLYCLOSETXNBUG_BOGUS_KEY));
            }
            return new Transaction(txn, storeNames, this._IDBKeyRange);
        } catch(err) {
            throw new StorageError("readTxn failed", err);
        }
    }
    async readWriteTxn(storeNames) {
        this._validateStoreNames(storeNames);
        try {
            const txn = this._db.transaction(storeNames, "readwrite");
            if (this._hasWebkitEarlyCloseTxnBug) {
                await reqAsPromise(txn.objectStore(storeNames[0]).get(WEBKITEARLYCLOSETXNBUG_BOGUS_KEY));
            }
            return new Transaction(txn, storeNames, this._IDBKeyRange);
        } catch(err) {
            throw new StorageError("readWriteTxn failed", err);
        }
    }
    close() {
        this._db.close();
    }
}

async function exportSession(db) {
    const NOT_DONE = {done: false};
    const txn = db.transaction(STORE_NAMES, "readonly");
    const data = {};
    await Promise.all(STORE_NAMES.map(async name => {
        const results = data[name] = [];
        const store = txn.objectStore(name);
        await iterateCursor(store.openCursor(), (value) => {
            results.push(value);
            return NOT_DONE;
        });
    }));
    return data;
}
async function importSession(db, data) {
    const txn = db.transaction(STORE_NAMES, "readwrite");
    for (const name of STORE_NAMES) {
        const store = txn.objectStore(name);
        for (const value of data[name]) {
            store.add(value);
        }
    }
    await txnAsPromise(txn);
}

function getPrevContentFromStateEvent(event) {
    return event.unsigned?.prev_content || event.prev_content;
}
const REDACTION_TYPE = "m.room.redaction";
function isRedacted(event) {
    return !!event?.unsigned?.redacted_because;
}

const EVENT_TYPE = "m.room.member";
class RoomMember {
    constructor(data) {
        this._data = data;
    }
    static fromUserId(roomId, userId, membership) {
        return new RoomMember({roomId, userId, membership});
    }
    static fromMemberEvent(roomId, memberEvent) {
        const userId = memberEvent?.state_key;
        if (typeof userId !== "string") {
            return;
        }
        const content = memberEvent.content;
        const prevContent = getPrevContentFromStateEvent(memberEvent);
        const membership = content?.membership;
        const displayName = content?.displayname || prevContent?.displayname;
        const avatarUrl = content?.avatar_url || prevContent?.avatar_url;
        return this._validateAndCreateMember(roomId, userId, membership, displayName, avatarUrl);
    }
    static fromReplacingMemberEvent(roomId, memberEvent) {
        const userId = memberEvent && memberEvent.state_key;
        if (typeof userId !== "string") {
            return;
        }
        const content = getPrevContentFromStateEvent(memberEvent);
        return this._validateAndCreateMember(roomId, userId,
            content?.membership,
            content?.displayname,
            content?.avatar_url
        );
    }
    static _validateAndCreateMember(roomId, userId, membership, displayName, avatarUrl) {
        if (typeof membership !== "string") {
            return;
        }
        return new RoomMember({
            roomId,
            userId,
            membership,
            avatarUrl,
            displayName,
        });
    }
    get membership() {
        return this._data.membership;
    }
    get displayName() {
        return this._data.displayName;
    }
    get name() {
        return this._data.displayName || this._data.userId;
    }
    get avatarUrl() {
        return this._data.avatarUrl;
    }
    get roomId() {
        return this._data.roomId;
    }
    get userId() {
        return this._data.userId;
    }
    serialize() {
        return this._data;
    }
    equals(other) {
        const data = this._data;
        const otherData = other._data;
        return data.roomId === otherData.roomId &&
            data.userId === otherData.userId &&
            data.membership === otherData.membership &&
            data.displayName === otherData.displayName &&
            data.avatarUrl === otherData.avatarUrl;
    }
}
class MemberChange {
    constructor(member, previousMembership) {
        this.member = member;
        this.previousMembership = previousMembership;
    }
    get roomId() {
        return this.member.roomId;
    }
    get userId() {
        return this.member.userId;
    }
    get membership() {
        return this.member.membership;
    }
    get hasLeft() {
        return this.previousMembership === "join" && this.membership !== "join";
    }
    get hasJoined() {
        return this.previousMembership !== "join" && this.membership === "join";
    }
}

const schema = [
    createInitialStores,
    createMemberStore,
    migrateSession,
    createE2EEStores,
    migrateEncryptionFlag,
    createAccountDataStore,
    createInviteStore,
    createArchivedRoomSummaryStore,
    migrateOperationScopeIndex,
    createTimelineRelationsStore,
];
function createInitialStores(db) {
    db.createObjectStore("session", {keyPath: "key"});
    db.createObjectStore("roomSummary", {keyPath: "roomId"});
    db.createObjectStore("timelineFragments", {keyPath: "key"});
    const timelineEvents = db.createObjectStore("timelineEvents", {keyPath: "key"});
    timelineEvents.createIndex("byEventId", "eventIdKey", {unique: true});
    db.createObjectStore("roomState", {keyPath: "key"});
    db.createObjectStore("pendingEvents", {keyPath: "key"});
}
async function createMemberStore(db, txn) {
    const roomMembers = new RoomMemberStore(db.createObjectStore("roomMembers", {keyPath: "key"}));
    const roomState = txn.objectStore("roomState");
    await iterateCursor(roomState.openCursor(), entry => {
        if (entry.event.type === EVENT_TYPE) {
            roomState.delete(entry.key);
            const member = RoomMember.fromMemberEvent(entry.roomId, entry.event);
            if (member) {
                roomMembers.set(member.serialize());
            }
        }
    });
}
async function migrateSession(db, txn) {
    const session = txn.objectStore("session");
    try {
        const PRE_MIGRATION_KEY = 1;
        const entry = await reqAsPromise(session.get(PRE_MIGRATION_KEY));
        if (entry) {
            session.delete(PRE_MIGRATION_KEY);
            const {syncToken, syncFilterId, serverVersions} = entry.value;
            const store = new SessionStore(session);
            store.set("sync", {token: syncToken, filterId: syncFilterId});
            store.set("serverVersions", serverVersions);
        }
    } catch (err) {
        txn.abort();
        console.error("could not migrate session", err.stack);
    }
}
function createE2EEStores(db) {
    db.createObjectStore("userIdentities", {keyPath: "userId"});
    const deviceIdentities = db.createObjectStore("deviceIdentities", {keyPath: "key"});
    deviceIdentities.createIndex("byCurve25519Key", "curve25519Key", {unique: true});
    db.createObjectStore("olmSessions", {keyPath: "key"});
    db.createObjectStore("inboundGroupSessions", {keyPath: "key"});
    db.createObjectStore("outboundGroupSessions", {keyPath: "roomId"});
    db.createObjectStore("groupSessionDecryptions", {keyPath: "key"});
    const operations = db.createObjectStore("operations", {keyPath: "id"});
    operations.createIndex("byTypeAndScope", "typeScopeKey", {unique: false});
}
async function migrateEncryptionFlag(db, txn) {
    const roomSummary = txn.objectStore("roomSummary");
    const roomState = txn.objectStore("roomState");
    const summaries = [];
    await iterateCursor(roomSummary.openCursor(), summary => {
        summaries.push(summary);
    });
    for (const summary of summaries) {
        const encryptionEntry = await reqAsPromise(roomState.get(`${summary.roomId}|m.room.encryption|`));
        if (encryptionEntry) {
            summary.encryption = encryptionEntry?.event?.content;
            delete summary.isEncrypted;
            roomSummary.put(summary);
        }
    }
}
function createAccountDataStore(db) {
    db.createObjectStore("accountData", {keyPath: "type"});
}
function createInviteStore(db) {
    db.createObjectStore("invites", {keyPath: "roomId"});
}
function createArchivedRoomSummaryStore(db) {
    db.createObjectStore("archivedRoomSummary", {keyPath: "summary.roomId"});
}
async function migrateOperationScopeIndex(db, txn) {
    try {
        const operations = txn.objectStore("operations");
        operations.deleteIndex("byTypeAndScope");
        await iterateCursor(operations.openCursor(), (op, key, cur) => {
            const {typeScopeKey} = op;
            delete op.typeScopeKey;
            const [type, scope] = typeScopeKey.split("|");
            op.scopeTypeKey = encodeScopeTypeKey(scope, type);
            cur.update(op);
        });
        operations.createIndex("byScopeAndType", "scopeTypeKey", {unique: false});
    } catch (err) {
        txn.abort();
        console.error("could not migrate operations", err.stack);
    }
}
function createTimelineRelationsStore(db) {
    db.createObjectStore("timelineRelations", {keyPath: "key"});
}

async function detectWebkitEarlyCloseTxnBug(idbFactory) {
    const dbName = "hydrogen_webkit_test_inactive_txn_bug";
    try {
        const db = await openDatabase(dbName, db => {
            db.createObjectStore("test", {keyPath: "key"});
        }, 1, idbFactory);
        const readTxn = db.transaction(["test"], "readonly");
        await reqAsPromise(readTxn.objectStore("test").get("somekey"));
        await new Promise(r => setTimeout(r, 0));
        const writeTxn = db.transaction(["test"], "readwrite");
        await Promise.resolve();
        writeTxn.objectStore("test").add({key: "somekey", value: "foo"});
        await txnAsPromise(writeTxn);
        db.close();
    } catch (err) {
        if (err.name === "TransactionInactiveError") {
            return true;
        }
    }
    return false;
}

const sessionName = sessionId => `hydrogen_session_${sessionId}`;
const openDatabaseWithSessionId = function(sessionId, idbFactory) {
    return openDatabase(sessionName(sessionId), createStores, schema.length, idbFactory);
};
async function requestPersistedStorage() {
    const glob = this;
    if (glob?.navigator?.storage?.persist) {
        return await glob.navigator.storage.persist();
    } else if (glob?.document.requestStorageAccess) {
        try {
            await glob.document.requestStorageAccess();
            return true;
        } catch (err) {
            return false;
        }
    } else {
        return false;
    }
}
class StorageFactory {
    constructor(serviceWorkerHandler, idbFactory = window.indexedDB, IDBKeyRange = window.IDBKeyRange) {
        this._serviceWorkerHandler = serviceWorkerHandler;
        this._idbFactory = idbFactory;
        this._IDBKeyRange = IDBKeyRange;
    }
    async create(sessionId) {
        await this._serviceWorkerHandler?.preventConcurrentSessionAccess(sessionId);
        requestPersistedStorage().then(persisted => {
            if (!persisted) {
                console.warn("no persisted storage, database can be evicted by browser");
            }
        });
        const hasWebkitEarlyCloseTxnBug = await detectWebkitEarlyCloseTxnBug(this._idbFactory);
        const db = await openDatabaseWithSessionId(sessionId, this._idbFactory);
        return new Storage(db, this._IDBKeyRange, hasWebkitEarlyCloseTxnBug);
    }
    delete(sessionId) {
        const databaseName = sessionName(sessionId);
        const req = this._idbFactory.deleteDatabase(databaseName);
        return reqAsPromise(req);
    }
    async export(sessionId) {
        const db = await openDatabaseWithSessionId(sessionId, this._idbFactory);
        return await exportSession(db);
    }
    async import(sessionId, data) {
        const db = await openDatabaseWithSessionId(sessionId, this._idbFactory);
        return await importSession(db, data);
    }
}
async function createStores(db, txn, oldVersion, version) {
    const startIdx = oldVersion || 0;
    for(let i = startIdx; i < version; ++i) {
        await schema[i](db, txn);
    }
}

class SessionInfoStorage {
    constructor(name) {
        this._name = name;
    }
    getAll() {
        const sessionsJson = localStorage.getItem(this._name);
        if (sessionsJson) {
            const sessions = JSON.parse(sessionsJson);
            if (Array.isArray(sessions)) {
                return Promise.resolve(sessions);
            }
        }
        return Promise.resolve([]);
    }
    async updateLastUsed(id, timestamp) {
        const sessions = await this.getAll();
        if (sessions) {
            const session = sessions.find(session => session.id === id);
            if (session) {
                session.lastUsed = timestamp;
                localStorage.setItem(this._name, JSON.stringify(sessions));
            }
        }
    }
    async get(id) {
        const sessions = await this.getAll();
        if (sessions) {
            return sessions.find(session => session.id === id);
        }
    }
    async add(sessionInfo) {
        const sessions = await this.getAll();
        sessions.push(sessionInfo);
        localStorage.setItem(this._name, JSON.stringify(sessions));
    }
    async delete(sessionId) {
        let sessions = await this.getAll();
        sessions = sessions.filter(s => s.id !== sessionId);
        localStorage.setItem(this._name, JSON.stringify(sessions));
    }
}

class SettingsStorage {
    constructor(prefix) {
        this._prefix = prefix;
    }
    async setInt(key, value) {
        this._set(key, value);
    }
    async getInt(key, defaultValue = 0) {
        const value = window.localStorage.getItem(`${this._prefix}${key}`);
        if (typeof value === "string") {
            return parseInt(value, 10);
        }
        return defaultValue;
    }
    async setBool(key, value) {
        this._set(key, value);
    }
    async getBool(key, defaultValue = false) {
        const value = window.localStorage.getItem(`${this._prefix}${key}`);
        if (typeof value === "string") {
            return value === "true";
        }
        return defaultValue;
    }
    async remove(key) {
        window.localStorage.removeItem(`${this._prefix}${key}`);
    }
    async _set(key, value) {
        window.localStorage.setItem(`${this._prefix}${key}`, value);
    }
}

class UTF8 {
    constructor() {
        this._encoder = null;
        this._decoder = null;
    }
    encode(str) {
        if (!this._encoder) {
            this._encoder = new TextEncoder();
        }
        return this._encoder.encode(str);
    }
    decode(buffer) {
        if (!this._decoder) {
            this._decoder = new TextDecoder();
        }
        return this._decoder.decode(buffer);
    }
}

function createCommonjsModule(fn, basedir, module) {
	return module = {
	  path: basedir,
	  exports: {},
	  require: function (path, base) {
      return commonjsRequire(path, (base === undefined || base === null) ? module.path : base);
    }
	}, fn(module, module.exports), module.exports;
}
function commonjsRequire () {
	throw new Error('Dynamic requires are not currently supported by @rollup/plugin-commonjs');
}
var base64Arraybuffer = createCommonjsModule(function (module, exports) {
(function(){
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var lookup = new Uint8Array(256);
  for (var i = 0; i < chars.length; i++) {
    lookup[chars.charCodeAt(i)] = i;
  }
  exports.encode = function(arraybuffer) {
    var bytes = new Uint8Array(arraybuffer),
    i, len = bytes.length, base64 = "";
    for (i = 0; i < len; i+=3) {
      base64 += chars[bytes[i] >> 2];
      base64 += chars[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)];
      base64 += chars[((bytes[i + 1] & 15) << 2) | (bytes[i + 2] >> 6)];
      base64 += chars[bytes[i + 2] & 63];
    }
    if ((len % 3) === 2) {
      base64 = base64.substring(0, base64.length - 1) + "=";
    } else if (len % 3 === 1) {
      base64 = base64.substring(0, base64.length - 2) + "==";
    }
    return base64;
  };
  exports.decode =  function(base64) {
    var bufferLength = base64.length * 0.75,
    len = base64.length, i, p = 0,
    encoded1, encoded2, encoded3, encoded4;
    if (base64[base64.length - 1] === "=") {
      bufferLength--;
      if (base64[base64.length - 2] === "=") {
        bufferLength--;
      }
    }
    var arraybuffer = new ArrayBuffer(bufferLength),
    bytes = new Uint8Array(arraybuffer);
    for (i = 0; i < len; i+=4) {
      encoded1 = lookup[base64.charCodeAt(i)];
      encoded2 = lookup[base64.charCodeAt(i+1)];
      encoded3 = lookup[base64.charCodeAt(i+2)];
      encoded4 = lookup[base64.charCodeAt(i+3)];
      bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
      bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
      bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
    }
    return arraybuffer;
  };
})();
});

class Base64 {
    encodeUnpadded(buffer) {
        const str = base64Arraybuffer.encode(buffer);
        const paddingIdx = str.indexOf("=");
        if (paddingIdx !== -1) {
            return str.substr(0, paddingIdx);
        } else {
            return str;
        }
    }
    encode(buffer) {
        return base64Arraybuffer.encode(buffer);
    }
    decode(str) {
        return base64Arraybuffer.decode(str);
    }
}

var buffer = class Buffer {
    static isBuffer(array) {return array instanceof Uint8Array;}
    static from(arrayBuffer) {return arrayBuffer;}
    static allocUnsafe(size) {return Buffer.alloc(size);}
    static alloc(size) {return new Uint8Array(size);}
};
var Buffer = buffer;
var safeBuffer = {
	Buffer: Buffer
};
var _Buffer = safeBuffer.Buffer;
function base (ALPHABET) {
  if (ALPHABET.length >= 255) { throw new TypeError('Alphabet too long') }
  var BASE_MAP = new Uint8Array(256);
  for (var j = 0; j < BASE_MAP.length; j++) {
    BASE_MAP[j] = 255;
  }
  for (var i = 0; i < ALPHABET.length; i++) {
    var x = ALPHABET.charAt(i);
    var xc = x.charCodeAt(0);
    if (BASE_MAP[xc] !== 255) { throw new TypeError(x + ' is ambiguous') }
    BASE_MAP[xc] = i;
  }
  var BASE = ALPHABET.length;
  var LEADER = ALPHABET.charAt(0);
  var FACTOR = Math.log(BASE) / Math.log(256);
  var iFACTOR = Math.log(256) / Math.log(BASE);
  function encode (source) {
    if (Array.isArray(source) || source instanceof Uint8Array) { source = _Buffer.from(source); }
    if (!_Buffer.isBuffer(source)) { throw new TypeError('Expected Buffer') }
    if (source.length === 0) { return '' }
    var zeroes = 0;
    var length = 0;
    var pbegin = 0;
    var pend = source.length;
    while (pbegin !== pend && source[pbegin] === 0) {
      pbegin++;
      zeroes++;
    }
    var size = ((pend - pbegin) * iFACTOR + 1) >>> 0;
    var b58 = new Uint8Array(size);
    while (pbegin !== pend) {
      var carry = source[pbegin];
      var i = 0;
      for (var it1 = size - 1; (carry !== 0 || i < length) && (it1 !== -1); it1--, i++) {
        carry += (256 * b58[it1]) >>> 0;
        b58[it1] = (carry % BASE) >>> 0;
        carry = (carry / BASE) >>> 0;
      }
      if (carry !== 0) { throw new Error('Non-zero carry') }
      length = i;
      pbegin++;
    }
    var it2 = size - length;
    while (it2 !== size && b58[it2] === 0) {
      it2++;
    }
    var str = LEADER.repeat(zeroes);
    for (; it2 < size; ++it2) { str += ALPHABET.charAt(b58[it2]); }
    return str
  }
  function decodeUnsafe (source) {
    if (typeof source !== 'string') { throw new TypeError('Expected String') }
    if (source.length === 0) { return _Buffer.alloc(0) }
    var psz = 0;
    if (source[psz] === ' ') { return }
    var zeroes = 0;
    var length = 0;
    while (source[psz] === LEADER) {
      zeroes++;
      psz++;
    }
    var size = (((source.length - psz) * FACTOR) + 1) >>> 0;
    var b256 = new Uint8Array(size);
    while (source[psz]) {
      var carry = BASE_MAP[source.charCodeAt(psz)];
      if (carry === 255) { return }
      var i = 0;
      for (var it3 = size - 1; (carry !== 0 || i < length) && (it3 !== -1); it3--, i++) {
        carry += (BASE * b256[it3]) >>> 0;
        b256[it3] = (carry % 256) >>> 0;
        carry = (carry / 256) >>> 0;
      }
      if (carry !== 0) { throw new Error('Non-zero carry') }
      length = i;
      psz++;
    }
    if (source[psz] === ' ') { return }
    var it4 = size - length;
    while (it4 !== size && b256[it4] === 0) {
      it4++;
    }
    var vch = _Buffer.allocUnsafe(zeroes + (size - it4));
    vch.fill(0x00, 0, zeroes);
    var j = zeroes;
    while (it4 !== size) {
      vch[j++] = b256[it4++];
    }
    return vch
  }
  function decode (string) {
    var buffer = decodeUnsafe(string);
    if (buffer) { return buffer }
    throw new Error('Non-base' + BASE + ' character')
  }
  return {
    encode: encode,
    decodeUnsafe: decodeUnsafe,
    decode: decode
  }
}
var src = base;
var ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
var bs58 = src(ALPHABET);

class Base58 {
    encode(buffer) {
        return bs58.encode(buffer);
    }
    decode(str) {
        return bs58.decode(str);
    }
}

class Encoding {
    constructor() {
        this.utf8 = new UTF8();
        this.base64 = new Base64();
        this.base58 = new Base58();
    }
}

class OlmWorker {
    constructor(workerPool) {
        this._workerPool = workerPool;
    }
    megolmDecrypt(session, ciphertext) {
        const sessionKey = session.export_session(session.first_known_index());
        return this._workerPool.send({type: "megolm_decrypt", ciphertext, sessionKey});
    }
    async createAccountAndOTKs(account, otkAmount) {
        let randomValues;
        if (window.msCrypto) {
            randomValues = [
                window.msCrypto.getRandomValues(new Uint8Array(64)),
                window.msCrypto.getRandomValues(new Uint8Array(otkAmount * 32)),
            ];
        }
        const pickle = await this._workerPool.send({type: "olm_create_account_otks", randomValues, otkAmount}).response();
        account.unpickle("", pickle);
    }
    async createOutboundOlmSession(account, newSession, theirIdentityKey, theirOneTimeKey) {
        const accountPickle = account.pickle("");
        let randomValues;
        if (window.msCrypto) {
            randomValues = [
                window.msCrypto.getRandomValues(new Uint8Array(64)),
            ];
        }
        const sessionPickle = await this._workerPool.send({type: "olm_create_outbound", accountPickle, theirIdentityKey, theirOneTimeKey, randomValues}).response();
        newSession.unpickle("", sessionPickle);
    }
    dispose() {
        this._workerPool.dispose();
    }
}

const LogLevel = {
    All: 1,
    Debug: 2,
    Detail: 3,
    Info: 4,
    Warn: 5,
    Error: 6,
    Fatal: 7,
    Off: 8,
};
class LogFilter {
    constructor(parentFilter) {
        this._parentFilter = parentFilter;
        this._min = null;
    }
    filter(item, children) {
        if (this._parentFilter) {
            if (!this._parentFilter.filter(item, children)) {
                return false;
            }
        }
        if (this._min !== null && !Array.isArray(children) && item.logLevel < this._min) {
            return false;
        } else {
            return true;
        }
    }
    minLevel(logLevel) {
        this._min = logLevel;
        return this;
    }
}

class LogItem {
    constructor(labelOrValues, logLevel, filterCreator, logger) {
        this._logger = logger;
        this._start = logger._now();
        this._end = null;
        this._values = typeof labelOrValues === "string" ? {l: labelOrValues} : labelOrValues;
        this.error = null;
        this.logLevel = logLevel;
        this._children = null;
        this._filterCreator = filterCreator;
    }
    runDetached(labelOrValues, callback, logLevel, filterCreator) {
        return this._logger.runDetached(labelOrValues, callback, logLevel, filterCreator);
    }
    wrapDetached(labelOrValues, callback, logLevel, filterCreator) {
        this.refDetached(this.runDetached(labelOrValues, callback, logLevel, filterCreator));
    }
    refDetached(logItem, logLevel = null) {
        if (!logItem._values.refId) {
            logItem.set("refId", this._logger._createRefId());
        }
        return this.log({ref: logItem._values.refId}, logLevel);
    }
    wrap(labelOrValues, callback, logLevel = null, filterCreator = null) {
        const item = this.child(labelOrValues, logLevel, filterCreator);
        return item.run(callback);
    }
    get duration() {
        if (this._end) {
            return this._end - this._start;
        } else {
            return null;
        }
    }
    durationWithoutType(type) {
        return this.duration - this.durationOfType(type);
    }
    durationOfType(type) {
        if (this._values.t === type) {
            return this.duration;
        } else if (this._children) {
            return this._children.reduce((sum, c) => {
                return sum + c.durationOfType(type);
            }, 0);
        } else {
            return 0;
        }
    }
    log(labelOrValues, logLevel = null) {
        const item = this.child(labelOrValues, logLevel, null);
        item._end = item._start;
    }
    set(key, value) {
        if(typeof key === "object") {
            const values = key;
            Object.assign(this._values, values);
        } else {
            this._values[key] = value;
        }
    }
    serialize(filter, parentStartTime = null, forced) {
        if (this._filterCreator) {
            try {
                filter = this._filterCreator(new LogFilter(filter), this);
            } catch (err) {
                console.error("Error creating log filter", err);
            }
        }
        let children;
        if (this._children !== null) {
            children = this._children.reduce((array, c) => {
                const s = c.serialize(filter, this._start, false);
                if (s) {
                    if (array === null) {
                        array = [];
                    }
                    array.push(s);
                }
                return array;
            }, null);
        }
        if (filter && !filter.filter(this, children)) {
            return null;
        }
        const item = {
            s: parentStartTime === null ? this._start : this._start - parentStartTime,
            d: this.duration,
            v: this._values,
            l: this.logLevel
        };
        if (this.error) {
            item.e = {
                stack: this.error.stack,
                name: this.error.name,
                message: this.error.message.split("\n")[0]
            };
        }
        if (forced) {
            item.f = true;
        }
        if (children) {
            item.c = children;
        }
        return item;
    }
    run(callback) {
        if (this._end !== null) {
            console.trace("log item is finished, additional logs will likely not be recorded");
        }
        let result;
        try {
            result = callback(this);
            if (result instanceof Promise) {
                return result.then(promiseResult => {
                    this.finish();
                    return promiseResult;
                }, err => {
                    throw this.catch(err);
                });
            } else {
                this.finish();
                return result;
            }
        } catch (err) {
            throw this.catch(err);
        }
    }
    finish() {
        if (this._end === null) {
            if (this._children !== null) {
                for(const c of this._children) {
                    c.finish();
                }
            }
            this._end = this._logger._now();
        }
    }
    get level() {
        return LogLevel;
    }
    catch(err) {
        this.error = err;
        this.logLevel = LogLevel.Error;
        this.finish();
        return err;
    }
    child(labelOrValues, logLevel, filterCreator) {
        if (this._end !== null) {
            console.trace("log item is finished, additional logs will likely not be recorded");
        }
        if (!logLevel) {
            logLevel = this.logLevel || LogLevel.Info;
        }
        const item = new LogItem(labelOrValues, logLevel, filterCreator, this._logger);
        if (this._children === null) {
            this._children = [];
        }
        this._children.push(item);
        return item;
    }
}

class BaseLogger {
    constructor({platform}) {
        this._openItems = new Set();
        this._platform = platform;
    }
    log(labelOrValues, logLevel = LogLevel.Info) {
        const item = new LogItem(labelOrValues, logLevel, null, this);
        item._end = item._start;
        this._persistItem(item, null, false);
    }
    wrapOrRun(item, labelOrValues, callback, logLevel = null, filterCreator = null) {
        if (item) {
            return item.wrap(labelOrValues, callback, logLevel, filterCreator);
        } else {
            return this.run(labelOrValues, callback, logLevel, filterCreator);
        }
    }
    runDetached(labelOrValues, callback, logLevel = null, filterCreator = null) {
        if (logLevel === null) {
            logLevel = LogLevel.Info;
        }
        const item = new LogItem(labelOrValues, logLevel, null, this);
        this._run(item, callback, logLevel, filterCreator, false );
        return item;
    }
    run(labelOrValues, callback, logLevel = null, filterCreator = null) {
        if (logLevel === null) {
            logLevel = LogLevel.Info;
        }
        const item = new LogItem(labelOrValues, logLevel, null, this);
        return this._run(item, callback, logLevel, filterCreator, true);
    }
    _run(item, callback, logLevel, filterCreator, shouldThrow) {
        this._openItems.add(item);
        const finishItem = () => {
            let filter = new LogFilter();
            if (filterCreator) {
                try {
                    filter = filterCreator(filter, item);
                } catch (err) {
                    console.error("Error while creating log filter", err);
                }
            } else {
                filter = filter.minLevel(logLevel);
            }
            try {
                this._persistItem(item, filter, false);
            } catch (err) {
                console.error("Could not persist log item", err);
            }
            this._openItems.delete(item);
        };
        try {
            const result = item.run(callback);
            if (result instanceof Promise) {
                return result.then(promiseResult => {
                    finishItem();
                    return promiseResult;
                }, err => {
                    finishItem();
                    if (shouldThrow) {
                        throw err;
                    }
                });
            } else {
                finishItem();
                return result;
            }
        } catch (err) {
            finishItem();
            if (shouldThrow) {
                throw err;
            }
        }
    }
    _finishOpenItems() {
        for (const openItem of this._openItems) {
            openItem.finish();
            try {
                this._persistItem(openItem, new LogFilter(), true);
            } catch (err) {
                console.error("Could not serialize log item", err);
            }
        }
        this._openItems.clear();
    }
    _persistItem() {
        throw new Error("not implemented");
    }
    async export() {
        throw new Error("not implemented");
    }
    get level() {
        return LogLevel;
    }
    _now() {
        return this._platform.clock.now();
    }
    _createRefId() {
        return Math.round(this._platform.random() * Number.MAX_SAFE_INTEGER);
    }
}

class IDBLogger extends BaseLogger {
    constructor(options) {
        super(options);
        const {name, flushInterval = 60 * 1000, limit = 3000} = options;
        this._name = name;
        this._limit = limit;
        this._queuedItems = this._loadQueuedItems();
        window.addEventListener("pagehide", this, false);
        this._flushInterval = this._platform.clock.createInterval(() => this._tryFlush(), flushInterval);
    }
    dispose() {
        window.removeEventListener("pagehide", this, false);
        this._flushInterval.dispose();
    }
    handleEvent(evt) {
        if (evt.type === "pagehide") {
            this._finishAllAndFlush();
        }
    }
    async _tryFlush() {
        const db = await this._openDB();
        try {
            const txn = db.transaction(["logs"], "readwrite");
            const logs = txn.objectStore("logs");
            const amount = this._queuedItems.length;
            for(const i of this._queuedItems) {
                logs.add(i);
            }
            const itemCount = await reqAsPromise(logs.count());
            if (itemCount > this._limit) {
                let deleteAmount = (itemCount - this._limit) + Math.round(0.1 * this._limit);
                await iterateCursor(logs.openCursor(), (_, __, cursor) => {
                    cursor.delete();
                    deleteAmount -= 1;
                    return {done: deleteAmount === 0};
                });
            }
            await txnAsPromise(txn);
            this._queuedItems.splice(0, amount);
        } catch (err) {
            console.error("Could not flush logs", err);
        } finally {
            try {
                db.close();
            } catch (e) {}
        }
    }
    _finishAllAndFlush() {
        this._finishOpenItems();
        this.log({l: "pagehide, closing logs", t: "navigation"});
        this._persistQueuedItems(this._queuedItems);
    }
    _loadQueuedItems() {
        const key = `${this._name}_queuedItems`;
        try {
            const json = window.localStorage.getItem(key);
            if (json) {
                window.localStorage.removeItem(key);
                return JSON.parse(json);
            }
        } catch (err) {
            console.error("Could not load queued log items", err);
        }
        return [];
    }
    _openDB() {
        return openDatabase(this._name, db => db.createObjectStore("logs", {keyPath: "id", autoIncrement: true}), 1);
    }
    _persistItem(logItem, filter, forced) {
        const serializedItem = logItem.serialize(filter, forced);
        this._queuedItems.push({
            json: JSON.stringify(serializedItem)
        });
    }
    _persistQueuedItems(items) {
        try {
            window.localStorage.setItem(`${this._name}_queuedItems`, JSON.stringify(items));
        } catch (e) {
            console.error("Could not persist queued log items in localStorage, they will likely be lost", e);
        }
    }
    async export() {
        const db = await this._openDB();
        try {
            const txn = db.transaction(["logs"], "readonly");
            const logs = txn.objectStore("logs");
            const storedItems = await fetchResults(logs.openCursor(), () => false);
            const allItems = storedItems.concat(this._queuedItems);
            return new IDBLogExport(allItems, this, this._platform);
        } finally {
            try {
                db.close();
            } catch (e) {}
        }
    }
    async _removeItems(items) {
        const db = await this._openDB();
        try {
            const txn = db.transaction(["logs"], "readwrite");
            const logs = txn.objectStore("logs");
            for (const item of items) {
                const queuedIdx = this._queuedItems.findIndex(i => i.id === item.id);
                if (queuedIdx === -1) {
                    logs.delete(item.id);
                } else {
                    this._queuedItems.splice(queuedIdx, 1);
                }
            }
            await txnAsPromise(txn);
        } finally {
            try {
                db.close();
            } catch (e) {}
        }
    }
}
class IDBLogExport {
    constructor(items, logger, platform) {
        this._items = items;
        this._logger = logger;
        this._platform = platform;
    }
    get count() {
        return this._items.length;
    }
    removeFromStore() {
        return this._logger._removeItems(this._items);
    }
    asBlob() {
        const log = {
            formatVersion: 1,
            appVersion: this._platform.updateService?.version,
            items: this._items.map(i => JSON.parse(i.json))
        };
        const json = JSON.stringify(log);
        const buffer = this._platform.encoding.utf8.encode(json);
        const blob = this._platform.createBlob(buffer, "application/json");
        return blob;
    }
}

class ConsoleLogger extends BaseLogger {
    _persistItem(item) {
        printToConsole(item);
    }
}
const excludedKeysFromTable = ["l", "id"];
function filterValues(values) {
    if (!values) {
        return null;
    }
    return Object.entries(values)
        .filter(([key]) => !excludedKeysFromTable.includes(key))
        .reduce((obj, [key, value]) => {
            obj = obj || {};
            obj[key] = value;
            return obj;
        }, null);
}
function printToConsole(item) {
    const label = `${itemCaption(item)} (${item.duration}ms)`;
    const filteredValues = filterValues(item._values);
    const shouldGroup = item._children || filteredValues;
    if (shouldGroup) {
        if (item.error) {
            console.group(label);
        } else {
            console.groupCollapsed(label);
        }
        if (item.error) {
            console.error(item.error);
        }
    } else {
        if (item.error) {
            console.error(item.error);
        } else {
            console.log(label);
        }
    }
    if (filteredValues) {
        console.table(filteredValues);
    }
    if (item._children) {
        for(const c of item._children) {
            printToConsole(c);
        }
    }
    if (shouldGroup) {
        console.groupEnd();
    }
}
function itemCaption(item) {
    if (item._values.t === "network") {
        return `${item._values.method} ${item._values.url}`;
    } else if (item._values.l && typeof item._values.id !== "undefined") {
        return `${item._values.l} ${item._values.id}`;
    } else if (item._values.l && typeof item._values.status !== "undefined") {
        return `${item._values.l} (${item._values.status})`;
    } else if (item._values.l && item.error) {
        return `${item._values.l} failed`;
    } else if (typeof item._values.ref !== "undefined") {
        return `ref ${item._values.ref}`
    } else {
        return item._values.l || item._values.type;
    }
}

function isChildren(children) {
    return typeof children !== "object" || !!children.nodeType || Array.isArray(children);
}
function classNames(obj, value) {
    return Object.entries(obj).reduce((cn, [name, enabled]) => {
        if (typeof enabled === "function") {
            enabled = enabled(value);
        }
        if (enabled) {
            return cn + (cn.length ? " " : "") + name;
        } else {
            return cn;
        }
    }, "");
}
function setAttribute(el, name, value) {
    if (name === "className") {
        name = "class";
    }
    if (value === false) {
        el.removeAttribute(name);
    } else {
        if (value === true) {
            value = name;
        }
        el.setAttribute(name, value);
    }
}
function el(elementName, attributes, children) {
    return elNS(HTML_NS, elementName, attributes, children);
}
function elNS(ns, elementName, attributes, children) {
    if (attributes && isChildren(attributes)) {
        children = attributes;
        attributes = null;
    }
    const e = document.createElementNS(ns, elementName);
    if (attributes) {
        for (let [name, value] of Object.entries(attributes)) {
            if (name === "className" && typeof value === "object" && value !== null) {
                value = classNames(value);
            }
            setAttribute(e, name, value);
        }
    }
    if (children) {
        if (!Array.isArray(children)) {
            children = [children];
        }
        for (let c of children) {
            if (!c.nodeType) {
                c = text(c);
            }
            e.appendChild(c);
        }
    }
    return e;
}
function text(str) {
    return document.createTextNode(str);
}
const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const TAG_NAMES = {
    [HTML_NS]: [
        "br", "a", "ol", "ul", "li", "div", "h1", "h2", "h3", "h4", "h5", "h6",
        "p", "strong", "em", "span", "img", "section", "main", "article", "aside",
        "pre", "button", "time", "input", "textarea", "label", "form", "progress", "output", "video"],
    [SVG_NS]: ["svg", "circle"]
};
const tag = {};
for (const [ns, tags] of Object.entries(TAG_NAMES)) {
    for (const tagName of tags) {
        tag[tagName] = function(attributes, children) {
            return elNS(ns, tagName, attributes, children);
        };
    }
}

function errorToDOM(error) {
    const stack = new Error().stack;
    let callee = null;
    if (stack) {
        callee = stack.split("\n")[1];
    }
    return tag.div([
        tag.h2("Something went wrong…"),
        tag.h3(error.message),
        tag.p(`This occurred while running ${callee}.`),
        tag.pre(error.stack),
    ]);
}

function mountView(view, mountArgs = undefined) {
    let node;
    try {
        node = view.mount(mountArgs);
    } catch (err) {
        node = errorToDOM(err);
    }
    return node;
}

function insertAt(parentNode, idx, childNode) {
    const isLast = idx === parentNode.childElementCount;
    if (isLast) {
        parentNode.appendChild(childNode);
    } else {
        const nextDomNode = parentNode.children[idx];
        parentNode.insertBefore(childNode, nextDomNode);
    }
}
class ListView {
    constructor({list, onItemClick, className, tagName = "ul", parentProvidesUpdates = true}, childCreator) {
        this._onItemClick = onItemClick;
        this._list = list;
        this._className = className;
        this._tagName = tagName;
        this._root = null;
        this._subscription = null;
        this._childCreator = childCreator;
        this._childInstances = null;
        this._mountArgs = {parentProvidesUpdates};
        this._onClick = this._onClick.bind(this);
    }
    root() {
        return this._root;
    }
    update(attributes) {
        if (attributes.hasOwnProperty("list")) {
            if (this._subscription) {
                this._unloadList();
                while (this._root.lastChild) {
                    this._root.lastChild.remove();
                }
            }
            this._list = attributes.list;
            this.loadList();
        }
    }
    mount() {
        const attr = {};
        if (this._className) {
            attr.className = this._className;
        }
        this._root = el(this._tagName, attr);
        this.loadList();
        if (this._onItemClick) {
            this._root.addEventListener("click", this._onClick);
        }
        return this._root;
    }
    unmount() {
        if (this._list) {
            this._unloadList();
        }
    }
    _onClick(event) {
        if (event.target === this._root) {
            return;
        }
        let childNode = event.target;
        while (childNode.parentNode !== this._root) {
            childNode = childNode.parentNode;
        }
        const index = Array.prototype.indexOf.call(this._root.childNodes, childNode);
        const childView = this._childInstances[index];
        this._onItemClick(childView, event);
    }
    _unloadList() {
        this._subscription = this._subscription();
        for (let child of this._childInstances) {
            child.unmount();
        }
        this._childInstances = null;
    }
    loadList() {
        if (!this._list) {
            return;
        }
        this._subscription = this._list.subscribe(this);
        this._childInstances = [];
        const fragment = document.createDocumentFragment();
        for (let item of this._list) {
            const child = this._childCreator(item);
            this._childInstances.push(child);
            fragment.appendChild(mountView(child, this._mountArgs));
        }
        this._root.appendChild(fragment);
    }
    onAdd(idx, value) {
        this.onBeforeListChanged();
        const child = this._childCreator(value);
        this._childInstances.splice(idx, 0, child);
        insertAt(this._root, idx, mountView(child, this._mountArgs));
        this.onListChanged();
    }
    onRemove(idx, _value) {
        this.onBeforeListChanged();
        const [child] = this._childInstances.splice(idx, 1);
        child.root().remove();
        child.unmount();
        this.onListChanged();
    }
    onMove(fromIdx, toIdx, value) {
        this.onBeforeListChanged();
        const [child] = this._childInstances.splice(fromIdx, 1);
        this._childInstances.splice(toIdx, 0, child);
        child.root().remove();
        insertAt(this._root, toIdx, child.root());
        this.onListChanged();
    }
    onUpdate(i, value, params) {
        if (this._childInstances) {
            const instance = this._childInstances[i];
            instance && instance.update(value, params);
        }
    }
    recreateItem(index, value) {
        if (this._childInstances) {
            const child = this._childCreator(value);
            if (!child) {
                this.onRemove(index, value);
            } else {
                const [oldChild] = this._childInstances.splice(index, 1, child);
                this._root.replaceChild(child.mount(this._mountArgs), oldChild.root());
                oldChild.unmount();
            }
        }
    }
    onBeforeListChanged() {}
    onListChanged() {}
}

class BaseUpdateView {
    constructor(value) {
        this._value = value;
        this._boundUpdateFromValue = null;
    }
    mount(options) {
        const parentProvidesUpdates = options && options.parentProvidesUpdates;
        if (!parentProvidesUpdates) {
            this._subscribe();
        }
    }
    unmount() {
        this._unsubscribe();
    }
    get value() {
        return this._value;
    }
    _updateFromValue(changedProps) {
        this.update(this._value, changedProps);
    }
    _subscribe() {
        if (typeof this._value?.on === "function") {
            this._boundUpdateFromValue = this._updateFromValue.bind(this);
            this._value.on("change", this._boundUpdateFromValue);
        }
    }
    _unsubscribe() {
        if (this._boundUpdateFromValue) {
            if (typeof this._value.off === "function") {
                this._value.off("change", this._boundUpdateFromValue);
            }
            this._boundUpdateFromValue = null;
        }
    }
}

function objHasFns(obj) {
    for(const value of Object.values(obj)) {
        if (typeof value === "function") {
            return true;
        }
    }
    return false;
}
class TemplateView extends BaseUpdateView {
    constructor(value, render = undefined) {
        super(value);
        this._render = render;
        this._eventListeners = null;
        this._bindings = null;
        this._subViews = null;
        this._root = null;
    }
    _attach() {
        if (this._eventListeners) {
            for (let {node, name, fn, useCapture} of this._eventListeners) {
                node.addEventListener(name, fn, useCapture);
            }
        }
    }
    _detach() {
        if (this._eventListeners) {
            for (let {node, name, fn, useCapture} of this._eventListeners) {
                node.removeEventListener(name, fn, useCapture);
            }
        }
    }
    mount(options) {
        const builder = new TemplateBuilder(this);
        try {
            if (this._render) {
                this._root = this._render(builder, this._value);
            } else if (this.render) {
                this._root = this.render(builder, this._value);
            } else {
                throw new Error("no render function passed in, or overriden in subclass");
            }
        } finally {
            builder.close();
        }
        super.mount(options);
        this._attach();
        return this._root;
    }
    unmount() {
        this._detach();
        super.unmount();
        if (this._subViews) {
            for (const v of this._subViews) {
                v.unmount();
            }
        }
    }
    root() {
        return this._root;
    }
    update(value) {
        this._value = value;
        if (this._bindings) {
            for (const binding of this._bindings) {
                binding();
            }
        }
    }
    _addEventListener(node, name, fn, useCapture = false) {
        if (!this._eventListeners) {
            this._eventListeners = [];
        }
        this._eventListeners.push({node, name, fn, useCapture});
    }
    _addBinding(bindingFn) {
        if (!this._bindings) {
            this._bindings = [];
        }
        this._bindings.push(bindingFn);
    }
    addSubView(view) {
        if (!this._subViews) {
            this._subViews = [];
        }
        this._subViews.push(view);
    }
    removeSubView(view) {
        const idx = this._subViews.indexOf(view);
        if (idx !== -1) {
            this._subViews.splice(idx, 1);
        }
    }
    updateSubViews(value, props) {
        if (this._subViews) {
            for (const v of this._subViews) {
                v.update(value, props);
            }
        }
    }
}
class TemplateBuilder {
    constructor(templateView) {
        this._templateView = templateView;
        this._closed = false;
    }
    close() {
        this._closed = true;
    }
    _addBinding(fn) {
        if (this._closed) {
            console.trace("Adding a binding after render will likely cause memory leaks");
        }
        this._templateView._addBinding(fn);
    }
    get _value() {
        return this._templateView._value;
    }
    addEventListener(node, name, fn, useCapture = false) {
        this._templateView._addEventListener(node, name, fn, useCapture);
    }
    _addAttributeBinding(node, name, fn) {
        let prevValue = undefined;
        const binding = () => {
            const newValue = fn(this._value);
            if (prevValue !== newValue) {
                prevValue = newValue;
                setAttribute(node, name, newValue);
            }
        };
        this._addBinding(binding);
        binding();
    }
    _addClassNamesBinding(node, obj) {
        this._addAttributeBinding(node, "className", value => classNames(obj, value));
    }
    _addTextBinding(fn) {
        const initialValue = fn(this._value);
        const node = text(initialValue);
        let prevValue = initialValue;
        const binding = () => {
            const newValue = fn(this._value);
            if (prevValue !== newValue) {
                prevValue = newValue;
                node.textContent = newValue+"";
            }
        };
        this._addBinding(binding);
        return node;
    }
    _setNodeAttributes(node, attributes) {
        for(let [key, value] of Object.entries(attributes)) {
            const isFn = typeof value === "function";
            if (key === "className" && typeof value === "object" && value !== null) {
                if (objHasFns(value)) {
                    this._addClassNamesBinding(node, value);
                } else {
                    setAttribute(node, key, classNames(value));
                }
            } else if (key.startsWith("on") && key.length > 2 && isFn) {
                const eventName = key.substr(2, 1).toLowerCase() + key.substr(3);
                const handler = value;
                this._templateView._addEventListener(node, eventName, handler);
            } else if (isFn) {
                this._addAttributeBinding(node, key, value);
            } else {
                setAttribute(node, key, value);
            }
        }
    }
    _setNodeChildren(node, children) {
        if (!Array.isArray(children)) {
            children = [children];
        }
        for (let child of children) {
            if (typeof child === "function") {
                child = this._addTextBinding(child);
            } else if (!child.nodeType) {
                child = text(child);
            }
            node.appendChild(child);
        }
    }
    _addReplaceNodeBinding(fn, renderNode) {
        let prevValue = fn(this._value);
        let node = renderNode(null);
        const binding = () => {
            const newValue = fn(this._value);
            if (prevValue !== newValue) {
                prevValue = newValue;
                const newNode = renderNode(node);
                if (node.parentNode) {
                    node.parentNode.replaceChild(newNode, node);
                }
                node = newNode;
            }
        };
        this._addBinding(binding);
        return node;
    }
    el(name, attributes, children) {
        return this.elNS(HTML_NS, name, attributes, children);
    }
    elNS(ns, name, attributes, children) {
        if (attributes && isChildren(attributes)) {
            children = attributes;
            attributes = null;
        }
        const node = document.createElementNS(ns, name);
        if (attributes) {
            this._setNodeAttributes(node, attributes);
        }
        if (children) {
            this._setNodeChildren(node, children);
        }
        return node;
    }
    view(view, mountOptions = undefined) {
        this._templateView.addSubView(view);
        return mountView(view, mountOptions);
    }
    mapView(mapFn, viewCreator) {
        return this._addReplaceNodeBinding(mapFn, (prevNode) => {
            if (prevNode && prevNode.nodeType !== Node.COMMENT_NODE) {
                const subViews = this._templateView._subViews;
                const viewIdx = subViews.findIndex(v => v.root() === prevNode);
                if (viewIdx !== -1) {
                    const [view] = subViews.splice(viewIdx, 1);
                    view.unmount();
                }
            }
            const view = viewCreator(mapFn(this._value));
            if (view) {
                return this.view(view);
            } else {
                return document.createComment("node binding placeholder");
            }
        });
    }
    map(mapFn, renderFn) {
        return this.mapView(mapFn, mappedValue => {
            return new TemplateView(this._value, (t, vm) => {
                const rootNode = renderFn(mappedValue, t, vm);
                if (!rootNode) {
                    return document.createComment("map placeholder");
                }
                return rootNode;
            });
        });
    }
    ifView(predicate, viewCreator) {
        return this.mapView(
            value => !!predicate(value),
            enabled => enabled ? viewCreator(this._value) : null
        );
    }
    if(predicate, renderFn) {
        return this.ifView(predicate, vm => new TemplateView(vm, renderFn));
    }
    mapSideEffect(mapFn, sideEffect) {
        let prevValue = mapFn(this._value);
        const binding = () => {
            const newValue = mapFn(this._value);
            if (prevValue !== newValue) {
                sideEffect(newValue, prevValue);
                prevValue = newValue;
            }
        };
        this._addBinding(binding);
        sideEffect(prevValue, undefined);
    }
}
for (const [ns, tags] of Object.entries(TAG_NAMES)) {
    for (const tag of tags) {
        TemplateBuilder.prototype[tag] = function(attributes, children) {
            return this.elNS(ns, tag, attributes, children);
        };
    }
}

class AvatarView extends BaseUpdateView {
    constructor(value, size) {
        super(value);
        this._root = null;
        this._avatarUrl = null;
        this._avatarTitle = null;
        this._avatarLetter = null;
        this._size = size;
    }
    _avatarUrlChanged() {
        if (this.value.avatarUrl(this._size) !== this._avatarUrl) {
            this._avatarUrl = this.value.avatarUrl(this._size);
            return true;
        }
        return false;
    }
    _avatarTitleChanged() {
        if (this.value.avatarTitle !== this._avatarTitle) {
            this._avatarTitle = this.value.avatarTitle;
            return true;
        }
        return false;
    }
    _avatarLetterChanged() {
        if (this.value.avatarLetter !== this._avatarLetter) {
            this._avatarLetter = this.value.avatarLetter;
            return true;
        }
        return false;
    }
    mount(options) {
        this._avatarUrlChanged();
        this._avatarLetterChanged();
        this._avatarTitleChanged();
        this._root = renderStaticAvatar(this.value, this._size);
        super.mount(options);
        return this._root;
    }
    root() {
        return this._root;
    }
    update(vm) {
        if (this._avatarUrlChanged()) {
            const bgColorClass = `usercolor${vm.avatarColorNumber}`;
            if (vm.avatarUrl(this._size)) {
                this._root.replaceChild(renderImg(vm, this._size), this._root.firstChild);
                this._root.classList.remove(bgColorClass);
            } else {
                this._root.replaceChild(text(vm.avatarLetter), this._root.firstChild);
                this._root.classList.add(bgColorClass);
            }
        }
        const hasAvatar = !!vm.avatarUrl(this._size);
        if (this._avatarTitleChanged() && hasAvatar) {
            const img = this._root.firstChild;
            img.setAttribute("title", vm.avatarTitle);
        }
        if (this._avatarLetterChanged() && !hasAvatar) {
            this._root.firstChild.textContent = vm.avatarLetter;
        }
    }
}
function renderStaticAvatar(vm, size, extraClasses = undefined) {
    const hasAvatar = !!vm.avatarUrl(size);
    let avatarClasses = classNames({
        avatar: true,
        [`size-${size}`]: true,
        [`usercolor${vm.avatarColorNumber}`]: !hasAvatar,
    });
    if (extraClasses) {
        avatarClasses += ` ${extraClasses}`;
    }
    const avatarContent = hasAvatar ? renderImg(vm, size) : text(vm.avatarLetter);
    return tag.div({className: avatarClasses}, [avatarContent]);
}
function renderImg(vm, size) {
    const sizeStr = size.toString();
    return tag.img({src: vm.avatarUrl(size), width: sizeStr, height: sizeStr, title: vm.avatarTitle});
}

class RoomTileView extends TemplateView {
    render(t, vm) {
        const classes = {
            "active": vm => vm.isOpen,
            "hidden": vm => vm.hidden
        };
        return t.li({"className": classes}, [
            t.a({href: vm.url}, [
                t.view(new AvatarView(vm, 32), {parentProvidesUpdates: true}),
                t.div({className: "description"}, [
                    t.div({className: {"name": true, unread: vm => vm.isUnread}}, vm => vm.name),
                    t.div({
                        className: {
                            badge: true,
                            highlighted: vm => vm.isHighlighted,
                            hidden: vm => !vm.badgeCount
                        }
                    }, vm => vm.badgeCount),
                ])
            ])
        ]);
    }
    update(value, props) {
        super.update(value);
        this.updateSubViews(value, props);
    }
}

let container;
function spinner(t, extraClasses = undefined) {
    if (container === undefined) {
        container = document.querySelector(".hydrogen");
    }
    if (container?.classList.contains("legacy")) {
        return t.div({className: "spinner"}, [
            t.div(),
            t.div(),
            t.div(),
            t.div(),
        ]);
    } else {
        return t.svg({className: Object.assign({"spinner": true}, extraClasses), viewBox:"0 0 100 100"},
            t.circle({cx:"50%", cy:"50%", r:"45%", pathLength:"100"})
        );
    }
}

class InviteTileView extends TemplateView {
    render(t, vm) {
        const classes = {
            "active": vm => vm.isOpen,
            "hidden": vm => vm.hidden
        };
        return t.li({"className": classes}, [
            t.a({href: vm.url}, [
                renderStaticAvatar(vm, 32),
                t.div({className: "description"}, [
                    t.div({className: "name"}, vm.name),
                    t.map(vm => vm.busy, busy => {
                        if (busy) {
                            return spinner(t);
                        } else {
                            return t.div({className: "badge highlighted"}, "!");
                        }
                    })
                ])
            ])
        ]);
    }
}

class FilterField extends TemplateView {
    render(t, options) {
        const clear = () => {
            filterInput.value = "";
            filterInput.blur();
            clearButton.blur();
            options.clear();
        };
        const filterInput = t.input({
            type: "text",
            placeholder: options?.label,
            "aria-label": options?.label,
            autocomplete: options?.autocomplete,
            enterkeyhint: 'search',
            name: options?.name,
            onInput: event => options.set(event.target.value),
            onKeydown: event => {
                if (event.key === "Escape" || event.key === "Esc") {
                    clear();
                }
            },
            onFocus: () => filterInput.select()
        });
        const clearButton = t.button({
            onClick: clear,
            title: options.i18n`Clear`,
            "aria-label": options.i18n`Clear`
        });
        return t.div({className: "FilterField"}, [filterInput, clearButton]);
    }
}
class LeftPanelView extends TemplateView {
    render(t, vm) {
        const gridButtonLabel = vm => {
            return vm.gridEnabled ?
                vm.i18n`Show single room` :
                vm.i18n`Enable grid layout`;
        };
        const utilitiesRow = t.div({className: "utilities"}, [
            t.a({className: "button-utility close-session", href: vm.closeUrl, "aria-label": vm.i18n`Back to account list`, title: vm.i18n`Back to account list`}),
            t.view(new FilterField({
                i18n: vm.i18n,
                label: vm.i18n`Filter rooms…`,
                name: "room-filter",
                autocomplete: true,
                set: query => vm.setFilter(query),
                clear: () => vm.clearFilter()
            })),
            t.button({
                onClick: () => vm.toggleGrid(),
                className: {
                    "button-utility": true,
                    grid: true,
                    on: vm => vm.gridEnabled
                },
                title: gridButtonLabel,
                "aria-label": gridButtonLabel
            }),
            t.a({className: "button-utility settings", href: vm.settingsUrl, "aria-label": vm.i18n`Settings`, title: vm.i18n`Settings`}),
        ]);
        return t.div({className: "LeftPanel"}, [
            utilitiesRow,
            t.view(new ListView(
                {
                    className: "RoomList",
                    list: vm.tileViewModels,
                },
                tileVM => {
                    if (tileVM.kind === "invite") {
                        return new InviteTileView(tileVM);
                    } else {
                        return new RoomTileView(tileVM);
                    }
                }
            ))
        ]);
    }
}

const HorizontalAxis = {
    scrollOffset(el) {return el.scrollLeft;},
    size(el) {return el.offsetWidth;},
    offsetStart(el) {return el.offsetLeft;},
    setStart(el, value) {el.style.left = `${value}px`;},
    setEnd(el, value) {el.style.right = `${value}px`;},
};
const VerticalAxis = {
    scrollOffset(el) {return el.scrollTop;},
    size(el) {return el.offsetHeight;},
    offsetStart(el) {return el.offsetTop;},
    setStart(el, value) {el.style.top = `${value}px`;},
    setEnd(el, value) {el.style.bottom = `${value}px`;},
};
class Popup {
    constructor(view, closeCallback = null) {
        this._view = view;
        this._target = null;
        this._arrangement = null;
        this._scroller = null;
        this._fakeRoot = null;
        this._trackingTemplateView = null;
        this._closeCallback = closeCallback;
    }
    trackInTemplateView(templateView) {
        this._trackingTemplateView = templateView;
        this._trackingTemplateView.addSubView(this);
    }
    showRelativeTo(target, arrangement) {
        this._target = target;
        this._arrangement = arrangement;
        this._scroller = findScrollParent(this._target);
        this._view.mount();
        this._target.offsetParent.appendChild(this._popup);
        this._applyArrangementAxis(HorizontalAxis, this._arrangement.horizontal);
        this._applyArrangementAxis(VerticalAxis, this._arrangement.vertical);
        if (this._scroller) {
            document.body.addEventListener("scroll", this, true);
        }
        setTimeout(() => {
            document.body.addEventListener("click", this, false);
        }, 10);
    }
    get isOpen() {
        return !!this._view;
    }
    close() {
        if (this._view) {
            this._view.unmount();
            this._trackingTemplateView.removeSubView(this);
            if (this._scroller) {
                document.body.removeEventListener("scroll", this, true);
            }
            document.body.removeEventListener("click", this, false);
            this._popup.remove();
            this._view = null;
            if (this._closeCallback) {
                this._closeCallback();
            }
        }
    }
    get _popup() {
        return this._view.root();
    }
    handleEvent(evt) {
        if (evt.type === "scroll") {
            this._onScroll();
        } else if (evt.type === "click") {
            this._onClick(evt);
        }
    }
    _onScroll() {
        if (this._scroller && !this._isVisibleInScrollParent(VerticalAxis)) {
            this.close();
        } else {
            this._applyArrangementAxis(HorizontalAxis, this._arrangement.horizontal);
            this._applyArrangementAxis(VerticalAxis, this._arrangement.vertical);
        }
    }
    _onClick() {
        this.close();
    }
    _applyArrangementAxis(axis, {relativeTo, align, before, after}) {
        if (relativeTo === "end") {
            let end = axis.size(this._target.offsetParent) - axis.offsetStart(this._target);
            if (align === "end") {
                end -= axis.size(this._popup);
            } else if (align === "center") {
                end -= ((axis.size(this._popup) / 2) - (axis.size(this._target) / 2));
            }
            if (typeof before === "number") {
                end += before;
            } else if (typeof after === "number") {
                end -= (axis.size(this._target) + after);
            }
            axis.setEnd(this._popup, end);
        } else if (relativeTo === "start") {
            let scrollOffset = this._scroller ? axis.scrollOffset(this._scroller) : 0;
            let start = axis.offsetStart(this._target) - scrollOffset;
            if (align === "start") {
                start -= axis.size(this._popup);
            } else if (align === "center") {
                start -= ((axis.size(this._popup) / 2) - (axis.size(this._target) / 2));
            }
            if (typeof before === "number") {
                start -= before;
            } else if (typeof after === "number") {
                start += (axis.size(this._target) + after);
            }
            axis.setStart(this._popup, start);
        } else {
            throw new Error("unknown relativeTo: " + relativeTo);
        }
    }
    _isVisibleInScrollParent(axis) {
        if ((axis.offsetStart(this._target) + axis.size(this._target)) < (
            axis.offsetStart(this._scroller) +
            axis.scrollOffset(this._scroller)
        )) {
            return false;
        }
        if (axis.offsetStart(this._target) > (
            axis.offsetStart(this._scroller) +
            axis.size(this._scroller) +
            axis.scrollOffset(this._scroller)
        )) {
            return false;
        }
        return true;
    }
    root() {
        return this._fakeRoot;
    }
    mount() {
        this._fakeRoot = document.createComment("popup");
        return this._fakeRoot;
    }
    unmount() {
        this.close();
    }
    update() {}
}
function findScrollParent(el) {
    let parent = el;
    do {
        parent = parent.parentElement;
        if (parent.scrollHeight > parent.clientHeight) {
            const style = window.getComputedStyle(parent);
            const {overflow} = style;
            if (overflow === "auto" || overflow === "scroll") {
                return parent;
            }
        }
    } while (parent !== el.offsetParent);
}

class Menu extends TemplateView {
    static option(label, callback) {
        return new MenuOption(label, callback);
    }
    constructor(options) {
        super();
        this._options = options;
    }
    render(t) {
        return t.ul({className: "menu", role: "menu"}, this._options.map(o => o.toDOM(t)));
    }
}
class MenuOption {
    constructor(label, callback) {
        this.label = label;
        this.callback = callback;
        this.icon = null;
        this.destructive = false;
    }
    setIcon(className) {
        this.icon = className;
        return this;
    }
    setDestructive() {
        this.destructive = true;
        return this;
    }
    toDOM(t) {
        const className = {
            destructive: this.destructive,
        };
        if (this.icon) {
            className.icon = true;
            className[this.icon] = true;
        }
        return t.li({
            className,
        }, t.button({className:"menu-item", onClick: this.callback}, this.label));
    }
}

class GapView extends TemplateView {
    render(t, vm) {
        const className = {
            GapView: true,
            isLoading: vm => vm.isLoading
        };
        return t.li({className}, [
            spinner(t),
            t.div(vm.i18n`Loading more messages …`),
            t.if(vm => vm.error, t => t.strong(vm => vm.error))
        ]);
    }
}

class StaticView {
    constructor(value, render = undefined) {
        if (typeof value === "function" && !render) {
            render = value;
            value = null;
        }
        this._root = render ? render(tag, value) : this.render(tag, value);
    }
    mount() {
        return this._root;
    }
    root() {
        return this._root;
    }
    unmount() {}
    update() {}
}

class ReactionsView extends ListView {
    constructor(reactionsViewModel) {
        const options = {
            className: "Timeline_messageReactions",
            tagName: "div",
            list: reactionsViewModel.reactions,
            onItemClick: reactionView => reactionView.onClick(),
        };
        super(options, reactionVM => new ReactionView(reactionVM));
    }
}
class ReactionView extends TemplateView {
    render(t, vm) {
        return t.button({
            className: {
                active: vm => vm.isActive,
                pending: vm => vm.isPending
            },
        }, [vm.key, " ", vm => `${vm.count}`]);
    }
    onClick() {
        this.value.toggle();
    }
}

class BaseMessageView extends TemplateView {
    constructor(value) {
        super(value);
        this._menuPopup = null;
    }
    render(t, vm) {
        const li = t.li({className: {
            "Timeline_message": true,
            own: vm.isOwn,
            unsent: vm.isUnsent,
            unverified: vm.isUnverified,
            continuation: vm => vm.isContinuation,
        }}, [
            this.renderMessageBody(t, vm),
            t.button({className: "Timeline_messageOptions"}, "⋯"),
        ]);
        t.mapSideEffect(vm => vm.isContinuation, (isContinuation, wasContinuation) => {
            if (isContinuation && wasContinuation === false) {
                li.removeChild(li.querySelector(".Timeline_messageAvatar"));
                li.removeChild(li.querySelector(".Timeline_messageSender"));
            } else if (!isContinuation) {
                li.insertBefore(renderStaticAvatar(vm, 30, "Timeline_messageAvatar"), li.firstChild);
                li.insertBefore(tag.div({className: `Timeline_messageSender usercolor${vm.avatarColorNumber}`}, vm.displayName), li.firstChild);
            }
        });
        let reactionsView = null;
        t.mapSideEffect(vm => vm.reactions, reactions => {
            if (reactions && !reactionsView) {
                reactionsView = new ReactionsView(vm.reactions);
                this.addSubView(reactionsView);
                li.appendChild(mountView(reactionsView));
            } else if (!reactions && reactionsView) {
                li.removeChild(reactionsView.root());
                reactionsView.unmount();
                this.removeSubView(reactionsView);
                reactionsView = null;
            }
        });
        return li;
    }
    onClick(evt) {
        if (evt.target.className === "Timeline_messageOptions") {
            this._toggleMenu(evt.target);
        }
    }
    _toggleMenu(button) {
        if (this._menuPopup && this._menuPopup.isOpen) {
            this._menuPopup.close();
        } else {
            const options = this.createMenuOptions(this.value);
            if (!options.length) {
                return;
            }
            this.root().classList.add("menuOpen");
            const onClose = () => this.root().classList.remove("menuOpen");
            this._menuPopup = new Popup(new Menu(options), onClose);
            this._menuPopup.trackInTemplateView(this);
            this._menuPopup.showRelativeTo(button, {
                horizontal: {
                    relativeTo: "end",
                    align: "start",
                    after: 0
                },
                vertical: {
                    relativeTo: "start",
                    align: "end",
                    before: -24
                }
            });
        }
    }
    createMenuOptions(vm) {
        const options = [];
        if (vm.canReact && vm.shape !== "redacted") {
            options.push(new QuickReactionsMenuOption(vm));
        }
        if (vm.canAbortSending) {
            options.push(Menu.option(vm.i18n`Cancel`, () => vm.abortSending()));
        } else if (vm.canRedact) {
            options.push(Menu.option(vm.i18n`Delete`, () => vm.redact()).setDestructive());
        }
        return options;
    }
    renderMessageBody() {}
}
class QuickReactionsMenuOption {
    constructor(vm) {
        this._vm = vm;
    }
    toDOM(t) {
        const emojiButtons = ["👍", "👎", "😄", "🎉", "😕", "❤️", "🚀", "👀"].map(emoji => {
            return t.button({onClick: () => this._vm.react(emoji)}, emoji);
        });
        const customButton = t.button({onClick: () => {
            const key = prompt("Enter your reaction (emoji)");
            if (key) {
                this._vm.react(key);
            }
        }}, "…");
        return t.li({className: "quick-reactions"}, [...emojiButtons, customButton]);
    }
}

class TextMessageView extends BaseMessageView {
    renderMessageBody(t, vm) {
        return t.p({
            className: {
                "Timeline_messageBody": true,
                statusMessage: vm => vm.shape === "message-status",
            },
        }, [
            t.mapView(vm => vm.body, body => new BodyView(body)),
            t.time({className: {hidden: !vm.date}}, vm.date + " " + vm.time)
        ]);
    }
}
const formatFunction = {
    text: textPart => text(textPart.text),
    link: linkPart => tag.a({ href: linkPart.url, target: "_blank", rel: "noopener" }, [linkPart.text]),
    newline: () => tag.br()
};
class BodyView extends StaticView {
    render(t, messageBody) {
        const container = t.span();
        for (const part of messageBody.parts) {
            const f = formatFunction[part.type];
            const element = f(part);
            container.appendChild(element);
        }
        return container;
    }
}

class BaseMediaView extends BaseMessageView {
    renderMessageBody(t, vm) {
        const heightRatioPercent = (vm.height / vm.width) * 100;
        let spacerStyle = `padding-top: ${heightRatioPercent}%;`;
        if (vm.platform.isIE11) {
            spacerStyle = `height: ${vm.height}px`;
        }
        const children = [
            t.div({className: "spacer", style: spacerStyle}),
            this.renderMedia(t, vm),
            t.time(vm.date + " " + vm.time),
        ];
        if (vm.isPending) {
            const sendStatus = t.div({
                className: {
                    sendStatus: true,
                    hidden: vm => !vm.sendStatus
                },
            }, vm => vm.sendStatus);
            const progress = t.progress({
                min: 0,
                max: 100,
                value: vm => vm.uploadPercentage,
                className: {hidden: vm => !vm.isUploading}
            });
            children.push(sendStatus, progress);
        }
        return t.div({className: "Timeline_messageBody"}, [
            t.div({className: "media", style: `max-width: ${vm.width}px`}, children),
            t.if(vm => vm.error, t => t.p({className: "error"}, vm.error))
        ]);
    }
}

class ImageView extends BaseMediaView {
    renderMedia(t, vm) {
        const img = t.img({
            loading: "lazy",
            src: vm => vm.thumbnailUrl,
            alt: vm => vm.label,
            title: vm => vm.label,
            style: `max-width: ${vm.width}px; max-height: ${vm.height}px;`
        });
        return vm.isPending ? img : t.a({href: vm.lightboxUrl}, img);
    }
}

function domEventAsPromise(element, successEvent) {
    return new Promise((resolve, reject) => {
        let detach;
        const handleError = evt => {
            detach();
            reject(evt.target.error);
        };
        const handleSuccess = () => {
            detach();
            resolve();
        };
        detach = () => {
            element.removeEventListener(successEvent, handleSuccess);
            element.removeEventListener("error", handleError);
        };
        element.addEventListener(successEvent, handleSuccess);
        element.addEventListener("error", handleError);
    });
}

class VideoView extends BaseMediaView {
    renderMedia(t) {
        const video = t.video({
            src: vm => vm.videoUrl || `data:${vm.mimeType},`,
            title: vm => vm.label,
            controls: true,
            preload: "none",
            poster: vm => vm.thumbnailUrl,
            onPlay: this._onPlay.bind(this),
            style: vm => `max-width: ${vm.width}px; max-height: ${vm.height}px;${vm.isPending ? "z-index: -1": ""}`
        });
        video.addEventListener("error", this._onError.bind(this));
        return video;
    }
    async _onPlay(evt) {
        const vm = this.value;
        if (!vm.videoUrl) {
            try {
                const video = evt.target;
                await vm.loadVideo();
                const loadPromise = domEventAsPromise(video, "loadeddata");
                video.load();
                await loadPromise;
                video.play();
            } catch (err) {}
        }
    }
    _onError(evt) {
        const vm = this.value;
        const video = evt.target;
        const err = video.error;
        if (err instanceof window.MediaError && err.code === 4) {
            if (!video.src.startsWith("data:")) {
                vm.setViewError(new Error(`this browser does not support videos of type ${vm.mimeType}.`));
            } else {
                return;
            }
        } else {
            vm.setViewError(err);
        }
    }
}

class FileView extends BaseMessageView {
    renderMessageBody(t, vm) {
        const children = [];
        if (vm.isPending) {
            children.push(vm => vm.label);
        } else {
            children.push(
                t.button({className: "link", onClick: () => vm.download()}, vm => vm.label),
                t.time(vm.date + " " + vm.time)
            );
        }
        return t.p({className: "Timeline_messageBody statusMessage"}, children);
    }
}

class MissingAttachmentView extends BaseMessageView {
    renderMessageBody(t, vm) {
        return t.p({className: "Timeline_messageBody statusMessage"}, vm.label);
    }
}

class AnnouncementView extends TemplateView {
    render(t) {
        return t.li({className: "AnnouncementView"}, t.div(vm => vm.announcement));
    }
    onClick() {}
}

class RedactedView extends BaseMessageView {
    renderMessageBody(t) {
        return t.p({className: "Timeline_messageBody statusMessage"}, vm => vm.description);
    }
    createMenuOptions(vm) {
        const options = super.createMenuOptions(vm);
        if (vm.isRedacting) {
            options.push(Menu.option(vm.i18n`Cancel`, () => vm.abortPendingRedaction()));
        }
        return options;
    }
}

function viewClassForEntry(entry) {
    switch (entry.shape) {
        case "gap": return GapView;
        case "announcement": return AnnouncementView;
        case "message":
        case "message-status":
            return TextMessageView;
        case "image": return ImageView;
        case "video": return VideoView;
        case "file": return FileView;
        case "missing-attachment": return MissingAttachmentView;
        case "redacted":
            return RedactedView;
    }
}
class TimelineList extends ListView {
    constructor(viewModel) {
        const options = {
            className: "Timeline bottom-aligned-scroll",
            list: viewModel.tiles,
            onItemClick: (tileView, evt) => tileView.onClick(evt),
        };
        super(options, entry => {
            const View = viewClassForEntry(entry);
            if (View) {
                return new View(entry);
            }
        });
        this._atBottom = false;
        this._onScroll = this._onScroll.bind(this);
        this._topLoadingPromise = null;
        this._viewModel = viewModel;
    }
    async _loadAtTopWhile(predicate) {
        if (this._topLoadingPromise) {
            return;
        }
        try {
            while (predicate()) {
                this._topLoadingPromise = this._viewModel.loadAtTop();
                const shouldStop = await this._topLoadingPromise;
                if (shouldStop) {
                    break;
                }
            }
        }
        catch (err) {
            console.error(err);
        }
        finally {
            this._topLoadingPromise = null;
        }
    }
    async _onScroll() {
        const PAGINATE_OFFSET = 100;
        const root = this.root();
        if (root.scrollTop < PAGINATE_OFFSET && !this._topLoadingPromise && this._viewModel) {
            let beforeContentHeight = root.scrollHeight;
            let lastContentHeight = beforeContentHeight;
            this._loadAtTopWhile(() => {
                const contentHeight = root.scrollHeight;
                const amountGrown = contentHeight - beforeContentHeight;
                root.scrollTop = root.scrollTop + (contentHeight - lastContentHeight);
                lastContentHeight = contentHeight;
                return amountGrown < PAGINATE_OFFSET;
            });
        }
    }
    mount() {
        const root = super.mount();
        root.addEventListener("scroll", this._onScroll);
        return root;
    }
    unmount() {
        this.root().removeEventListener("scroll", this._onScroll);
        super.unmount();
    }
    async loadList() {
        super.loadList();
        const root = this.root();
        await Promise.resolve();
        const {scrollHeight, clientHeight} = root;
        if (scrollHeight > clientHeight) {
            root.scrollTop = root.scrollHeight;
        }
        this._loadAtTopWhile(() => {
            const {scrollHeight, clientHeight} = root;
            return scrollHeight <= clientHeight;
        });
    }
    onBeforeListChanged() {
        const fromBottom = this._distanceFromBottom();
        this._atBottom = fromBottom < 1;
    }
    _distanceFromBottom() {
        const root = this.root();
        return root.scrollHeight - root.scrollTop - root.clientHeight;
    }
    onListChanged() {
        const root = this.root();
        if (this._atBottom) {
            root.scrollTop = root.scrollHeight;
        }
    }
    onUpdate(index, value, param) {
        if (param === "shape") {
            if (this._childInstances) {
                const ExpectedClass = viewClassForEntry(value);
                const child = this._childInstances[index];
                if (!ExpectedClass || !(child instanceof ExpectedClass)) {
                    super.recreateItem(index, value);
                    return;
                }
            }
        }
        super.onUpdate(index, value, param);
    }
}

class TimelineLoadingView extends TemplateView {
    render(t, vm) {
        return t.div({className: "TimelineLoadingView"}, [
            spinner(t),
            t.div(vm.isEncrypted ? vm.i18n`Loading encrypted messages…` : vm.i18n`Loading messages…`)
        ]);
    }
}

class MessageComposer extends TemplateView {
    constructor(viewModel) {
        super(viewModel);
        this._input = null;
        this._attachmentPopup = null;
    }
    render(t, vm) {
        this._input = t.input({
            placeholder: vm.isEncrypted ? "Send an encrypted message…" : "Send a message…",
            enterkeyhint: 'send',
            onKeydown: e => this._onKeyDown(e),
            onInput: () => vm.setInput(this._input.value),
        });
        return t.div({className: "MessageComposer"}, [
            this._input,
            t.button({
                className: "sendFile",
                title: vm.i18n`Pick attachment`,
                onClick: evt => this._toggleAttachmentMenu(evt),
            }, vm.i18n`Send file`),
            t.button({
                className: "send",
                title: vm.i18n`Send`,
                disabled: vm => !vm.canSend,
                onClick: () => this._trySend(),
            }, vm.i18n`Send`),
        ]);
    }
    _trySend() {
        this._input.focus();
        if (this.value.sendMessage(this._input.value)) {
            this._input.value = "";
        }
    }
    _onKeyDown(event) {
        if (event.key === "Enter") {
            this._trySend();
        }
    }
    _toggleAttachmentMenu(evt) {
        if (this._attachmentPopup && this._attachmentPopup.isOpen) {
            this._attachmentPopup.close();
        } else {
            const vm = this.value;
            this._attachmentPopup = new Popup(new Menu([
                Menu.option(vm.i18n`Send video`, () => vm.sendVideo()).setIcon("video"),
                Menu.option(vm.i18n`Send picture`, () => vm.sendPicture()).setIcon("picture"),
                Menu.option(vm.i18n`Send file`, () => vm.sendFile()).setIcon("file"),
            ]));
            this._attachmentPopup.trackInTemplateView(this);
            this._attachmentPopup.showRelativeTo(evt.target, {
                horizontal: {
                    relativeTo: "end",
                    align: "start",
                    after: 0
                },
                vertical: {
                    relativeTo: "end",
                    align: "start",
                    before: 8,
                }
            });
        }
    }
}

class RoomArchivedView extends TemplateView {
    render(t, vm) {
        return t.div({className: "RoomArchivedView"}, t.h3(vm => vm.description));
    }
}

class RoomView extends TemplateView {
    constructor(options) {
        super(options);
        this._optionsPopup = null;
    }
    render(t, vm) {
        let bottomView;
        if (vm.composerViewModel.kind === "composer") {
            bottomView = new MessageComposer(vm.composerViewModel);
        } else if (vm.composerViewModel.kind === "archived") {
            bottomView = new RoomArchivedView(vm.composerViewModel);
        }
        return t.main({className: "RoomView middle"}, [
            t.div({className: "RoomHeader middle-header"}, [
                t.a({className: "button-utility close-middle", href: vm.closeUrl, title: vm.i18n`Close room`}),
                t.view(new AvatarView(vm, 32)),
                t.div({className: "room-description"}, [
                    t.h2(vm => vm.name),
                ]),
                t.button({
                    className: "button-utility room-options",
                    "aria-label":vm.i18n`Room options`,
                    onClick: evt => this._toggleOptionsMenu(evt)
                })
            ]),
            t.div({className: "RoomView_body"}, [
                t.div({className: "RoomView_error"}, vm => vm.error),
                t.mapView(vm => vm.timelineViewModel, timelineViewModel => {
                    return timelineViewModel ?
                        new TimelineList(timelineViewModel) :
                        new TimelineLoadingView(vm);
                }),
                t.view(bottomView),
            ])
        ]);
    }
    _toggleOptionsMenu(evt) {
        if (this._optionsPopup && this._optionsPopup.isOpen) {
            this._optionsPopup.close();
        } else {
            const vm = this.value;
            const options = [];
            options.push(Menu.option(vm.i18n`Room details`, () => vm.openDetailsPanel()));
            if (vm.canLeave) {
                options.push(Menu.option(vm.i18n`Leave room`, () => vm.leaveRoom()).setDestructive());
            }
            if (vm.canForget) {
                options.push(Menu.option(vm.i18n`Forget room`, () => vm.forgetRoom()).setDestructive());
            }
            if (vm.canRejoin) {
                options.push(Menu.option(vm.i18n`Rejoin room`, () => vm.rejoinRoom()));
            }
            if (!options.length) {
                return;
            }
            this._optionsPopup = new Popup(new Menu(options));
            this._optionsPopup.trackInTemplateView(this);
            this._optionsPopup.showRelativeTo(evt.target, {
                horizontal: {
                    relativeTo: "end",
                    align: "start",
                    after: 0
                },
                vertical: {
                    relativeTo: "start",
                    align: "end",
                    before: -32 - 4
                }
            });
        }
    }
}

class UnknownRoomView extends TemplateView {
    render(t, vm) {
        return t.main({className: "UnknownRoomView middle"}, t.div([
            t.h2([
                vm.i18n`You are currently not in ${vm.roomIdOrAlias}.`,
                t.br(),
                vm.i18n`Want to join it?`
            ]),
            t.button({
                className: "button-action primary",
                onClick: () => vm.join(),
                disabled: vm => vm.busy,
            }, vm.i18n`Join room`),
            t.if(vm => vm.error, t => t.p({className: "error"}, vm.error))
        ]));
    }
}

class InviteView extends TemplateView {
    render(t, vm) {
        let inviteNodes = [];
        if (vm.isDirectMessage) {
            inviteNodes.push(renderStaticAvatar(vm, 128, "InviteView_dmAvatar"));
        }
        let inviterNodes;
        if (vm.isDirectMessage) {
            inviterNodes = [t.strong(vm.name), ` (${vm.inviter?.id}) wants to chat with you.`];
        } else if (vm.inviter) {
            inviterNodes = [renderStaticAvatar(vm.inviter, 24), t.strong(vm.inviter.name), ` (${vm.inviter.id}) invited you.`];
        } else {
            inviterNodes = `You were invited to join.`;
        }
        inviteNodes.push(t.p({className: "InviteView_inviter"}, inviterNodes));
        if (!vm.isDirectMessage) {
            inviteNodes.push(t.div({className: "InviteView_roomProfile"}, [
                renderStaticAvatar(vm, 64, "InviteView_roomAvatar"),
                t.h3(vm.name),
                t.p({className: "InviteView_roomDescription"}, vm.roomDescription)
            ]));
        }
        return t.main({className: "InviteView middle"}, [
            t.div({className: "RoomHeader middle-header"}, [
                t.a({className: "button-utility close-middle", href: vm.closeUrl, title: vm.i18n`Close invite`}),
                renderStaticAvatar(vm, 32),
                t.div({className: "room-description"}, [
                    t.h2(vm => vm.name),
                ]),
            ]),
            t.if(vm => vm.error, t => t.div({className: "RoomView_error"}, vm => vm.error)),
            t.div({className: "InviteView_body"}, [
                t.div({className: "InviteView_invite"}, [
                    ...inviteNodes,
                    t.div({className: "InviteView_buttonRow"},
                        t.button({
                            className: "button-action primary",
                            disabled: vm => vm.busy,
                            onClick: () => vm.accept()
                        }, vm.i18n`Accept`)
                    ),
                    t.div({className: "InviteView_buttonRow"},
                        t.button({
                            className: "button-action primary destructive",
                            disabled: vm => vm.busy,
                            onClick: () => vm.reject()
                        }, vm.i18n`Reject`)
                    ),
                ])
            ])
        ]);
    }
}

class LightboxView extends TemplateView {
    render(t, vm) {
        const close = t.a({href: vm.closeUrl, title: vm.i18n`Close`, className: "close"});
        const image = t.div({
            role: "img",
            "aria-label": vm => vm.name,
            title: vm => vm.name,
            className: {
                picture: true,
                hidden: vm => !vm.imageUrl,
            },
            style: vm => `background-image: url('${vm.imageUrl}'); max-width: ${vm.imageWidth}px; max-height: ${vm.imageHeight}px;`
        });
        const loading = t.div({
            className: {
                loading: true,
                hidden: vm => !!vm.imageUrl
            }
        }, [
            spinner(t),
            t.div(vm.i18n`Loading image…`)
        ]);
        const details = t.div({
            className: "details"
        }, [t.strong(vm => vm.name), t.br(), "uploaded by ", t.strong(vm => vm.sender), vm => ` at ${vm.time} on ${vm.date}.`]);
        const dialog = t.div({
            role: "dialog",
            className: "lightbox",
            onClick: evt => this.clickToClose(evt),
            onKeydown: evt => this.closeOnEscKey(evt)
        }, [image, loading, details, close]);
        trapFocus(t, dialog);
        return dialog;
    }
    clickToClose(evt) {
        if (evt.target === this.root()) {
            this.value.close();
        }
    }
    closeOnEscKey(evt) {
        if (evt.key === "Escape" || evt.key === "Esc") {
            this.value.close();
        }
    }
}
function trapFocus(t, element) {
    const elements = focusables(element);
    const first = elements[0];
    const last = elements[elements.length - 1];
    t.addEventListener(element, "keydown", evt => {
        if (evt.key === "Tab") {
            if (evt.shiftKey) {
                if (document.activeElement === first) {
                    last.focus();
                    evt.preventDefault();
                }
            } else {
                if (document.activeElement === last) {
                    first.focus();
                    evt.preventDefault();
                }
            }
        }
    }, true);
    Promise.resolve().then(() => {
        first.focus();
    });
}
function focusables(element) {
    return element.querySelectorAll('a[href], button, textarea, input, select');
}

class SessionStatusView extends TemplateView {
    render(t, vm) {
        return t.div({className: {
            "SessionStatusView": true,
            "hidden": vm => !vm.isShown,
        }}, [
            spinner(t, {hidden: vm => !vm.isWaiting}),
            t.p(vm => vm.statusLabel),
            t.if(vm => vm.isConnectNowShown, t => t.button({className: "link", onClick: () => vm.connectNow()}, "Retry now")),
            t.if(vm => vm.isSecretStorageShown, t => t.a({href: vm.setupSessionBackupUrl}, "Go to settings")),
            t.if(vm => vm.canDismiss, t => t.div({className: "end"}, t.button({className: "dismiss", onClick: () => vm.dismiss()}))),
        ]);
    }
}

class RoomGridView extends TemplateView {
    render(t, vm) {
        const children = [];
        for (let i = 0; i < (vm.height * vm.width); i+=1) {
            children.push(t.div({
                onClick: () => vm.focusTile(i),
                onFocusin: () => vm.focusTile(i),
                className: {
                    "container": true,
                    [`tile${i}`]: true,
                    "focused": vm => vm.focusIndex === i
                },
            }, t.mapView(vm => vm.roomViewModelAt(i), roomVM => {
                if (roomVM) {
                    if (roomVM.kind === "invite") {
                        return new InviteView(roomVM);
                    } else {
                        return new RoomView(roomVM);
                    }
                } else {
                    return new StaticView(t => t.div({className: "room-placeholder"}, [
                        t.h2({className: "focused"}, vm.i18n`Select a room on the left`),
                        t.h2({className: "unfocused"}, vm.i18n`Click to select this tile`),
                    ]));
                }
            })));
        }
        children.push(t.div({className: vm => `focus-ring tile${vm.focusIndex}`}));
        return t.div({className: "RoomGridView middle layout3x2"}, children);
    }
}

class SessionBackupSettingsView extends TemplateView {
    render(t, vm) {
        return t.mapView(vm => vm.status, status => {
            switch (status) {
                case "enabled": return new TemplateView(vm, renderEnabled)
                case "setupKey": return new TemplateView(vm, renderEnableFromKey)
                case "setupPhrase": return new TemplateView(vm, renderEnableFromPhrase)
                case "pending": return new StaticView(vm, t => t.p(vm.i18n`Waiting to go online…`))
            }
        });
    }
}
function renderEnabled(t, vm) {
    return t.p(vm.i18n`Session backup is enabled, using backup version ${vm.backupVersion}.`);
}
function renderEnableFromKey(t, vm) {
    const useASecurityPhrase = t.button({className: "link", onClick: () => vm.showPhraseSetup()}, vm.i18n`use a security phrase`);
    return t.div([
        t.p(vm.i18n`Enter your secret storage security key below to set up session backup, which will enable you to decrypt messages received before you logged into this session. The security key is a code of 12 groups of 4 characters separated by a space that Element created for you when setting up security.`),
        t.p([vm.i18n`Alternatively, you can `, useASecurityPhrase, vm.i18n` if you have one.`]),
        renderError(t),
        renderEnableFieldRow(t, vm, vm.i18n`Security key`, key => vm.enterSecurityKey(key))
    ]);
}
function renderEnableFromPhrase(t, vm) {
    const useASecurityKey = t.button({className: "link", onClick: () => vm.showKeySetup()}, vm.i18n`use your security key`);
    return t.div([
        t.p(vm.i18n`Enter your secret storage security phrase below to set up session backup, which will enable you to decrypt messages received before you logged into this session. The security phrase is a freeform secret phrase you optionally chose when setting up security in Element. It is different from your password to login, unless you chose to set them to the same value.`),
        t.p([vm.i18n`You can also `, useASecurityKey, vm.i18n`.`]),
        renderError(t),
        renderEnableFieldRow(t, vm, vm.i18n`Security phrase`, phrase => vm.enterSecurityPhrase(phrase))
    ]);
}
function renderEnableFieldRow(t, vm, label, callback) {
    const eventHandler = () => callback(input.value);
    const input = t.input({type: "password", disabled: vm => vm.isBusy, placeholder: label, onChange: eventHandler});
    return t.div({className: `row`}, [
        t.div({className: "label"}, label),
        t.div({className: "content"}, [
            input,
            t.button({disabled: vm => vm.isBusy, onClick: eventHandler}, vm.i18n`Set up`),
        ]),
    ]);
}
function renderError(t) {
    return t.if(vm => vm.error, (t, vm) => {
        return t.div([
            t.p({className: "error"}, vm => vm.i18n`Could not enable session backup: ${vm.error}.`),
            t.p(vm.i18n`Try double checking that you did not mix up your security key, security phrase and login password as explained above.`)
        ])
    });
}

class SettingsView extends TemplateView {
    render(t, vm) {
        let version = vm.version;
        if (vm.showUpdateButton) {
            version = t.span([
                vm.version,
                t.button({onClick: () => vm.checkForUpdate()}, vm.i18n`Check for updates`)
            ]);
        }
        const row = (t, label, content, extraClass = "") => {
            return t.div({className: `row ${extraClass}`}, [
                t.div({className: "label"}, label),
                t.div({className: "content"}, content),
            ]);
        };
        const settingNodes = [];
        settingNodes.push(
            t.h3("Session"),
            row(t, vm.i18n`User ID`, vm.userId),
            row(t, vm.i18n`Session ID`, vm.deviceId, "code"),
            row(t, vm.i18n`Session key`, vm.fingerprintKey, "code")
        );
        settingNodes.push(
            t.h3("Session Backup"),
            t.view(new SessionBackupSettingsView(vm.sessionBackupViewModel))
        );
        settingNodes.push(
            t.h3("Notifications"),
            t.map(vm => vm.pushNotifications.supported, (supported, t) => {
                if (supported === null) {
                    return t.p(vm.i18n`Loading…`);
                } else if (supported) {
                    const label = vm => vm.pushNotifications.enabled ?
                        vm.i18n`Push notifications are enabled`:
                        vm.i18n`Push notifications are disabled`;
                    const buttonLabel = vm => vm.pushNotifications.enabled ?
                        vm.i18n`Disable`:
                        vm.i18n`Enable`;
                    return row(t, label, t.button({
                        onClick: () => vm.togglePushNotifications(),
                        disabled: vm => vm.pushNotifications.updating
                    }, buttonLabel));
                } else {
                    return t.p(vm.i18n`Push notifications are not supported on this browser`);
                }
            }),
            t.if(vm => vm.pushNotifications.supported && vm.pushNotifications.enabled, t => {
                return t.div([
                    t.p([
                        "If you think push notifications are not being delivered, ",
                        t.button({className: "link", onClick: () => vm.checkPushEnabledOnServer()}, "check"),
                        " if they got disabled on the server"
                    ]),
                    t.map(vm => vm.pushNotifications.enabledOnServer, (enabled, t) => {
                        if (enabled === true) {
                            return t.p("Push notifications are still enabled on the server, so everything should be working. Sometimes notifications can get dropped if they can't be delivered within a given time.");
                        } else if (enabled === false) {
                            return t.p("Push notifications have been disabled on the server, likely due to a bug. Please re-enable them by clicking Disable and then Enable again above.");
                        }
                    }),
                    t.map(vm => vm.pushNotifications.serverError, (err, t) => {
                        if (err) {
                            return t.p("Couln't not check on server: " + err.message);
                        }
                    })
                ]);
            })
        );
        settingNodes.push(
            t.h3("Preferences"),
            row(t, vm.i18n`Scale down images when sending`, this._imageCompressionRange(t, vm)),
        );
        settingNodes.push(
            t.h3("Application"),
            row(t, vm.i18n`Version`, version),
            row(t, vm.i18n`Storage usage`, vm => `${vm.storageUsage} / ${vm.storageQuota}`),
            row(t, vm.i18n`Debug logs`, t.button({onClick: () => vm.exportLogs()}, "Export")),
            t.p(["Debug logs contain application usage data including your username, the IDs or aliases of the rooms or groups you have visited, the usernames of other users and the names of files you send. They do not contain messages. For more information, review our ",
                t.a({href: "https://element.io/privacy", target: "_blank", rel: "noopener"}, "privacy policy"), "."]),
        );
        return t.main({className: "Settings middle"}, [
            t.div({className: "middle-header"}, [
                t.a({className: "button-utility close-middle", href: vm.closeUrl, title: vm.i18n`Close settings`}),
                t.h2("Settings")
            ]),
            t.div({className: "SettingsBody"}, settingNodes)
        ]);
    }
    _imageCompressionRange(t, vm) {
        const step = 32;
        const min = Math.ceil(vm.minSentImageSizeLimit / step) * step;
        const max = (Math.floor(vm.maxSentImageSizeLimit / step) + 1) * step;
        const updateSetting = evt => vm.setSentImageSizeLimit(parseInt(evt.target.value, 10));
        return [t.input({
            type: "range",
            step,
            min,
            max,
            value: vm => vm.sentImageSizeLimit || max,
            onInput: updateSetting,
            onChange: updateSetting,
        }), " ", t.output(vm => {
            return vm.sentImageSizeLimit ?
                vm.i18n`resize to ${vm.sentImageSizeLimit}px` :
                vm.i18n`no resizing`;
        })];
    }
}

class RoomDetailsView extends TemplateView {
    render(t, vm) {
        const encryptionString = () => vm.isEncrypted ? vm.i18n`On` : vm.i18n`Off`;
        return t.div({className: "RoomDetailsView"}, [
            this._createButton(t, vm),
            t.div({className: "RoomDetailsView_avatar"},
                [
                    t.view(new AvatarView(vm, 52)),
                    t.mapView(vm => vm.isEncrypted, isEncrypted => new EncryptionIconView(isEncrypted))
                ]),
            t.div({className: "RoomDetailsView_name"}, [t.h2(vm => vm.name)]),
            this._createRoomAliasDisplay(vm),
            t.div({className: "RoomDetailsView_rows"},
                [
                    this._createRightPanelRow(t, vm.i18n`People`, {MemberCount: true}, vm => vm.memberCount),
                    this._createRightPanelRow(t, vm.i18n`Encryption`, {EncryptionStatus: true}, encryptionString)
                ])
        ]);
    }
    _createRoomAliasDisplay(vm) {
        return vm.canonicalAlias ? tag.div({className: "RoomDetailsView_id"}, [vm.canonicalAlias]) :
            "";
    }
    _createRightPanelRow(t, label, labelClass, value) {
        const labelClassString = classNames({RoomDetailsView_label: true, ...labelClass});
        return t.div({className: "RoomDetailsView_row"}, [
            t.div({className: labelClassString}, [label]),
            t.div({className: "RoomDetailsView_value"}, value)
        ]);
    }
    _createButton(t, vm) {
        return t.div({className: "RoomDetailsView_buttons"},
            [
                t.button({className: "close button-utility", onClick: () => vm.closePanel()})
            ]);
    }
}
class EncryptionIconView extends TemplateView {
    render(t, isEncrypted) {
        return t.div({className: "EncryptionIconView"},
            [t.div({className: isEncrypted ? "EncryptionIconView_encrypted" : "EncryptionIconView_unencrypted"})]);
    }
}

class SessionView extends TemplateView {
    render(t, vm) {
        return t.div({
            className: {
                "SessionView": true,
                "middle-shown": vm => !!vm.activeMiddleViewModel,
                "right-shown": vm => !!vm.roomDetailsViewModel
            },
        }, [
            t.view(new SessionStatusView(vm.sessionStatusViewModel)),
            t.view(new LeftPanelView(vm.leftPanelViewModel)),
            t.mapView(vm => vm.activeMiddleViewModel, () => {
                if (vm.roomGridViewModel) {
                    return new RoomGridView(vm.roomGridViewModel);
                } else if (vm.settingsViewModel) {
                    return new SettingsView(vm.settingsViewModel);
                } else if (vm.currentRoomViewModel) {
                    if (vm.currentRoomViewModel.kind === "invite") {
                        return new InviteView(vm.currentRoomViewModel);
                    } else if (vm.currentRoomViewModel.kind === "room") {
                        return new RoomView(vm.currentRoomViewModel);
                    } else {
                        return new UnknownRoomView(vm.currentRoomViewModel);
                    }
                } else {
                    return new StaticView(t => t.div({className: "room-placeholder"}, t.h2(vm.i18n`Choose a room on the left side.`)));
                }
            }),
            t.mapView(vm => vm.roomDetailsViewModel, roomDetailsViewModel => roomDetailsViewModel ? new RoomDetailsView(roomDetailsViewModel) : null),
            t.mapView(vm => vm.lightboxViewModel, lightboxViewModel => lightboxViewModel ? new LightboxView(lightboxViewModel) : null)
        ]);
    }
}

function hydrogenGithubLink(t) {
    if (window.HYDROGEN_VERSION) {
        return t.a({target: "_blank",
            href: `https://speaklink.uk.to/onmobile/notice.html`},
            `Read important notice for Mobile`);
    } else {
        return t.a({target: "_blank", href: "https://speaklink.uk.to/onmobile/notice.html"},
            "Read important notice for Mobile");
    }
}

class SessionLoadStatusView extends TemplateView {
    render(t) {
        return t.div({className: "SessionLoadStatusView"}, [
            spinner(t, {hiddenWithLayout: vm => !vm.loading}),
            t.p(vm => vm.loadLabel)
        ]);
    }
}

class LoginView extends TemplateView {
    render(t, vm) {
        const disabled = vm => !!vm.isBusy;
        const username = t.input({
            id: "username",
            type: "text",
            placeholder: vm.i18n`Username`,
            disabled
        });
        const password = t.input({
            id: "password",
            type: "password",
            placeholder: vm.i18n`Password`,
            disabled
        });
        const homeserver = t.input({
            id: "homeserver",
            type: "text",
            placeholder: vm.i18n`Your matrix homeserver`,
            value: vm.defaultHomeServer,
            disabled
        });
        return t.div({className: "PreSessionScreen"}, [
            t.div({className: "logo"}),
            t.div({className: "LoginView form"}, [
                t.h1([vm.i18n`Sign In`]),
                t.if(vm => vm.error, t => t.div({className: "error"}, vm => vm.error)),
                t.form({
                    onSubmit: evnt => {
                        evnt.preventDefault();
                        vm.login(username.value, password.value, homeserver.value);
                    }
                }, [
                    t.div({className: "form-row"}, [t.label({for: "username"}, vm.i18n`Username`), username]),
                    t.div({className: "form-row"}, [t.label({for: "password"}, vm.i18n`Password`), password]),
                    t.div({className: "form-row"}, [t.label({for: "homeserver"}, vm.i18n`Homeserver`), homeserver]),
                    t.mapView(vm => vm.loadViewModel, loadViewModel => loadViewModel ? new SessionLoadStatusView(loadViewModel) : null),
                    t.div({className: "button-row"}, [
                        t.a({
                            className: "button-action secondary",
                            href: vm.cancelUrl
                        }, [vm.i18n`Go Back`]),
                        t.button({
                            className: "button-action primary",
                            type: "submit"
                        }, vm.i18n`Log In`),
                    ]),
                ]),
                t.p(hydrogenGithubLink(t))
            ])
        ]);
    }
}

class SessionLoadView extends TemplateView {
    render(t, vm) {
        return t.div({className: "PreSessionScreen"}, [
            t.div({className: "logo"}),
            t.div({className: "SessionLoadView"}, [
                t.view(new SessionLoadStatusView(vm))
            ]),
            t.div({className: {"button-row": true, hidden: vm => vm.loading}},
                t.a({className: "button-action primary", href: vm.backUrl}, vm.i18n`Go back`))
        ]);
    }
}

function selectFileAsText(mimeType) {
    const input = document.createElement("input");
    input.setAttribute("type", "file");
    if (mimeType) {
        input.setAttribute("accept", mimeType);
    }
    const promise = new Promise((resolve, reject) => {
        const checkFile = () => {
            input.removeEventListener("change", checkFile, true);
            const file = input.files[0];
            if (file) {
                resolve(file.text());
            } else {
                reject(new Error("No file selected"));
            }
        };
        input.addEventListener("change", checkFile, true);
    });
    input.click();
    return promise;
}
class SessionPickerItemView extends TemplateView {
    _onDeleteClick() {
        if (confirm("Are you sure?")) {
            this.value.delete();
        }
    }
    _onClearClick() {
        if (confirm("Are you sure?")) {
            this.value.clear();
        }
    }
    render(t, vm) {
        const deleteButton = t.button({
            className: "destructive",
            disabled: vm => vm.isDeleting,
            onClick: this._onDeleteClick.bind(this),
        }, "Sign Out");
        const clearButton = t.button({
            disabled: vm => vm.isClearing,
            onClick: this._onClearClick.bind(this),
        }, "Clear");
        const exportButton = t.button({
            disabled: vm => vm.isClearing,
            onClick: () => vm.export(),
        }, "Export");
        const downloadExport = t.if(vm => vm.exportDataUrl, (t, vm) => {
            return t.a({
                href: vm.exportDataUrl,
                download: `brawl-session-${vm.id}.json`,
                onClick: () => setTimeout(() => vm.clearExport(), 100),
            }, "Download");
        });
        const errorMessage = t.if(vm => vm.error, t => t.p({className: "error"}, vm => vm.error));
        return t.li([
            t.a({className: "session-info", href: vm.openUrl}, [
                t.div({className: `avatar usercolor${vm.avatarColorNumber}`}, vm => vm.avatarInitials),
                t.div({className: "user-id"}, vm => vm.label),
            ]),
            t.div({className: "session-actions"}, [
                deleteButton,
                exportButton,
                downloadExport,
                clearButton,
            ]),
            errorMessage
        ]);
    }
}
class SessionPickerView extends TemplateView {
    render(t, vm) {
        const sessionList = new ListView({
            list: vm.sessions,
            parentProvidesUpdates: false,
        }, sessionInfo => {
            return new SessionPickerItemView(sessionInfo);
        });
        return t.div({className: "PreSessionScreen"}, [
            t.div({className: "logo"}),
            t.div({className: "SessionPickerView"}, [
                t.h1(["Speaklink Mobile"]),
                t.view(sessionList),
                t.div({className: "button-row"}, [
                    t.button({
                        className: "button-action secondary",
                        onClick: async () => vm.import(await selectFileAsText("application/json"))
                    }, vm.i18n`Import a session`),
                    t.a({
                        className: "button-action primary",
                        href: vm.cancelUrl
                    }, vm.i18n`Sign In`)
                ]),
                t.ifView(vm => vm.loadViewModel, () => new SessionLoadStatusView(vm.loadViewModel)),
                t.p(hydrogenGithubLink(t))
            ])
        ]);
    }
}

class RootView extends TemplateView {
    render(t, vm) {
        return t.mapView(vm => vm.activeSection, activeSection => {
            switch (activeSection) {
                case "error":
                    return new StaticView(t => {
                        return t.div({className: "StatusView"}, [
                            t.h1("Something went wrong"),
                            t.p(vm.errorText),
                        ])
                    });
                case "session":
                    return new SessionView(vm.sessionViewModel);
                case "login":
                    return new LoginView(vm.loginViewModel);
                case "picker":
                    return new SessionPickerView(vm.sessionPickerViewModel);
                case "redirecting":
                    return new StaticView(t => t.p("Redirecting..."));
                case "loading":
                    return new SessionLoadView(vm.sessionLoadViewModel);
                default:
                    throw new Error(`Unknown section: ${vm.activeSection}`);
            }
        });
    }
}

class Timeout {
    constructor(ms) {
        this._reject = null;
        this._handle = null;
        this._promise = new Promise((resolve, reject) => {
            this._reject = reject;
            this._handle = setTimeout(() => {
                this._reject = null;
                resolve();
            }, ms);
        });
    }
    elapsed() {
        return this._promise;
    }
    abort() {
        if (this._reject) {
            this._reject(new AbortError());
            clearTimeout(this._handle);
            this._handle = null;
            this._reject = null;
        }
    }
    dispose() {
        this.abort();
    }
}
class Interval {
    constructor(ms, callback) {
        this._handle = setInterval(callback, ms);
    }
    dispose() {
        if (this._handle) {
            clearInterval(this._handle);
            this._handle = null;
        }
    }
}
class TimeMeasure {
    constructor() {
        this._start = window.performance.now();
    }
    measure() {
        return window.performance.now() - this._start;
    }
}
class Clock {
    createMeasure() {
        return new TimeMeasure();
    }
    createTimeout(ms) {
        return new Timeout(ms);
    }
    createInterval(callback, ms) {
        return new Interval(ms, callback);
    }
    now() {
        return Date.now();
    }
}

class ServiceWorkerHandler {
    constructor() {
        this._waitingForReply = new Map();
        this._messageIdCounter = 0;
        this._navigation = null;
        this._registration = null;
        this._registrationPromise = null;
        this._currentController = null;
        this.haltRequests = false;
    }
    setNavigation(navigation) {
        this._navigation = navigation;
    }
    registerAndStart(path) {
        this._registrationPromise = (async () => {
            navigator.serviceWorker.addEventListener("message", this);
            navigator.serviceWorker.addEventListener("controllerchange", this);
            this._registration = await navigator.serviceWorker.register(path);
            await navigator.serviceWorker.ready;
            this._currentController = navigator.serviceWorker.controller;
            this._registration.addEventListener("updatefound", this);
            this._registrationPromise = null;
            if (this._registration.waiting && this._registration.active) {
                this._proposeUpdate();
            }
            console.log("Service Worker registered");
        })();
    }
    _onMessage(event) {
        const {data} = event;
        const replyTo = data.replyTo;
        if (replyTo) {
            const resolve = this._waitingForReply.get(replyTo);
            if (resolve) {
                this._waitingForReply.delete(replyTo);
                resolve(data.payload);
            }
        }
        if (data.type === "hasSessionOpen") {
            const hasOpen = this._navigation.observe("session").get() === data.payload.sessionId;
            event.source.postMessage({replyTo: data.id, payload: hasOpen});
        } else if (data.type === "hasRoomOpen") {
            const hasSessionOpen = this._navigation.observe("session").get() === data.payload.sessionId;
            const hasRoomOpen = this._navigation.observe("room").get() === data.payload.roomId;
            event.source.postMessage({replyTo: data.id, payload: hasSessionOpen && hasRoomOpen});
        } else if (data.type === "closeSession") {
            const {sessionId} = data.payload;
            this._closeSessionIfNeeded(sessionId).finally(() => {
                event.source.postMessage({replyTo: data.id});
            });
        } else if (data.type === "haltRequests") {
            this.haltRequests = true;
            event.source.postMessage({replyTo: data.id});
        } else if (data.type === "openRoom") {
            this._navigation.push("room", data.payload.roomId);
        }
    }
    _closeSessionIfNeeded(sessionId) {
        const currentSession = this._navigation?.path.get("session");
        if (sessionId && currentSession?.value === sessionId) {
            return new Promise(resolve => {
                const unsubscribe = this._navigation.pathObservable.subscribe(path => {
                    const session = path.get("session");
                    if (!session || session.value !== sessionId) {
                        unsubscribe();
                        resolve();
                    }
                });
                this._navigation.push("session");
            });
        } else {
            return Promise.resolve();
        }
    }
    async _proposeUpdate() {
        if (document.hidden) {
            return;
        }
        const version = await this._sendAndWaitForReply("version", null, this._registration.waiting);
        if (confirm(`Version ${version.version} (${version.buildHash}) is available. Reload to apply?`)) {
            await this._sendAndWaitForReply("haltRequests");
            this._send("skipWaiting", null, this._registration.waiting);
        }
    }
    handleEvent(event) {
        switch (event.type) {
            case "message":
                this._onMessage(event);
                break;
            case "updatefound":
                this._registration.installing.addEventListener("statechange", this);
                break;
            case "statechange": {
                if (event.target.state === "installed") {
                    this._proposeUpdate();
                    event.target.removeEventListener("statechange", this);
                }
                break;
            }
            case "controllerchange":
                if (!this._currentController) {
                    this._currentController = navigator.serviceWorker.controller;
                } else {
                    document.location.reload();
                }
                break;
        }
    }
    async _send(type, payload, worker = undefined) {
        if (this._registrationPromise) {
            await this._registrationPromise;
        }
        if (!worker) {
            worker = this._registration.active;
        }
        worker.postMessage({type, payload});
    }
    async _sendAndWaitForReply(type, payload, worker = undefined) {
        if (this._registrationPromise) {
            await this._registrationPromise;
        }
        if (!worker) {
            worker = this._registration.active;
        }
        this._messageIdCounter += 1;
        const id = this._messageIdCounter;
        const promise = new Promise(resolve => {
            this._waitingForReply.set(id, resolve);
        });
        worker.postMessage({type, id, payload});
        return await promise;
    }
    async checkForUpdate() {
        if (this._registrationPromise) {
            await this._registrationPromise;
        }
        this._registration.update();
    }
    get version() {
        return window.HYDROGEN_VERSION;
    }
    get buildHash() {
        return window.HYDROGEN_GLOBAL_HASH;
    }
    async preventConcurrentSessionAccess(sessionId) {
        return this._sendAndWaitForReply("closeSession", {sessionId});
    }
    async getRegistration() {
        if (this._registrationPromise) {
            await this._registrationPromise;
        }
        return this._registration;
    }
}

class NotificationService {
    constructor(serviceWorkerHandler, pushConfig) {
        this._serviceWorkerHandler = serviceWorkerHandler;
        this._pushConfig = pushConfig;
    }
    async enablePush(pusherFactory, defaultPayload) {
        const registration = await this._serviceWorkerHandler?.getRegistration();
        if (registration?.pushManager) {
            const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: this._pushConfig.applicationServerKey,
            });
            const subscriptionData = subscription.toJSON();
            const pushkey = subscriptionData.keys.p256dh;
            const data = {
                endpoint: subscriptionData.endpoint,
                auth: subscriptionData.keys.auth,
                events_only: true,
                default_payload: defaultPayload
            };
            return pusherFactory.httpPusher(
                this._pushConfig.gatewayUrl,
                this._pushConfig.appId,
                pushkey,
                data
            );
        }
    }
    async disablePush() {
        const registration = await this._serviceWorkerHandler?.getRegistration();
        if (registration?.pushManager) {
            const subscription = await registration.pushManager.getSubscription();
            if (subscription) {
                await subscription.unsubscribe();
            }
        }
    }
    async isPushEnabled() {
        const registration = await this._serviceWorkerHandler?.getRegistration();
        if (registration?.pushManager) {
            const subscription = await registration.pushManager.getSubscription();
            return !!subscription;
        }
        return false;
    }
    async supportsPush() {
        if (!this._pushConfig) {
            return false;
        }
        const registration = await this._serviceWorkerHandler?.getRegistration();
        return registration && "pushManager" in registration;
    }
    async enableNotifications() {
        if ("Notification" in window) {
            return (await Notification.requestPermission()) === "granted";
        }
        return false;
    }
    async supportsNotifications() {
        return "Notification" in window;
    }
    async areNotificationsEnabled() {
        if ("Notification" in window) {
            return Notification.permission === "granted";
        } else {
            return false;
        }
    }
    async showNotification(title, body = undefined) {
        if ("Notification" in window) {
            new Notification(title, {body});
            return;
        }
        const registration = await this._serviceWorkerHandler?.getRegistration();
        registration?.showNotification(title, {body});
    }
}

class History extends BaseObservableValue {
    handleEvent(event) {
        if (event.type === "hashchange") {
            this.emit(this.get());
            this._storeHash(this.get());
        }
    }
    get() {
        return document.location.hash;
    }
    replaceUrlSilently(url) {
        window.history.replaceState(null, null, url);
        this._storeHash(url);
    }
    pushUrlSilently(url) {
        window.history.pushState(null, null, url);
        this._storeHash(url);
    }
    pushUrl(url) {
        document.location.hash = url;
    }
    urlAsPath(url) {
        if (url.startsWith("#")) {
            return url.substr(1);
        } else {
            return url;
        }
    }
    pathAsUrl(path) {
        return `#${path}`;
    }
    onSubscribeFirst() {
        window.addEventListener('hashchange', this);
    }
    onUnsubscribeLast() {
        window.removeEventListener('hashchange', this);
    }
    _storeHash(hash) {
        window.localStorage?.setItem("hydrogen_last_url_hash", hash);
    }
    getLastUrl() {
        return window.localStorage?.getItem("hydrogen_last_url_hash");
    }
}

class OnlineStatus extends BaseObservableValue {
    constructor() {
        super();
        this._onOffline = this._onOffline.bind(this);
        this._onOnline = this._onOnline.bind(this);
    }
    _onOffline() {
        this.emit(false);
    }
    _onOnline() {
        this.emit(true);
    }
    get() {
        return navigator.onLine;
    }
    onSubscribeFirst() {
        window.addEventListener('offline', this._onOffline);
        window.addEventListener('online', this._onOnline);
    }
    onUnsubscribeLast() {
        window.removeEventListener('offline', this._onOffline);
        window.removeEventListener('online', this._onOnline);
    }
}

function subtleCryptoResult(promiseOrOp, method) {
    if (promiseOrOp instanceof Promise) {
        return promiseOrOp;
    } else {
        return new Promise((resolve, reject) => {
            promiseOrOp.oncomplete = e => resolve(e.target.result);
            promiseOrOp.onerror = () => reject(new Error("Crypto error on " + method));
        });
    }
}
class HMACCrypto {
    constructor(subtleCrypto) {
        this._subtleCrypto = subtleCrypto;
    }
    async verify(key, mac, data, hash) {
        const opts = {
            name: 'HMAC',
            hash: {name: hashName(hash)},
        };
        const hmacKey = await subtleCryptoResult(this._subtleCrypto.importKey(
            'raw',
            key,
            opts,
            false,
            ['verify'],
        ), "importKey");
        const isVerified = await subtleCryptoResult(this._subtleCrypto.verify(
            opts,
            hmacKey,
            mac,
            data,
        ), "verify");
        return isVerified;
    }
    async compute(key, data, hash) {
        const opts = {
            name: 'HMAC',
            hash: {name: hashName(hash)},
        };
        const hmacKey = await subtleCryptoResult(this._subtleCrypto.importKey(
            'raw',
            key,
            opts,
            false,
            ['sign'],
        ), "importKey");
        const buffer = await subtleCryptoResult(this._subtleCrypto.sign(
            opts,
            hmacKey,
            data,
        ), "sign");
        return new Uint8Array(buffer);
    }
}
class DeriveCrypto {
    constructor(subtleCrypto, crypto, cryptoExtras) {
        this._subtleCrypto = subtleCrypto;
        this._crypto = crypto;
        this._cryptoExtras = cryptoExtras;
    }
    async pbkdf2(password, iterations, salt, hash, length) {
        if (!this._subtleCrypto.deriveBits) {
            throw new Error("PBKDF2 is not supported");
        }
        const key = await subtleCryptoResult(this._subtleCrypto.importKey(
            'raw',
            password,
            {name: 'PBKDF2'},
            false,
            ['deriveBits'],
        ), "importKey");
        const keybits = await subtleCryptoResult(this._subtleCrypto.deriveBits(
            {
                name: 'PBKDF2',
                salt,
                iterations,
                hash: hashName(hash),
            },
            key,
            length,
        ), "deriveBits");
        return new Uint8Array(keybits);
    }
    async hkdf(key, salt, info, hash, length) {
        if (!this._subtleCrypto.deriveBits) {
            return this._cryptoExtras.hkdf(this._crypto, key, salt, info, hash, length);
        }
        const hkdfkey = await subtleCryptoResult(this._subtleCrypto.importKey(
            'raw',
            key,
            {name: "HKDF"},
            false,
            ["deriveBits"],
        ), "importKey");
        const keybits = await subtleCryptoResult(this._subtleCrypto.deriveBits({
                name: "HKDF",
                salt,
                info,
                hash: hashName(hash),
            },
            hkdfkey,
            length,
        ), "deriveBits");
        return new Uint8Array(keybits);
    }
}
class AESCrypto {
    constructor(subtleCrypto, crypto) {
        this._subtleCrypto = subtleCrypto;
        this._crypto = crypto;
    }
    async decryptCTR({key, jwkKey, iv, data, counterLength = 64}) {
        const opts = {
            name: "AES-CTR",
            counter: iv,
            length: counterLength,
        };
        let aesKey;
        try {
            const selectedKey = key || jwkKey;
            const format = jwkKey ? "jwk" : "raw";
            aesKey = await subtleCryptoResult(this._subtleCrypto.importKey(
                format,
                selectedKey,
                opts,
                false,
                ['decrypt'],
            ), "importKey");
        } catch (err) {
            throw new Error(`Could not import key for AES-CTR decryption: ${err.message}`);
        }
        try {
            const plaintext = await subtleCryptoResult(this._subtleCrypto.decrypt(
                opts,
                aesKey,
                data,
            ), "decrypt");
            return new Uint8Array(plaintext);
        } catch (err) {
            throw new Error(`Could not decrypt with AES-CTR: ${err.message}`);
        }
    }
    async encryptCTR({key, jwkKey, iv, data}) {
        const opts = {
            name: "AES-CTR",
            counter: iv,
            length: 64,
        };
        let aesKey;
        const selectedKey = key || jwkKey;
        const format = jwkKey ? "jwk" : "raw";
        try {
            aesKey = await subtleCryptoResult(this._subtleCrypto.importKey(
                format,
                selectedKey,
                opts,
                false,
                ['encrypt'],
            ), "importKey");
        } catch (err) {
            throw new Error(`Could not import key for AES-CTR encryption: ${err.message}`);
        }
        try {
            const ciphertext = await subtleCryptoResult(this._subtleCrypto.encrypt(
                opts,
                aesKey,
                data,
            ), "encrypt");
            return new Uint8Array(ciphertext);
        } catch (err) {
            throw new Error(`Could not encrypt with AES-CTR: ${err.message}`);
        }
    }
    async generateKey(format, length = 256) {
        const cryptoKey = await subtleCryptoResult(this._subtleCrypto.generateKey(
            {"name": "AES-CTR", length}, true, ["encrypt", "decrypt"]));
        return subtleCryptoResult(this._subtleCrypto.exportKey(format, cryptoKey));
    }
    async generateIV() {
        return generateIV(this._crypto);
    }
}
function generateIV(crypto) {
    const randomBytes = crypto.getRandomValues(new Uint8Array(8));
    const ivArray = new Uint8Array(16);
    for (let i = 0; i < randomBytes.length; i += 1) {
        ivArray[i] = randomBytes[i];
    }
    return ivArray;
}
function jwkKeyToRaw(jwkKey) {
    if (jwkKey.alg !== "A256CTR") {
        throw new Error(`Unknown algorithm: ${jwkKey.alg}`);
    }
    if (!jwkKey.key_ops.includes("decrypt")) {
        throw new Error(`decrypt missing from key_ops`);
    }
    if (jwkKey.kty !== "oct") {
        throw new Error(`Invalid key type, "oct" expected: ${jwkKey.kty}`);
    }
    const base64UrlKey = jwkKey.k;
    const base64Key = base64UrlKey.replace(/-/g, "+").replace(/_/g, "/");
    return base64Arraybuffer.decode(base64Key);
}
function encodeUnpaddedBase64(buffer) {
    const str = base64Arraybuffer.encode(buffer);
    const paddingIdx = str.indexOf("=");
    if (paddingIdx !== -1) {
        return str.substr(0, paddingIdx);
    } else {
        return str;
    }
}
function encodeUrlBase64(buffer) {
    const unpadded = encodeUnpaddedBase64(buffer);
    return unpadded.replace(/\+/g, "-").replace(/\//g, "_");
}
function rawKeyToJwk(key) {
    return {
        "alg": "A256CTR",
        "ext": true,
        "k": encodeUrlBase64(key),
        "key_ops": [
            "encrypt",
            "decrypt"
        ],
        "kty": "oct"
    };
}
class AESLegacyCrypto {
    constructor(aesjs, crypto) {
        this._aesjs = aesjs;
        this._crypto = crypto;
    }
    async decryptCTR({key, jwkKey, iv, data, counterLength = 64}) {
        if (counterLength !== 64) {
            throw new Error(`Unsupported counter length: ${counterLength}`);
        }
        if (jwkKey) {
            key = jwkKeyToRaw(jwkKey);
        }
        const aesjs = this._aesjs;
        var aesCtr = new aesjs.ModeOfOperation.ctr(new Uint8Array(key), new aesjs.Counter(new Uint8Array(iv)));
        return aesCtr.decrypt(new Uint8Array(data));
    }
    async encryptCTR({key, jwkKey, iv, data}) {
        if (jwkKey) {
            key = jwkKeyToRaw(jwkKey);
        }
        const aesjs = this._aesjs;
        var aesCtr = new aesjs.ModeOfOperation.ctr(new Uint8Array(key), new aesjs.Counter(new Uint8Array(iv)));
        return aesCtr.encrypt(new Uint8Array(data));
    }
    async generateKey(format, length = 256) {
        let key = crypto.getRandomValues(new Uint8Array(length / 8));
        if (format === "jwk") {
            key = rawKeyToJwk(key);
        }
        return key;
    }
    async generateIV() {
        return generateIV(this._crypto);
    }
}
function hashName(name) {
    if (name !== "SHA-256" && name !== "SHA-512") {
        throw new Error(`Invalid hash name: ${name}`);
    }
    return name;
}
class Crypto {
    constructor(cryptoExtras) {
        const crypto = window.crypto || window.msCrypto;
        const subtleCrypto = crypto.subtle || crypto.webkitSubtle;
        this._subtleCrypto = subtleCrypto;
        if (!subtleCrypto.deriveBits && cryptoExtras?.aesjs) {
            this.aes = new AESLegacyCrypto(cryptoExtras.aesjs, crypto);
        } else {
            this.aes = new AESCrypto(subtleCrypto, crypto);
        }
        this.hmac = new HMACCrypto(subtleCrypto);
        this.derive = new DeriveCrypto(subtleCrypto, this, cryptoExtras);
    }
    async digest(hash, data) {
        return await subtleCryptoResult(this._subtleCrypto.digest(hashName(hash), data));
    }
    digestSize(hash) {
        switch (hashName(hash)) {
            case "SHA-512": return 64;
            case "SHA-256": return 32;
            default: throw new Error(`Not implemented for ${hashName(hash)}`);
        }
    }
}

async function estimateStorageUsage() {
    if (navigator?.storage?.estimate) {
        const {quota, usage} = await navigator.storage.estimate();
        return {quota, usage};
    } else {
        return {quota: null, usage: null};
    }
}

class WorkerState {
    constructor(worker) {
        this.worker = worker;
        this.busy = false;
    }
    attach(pool) {
        this.worker.addEventListener("message", pool);
        this.worker.addEventListener("error", pool);
    }
    detach(pool) {
        this.worker.removeEventListener("message", pool);
        this.worker.removeEventListener("error", pool);
    }
}
class Request {
    constructor(message, pool) {
        this._promise = new Promise((_resolve, _reject) => {
            this._resolve = _resolve;
            this._reject = _reject;
        });
        this._message = message;
        this._pool = pool;
        this._worker = null;
    }
    abort() {
        if (this._isNotDisposed) {
            this._pool._abortRequest(this);
            this._dispose();
        }
    }
    response() {
        return this._promise;
    }
    _dispose() {
        this._reject = null;
        this._resolve = null;
    }
    get _isNotDisposed() {
        return this._resolve && this._reject;
    }
}
class WorkerPool {
    constructor(path, amount) {
        this._workers = [];
        for (let i = 0; i < amount ; ++i) {
            const worker = new WorkerState(new Worker(path));
            worker.attach(this);
            this._workers[i] = worker;
        }
        this._requests = new Map();
        this._counter = 0;
        this._pendingFlag = false;
        this._init = null;
    }
    init() {
        const promise = new Promise((resolve, reject) => {
            this._init = {resolve, reject};
        });
        this.sendAll({type: "ping"})
            .then(this._init.resolve, this._init.reject)
            .finally(() => {
                this._init = null;
            });
        return promise;
    }
    handleEvent(e) {
        if (e.type === "message") {
            const message = e.data;
            const request = this._requests.get(message.replyToId);
            if (request) {
                request._worker.busy = false;
                if (request._isNotDisposed) {
                    if (message.type === "success") {
                        request._resolve(message.payload);
                    } else if (message.type === "error") {
                        const err = new Error(message.message);
                        err.stack = message.stack;
                        request._reject(err);
                    }
                    request._dispose();
                }
                this._requests.delete(message.replyToId);
            }
            this._sendPending();
        } else if (e.type === "error") {
            if (this._init) {
                this._init.reject(new Error("worker error during init"));
            }
            console.error("worker error", e);
        }
    }
    _getPendingRequest() {
        for (const r of this._requests.values()) {
            if (!r._worker) {
                return r;
            }
        }
    }
    _getFreeWorker() {
        for (const w of this._workers) {
            if (!w.busy) {
                return w;
            }
        }
    }
    _sendPending() {
        this._pendingFlag = false;
        let success;
        do {
            success = false;
            const request = this._getPendingRequest();
            if (request) {
                const worker = this._getFreeWorker();
                if (worker) {
                    this._sendWith(request, worker);
                    success = true;
                }
            }
        } while (success);
    }
    _sendWith(request, worker) {
        request._worker = worker;
        worker.busy = true;
        worker.worker.postMessage(request._message);
    }
    _enqueueRequest(message) {
        this._counter += 1;
        message.id = this._counter;
        const request = new Request(message, this);
        this._requests.set(message.id, request);
        return request;
    }
    send(message) {
        const request = this._enqueueRequest(message);
        const worker = this._getFreeWorker();
        if (worker) {
            this._sendWith(request, worker);
        }
        return request;
    }
    sendAll(message) {
        const promises = this._workers.map(worker => {
            const request = this._enqueueRequest(Object.assign({}, message));
            this._sendWith(request, worker);
            return request.response();
        });
        return Promise.all(promises);
    }
    dispose() {
        for (const w of this._workers) {
            w.detach(this);
            w.worker.terminate();
        }
    }
    _trySendPendingInNextTick() {
        if (!this._pendingFlag) {
            this._pendingFlag = true;
            Promise.resolve().then(() => {
                this._sendPending();
            });
        }
    }
    _abortRequest(request) {
        request._reject(new AbortError());
        if (request._worker) {
            request._worker.busy = false;
        }
        this._requests.delete(request._message.id);
        this._trySendPendingInNextTick();
    }
}

const ALLOWED_BLOB_MIMETYPES = {
    'image/jpeg': true,
    'image/gif': true,
    'image/png': true,
    'video/mp4': true,
    'video/webm': true,
    'video/ogg': true,
    'video/quicktime': true,
    'video/VP8': true,
    'audio/mp4': true,
    'audio/webm': true,
    'audio/aac': true,
    'audio/mpeg': true,
    'audio/ogg': true,
    'audio/wave': true,
    'audio/wav': true,
    'audio/x-wav': true,
    'audio/x-pn-wav': true,
    'audio/flac': true,
    'audio/x-flac': true,
};
const DEFAULT_MIMETYPE = 'application/octet-stream';
class BlobHandle {
    constructor(blob, buffer = null) {
        this._blob = blob;
        this._buffer = buffer;
        this._url = null;
    }
    static fromBuffer(buffer, mimetype) {
        mimetype = mimetype ? mimetype.split(";")[0].trim() : '';
        if (!ALLOWED_BLOB_MIMETYPES[mimetype]) {
            mimetype = DEFAULT_MIMETYPE;
        }
        return new BlobHandle(new Blob([buffer], {type: mimetype}), buffer);
    }
    static fromBlob(blob) {
        return new BlobHandle(blob);
    }
    get nativeBlob() {
        return this._blob;
    }
    async readAsBuffer() {
        if (this._buffer) {
            return this._buffer;
        } else {
            const reader = new FileReader();
            const promise = new Promise((resolve, reject) => {
                reader.addEventListener("load", evt => resolve(evt.target.result));
                reader.addEventListener("error", evt => reject(evt.target.error));
            });
            reader.readAsArrayBuffer(this._blob);
            return promise;
        }
    }
    get url() {
        if (!this._url) {
             this._url = URL.createObjectURL(this._blob);
        }
        return this._url;
    }
    get size() {
        return this._blob.size;
    }
    get mimeType() {
        return this._blob.type || DEFAULT_MIMETYPE;
    }
    dispose() {
        if (this._url) {
            URL.revokeObjectURL(this._url);
            this._url = null;
        }
    }
}

class ImageHandle {
    static async fromBlob(blob) {
        const img = await loadImgFromBlob(blob);
        const {width, height} = img;
        return new ImageHandle(blob, width, height, img);
    }
    constructor(blob, width, height, imgElement) {
        this.blob = blob;
        this.width = width;
        this.height = height;
        this._domElement = imgElement;
    }
    get maxDimension() {
        return Math.max(this.width, this.height);
    }
    async _getDomElement() {
        if (!this._domElement) {
            this._domElement = await loadImgFromBlob(this.blob);
        }
        return this._domElement;
    }
    async scale(maxDimension) {
        const aspectRatio = this.width / this.height;
        const scaleFactor = Math.min(1, maxDimension / (aspectRatio >= 1 ? this.width : this.height));
        const scaledWidth = Math.round(this.width * scaleFactor);
        const scaledHeight = Math.round(this.height * scaleFactor);
        const canvas = document.createElement("canvas");
        canvas.width = scaledWidth;
        canvas.height = scaledHeight;
        const ctx = canvas.getContext("2d");
        const drawableElement = await this._getDomElement();
        ctx.drawImage(drawableElement, 0, 0, scaledWidth, scaledHeight);
        let mimeType = this.blob.mimeType === "image/jpeg" ? "image/jpeg" : "image/png";
        let nativeBlob;
        if (canvas.toBlob) {
            nativeBlob = await new Promise(resolve => canvas.toBlob(resolve, mimeType));
        } else if (canvas.msToBlob) {
            mimeType = "image/png";
            nativeBlob = canvas.msToBlob();
        } else {
            throw new Error("canvas can't be turned into blob");
        }
        const blob = BlobHandle.fromBlob(nativeBlob);
        return new ImageHandle(blob, scaledWidth, scaledHeight, null);
    }
    dispose() {
        this.blob.dispose();
    }
}
class VideoHandle extends ImageHandle {
    get duration() {
        if (typeof this._domElement.duration === "number") {
            return Math.round(this._domElement.duration * 1000);
        }
        return undefined;
    }
    static async fromBlob(blob) {
        const video = await loadVideoFromBlob(blob);
        const {videoWidth, videoHeight} = video;
        return new VideoHandle(blob, videoWidth, videoHeight, video);
    }
}
function hasReadPixelPermission() {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    const rgb = [
        Math.round(Math.random() * 255),
        Math.round(Math.random() * 255),
        Math.round(Math.random() * 255),
    ];
    ctx.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    ctx.fillRect(0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    return data[0] === rgb[0] && data[1] === rgb[1] && data[2] === rgb[2];
}
async function loadImgFromBlob(blob) {
    const img = document.createElement("img");
    const loadPromise = domEventAsPromise(img, "load");
    img.src = blob.url;
    await loadPromise;
    return img;
}
async function loadVideoFromBlob(blob) {
    const video = document.createElement("video");
    video.muted = true;
    const loadPromise = domEventAsPromise(video, "loadedmetadata");
    video.src = blob.url;
    video.load();
    await loadPromise;
    const seekPromise = domEventAsPromise(video, "seeked");
    await new Promise(r => setTimeout(r, 200));
    video.currentTime = 0.1;
    await seekPromise;
    return video;
}

async function downloadInIframe(container, iframeSrc, blobHandle, filename, isIOS) {
    let iframe = container.querySelector("iframe.downloadSandbox");
    if (!iframe) {
        iframe = document.createElement("iframe");
        iframe.setAttribute("sandbox", "allow-scripts allow-downloads allow-downloads-without-user-activation");
        iframe.setAttribute("src", iframeSrc);
        iframe.className = "hidden downloadSandbox";
        container.appendChild(iframe);
        let detach;
        await new Promise((resolve, reject) => {
            detach = () => {
                iframe.removeEventListener("load", resolve);
                iframe.removeEventListener("error", reject);
            };
            iframe.addEventListener("load", resolve);
            iframe.addEventListener("error", reject);
        });
        detach();
    }
    if (isIOS) {
        const buffer = await blobHandle.readAsBuffer();
        iframe.contentWindow.postMessage({
            type: "downloadBuffer",
            buffer,
            mimeType: blobHandle.mimeType,
            filename: filename
        }, "*");
    } else {
        iframe.contentWindow.postMessage({
            type: "downloadBlob",
            blob: blobHandle.nativeBlob,
            filename: filename
        }, "*");
    }
}

function disposeValue(value) {
    if (typeof value === "function") {
        value();
    } else {
        value.dispose();
    }
}
function isDisposable(value) {
    return value && (typeof value === "function" || typeof value.dispose === "function");
}
class Disposables {
    constructor() {
        this._disposables = [];
    }
    track(disposable) {
        if (!isDisposable(disposable)) {
            throw new Error("Not a disposable");
        }
        if (this.isDisposed) {
            console.warn("Disposables already disposed, disposing new value");
            disposeValue(disposable);
            return disposable;
        }
        this._disposables.push(disposable);
        return disposable;
    }
    untrack(disposable) {
        const idx = this._disposables.indexOf(disposable);
        if (idx >= 0) {
            this._disposables.splice(idx, 1);
        }
        return null;
    }
    dispose() {
        if (this._disposables) {
            for (const d of this._disposables) {
                disposeValue(d);
            }
            this._disposables = null;
        }
    }
    get isDisposed() {
        return this._disposables === null;
    }
    disposeTracked(value) {
        if (value === undefined || value === null || this.isDisposed) {
            return null;
        }
        const idx = this._disposables.indexOf(value);
        if (idx !== -1) {
            const [foundValue] = this._disposables.splice(idx, 1);
            disposeValue(foundValue);
        } else {
            console.warn("disposable not found, did it leak?", value);
        }
        return null;
    }
}

function addScript(src) {
    return new Promise(function (resolve, reject) {
        var s = document.createElement("script");
        s.setAttribute("src", src );
        s.onload=resolve;
        s.onerror=reject;
        document.body.appendChild(s);
    });
}
async function loadOlm(olmPaths) {
    if (window.msCrypto && !window.crypto) {
        window.crypto = window.msCrypto;
    }
    if (olmPaths) {
        if (window.WebAssembly) {
            await addScript(olmPaths.wasmBundle);
            await window.Olm.init({locateFile: () => olmPaths.wasm});
        } else {
            await addScript(olmPaths.legacyBundle);
            await window.Olm.init();
        }
        return window.Olm;
    }
    return null;
}
function relPath(path, basePath) {
    const idx = basePath.lastIndexOf("/");
    const dir = idx === -1 ? "" : basePath.slice(0, idx);
    const dirCount = dir.length ? dir.split("/").length : 0;
    return "../".repeat(dirCount) + path;
}
async function loadOlmWorker(config) {
    const workerPool = new WorkerPool(config.worker, 4);
    await workerPool.init();
    const path = relPath(config.olm.legacyBundle, config.worker);
    await workerPool.sendAll({type: "load_olm", path});
    const olmWorker = new OlmWorker(workerPool);
    return olmWorker;
}
function adaptUIOnVisualViewportResize(container) {
    if (!window.visualViewport) {
        return;
    }
    const handler = () => {
        const sessionView = container.querySelector('.SessionView');
        if (!sessionView) {
            return;
        }
        const scrollable = container.querySelector('.bottom-aligned-scroll');
        let scrollTopBefore, heightBefore, heightAfter;
        if (scrollable) {
            scrollTopBefore = scrollable.scrollTop;
            heightBefore = scrollable.offsetHeight;
        }
        const offsetTop = sessionView.offsetTop + sessionView.offsetHeight - window.visualViewport.height;
        container.style.setProperty('--ios-viewport-height', window.visualViewport.height.toString() + 'px');
        container.style.setProperty('--ios-viewport-top', offsetTop.toString() + 'px');
        if (scrollable) {
            heightAfter = scrollable.offsetHeight;
            scrollable.scrollTop = scrollTopBefore + heightBefore - heightAfter;
        }
    };
    window.visualViewport.addEventListener('resize', handler);
    return () => {
        window.visualViewport.removeEventListener('resize', handler);
    };
}
class Platform {
    constructor(container, config, cryptoExtras = null, options = null) {
        this._config = config;
        this._container = container;
        this.settingsStorage = new SettingsStorage("hydrogen_setting_v1_");
        this.clock = new Clock();
        this.encoding = new Encoding();
        this.random = Math.random;
        if (options?.development) {
            this.logger = new ConsoleLogger({platform: this});
        } else {
            this.logger = new IDBLogger({name: "hydrogen_logs", platform: this});
        }
        this.history = new History();
        this.onlineStatus = new OnlineStatus();
        this._serviceWorkerHandler = null;
        if (config.serviceWorker && "serviceWorker" in navigator) {
            this._serviceWorkerHandler = new ServiceWorkerHandler();
            this._serviceWorkerHandler.registerAndStart(config.serviceWorker);
        }
        this.notificationService = new NotificationService(this._serviceWorkerHandler, config.push);
        this.crypto = new Crypto(cryptoExtras);
        this.storageFactory = new StorageFactory(this._serviceWorkerHandler);
        this.sessionInfoStorage = new SessionInfoStorage("hydrogen_sessions_v1");
        this.estimateStorageUsage = estimateStorageUsage;
        if (typeof fetch === "function") {
            this.request = createFetchRequest(this.clock.createTimeout, this._serviceWorkerHandler);
        } else {
            this.request = xhrRequest;
        }
        const isIE11 = !!window.MSInputMethodContext && !!document.documentMode;
        this.isIE11 = isIE11;
        const isIOS = /iPad|iPhone|iPod/.test(navigator.platform) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) && !window.MSStream;
        this.isIOS = isIOS;
        this._disposables = new Disposables();
    }
    get updateService() {
        return this._serviceWorkerHandler;
    }
    loadOlm() {
        return loadOlm(this._config.olm);
    }
    get config() {
        return this._config;
    }
    async loadOlmWorker() {
        if (!window.WebAssembly) {
            return await loadOlmWorker(this._config);
        }
    }
    createAndMountRootView(vm) {
        if (this.isIE11) {
            this._container.className += " legacy";
        }
        if (this.isIOS) {
            this._container.className += " ios";
            const disposable = adaptUIOnVisualViewportResize(this._container);
            if (disposable) {
                this._disposables.track(disposable);
            }
        }
        window.__hydrogenViewModel = vm;
        const view = new RootView(vm);
        this._container.appendChild(view.mount());
    }
    setNavigation(navigation) {
        this._serviceWorkerHandler?.setNavigation(navigation);
    }
    createBlob(buffer, mimetype) {
        return BlobHandle.fromBuffer(buffer, mimetype);
    }
    saveFileAs(blobHandle, filename) {
        if (navigator.msSaveBlob) {
            navigator.msSaveBlob(blobHandle.nativeBlob, filename);
        } else {
            downloadInIframe(this._container, this._config.downloadSandbox, blobHandle, filename, this.isIOS);
        }
    }
    openFile(mimeType = null) {
        const input = document.createElement("input");
        input.setAttribute("type", "file");
        input.className = "hidden";
        if (mimeType) {
            input.setAttribute("accept", mimeType);
        }
        const promise = new Promise((resolve, reject) => {
            const checkFile = () => {
                input.removeEventListener("change", checkFile, true);
                const file = input.files[0];
                this._container.removeChild(input);
                if (file) {
                    resolve({name: file.name, blob: BlobHandle.fromBlob(file)});
                } else {
                    resolve();
                }
            };
            input.addEventListener("change", checkFile, true);
        });
        this._container.appendChild(input);
        input.click();
        return promise;
    }
    async loadImage(blob) {
        return ImageHandle.fromBlob(blob);
    }
    async loadVideo(blob) {
        return VideoHandle.fromBlob(blob);
    }
    hasReadPixelPermission() {
        return hasReadPixelPermission();
    }
    get devicePixelRatio() {
        return window.devicePixelRatio || 1;
    }
    get version() {
        return window.HYDROGEN_VERSION;
    }
    dispose() {
        this._disposables.dispose();
    }
}

function createEnum(...values) {
    const obj = {};
    for (const value of values) {
        if (typeof value !== "string") {
            throw new Error("Invalid enum value name" + value?.toString());
        }
        obj[value] = value;
    }
    return Object.freeze(obj);
}

function encodeQueryParams(queryParams) {
    return Object.entries(queryParams || {})
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => {
            if (typeof value === "object") {
                value = JSON.stringify(value);
            }
            return `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
        })
        .join("&");
}
function encodeBody(body) {
    if (body.nativeBlob && body.mimeType) {
        const blob = body;
        return {
            mimeType: blob.mimeType,
            body: blob,
            length: blob.size
        };
    } else if (typeof body === "object") {
        const json = JSON.stringify(body);
        return {
            mimeType: "application/json",
            body: json,
            length: body.length
        };
    } else {
        throw new Error("Unknown body type: " + body);
    }
}

class HomeServerRequest {
    constructor(method, url, sourceRequest, log) {
        this._log = log;
        this._sourceRequest = sourceRequest;
        this._promise = sourceRequest.response().then(response => {
            log?.set("status", response.status);
            if (response.status >= 200 && response.status < 300) {
                log?.finish();
                return response.body;
            } else {
                if (response.status >= 500) {
                    const err = new ConnectionError(`Internal Server Error`);
                    log?.catch(err);
                    throw err;
                } else if (response.status >= 400 && !response.body?.errcode) {
                    const err = new ConnectionError(`HTTP error status ${response.status} without errcode in body, assume this is a load balancer complaining the server is offline.`);
                    log?.catch(err);
                    throw err;
                } else {
                    const err = new HomeServerError(method, url, response.body, response.status);
                    log?.set("errcode", err.errcode);
                    log?.catch(err);
                    throw err;
                }
            }
        }, err => {
            if (err.name === "AbortError" && this._sourceRequest) {
                const err = new ConnectionError(`Service worker aborted, either updating or hit #187.`);
                log?.catch(err);
                throw err;
            } else {
                if (err.name === "ConnectionError") {
                    log?.set("timeout", err.isTimeout);
                }
                log?.catch(err);
                throw err;
            }
        });
    }
    abort() {
        if (this._sourceRequest) {
            this._log?.set("aborted", true);
            this._sourceRequest.abort();
            this._sourceRequest = null;
        }
    }
    response() {
        return this._promise;
    }
}

class HomeServerApi {
    constructor({homeServer, accessToken, request, reconnector}) {
        this._homeserver = homeServer;
        this._accessToken = accessToken;
        this._requestFn = request;
        this._reconnector = reconnector;
    }
    _url(csPath) {
        return `${this._homeserver}/_matrix/client/r0${csPath}`;
    }
    _baseRequest(method, url, queryParams, body, options, accessToken) {
        const queryString = encodeQueryParams(queryParams);
        url = `${url}?${queryString}`;
        let log;
        if (options?.log) {
            const parent = options?.log;
            log = parent.child({
                t: "network",
                url,
                method,
            }, parent.level.Info);
        }
        let encodedBody;
        const headers = new Map();
        if (accessToken) {
            headers.set("Authorization", `Bearer ${accessToken}`);
        }
        headers.set("Accept", "application/json");
        if (body) {
            const encoded = encodeBody(body);
            headers.set("Content-Type", encoded.mimeType);
            headers.set("Content-Length", encoded.length);
            encodedBody = encoded.body;
        }
        const requestResult = this._requestFn(url, {
            method,
            headers,
            body: encodedBody,
            timeout: options?.timeout,
            uploadProgress: options?.uploadProgress,
            format: "json"
        });
        const hsRequest = new HomeServerRequest(method, url, requestResult, log);
        if (this._reconnector) {
            hsRequest.response().catch(err => {
                if (err.name === "ConnectionError") {
                    this._reconnector.onRequestFailed(this);
                }
            });
        }
        return hsRequest;
    }
    _unauthedRequest(method, url, queryParams, body, options) {
        return this._baseRequest(method, url, queryParams, body, options, null);
    }
    _authedRequest(method, url, queryParams, body, options) {
        return this._baseRequest(method, url, queryParams, body, options, this._accessToken);
    }
    _post(csPath, queryParams, body, options) {
        return this._authedRequest("POST", this._url(csPath), queryParams, body, options);
    }
    _put(csPath, queryParams, body, options) {
        return this._authedRequest("PUT", this._url(csPath), queryParams, body, options);
    }
    _get(csPath, queryParams, body, options) {
        return this._authedRequest("GET", this._url(csPath), queryParams, body, options);
    }
    sync(since, filter, timeout, options = null) {
        return this._get("/sync", {since, timeout, filter}, null, options);
    }
    messages(roomId, params, options = null) {
        return this._get(`/rooms/${encodeURIComponent(roomId)}/messages`, params, null, options);
    }
    members(roomId, params, options = null) {
        return this._get(`/rooms/${encodeURIComponent(roomId)}/members`, params, null, options);
    }
    send(roomId, eventType, txnId, content, options = null) {
        return this._put(`/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/${encodeURIComponent(txnId)}`, {}, content, options);
    }
    redact(roomId, eventId, txnId, content, options = null) {
        return this._put(`/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${encodeURIComponent(txnId)}`, {}, content, options);
    }
    receipt(roomId, receiptType, eventId, options = null) {
        return this._post(`/rooms/${encodeURIComponent(roomId)}/receipt/${encodeURIComponent(receiptType)}/${encodeURIComponent(eventId)}`,
            {}, {}, options);
    }
    passwordLogin(username, password, initialDeviceDisplayName, options = null) {
        return this._unauthedRequest("POST", this._url("/login"), null, {
          "type": "m.login.password",
          "identifier": {
            "type": "m.id.user",
            "user": username
          },
          "password": password,
          "initial_device_display_name": initialDeviceDisplayName
        }, options);
    }
    createFilter(userId, filter, options = null) {
        return this._post(`/user/${encodeURIComponent(userId)}/filter`, null, filter, options);
    }
    versions(options = null) {
        return this._unauthedRequest("GET", `${this._homeserver}/_matrix/client/versions`, null, null, options);
    }
    uploadKeys(payload, options = null) {
        return this._post("/keys/upload", null, payload, options);
    }
    queryKeys(queryRequest, options = null) {
        return this._post("/keys/query", null, queryRequest, options);
    }
    claimKeys(payload, options = null) {
        return this._post("/keys/claim", null, payload, options);
    }
    sendToDevice(type, payload, txnId, options = null) {
        return this._put(`/sendToDevice/${encodeURIComponent(type)}/${encodeURIComponent(txnId)}`, null, payload, options);
    }
    roomKeysVersion(version = null, options = null) {
        let versionPart = "";
        if (version) {
            versionPart = `/${encodeURIComponent(version)}`;
        }
        return this._get(`/room_keys/version${versionPart}`, null, null, options);
    }
    roomKeyForRoomAndSession(version, roomId, sessionId, options = null) {
        return this._get(`/room_keys/keys/${encodeURIComponent(roomId)}/${encodeURIComponent(sessionId)}`, {version}, null, options);
    }
    uploadAttachment(blob, filename, options = null) {
        return this._authedRequest("POST", `${this._homeserver}/_matrix/media/r0/upload`, {filename}, blob, options);
    }
    setPusher(pusher, options = null) {
        return this._post("/pushers/set", null, pusher, options);
    }
    getPushers(options = null) {
        return this._get("/pushers", null, null, options);
    }
    join(roomId, options = null) {
        return this._post(`/rooms/${encodeURIComponent(roomId)}/join`, null, null, options);
    }
    joinIdOrAlias(roomIdOrAlias, options = null) {
        return this._post(`/join/${encodeURIComponent(roomIdOrAlias)}`, null, null, options);
    }
    leave(roomId, options = null) {
        return this._post(`/rooms/${encodeURIComponent(roomId)}/leave`, null, null, options);
    }
    forget(roomId, options = null) {
        return this._post(`/rooms/${encodeURIComponent(roomId)}/forget`, null, null, options);
    }
}

class ExponentialRetryDelay {
    constructor(createTimeout) {
        const start = 2000;
        this._start = start;
        this._current = start;
        this._createTimeout = createTimeout;
        this._max = 60 * 5 * 1000;
        this._timeout = null;
    }
    async waitForRetry() {
        this._timeout = this._createTimeout(this._current);
        try {
            await this._timeout.elapsed();
            const next = 2 * this._current;
            this._current = Math.min(this._max, next);
        } catch(err) {
            if (!(err instanceof AbortError)) {
                throw err;
            }
        } finally {
            this._timeout = null;
        }
    }
    abort() {
        if (this._timeout) {
            this._timeout.abort();
        }
    }
    reset() {
        this._current = this._start;
        this.abort();
    }
    get nextValue() {
        return this._current;
    }
}

const ConnectionStatus = createEnum(
    "Waiting",
    "Reconnecting",
    "Online"
);
class Reconnector {
    constructor({retryDelay, createMeasure, onlineStatus}) {
        this._onlineStatus = onlineStatus;
        this._retryDelay = retryDelay;
        this._createTimeMeasure = createMeasure;
        this._state = new ObservableValue(ConnectionStatus.Online);
        this._isReconnecting = false;
        this._versionsResponse = null;
    }
    get lastVersionsResponse() {
        return this._versionsResponse;
    }
    get connectionStatus() {
        return this._state;
    }
    get retryIn() {
        if (this._state.get() === ConnectionStatus.Waiting) {
            return this._retryDelay.nextValue - this._stateSince.measure();
        }
        return 0;
    }
    async onRequestFailed(hsApi) {
        if (!this._isReconnecting) {
            this._isReconnecting = true;
            const onlineStatusSubscription = this._onlineStatus && this._onlineStatus.subscribe(online => {
                if (online) {
                    this.tryNow();
                }
            });
            try {
                await this._reconnectLoop(hsApi);
            } catch (err) {
                console.error(err);
            } finally {
                if (onlineStatusSubscription) {
                    onlineStatusSubscription();
                }
                this._isReconnecting = false;
            }
        }
    }
    tryNow() {
        if (this._retryDelay) {
            this._retryDelay.abort();
        }
    }
    _setState(state) {
        if (state !== this._state.get()) {
            if (state === ConnectionStatus.Waiting) {
                this._stateSince = this._createTimeMeasure();
            } else {
                this._stateSince = null;
            }
            this._state.set(state);
        }
    }
    async _reconnectLoop(hsApi) {
        this._versionsResponse = null;
        this._retryDelay.reset();
        while (!this._versionsResponse) {
            try {
                this._setState(ConnectionStatus.Reconnecting);
                const versionsRequest = hsApi.versions({timeout: 30000});
                this._versionsResponse = await versionsRequest.response();
                this._setState(ConnectionStatus.Online);
            } catch (err) {
                if (err.name === "ConnectionError") {
                    this._setState(ConnectionStatus.Waiting);
                    await this._retryDelay.waitForRetry();
                } else {
                    throw err;
                }
            }
        }
    }
}

async function decryptAttachment(platform, ciphertextBuffer, info) {
    if (info === undefined || info.key === undefined || info.iv === undefined
        || info.hashes === undefined || info.hashes.sha256 === undefined) {
       throw new Error("Invalid info. Missing info.key, info.iv or info.hashes.sha256 key");
    }
    const {crypto} = platform;
    const {base64} = platform.encoding;
    var ivArray = base64.decode(info.iv);
    var expectedSha256base64 = base64.encode(base64.decode(info.hashes.sha256));
    const digestResult = await crypto.digest("SHA-256", ciphertextBuffer);
    if (base64.encode(new Uint8Array(digestResult)) != expectedSha256base64) {
        throw new Error("Mismatched SHA-256 digest");
    }
    var counterLength;
    if (info.v == "v1" || info.v == "v2") {
        counterLength = 64;
    } else {
        counterLength = 128;
    }
    const decryptedBuffer = await crypto.aes.decryptCTR({
        jwkKey: info.key,
        iv: ivArray,
        data: ciphertextBuffer,
        counterLength
    });
    return decryptedBuffer;
}
async function encryptAttachment(platform, blob) {
    const {crypto} = platform;
    const {base64} = platform.encoding;
    const iv = await crypto.aes.generateIV();
    const key = await crypto.aes.generateKey("jwk", 256);
    const buffer = await blob.readAsBuffer();
    const ciphertext = await crypto.aes.encryptCTR({jwkKey: key, iv, data: buffer});
    const digest = await crypto.digest("SHA-256", ciphertext);
    return {
        blob: platform.createBlob(ciphertext, 'application/octet-stream'),
        info: {
            v: "v2",
            key,
            iv: base64.encodeUnpadded(iv),
            hashes: {
                sha256: base64.encodeUnpadded(digest)
            }
        }
    };
}

class MediaRepository {
    constructor({homeServer, platform}) {
        this._homeServer = homeServer;
        this._platform = platform;
    }
    mxcUrlThumbnail(url, width, height, method) {
        const parts = this._parseMxcUrl(url);
        if (parts) {
            const [serverName, mediaId] = parts;
            const httpUrl = `${this._homeServer}/_matrix/media/r0/thumbnail/${encodeURIComponent(serverName)}/${encodeURIComponent(mediaId)}`;
            return httpUrl + "?" + encodeQueryParams({width: Math.round(width), height: Math.round(height), method});
        }
        return null;
    }
    mxcUrl(url) {
        const parts = this._parseMxcUrl(url);
        if (parts) {
            const [serverName, mediaId] = parts;
            return `${this._homeServer}/_matrix/media/r0/download/${encodeURIComponent(serverName)}/${encodeURIComponent(mediaId)}`;
        } else {
            return null;
        }
    }
    _parseMxcUrl(url) {
        const prefix = "mxc://";
        if (url.startsWith(prefix)) {
            return url.substr(prefix.length).split("/", 2);
        } else {
            return null;
        }
    }
    async downloadEncryptedFile(fileEntry, cache = false) {
        const url = this.mxcUrl(fileEntry.url);
        const {body: encryptedBuffer} = await this._platform.request(url, {method: "GET", format: "buffer", cache}).response();
        const decryptedBuffer = await decryptAttachment(this._platform, encryptedBuffer, fileEntry);
        return this._platform.createBlob(decryptedBuffer, fileEntry.mimetype);
    }
    async downloadPlaintextFile(mxcUrl, mimetype, cache = false) {
        const url = this.mxcUrl(mxcUrl);
        const {body: buffer} = await this._platform.request(url, {method: "GET", format: "buffer", cache}).response();
        return this._platform.createBlob(buffer, mimetype);
    }
    async downloadAttachment(content, cache = false) {
        if (content.file) {
            return this.downloadEncryptedFile(content.file, cache);
        } else {
            return this.downloadPlaintextFile(content.url, content.info?.mimetype, cache);
        }
    }
}

class Request$1 {
    constructor(methodName, args) {
        this._methodName = methodName;
        this._args = args;
        this._responsePromise = new Promise((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
        });
        this._requestResult = null;
    }
    abort() {
        if (this._requestResult) {
            this._requestResult.abort();
        } else {
            this._reject(new AbortError());
        }
    }
    response() {
        return this._responsePromise;
    }
}
class HomeServerApiWrapper {
    constructor(scheduler) {
        this._scheduler = scheduler;
    }
}
for (const methodName of Object.getOwnPropertyNames(HomeServerApi.prototype)) {
    if (methodName !== "constructor" && !methodName.startsWith("_")) {
        HomeServerApiWrapper.prototype[methodName] = function(...args) {
            return this._scheduler._hsApiRequest(methodName, args);
        };
    }
}
class RequestScheduler {
    constructor({hsApi, clock}) {
        this._hsApi = hsApi;
        this._clock = clock;
        this._requests = new Set();
        this._isRateLimited = false;
        this._isDrainingRateLimit = false;
        this._stopped = true;
        this._wrapper = new HomeServerApiWrapper(this);
    }
    get hsApi() {
        return this._wrapper;
    }
    stop() {
        this._stopped = true;
        for (const request of this._requests) {
            request.abort();
        }
        this._requests.clear();
    }
    start() {
        this._stopped = false;
    }
    _hsApiRequest(name, args) {
        const request = new Request$1(name, args);
        this._doSend(request);
        return request;
    }
    async _doSend(request) {
        this._requests.add(request);
        try {
            let retryDelay;
            while (!this._stopped) {
                try {
                    const requestResult = this._hsApi[request._methodName].apply(this._hsApi, request._args);
                    request._requestResult = requestResult;
                    const response = await requestResult.response();
                    request._resolve(response);
                    return;
                } catch (err) {
                    if (err instanceof HomeServerError && err.errcode === "M_LIMIT_EXCEEDED") {
                        if (Number.isSafeInteger(err.retry_after_ms)) {
                            await this._clock.createTimeout(err.retry_after_ms).elapsed();
                        } else {
                            if (!retryDelay) {
                                retryDelay = new ExponentialRetryDelay(this._clock.createTimeout);
                            }
                            await retryDelay.waitForRetry();
                        }
                    } else {
                        request._reject(err);
                        return;
                    }
                }
            }
            if (this._stopped) {
                request.abort();
            }
        } finally {
            this._requests.delete(request);
        }
    }
}

const INCREMENTAL_TIMEOUT = 30000;
const SyncStatus = createEnum(
    "InitialSync",
    "CatchupSync",
    "Syncing",
    "Stopped"
);
function timelineIsEmpty(roomResponse) {
    try {
        const events = roomResponse?.timeline?.events;
        return Array.isArray(events) && events.length === 0;
    } catch (err) {
        return true;
    }
}
class Sync {
    constructor({hsApi, session, storage, logger}) {
        this._hsApi = hsApi;
        this._logger = logger;
        this._session = session;
        this._storage = storage;
        this._currentRequest = null;
        this._status = new ObservableValue(SyncStatus.Stopped);
        this._error = null;
    }
    get status() {
        return this._status;
    }
    get error() {
        return this._error;
    }
    start() {
        if (this._status.get() !== SyncStatus.Stopped) {
            return;
        }
        this._error = null;
        let syncToken = this._session.syncToken;
        if (syncToken) {
            this._status.set(SyncStatus.CatchupSync);
        } else {
            this._status.set(SyncStatus.InitialSync);
        }
        this._syncLoop(syncToken);
    }
    async _syncLoop(syncToken) {
        while(this._status.get() !== SyncStatus.Stopped) {
            let roomStates;
            let sessionChanges;
            let wasCatchupOrInitial = this._status.get() === SyncStatus.CatchupSync || this._status.get() === SyncStatus.InitialSync;
            await this._logger.run("sync", async log => {
                log.set("token", syncToken);
                log.set("status", this._status.get());
                try {
                    const timeout = this._status.get() === SyncStatus.Syncing ? INCREMENTAL_TIMEOUT : 0;
                    const syncResult = await this._syncRequest(syncToken, timeout, log);
                    syncToken = syncResult.syncToken;
                    roomStates = syncResult.roomStates;
                    sessionChanges = syncResult.sessionChanges;
                    if (this._status.get() !== SyncStatus.Syncing && syncResult.hadToDeviceMessages) {
                        this._status.set(SyncStatus.CatchupSync);
                    } else {
                        this._status.set(SyncStatus.Syncing);
                    }
                } catch (err) {
                    if (err.name === "ConnectionError" && err.isTimeout) {
                        return;
                    }
                    this._error = err;
                    if (err.name !== "AbortError") {
                        log.error = err;
                        log.logLevel = log.level.Fatal;
                    }
                    log.set("stopping", true);
                    this._status.set(SyncStatus.Stopped);
                }
                if (this._status.get() !== SyncStatus.Stopped) {
                    await log.wrap("afterSyncCompleted", log => this._runAfterSyncCompleted(sessionChanges, roomStates, log));
                }
            },
            this._logger.level.Info,
            (filter, log) => {
                if (log.durationWithoutType("network") >= 2000 || log.error || wasCatchupOrInitial) {
                    return filter.minLevel(log.level.Detail);
                } else {
                    return filter.minLevel(log.level.Info);
                }
            });
        }
    }
    async _runAfterSyncCompleted(sessionChanges, roomStates, log) {
        const isCatchupSync = this._status.get() === SyncStatus.CatchupSync;
        const sessionPromise = (async () => {
            try {
                await log.wrap("session", log => this._session.afterSyncCompleted(sessionChanges, isCatchupSync, log), log.level.Detail);
            } catch (err) {}
        })();
        const roomsNeedingAfterSyncCompleted = roomStates.filter(rs => {
            return rs.room.needsAfterSyncCompleted(rs.changes);
        });
        const roomsPromises = roomsNeedingAfterSyncCompleted.map(async rs => {
            try {
                await log.wrap("room", log => rs.room.afterSyncCompleted(rs.changes, log), log.level.Detail);
            } catch (err) {}
        });
        await Promise.all(roomsPromises.concat(sessionPromise));
    }
    async _syncRequest(syncToken, timeout, log) {
        let {syncFilterId} = this._session;
        if (typeof syncFilterId !== "string") {
            this._currentRequest = this._hsApi.createFilter(this._session.user.id, {room: {state: {lazy_load_members: true}}}, {log});
            syncFilterId = (await this._currentRequest.response()).filter_id;
        }
        const totalRequestTimeout = timeout + (80 * 1000);
        this._currentRequest = this._hsApi.sync(syncToken, syncFilterId, timeout, {timeout: totalRequestTimeout, log});
        const response = await this._currentRequest.response();
        const isInitialSync = !syncToken;
        const sessionState = new SessionSyncProcessState();
        const inviteStates = this._parseInvites(response.rooms);
        const {roomStates, archivedRoomStates} = await this._parseRoomsResponse(
            response.rooms, inviteStates, isInitialSync, log);
        try {
            sessionState.lock = await log.wrap("obtainSyncLock", () => this._session.obtainSyncLock(response));
            await log.wrap("prepare", log => this._prepareSync(sessionState, roomStates, response, log));
            await log.wrap("afterPrepareSync", log => Promise.all(roomStates.map(rs => {
                return rs.room.afterPrepareSync(rs.preparation, log);
            })));
            await log.wrap("write", async log => this._writeSync(
                sessionState, inviteStates, roomStates, archivedRoomStates,
                response, syncFilterId, isInitialSync, log));
        } finally {
            sessionState.dispose();
        }
        log.wrap("after", log => this._afterSync(
            sessionState, inviteStates, roomStates, archivedRoomStates, log));
        const toDeviceEvents = response.to_device?.events;
        return {
            syncToken: response.next_batch,
            roomStates,
            sessionChanges: sessionState.changes,
            hadToDeviceMessages: Array.isArray(toDeviceEvents) && toDeviceEvents.length > 0,
        };
    }
    _openPrepareSyncTxn() {
        const storeNames = this._storage.storeNames;
        return this._storage.readTxn([
            storeNames.olmSessions,
            storeNames.inboundGroupSessions,
            storeNames.timelineFragments,
            storeNames.timelineEvents,
        ]);
    }
    async _prepareSync(sessionState, roomStates, response, log) {
        const prepareTxn = await this._openPrepareSyncTxn();
        sessionState.preparation = await log.wrap("session", log => this._session.prepareSync(
            response, sessionState.lock, prepareTxn, log));
        const newKeysByRoom = sessionState.preparation?.newKeysByRoom;
        if (newKeysByRoom) {
            const {hasOwnProperty} = Object.prototype;
            for (const roomId of newKeysByRoom.keys()) {
                const isRoomInResponse = response.rooms?.join && hasOwnProperty.call(response.rooms.join, roomId);
                if (!isRoomInResponse) {
                    let room = this._session.rooms.get(roomId);
                    if (room) {
                        roomStates.push(new RoomSyncProcessState(room, false, null, {}, room.membership));
                    }
                }
            }
        }
        await Promise.all(roomStates.map(async rs => {
            const newKeys = newKeysByRoom?.get(rs.room.id);
            rs.preparation = await log.wrap("room", async log => {
                if (rs.isNewRoom) {
                    await rs.room.load(null, prepareTxn, log);
                }
                return rs.room.prepareSync(
                    rs.roomResponse, rs.membership, rs.invite, newKeys, prepareTxn, log)
            }, log.level.Detail);
        }));
        await prepareTxn.complete();
    }
    async _writeSync(sessionState, inviteStates, roomStates, archivedRoomStates, response, syncFilterId, isInitialSync, log) {
        const syncTxn = await this._openSyncTxn();
        try {
            sessionState.changes = await log.wrap("session", log => this._session.writeSync(
                response, syncFilterId, sessionState.preparation, syncTxn, log));
            await Promise.all(inviteStates.map(async is => {
                is.changes = await log.wrap("invite", log => is.invite.writeSync(
                    is.membership, is.roomResponse, syncTxn, log));
            }));
            await Promise.all(roomStates.map(async rs => {
                rs.changes = await log.wrap("room", log => rs.room.writeSync(
                    rs.roomResponse, isInitialSync, rs.preparation, syncTxn, log));
            }));
            await Promise.all(archivedRoomStates.map(async ars => {
                const summaryChanges = ars.roomState?.summaryChanges;
                ars.changes = await log.wrap("archivedRoom", log => ars.archivedRoom.writeSync(
                    summaryChanges, ars.roomResponse, ars.membership, syncTxn, log));
            }));
        } catch(err) {
            try {
                syncTxn.abort();
            } catch (abortErr) {
                log.set("couldNotAbortTxn", true);
            }
            throw err;
        }
        await syncTxn.complete();
    }
    _afterSync(sessionState, inviteStates, roomStates, archivedRoomStates, log) {
        log.wrap("session", log => this._session.afterSync(sessionState.changes, log), log.level.Detail);
        for(let ars of archivedRoomStates) {
            log.wrap("archivedRoom", log => {
                ars.archivedRoom.afterSync(ars.changes, log);
                ars.archivedRoom.release();
            }, log.level.Detail);
        }
        for(let rs of roomStates) {
            log.wrap("room", log => rs.room.afterSync(rs.changes, log), log.level.Detail);
        }
        for(let is of inviteStates) {
            log.wrap("invite", log => is.invite.afterSync(is.changes, log), log.level.Detail);
        }
        this._session.applyRoomCollectionChangesAfterSync(inviteStates, roomStates, archivedRoomStates);
    }
    _openSyncTxn() {
        const storeNames = this._storage.storeNames;
        return this._storage.readWriteTxn([
            storeNames.session,
            storeNames.roomSummary,
            storeNames.archivedRoomSummary,
            storeNames.invites,
            storeNames.roomState,
            storeNames.roomMembers,
            storeNames.timelineEvents,
            storeNames.timelineRelations,
            storeNames.timelineFragments,
            storeNames.pendingEvents,
            storeNames.userIdentities,
            storeNames.groupSessionDecryptions,
            storeNames.deviceIdentities,
            storeNames.outboundGroupSessions,
            storeNames.operations,
            storeNames.accountData,
            storeNames.olmSessions,
            storeNames.inboundGroupSessions,
        ]);
    }
    async _parseRoomsResponse(roomsSection, inviteStates, isInitialSync, log) {
        const roomStates = [];
        const archivedRoomStates = [];
        if (roomsSection) {
            const allMemberships = ["join", "leave"];
            for(const membership of allMemberships) {
                const membershipSection = roomsSection[membership];
                if (membershipSection) {
                    for (const [roomId, roomResponse] of Object.entries(membershipSection)) {
                        if (isInitialSync && timelineIsEmpty(roomResponse)) {
                            continue;
                        }
                        const invite = this._session.invites.get(roomId);
                        if (invite) {
                            inviteStates.push(new InviteSyncProcessState(invite, false, null, membership));
                        }
                        const roomState = this._createRoomSyncState(roomId, invite, roomResponse, membership, isInitialSync);
                        if (roomState) {
                            roomStates.push(roomState);
                        }
                        const ars = await this._createArchivedRoomSyncState(roomId, roomState, roomResponse, membership, isInitialSync, log);
                        if (ars) {
                            archivedRoomStates.push(ars);
                        }
                    }
                }
            }
        }
        return {roomStates, archivedRoomStates};
    }
    _createRoomSyncState(roomId, invite, roomResponse, membership, isInitialSync) {
        let isNewRoom = false;
        let room = this._session.rooms.get(roomId);
        if (!room && (membership === "join" || (isInitialSync && membership === "leave"))) {
            room = this._session.createRoom(roomId);
            isNewRoom = true;
        }
        if (room) {
            return new RoomSyncProcessState(
                room, isNewRoom, invite, roomResponse, membership);
        }
    }
    async _createArchivedRoomSyncState(roomId, roomState, roomResponse, membership, isInitialSync, log) {
        let archivedRoom;
        if (roomState?.shouldAdd && !isInitialSync) {
            archivedRoom = this._session.createOrGetArchivedRoomForSync(roomId);
        } else if (membership === "leave") {
            if (roomState) {
                archivedRoom = this._session.createOrGetArchivedRoomForSync(roomId);
            } else {
                archivedRoom = await this._session.loadArchivedRoom(roomId, log);
            }
        }
        if (archivedRoom) {
            return new ArchivedRoomSyncProcessState(
                archivedRoom, roomState, roomResponse, membership);
        }
    }
    _parseInvites(roomsSection) {
        const inviteStates = [];
        if (roomsSection?.invite) {
            for (const [roomId, roomResponse] of Object.entries(roomsSection.invite)) {
                let invite = this._session.invites.get(roomId);
                let isNewInvite = false;
                if (!invite) {
                    invite = this._session.createInvite(roomId);
                    isNewInvite = true;
                }
                inviteStates.push(new InviteSyncProcessState(invite, isNewInvite, roomResponse, "invite"));
            }
        }
        return inviteStates;
    }
    stop() {
        if (this._status.get() === SyncStatus.Stopped) {
            return;
        }
        this._status.set(SyncStatus.Stopped);
        if (this._currentRequest) {
            this._currentRequest.abort();
            this._currentRequest = null;
        }
    }
}
class SessionSyncProcessState {
    constructor() {
        this.lock = null;
        this.preparation = null;
        this.changes = null;
    }
    dispose() {
        this.lock?.release();
        this.preparation?.dispose();
    }
}
class RoomSyncProcessState {
    constructor(room, isNewRoom, invite, roomResponse, membership) {
        this.room = room;
        this.isNewRoom = isNewRoom;
        this.invite = invite;
        this.roomResponse = roomResponse;
        this.membership = membership;
        this.preparation = null;
        this.changes = null;
    }
    get id() {
        return this.room.id;
    }
    get shouldAdd() {
        return this.isNewRoom && this.membership === "join";
    }
    get shouldRemove() {
        return !this.isNewRoom && this.membership !== "join";
    }
    get summaryChanges() {
        return this.changes?.summaryChanges;
    }
}
class ArchivedRoomSyncProcessState {
    constructor(archivedRoom, roomState, roomResponse, membership, isInitialSync) {
        this.archivedRoom = archivedRoom;
        this.roomState = roomState;
        this.roomResponse = roomResponse;
        this.membership = membership;
        this.isInitialSync = isInitialSync;
        this.changes = null;
    }
    get id() {
        return this.archivedRoom.id;
    }
    get shouldAdd() {
        return (this.roomState || this.isInitialSync) && this.membership === "leave";
    }
    get shouldRemove() {
        return this.membership === "join";
    }
}
class InviteSyncProcessState {
    constructor(invite, isNewInvite, roomResponse, membership) {
        this.invite = invite;
        this.isNewInvite = isNewInvite;
        this.membership = membership;
        this.roomResponse = roomResponse;
        this.changes = null;
    }
    get id() {
        return this.invite.id;
    }
    get shouldAdd() {
        return this.isNewInvite;
    }
    get shouldRemove() {
        return this.membership !== "invite";
    }
}

class EventEmitter {
    constructor() {
        this._handlersByName = {};
    }
    emit(name, ...values) {
        const handlers = this._handlersByName[name];
        if (handlers) {
            for(const h of handlers) {
                h(...values);
            }
        }
    }
    disposableOn(name, callback) {
        this.on(name, callback);
        return () => {
            this.off(name, callback);
        }
    }
    on(name, callback) {
        let handlers = this._handlersByName[name];
        if (!handlers) {
            this.onFirstSubscriptionAdded(name);
            this._handlersByName[name] = handlers = new Set();
        }
        handlers.add(callback);
    }
    off(name, callback) {
        const handlers = this._handlersByName[name];
        if (handlers) {
            handlers.delete(callback);
            if (handlers.length === 0) {
                delete this._handlersByName[name];
                this.onLastSubscriptionRemoved(name);
            }
        }
    }
    onFirstSubscriptionAdded(name) {}
    onLastSubscriptionRemoved(name) {}
}

var escaped = /[\\\"\x00-\x1F]/g;
var escapes = {};
for (var i = 0; i < 0x20; ++i) {
    escapes[String.fromCharCode(i)] = (
        '\\U' + ('0000' + i.toString(16)).slice(-4).toUpperCase()
    );
}
escapes['\b'] = '\\b';
escapes['\t'] = '\\t';
escapes['\n'] = '\\n';
escapes['\f'] = '\\f';
escapes['\r'] = '\\r';
escapes['\"'] = '\\\"';
escapes['\\'] = '\\\\';
function escapeString(value) {
    escaped.lastIndex = 0;
    return value.replace(escaped, function(c) { return escapes[c]; });
}
function stringify(value) {
    switch (typeof value) {
        case 'string':
            return '"' + escapeString(value) + '"';
        case 'number':
            return isFinite(value) ? value : 'null';
        case 'boolean':
            return value;
        case 'object':
            if (value === null) {
                return 'null';
            }
            if (Array.isArray(value)) {
                return stringifyArray(value);
            }
            return stringifyObject(value);
        default:
            throw new Error('Cannot stringify: ' + typeof value);
    }
}
function stringifyArray(array) {
    var sep = '[';
    var result = '';
    for (var i = 0; i < array.length; ++i) {
        result += sep;
        sep = ',';
        result += stringify(array[i]);
    }
    if (sep != ',') {
        return '[]';
    } else {
        return result + ']';
    }
}
function stringifyObject(object) {
    var sep = '{';
    var result = '';
    var keys = Object.keys(object);
    keys.sort();
    for (var i = 0; i < keys.length; ++i) {
        var key = keys[i];
        result += sep + '"' + escapeString(key) + '":';
        sep = ',';
        result += stringify(object[key]);
    }
    if (sep != ',') {
        return '{}';
    } else {
        return result + '}';
    }
}
var anotherJson = {stringify: stringify};

const DecryptionSource = createEnum("Sync", "Timeline", "Retry");
const SESSION_KEY_PREFIX = "e2ee:";
const OLM_ALGORITHM = "m.olm.v1.curve25519-aes-sha2";
const MEGOLM_ALGORITHM = "m.megolm.v1.aes-sha2";
class DecryptionError extends Error {
    constructor(code, event, detailsObj = null) {
        super(`Decryption error ${code}${detailsObj ? ": "+JSON.stringify(detailsObj) : ""}`);
        this.code = code;
        this.event = event;
        this.details = detailsObj;
    }
}
const SIGNATURE_ALGORITHM = "ed25519";
function verifyEd25519Signature(olmUtil, userId, deviceOrKeyId, ed25519Key, value) {
    const clone = Object.assign({}, value);
    delete clone.unsigned;
    delete clone.signatures;
    const canonicalJson = anotherJson.stringify(clone);
    const signature = value?.signatures?.[userId]?.[`${SIGNATURE_ALGORITHM}:${deviceOrKeyId}`];
    try {
        if (!signature) {
            throw new Error("no signature");
        }
        olmUtil.ed25519_verify(ed25519Key, canonicalJson, signature);
        return true;
    } catch (err) {
        console.warn("Invalid signature, ignoring.", ed25519Key, canonicalJson, signature, err);
        return false;
    }
}

function applyTimelineEntries(data, timelineEntries, isInitialSync, canMarkUnread, ownUserId) {
    if (timelineEntries.length) {
        data = timelineEntries.reduce((data, entry) => {
            return processTimelineEvent(data, entry,
                isInitialSync, canMarkUnread, ownUserId);
        }, data);
    }
    return data;
}
function reduceStateEvents(roomResponse, callback, value) {
    const stateEvents = roomResponse?.state?.events;
    if (Array.isArray(stateEvents)) {
        value = stateEvents.reduce(callback, value);
    }
    const timelineEvents = roomResponse?.timeline?.events;
    if (Array.isArray(timelineEvents)) {
        value = timelineEvents.reduce((data, event) => {
            if (typeof event.state_key === "string") {
                value = callback(value, event);
            }
            return value;
        }, value);
    }
    return value;
}
function applySyncResponse(data, roomResponse, membership) {
    if (roomResponse.summary) {
        data = updateSummary(data, roomResponse.summary);
    }
    if (membership !== data.membership) {
        data = data.cloneIfNeeded();
        data.membership = membership;
    }
    if (roomResponse.account_data) {
        data = roomResponse.account_data.events.reduce(processRoomAccountData, data);
    }
    data = reduceStateEvents(roomResponse, processStateEvent, data);
    const unreadNotifications = roomResponse.unread_notifications;
    if (unreadNotifications) {
        data = processNotificationCounts(data, unreadNotifications);
    }
    return data;
}
function processNotificationCounts(data, unreadNotifications) {
    const highlightCount = unreadNotifications.highlight_count || 0;
    if (highlightCount !== data.highlightCount) {
        data = data.cloneIfNeeded();
        data.highlightCount = highlightCount;
    }
    const notificationCount = unreadNotifications.notification_count;
    if (notificationCount !== data.notificationCount) {
        data = data.cloneIfNeeded();
        data.notificationCount = notificationCount;
    }
    return data;
}
function processRoomAccountData(data, event) {
    if (event?.type === "m.tag") {
        let tags = event?.content?.tags;
        if (!tags || Array.isArray(tags) || typeof tags !== "object") {
            tags = null;
        }
        data = data.cloneIfNeeded();
        data.tags = tags;
    }
    return data;
}
function processStateEvent(data, event) {
    if (event.type === "m.room.encryption") {
        const algorithm = event.content?.algorithm;
        if (!data.encryption && algorithm === MEGOLM_ALGORITHM) {
            data = data.cloneIfNeeded();
            data.encryption = event.content;
        }
    } else if (event.type === "m.room.name") {
        const newName = event.content?.name;
        if (newName !== data.name) {
            data = data.cloneIfNeeded();
            data.name = newName;
        }
    } else if (event.type === "m.room.avatar") {
        const newUrl = event.content?.url;
        if (newUrl !== data.avatarUrl) {
            data = data.cloneIfNeeded();
            data.avatarUrl = newUrl;
        }
    } else if (event.type === "m.room.canonical_alias") {
        const content = event.content;
        data = data.cloneIfNeeded();
        data.canonicalAlias = content.alias;
    }
    return data;
}
function processTimelineEvent(data, eventEntry, isInitialSync, canMarkUnread, ownUserId) {
    if (eventEntry.eventType === "m.room.message") {
        if (!data.lastMessageTimestamp || eventEntry.timestamp > data.lastMessageTimestamp) {
            data = data.cloneIfNeeded();
            data.lastMessageTimestamp = eventEntry.timestamp;
        }
        if (!isInitialSync && eventEntry.sender !== ownUserId && canMarkUnread) {
            data = data.cloneIfNeeded();
            data.isUnread = true;
        }
    }
    return data;
}
function updateSummary(data, summary) {
    const heroes = summary["m.heroes"];
    const joinCount = summary["m.joined_member_count"];
    const inviteCount = summary["m.invited_member_count"];
    if (heroes && Array.isArray(heroes)) {
        data = data.cloneIfNeeded();
        data.heroes = heroes;
    }
    if (Number.isInteger(inviteCount)) {
        data = data.cloneIfNeeded();
        data.inviteCount = inviteCount;
    }
    if (Number.isInteger(joinCount)) {
        data = data.cloneIfNeeded();
        data.joinCount = joinCount;
    }
    return data;
}
function applyInvite(data, invite) {
    if (data.isDirectMessage !== invite.isDirectMessage) {
        data = data.cloneIfNeeded();
        data.isDirectMessage = invite.isDirectMessage;
        if (invite.isDirectMessage) {
            data.dmUserId = invite.inviter?.userId;
        } else {
            data.dmUserId = null;
        }
    }
    return data;
}
class SummaryData {
    constructor(copy, roomId) {
        this.roomId = copy ? copy.roomId : roomId;
        this.name = copy ? copy.name : null;
        this.lastMessageTimestamp = copy ? copy.lastMessageTimestamp : null;
        this.isUnread = copy ? copy.isUnread : false;
        this.encryption = copy ? copy.encryption : null;
        this.membership = copy ? copy.membership : null;
        this.inviteCount = copy ? copy.inviteCount : 0;
        this.joinCount = copy ? copy.joinCount : 0;
        this.heroes = copy ? copy.heroes : null;
        this.canonicalAlias = copy ? copy.canonicalAlias : null;
        this.hasFetchedMembers = copy ? copy.hasFetchedMembers : false;
        this.isTrackingMembers = copy ? copy.isTrackingMembers : false;
        this.avatarUrl = copy ? copy.avatarUrl : null;
        this.notificationCount = copy ? copy.notificationCount : 0;
        this.highlightCount = copy ? copy.highlightCount : 0;
        this.tags = copy ? copy.tags : null;
        this.isDirectMessage = copy ? copy.isDirectMessage : false;
        this.dmUserId = copy ? copy.dmUserId : null;
        this.cloned = copy ? true : false;
    }
    diff(other) {
        const props = Object.getOwnPropertyNames(this);
        return props.reduce((diff, prop) => {
            if (prop !== "cloned") {
                if (this[prop] !== other[prop]) {
                    diff[prop] = this[prop];
                }
            }
            return diff;
        }, {});
    }
    cloneIfNeeded() {
        if (this.cloned) {
            return this;
        } else {
            return new SummaryData(this);
        }
    }
    serialize() {
        return Object.entries(this).reduce((obj, [key, value]) => {
            if (key !== "cloned" && value !== null) {
                obj[key] = value;
            }
            return obj;
        }, {});
    }
    applyTimelineEntries(timelineEntries, isInitialSync, canMarkUnread, ownUserId) {
        return applyTimelineEntries(this, timelineEntries, isInitialSync, canMarkUnread, ownUserId);
    }
    applySyncResponse(roomResponse, membership) {
        return applySyncResponse(this, roomResponse, membership);
    }
    applyInvite(invite) {
        return applyInvite(this, invite);
    }
    get needsHeroes() {
        return !this.name && !this.canonicalAlias && this.heroes && this.heroes.length > 0;
    }
    isNewJoin(oldData) {
        return this.membership === "join" && oldData.membership !== "join";
    }
}
class RoomSummary {
	constructor(roomId) {
        this._data = null;
        this.applyChanges(new SummaryData(null, roomId));
	}
    get data() {
        return this._data;
    }
    writeClearUnread(txn) {
        const data = new SummaryData(this._data);
        data.isUnread = false;
        data.notificationCount = 0;
        data.highlightCount = 0;
        txn.roomSummary.set(data.serialize());
        return data;
    }
    writeHasFetchedMembers(value, txn) {
        const data = new SummaryData(this._data);
        data.hasFetchedMembers = value;
        txn.roomSummary.set(data.serialize());
        return data;
    }
    writeIsTrackingMembers(value, txn) {
        const data = new SummaryData(this._data);
        data.isTrackingMembers = value;
        txn.roomSummary.set(data.serialize());
        return data;
    }
	writeData(data, txn) {
		if (data !== this._data) {
            txn.roomSummary.set(data.serialize());
            return data;
		}
	}
    writeArchivedData(data, txn) {
        if (data !== this._data) {
            txn.archivedRoomSummary.set(data.serialize());
            return data;
        }
    }
    async writeAndApplyData(data, storage) {
        if (data === this._data) {
            return false;
        }
        const txn = await storage.readWriteTxn([
            storage.storeNames.roomSummary,
        ]);
        try {
            txn.roomSummary.set(data.serialize());
        } catch (err) {
            txn.abort();
            throw err;
        }
        await txn.complete();
        this.applyChanges(data);
        return true;
    }
    applyChanges(data) {
        this._data = data;
        this._data.cloned = false;
    }
	async load(summary) {
        this.applyChanges(new SummaryData(summary));
	}
}

const PENDING_FRAGMENT_ID = Number.MAX_SAFE_INTEGER;
class BaseEntry {
    constructor(fragmentIdComparer) {
        this._fragmentIdComparer = fragmentIdComparer;
    }
    get fragmentId() {
        throw new Error("unimplemented");
    }
    get entryIndex() {
        throw new Error("unimplemented");
    }
    compare(otherEntry) {
        if (this.fragmentId === otherEntry.fragmentId) {
            return this.entryIndex - otherEntry.entryIndex;
        } else if (this.fragmentId === PENDING_FRAGMENT_ID) {
            return 1;
        } else if (otherEntry.fragmentId === PENDING_FRAGMENT_ID) {
            return -1;
        } else {
            return this._fragmentIdComparer.compare(this.fragmentId, otherEntry.fragmentId);
        }
    }
    asEventKey() {
        return new EventKey(this.fragmentId, this.entryIndex);
    }
    updateFrom() {}
}

const REACTION_TYPE = "m.reaction";
const ANNOTATION_RELATION_TYPE = "m.annotation";
function createAnnotation(targetId, key) {
    return {
        "m.relates_to": {
            "event_id": targetId,
            key,
            "rel_type": ANNOTATION_RELATION_TYPE
        }
    };
}
function getRelatedEventId(event) {
	if (event.type === REDACTION_TYPE) {
        return event.redacts;
    } else {
        const relation = getRelation(event);
        if (relation) {
            return relation.event_id;
        }
    }
    return null;
}
function getRelationFromContent(content) {
    return content?.["m.relates_to"];
}
function getRelation(event) {
	return getRelationFromContent(event.content);
}

class PendingAnnotation {
    constructor() {
        this._entries = [];
    }
    get firstTimestamp() {
        return this._entries.reduce((ts, e) => {
            if (e.isRedaction) {
                return ts;
            }
            return Math.min(e.timestamp, ts);
        }, Number.MAX_SAFE_INTEGER);
    }
    get annotationEntry() {
        return this._entries.find(e => !e.isRedaction);
    }
    get redactionEntry() {
        return this._entries.find(e => e.isRedaction);
    }
    get count() {
        return this._entries.reduce((count, e) => {
            return count + (e.isRedaction ? -1 : 1);
        }, 0);
    }
    add(entry) {
        this._entries.push(entry);
    }
    remove(entry) {
        const idx = this._entries.indexOf(entry);
        if (idx === -1) {
            return false;
        }
        this._entries.splice(idx, 1);
        return true;
    }
    get willAnnotate() {
        const lastEntry = this._entries.reduce((lastEntry, e) => {
            if (!lastEntry || e.pendingEvent.queueIndex > lastEntry.pendingEvent.queueIndex) {
                return e;
            }
            return lastEntry;
        }, null);
        if (lastEntry) {
            return !lastEntry.isRedaction;
        }
        return false;
    }
    get isEmpty() {
        return this._entries.length === 0;
    }
}

class BaseEventEntry extends BaseEntry {
    constructor(fragmentIdComparer) {
        super(fragmentIdComparer);
        this._pendingRedactions = null;
        this._pendingAnnotations = null;
    }
    get isRedacting() {
        return !!this._pendingRedactions;
    }
    get isRedacted() {
        return this.isRedacting;
    }
    get isRedaction() {
        return this.eventType === REDACTION_TYPE;
    }
    get redactionReason() {
        if (this._pendingRedactions) {
            return this._pendingRedactions[0].content?.reason;
        }
        return null;
    }
    addLocalRelation(entry) {
        if (entry.eventType === REDACTION_TYPE && entry.isRelatedToId(this.id)) {
            if (!this._pendingRedactions) {
                this._pendingRedactions = [];
            }
            this._pendingRedactions.push(entry);
            if (this._pendingRedactions.length === 1) {
                return "isRedacted";
            }
        } else {
            const relationEntry = entry.redactingEntry || entry;
            if (relationEntry.isRelatedToId(this.id)) {
                if (relationEntry.relation.rel_type === ANNOTATION_RELATION_TYPE) {
                    if (this._addPendingAnnotation(entry)) {
                        return "pendingAnnotations";
                    }
                }
            }
        }
    }
    removeLocalRelation(entry) {
        if (entry.eventType === REDACTION_TYPE && entry.isRelatedToId(this.id) && this._pendingRedactions) {
            const countBefore = this._pendingRedactions.length;
            this._pendingRedactions = this._pendingRedactions.filter(e => e !== entry);
            if (this._pendingRedactions.length === 0) {
                this._pendingRedactions = null;
                if (countBefore !== 0) {
                    return "isRedacted";
                }
            }
        } else {
            const relationEntry = entry.redactingEntry || entry;
            if (relationEntry.isRelatedToId(this.id)) {
                if (relationEntry.relation?.rel_type === ANNOTATION_RELATION_TYPE && this._pendingAnnotations) {
                    if (this._removePendingAnnotation(entry)) {
                        return "pendingAnnotations";
                    }
                }
            }
        }
    }
    _addPendingAnnotation(entry) {
        if (!this._pendingAnnotations) {
            this._pendingAnnotations = new Map();
        }
        const {key} = (entry.redactingEntry || entry).relation;
        if (key) {
            let annotation = this._pendingAnnotations.get(key);
            if (!annotation) {
                annotation = new PendingAnnotation();
                this._pendingAnnotations.set(key, annotation);
            }
            annotation.add(entry);
            return true;
        }
        return false;
    }
    _removePendingAnnotation(entry) {
        const {key} = (entry.redactingEntry || entry).relation;
        if (key) {
            let annotation = this._pendingAnnotations.get(key);
            if (annotation.remove(entry) && annotation.isEmpty) {
                this._pendingAnnotations.delete(key);
            }
            if (this._pendingAnnotations.size === 0) {
                this._pendingAnnotations = null;
            }
            return true;
        }
        return false;
    }
    async abortPendingRedaction() {
        if (this._pendingRedactions) {
            for (const pee of this._pendingRedactions) {
                await pee.pendingEvent.abort();
            }
        }
    }
    get pendingRedaction() {
        if (this._pendingRedactions) {
            return this._pendingRedactions[0];
        }
        return null;
    }
    annotate(key) {
        return createAnnotation(this.id, key);
    }
    isRelatedToId(id) {
        return id && this.relatedEventId === id;
    }
    haveAnnotation(key) {
        const haveRemoteReaction = this.annotations?.[key]?.me || false;
        const pendingAnnotation = this.pendingAnnotations?.get(key);
        const willAnnotate = pendingAnnotation?.willAnnotate || false;
        return (haveRemoteReaction && (!pendingAnnotation || willAnnotate)) ||
            (!haveRemoteReaction && willAnnotate);
    }
    get relation() {
        return getRelationFromContent(this.content);
    }
    get pendingAnnotations() {
        return this._pendingAnnotations;
    }
    get annotations() {
        return null;
    }
}

class PendingEventEntry extends BaseEventEntry {
    constructor({pendingEvent, member, clock, redactingEntry}) {
        super(null);
        this._pendingEvent = pendingEvent;
        this._member = member;
        this._timestamp = clock.now() - (100 - pendingEvent.queueIndex);
        this._redactingEntry = redactingEntry;
    }
    get fragmentId() {
        return PENDING_FRAGMENT_ID;
    }
    get entryIndex() {
        return this._pendingEvent.queueIndex;
    }
    get content() {
        return this._pendingEvent.content;
    }
    get event() {
        return null;
    }
    get eventType() {
        return this._pendingEvent.eventType;
    }
    get stateKey() {
        return null;
    }
    get sender() {
        return this._member?.userId;
    }
    get displayName() {
        return this._member?.name;
    }
    get avatarUrl() {
        return this._member?.avatarUrl;
    }
    get timestamp() {
        return this._timestamp;
    }
    get isPending() {
        return true;
    }
    get id() {
        return this._pendingEvent.txnId;
    }
    get pendingEvent() {
        return this._pendingEvent;
    }
    notifyUpdate() {
    }
    isRelatedToId(id) {
        if (id && id === this._pendingEvent.relatedTxnId) {
            return true;
        }
        return super.isRelatedToId(id);
    }
    get relatedEventId() {
        return this._pendingEvent.relatedEventId;
    }
    get redactingEntry() {
        return this._redactingEntry;
    }
}

const SendStatus = createEnum(
    "Waiting",
    "EncryptingAttachments",
    "UploadingAttachments",
    "Encrypting",
    "Sending",
    "Sent",
    "Error",
);
class PendingEvent {
    constructor({data, remove, emitUpdate, attachments}) {
        this._data = data;
        this._attachments = attachments;
        this._emitUpdate = emitUpdate;
        this._removeFromQueueCallback = remove;
        this._aborted = false;
        this._status = SendStatus.Waiting;
        this._sendRequest = null;
        this._attachmentsTotalBytes = 0;
        if (this._attachments) {
            this._attachmentsTotalBytes = Object.values(this._attachments).reduce((t, a) => t + a.size, 0);
        }
    }
    get roomId() { return this._data.roomId; }
    get queueIndex() { return this._data.queueIndex; }
    get eventType() { return this._data.eventType; }
    get txnId() { return this._data.txnId; }
    get remoteId() { return this._data.remoteId; }
    get content() { return this._data.content; }
    get relatedTxnId() { return this._data.relatedTxnId; }
    get relatedEventId() {
        const relation = getRelationFromContent(this.content);
        if (relation) {
            return relation.event_id;
        } else {
            return this._data.relatedEventId;
        }
    }
    setRelatedEventId(eventId) {
        const relation = getRelationFromContent(this.content);
        if (relation) {
            relation.event_id = eventId;
        } else {
            this._data.relatedEventId = eventId;
        }
    }
    get data() { return this._data; }
    getAttachment(key) {
        return this._attachments && this._attachments[key];
    }
    get needsSending() {
        return !this.remoteId && !this.aborted;
    }
    get needsEncryption() {
        return this._data.needsEncryption && !this.aborted;
    }
    get needsUpload() {
        return this._data.needsUpload && !this.aborted;
    }
    get isMissingAttachments() {
        return this.needsUpload && !this._attachments;
    }
    setEncrypting() {
        this._status = SendStatus.Encrypting;
        this._emitUpdate("status");
    }
    setEncrypted(type, content) {
        this._data.encryptedEventType = type;
        this._data.encryptedContent = content;
        this._data.needsEncryption = false;
    }
    setError(error) {
        this._status = SendStatus.Error;
        this._error = error;
        this._emitUpdate("status");
    }
    setWaiting() {
        this._status = SendStatus.Waiting;
        this._emitUpdate("status");
    }
    get status() { return this._status; }
    get error() { return this._error; }
    get hasStartedSending() {
        return this._status === SendStatus.Sending || this._status === SendStatus.Sent;
    }
    get attachmentsTotalBytes() {
        return this._attachmentsTotalBytes;
    }
    get attachmentsSentBytes() {
        return this._attachments && Object.values(this._attachments).reduce((t, a) => t + a.sentBytes, 0);
    }
    async uploadAttachments(hsApi, log) {
        if (!this.needsUpload) {
            return;
        }
        if (!this._attachments) {
            throw new Error("attachments missing");
        }
        if (this.needsEncryption) {
            this._status = SendStatus.EncryptingAttachments;
            this._emitUpdate("status");
            for (const attachment of Object.values(this._attachments)) {
                await log.wrap("encrypt", () => {
                    log.set("size", attachment.size);
                    return attachment.encrypt();
                });
                if (this.aborted) {
                    throw new AbortError();
                }
            }
        }
        this._status = SendStatus.UploadingAttachments;
        this._emitUpdate("status");
        const entries = Object.entries(this._attachments);
        entries.sort(([, a1], [, a2]) => a1.size - a2.size);
        for (const [urlPath, attachment] of entries) {
            await log.wrap("upload", log => {
                log.set("size", attachment.size);
                return attachment.upload(hsApi, () => {
                    this._emitUpdate("attachmentsSentBytes");
                }, log);
            });
            attachment.applyToContent(urlPath, this.content);
        }
        this._data.needsUpload = false;
    }
    async abort() {
        if (!this._aborted) {
            this._aborted = true;
            if (this._attachments) {
                for (const attachment of Object.values(this._attachments)) {
                    attachment.abort();
                }
            }
            this._sendRequest?.abort();
            await this._removeFromQueueCallback();
        }
    }
    get aborted() {
        return this._aborted;
    }
    async send(hsApi, log) {
        this._status = SendStatus.Sending;
        this._emitUpdate("status");
        const eventType = this._data.encryptedEventType || this._data.eventType;
        const content = this._data.encryptedContent || this._data.content;
        if (eventType === REDACTION_TYPE) {
            this._sendRequest = hsApi.redact(
                    this.roomId,
                    this._data.relatedEventId,
                    this.txnId,
                    content,
                    {log}
                );
        } else {
            this._sendRequest = hsApi.send(
                    this.roomId,
                    eventType,
                    this.txnId,
                    content,
                    {log}
                );
        }
        const response = await this._sendRequest.response();
        this._sendRequest = null;
        this._data.remoteId = response.event_id;
        log.set("id", this._data.remoteId);
        this._status = SendStatus.Sent;
        this._emitUpdate("status");
    }
    dispose() {
        if (this._attachments) {
            for (const attachment of Object.values(this._attachments)) {
                attachment.dispose();
            }
        }
    }
}

class EventEntry extends BaseEventEntry {
    constructor(eventEntry, fragmentIdComparer) {
        super(fragmentIdComparer);
        this._eventEntry = eventEntry;
        this._decryptionError = null;
        this._decryptionResult = null;
    }
    clone() {
        const clone = new EventEntry(this._eventEntry, this._fragmentIdComparer);
        clone.updateFrom(this);
        return clone;
    }
    updateFrom(other) {
        super.updateFrom(other);
        if (other._decryptionResult && !this._decryptionResult) {
            this._decryptionResult = other._decryptionResult;
        }
        if (other._decryptionError && !this._decryptionError) {
            this._decryptionError = other._decryptionError;
        }
    }
    get event() {
        return this._eventEntry.event;
    }
    get fragmentId() {
        return this._eventEntry.fragmentId;
    }
    get entryIndex() {
        return this._eventEntry.eventIndex;
    }
    get content() {
        return this._decryptionResult?.event?.content || this._eventEntry.event.content;
    }
    get prevContent() {
        return getPrevContentFromStateEvent(this._eventEntry.event);
    }
    get eventType() {
        return this._decryptionResult?.event?.type || this._eventEntry.event.type;
    }
    get stateKey() {
        return this._eventEntry.event.state_key;
    }
    get sender() {
        return this._eventEntry.event.sender;
    }
    get displayName() {
        return this._eventEntry.displayName;
    }
    get avatarUrl() {
        return this._eventEntry.avatarUrl;
    }
    get timestamp() {
        return this._eventEntry.event.origin_server_ts;
    }
    get id() {
        return this._eventEntry.event.event_id;
    }
    setDecryptionResult(result) {
        this._decryptionResult = result;
    }
    get isEncrypted() {
        return this._eventEntry.event.type === "m.room.encrypted";
    }
    get isDecrypted() {
        return !!this._decryptionResult?.event;
    }
    get isVerified() {
        return this.isEncrypted && this._decryptionResult?.isVerified;
    }
    get isUnverified() {
        return this.isEncrypted && this._decryptionResult?.isUnverified;
    }
    setDecryptionError(err) {
        this._decryptionError = err;
    }
    get decryptionError() {
        return this._decryptionError;
    }
    get relatedEventId() {
        return getRelatedEventId(this.event);
    }
    get isRedacted() {
        return super.isRedacted || isRedacted(this._eventEntry.event);
    }
    get redactionReason() {
        const redactionEvent = this._eventEntry.event.unsigned?.redacted_because;
        if (redactionEvent) {
            return redactionEvent.content?.reason;
        }
        return super.redactionReason;
    }
    get annotations() {
        return this._eventEntry.annotations;
    }
}

function createEventEntry(key, roomId, event) {
    return {
        fragmentId: key.fragmentId,
        eventIndex: key.eventIndex,
        roomId,
        event: event,
    };
}
function directionalAppend(array, value, direction) {
    if (direction.isForward) {
        array.push(value);
    } else {
        array.unshift(value);
    }
}
function directionalConcat(array, otherArray, direction) {
    if (direction.isForward) {
        return array.concat(otherArray);
    } else {
        return otherArray.concat(array);
    }
}

class GapWriter {
    constructor({roomId, storage, fragmentIdComparer, relationWriter}) {
        this._roomId = roomId;
        this._storage = storage;
        this._fragmentIdComparer = fragmentIdComparer;
        this._relationWriter = relationWriter;
    }
    async _findOverlappingEvents(fragmentEntry, events, txn, log) {
        let expectedOverlappingEventId;
        if (fragmentEntry.hasLinkedFragment) {
            expectedOverlappingEventId = await this._findExpectedOverlappingEventId(fragmentEntry, txn);
        }
        let remainingEvents = events;
        let nonOverlappingEvents = [];
        let neighbourFragmentEntry;
        while (remainingEvents && remainingEvents.length) {
            const eventIds = remainingEvents.map(e => e.event_id);
            const duplicateEventId = await txn.timelineEvents.findFirstOccurringEventId(this._roomId, eventIds);
            if (duplicateEventId) {
                const duplicateEventIndex = remainingEvents.findIndex(e => e.event_id === duplicateEventId);
                if (duplicateEventIndex === -1) {
                    throw new Error(`findFirstOccurringEventId returned ${duplicateEventIndex} which wasn't ` +
                        `in [${eventIds.join(",")}] in ${this._roomId}`);
                }
                nonOverlappingEvents.push(...remainingEvents.slice(0, duplicateEventIndex));
                if (!expectedOverlappingEventId || duplicateEventId === expectedOverlappingEventId) {
                    const neighbourEvent = await txn.timelineEvents.getByEventId(this._roomId, duplicateEventId);
                    if (neighbourEvent.fragmentId === fragmentEntry.fragmentId) {
                        log.log("hit #160, prevent fragment linking to itself", log.level.Warn);
                    } else {
                        const neighbourFragment = await txn.timelineFragments.get(this._roomId, neighbourEvent.fragmentId);
                        neighbourFragmentEntry = fragmentEntry.createNeighbourEntry(neighbourFragment);
                    }
                    remainingEvents = null;
                } else {
                    remainingEvents = remainingEvents.slice(duplicateEventIndex + 1);
                }
            } else {
                nonOverlappingEvents.push(...remainingEvents);
                remainingEvents = null;
            }
        }
        return {nonOverlappingEvents, neighbourFragmentEntry};
    }
    async _findExpectedOverlappingEventId(fragmentEntry, txn) {
        const eventEntry = await this._findFragmentEdgeEvent(
            fragmentEntry.linkedFragmentId,
            fragmentEntry.direction.reverse(),
            txn);
        if (eventEntry) {
            return eventEntry.event.event_id;
        }
    }
    async _findFragmentEdgeEventKey(fragmentEntry, txn) {
        const {fragmentId, direction} = fragmentEntry;
        const event = await this._findFragmentEdgeEvent(fragmentId, direction, txn);
        if (event) {
            return new EventKey(event.fragmentId, event.eventIndex);
        } else {
            return EventKey.defaultFragmentKey(fragmentEntry.fragmentId);
        }
    }
    async _findFragmentEdgeEvent(fragmentId, direction, txn) {
        if (direction.isBackward) {
            const [firstEvent] = await txn.timelineEvents.firstEvents(this._roomId, fragmentId, 1);
            return firstEvent;
        } else {
            const [lastEvent] = await txn.timelineEvents.lastEvents(this._roomId, fragmentId, 1);
            return lastEvent;
        }
    }
    async _storeEvents(events, startKey, direction, state, txn, log) {
        const entries = [];
        const updatedEntries = [];
        let key = startKey;
        for (let i = 0; i < events.length; ++i) {
            const event = events[i];
            key = key.nextKeyForDirection(direction);
            const eventStorageEntry = createEventEntry(key, this._roomId, event);
            const member = this._findMember(event.sender, state, events, i, direction);
            if (member) {
                eventStorageEntry.displayName = member.displayName;
                eventStorageEntry.avatarUrl = member.avatarUrl;
            }
            const updatedRelationTargetEntries = await this._relationWriter.writeGapRelation(eventStorageEntry, direction, txn, log);
            if (updatedRelationTargetEntries) {
                updatedEntries.push(...updatedRelationTargetEntries);
            }
            txn.timelineEvents.insert(eventStorageEntry);
            const eventEntry = new EventEntry(eventStorageEntry, this._fragmentIdComparer);
            directionalAppend(entries, eventEntry, direction);
        }
        return {entries, updatedEntries};
    }
    _findMember(userId, state, events, index, direction) {
        function isOurUser(event) {
            return event.type === EVENT_TYPE && event.state_key === userId;
        }
        const inc = direction.isBackward ? 1 : -1;
        for (let i = index + inc; i >= 0 && i < events.length; i += inc) {
            const event = events[i];
            if (isOurUser(event)) {
                return RoomMember.fromMemberEvent(this._roomId, event);
            }
        }
        for (let i = index; i >= 0 && i < events.length; i -= inc) {
            const event = events[i];
            if (isOurUser(event)) {
                return RoomMember.fromReplacingMemberEvent(this._roomId, event);
            }
        }
        const stateMemberEvent = state?.find(isOurUser);
        if (stateMemberEvent) {
            return RoomMember.fromMemberEvent(this._roomId, stateMemberEvent);
        }
    }
    async _updateFragments(fragmentEntry, neighbourFragmentEntry, end, entries, txn) {
        const {direction} = fragmentEntry;
        const changedFragments = [];
        directionalAppend(entries, fragmentEntry, direction);
        if (neighbourFragmentEntry) {
            if (!fragmentEntry.hasLinkedFragment) {
                fragmentEntry.linkedFragmentId = neighbourFragmentEntry.fragmentId;
            } else if (fragmentEntry.linkedFragmentId !== neighbourFragmentEntry.fragmentId) {
                throw new Error(`Prevented changing fragment ${fragmentEntry.fragmentId} ` +
                    `${fragmentEntry.direction.asApiString()} link from ${fragmentEntry.linkedFragmentId} ` +
                    `to ${neighbourFragmentEntry.fragmentId} in ${this._roomId}`);
            }
            if (!neighbourFragmentEntry.hasLinkedFragment) {
                neighbourFragmentEntry.linkedFragmentId = fragmentEntry.fragmentId;
            } else if (neighbourFragmentEntry.linkedFragmentId !== fragmentEntry.fragmentId) {
                throw new Error(`Prevented changing fragment ${neighbourFragmentEntry.fragmentId} ` +
                    `${neighbourFragmentEntry.direction.asApiString()} link from ${neighbourFragmentEntry.linkedFragmentId} ` +
                    `to ${fragmentEntry.fragmentId} in ${this._roomId}`);
            }
            neighbourFragmentEntry.token = null;
            fragmentEntry.token = null;
            txn.timelineFragments.update(neighbourFragmentEntry.fragment);
            directionalAppend(entries, neighbourFragmentEntry, direction);
            changedFragments.push(fragmentEntry.fragment);
            changedFragments.push(neighbourFragmentEntry.fragment);
        } else {
            fragmentEntry.token = end;
        }
        txn.timelineFragments.update(fragmentEntry.fragment);
        return changedFragments;
    }
    async writeFragmentFill(fragmentEntry, response, txn, log) {
        const {fragmentId, direction} = fragmentEntry;
        const {chunk, start, state} = response;
        let {end} = response;
        if (!Array.isArray(chunk)) {
            throw new Error("Invalid chunk in response");
        }
        if (typeof end !== "string") {
            throw new Error("Invalid end token in response");
        }
        const fragment = await txn.timelineFragments.get(this._roomId, fragmentId);
        if (!fragment) {
            throw new Error(`Unknown fragment: ${fragmentId}`);
        }
        fragmentEntry = fragmentEntry.withUpdatedFragment(fragment);
        if (fragmentEntry.token !== start) {
            throw new Error("start is not equal to prev_batch or next_batch");
        }
        if (chunk.length === 0) {
            fragmentEntry.edgeReached = true;
            await txn.timelineFragments.update(fragmentEntry.fragment);
            return {entries: [fragmentEntry], updatedEntries: [], fragments: []};
        }
        let lastKey = await this._findFragmentEdgeEventKey(fragmentEntry, txn);
        const {
            nonOverlappingEvents,
            neighbourFragmentEntry
        } = await this._findOverlappingEvents(fragmentEntry, chunk, txn, log);
        if (!neighbourFragmentEntry && nonOverlappingEvents.length === 0 && typeof end === "string") {
            log.log("hit #160, clearing token", log.level.Warn);
            end = null;
        }
        const {entries, updatedEntries} = await this._storeEvents(nonOverlappingEvents, lastKey, direction, state, txn, log);
        const fragments = await this._updateFragments(fragmentEntry, neighbourFragmentEntry, end, entries, txn);
        return {entries, updatedEntries, fragments};
    }
}

function isValidFragmentId(id) {
    return typeof id === "number";
}

function findBackwardSiblingFragments(current, byId) {
    const sortedSiblings = [];
    while (isValidFragmentId(current.previousId)) {
        const previous = byId.get(current.previousId);
        if (!previous) {
            break;
        }
        if (previous.nextId !== current.id) {
            throw new Error(`Previous fragment ${previous.id} doesn't point back to ${current.id}`);
        }
        byId.delete(current.previousId);
        sortedSiblings.unshift(previous);
        current = previous;
    }
    return sortedSiblings;
}
function findForwardSiblingFragments(current, byId) {
    const sortedSiblings = [];
    while (isValidFragmentId(current.nextId)) {
        const next = byId.get(current.nextId);
        if (!next) {
            break;
        }
        if (next.previousId !== current.id) {
            throw new Error(`Next fragment ${next.id} doesn't point back to ${current.id}`);
        }
        byId.delete(current.nextId);
        sortedSiblings.push(next);
        current = next;
    }
    return sortedSiblings;
}
function createIslands(fragments) {
    const byId = new Map();
    for(let f of fragments) {
        byId.set(f.id, f);
    }
    const islands = [];
    while(byId.size) {
        const current = byId.values().next().value;
        byId.delete(current.id);
        const previousSiblings = findBackwardSiblingFragments(current, byId);
        const nextSiblings = findForwardSiblingFragments(current, byId);
        const island = previousSiblings.concat(current, nextSiblings);
        islands.push(island);
    }
    return islands.map(a => new Island(a));
}
class Fragment {
    constructor(id, previousId, nextId) {
        this.id = id;
        this.previousId = previousId;
        this.nextId = nextId;
    }
}
class Island {
    constructor(sortedFragments) {
        this._idToSortIndex = new Map();
        sortedFragments.forEach((f, i) => {
            this._idToSortIndex.set(f.id, i);
        });
    }
    compare(idA, idB) {
        const sortIndexA = this._idToSortIndex.get(idA);
        if (sortIndexA === undefined) {
            throw new Error(`first id ${idA} isn't part of this island`);
        }
        const sortIndexB = this._idToSortIndex.get(idB);
        if (sortIndexB === undefined) {
            throw new Error(`second id ${idB} isn't part of this island`);
        }
        return sortIndexA - sortIndexB;
    }
    get fragmentIds() {
        return this._idToSortIndex.keys();
    }
}
class FragmentIdComparer {
    constructor(fragments) {
        this._fragmentsById = fragments.reduce((map, f) => {map.set(f.id, f); return map;}, new Map());
        this.rebuild(fragments);
    }
    _getIsland(id) {
        const island = this._idToIsland.get(id);
        if (island === undefined) {
            throw new Error(`Unknown fragment id ${id}`);
        }
        return island;
    }
    compare(idA, idB) {
        if (idA === idB) {
            return 0;
        }
        const islandA = this._getIsland(idA);
        const islandB = this._getIsland(idB);
        if (islandA !== islandB) {
            throw new Error(`${idA} and ${idB} are on different islands, can't tell order`);
        }
        return islandA.compare(idA, idB);
    }
    rebuild(fragments) {
        const islands = createIslands(fragments);
        this._idToIsland = new Map();
        for(let island of islands) {
            for(let id of island.fragmentIds) {
                this._idToIsland.set(id, island);
            }
        }
    }
    add(fragment) {
        const copy = new Fragment(fragment.id, fragment.previousId, fragment.nextId);
        this._fragmentsById.set(fragment.id, copy);
        this.rebuild(this._fragmentsById.values());
    }
    append(id, previousId) {
        const fragment = new Fragment(id, previousId, null);
        const prevFragment = this._fragmentsById.get(previousId);
        if (prevFragment) {
            prevFragment.nextId = id;
        }
        this._fragmentsById.set(id, fragment);
        this.rebuild(this._fragmentsById.values());
    }
    prepend(id, nextId) {
        const fragment = new Fragment(id, null, nextId);
        const nextFragment = this._fragmentsById.get(nextId);
        if (nextFragment) {
            nextFragment.previousId = id;
        }
        this._fragmentsById.set(id, fragment);
        this.rebuild(this._fragmentsById.values());
    }
}

function noop () {}
class NullLogger {
    constructor() {
        this.item = new NullLogItem();
    }
    log() {}
    run(_, callback) {
        return callback(this.item);
    }
    wrapOrRun(item, _, callback) {
        if (item) {
            return item.wrap(null, callback);
        } else {
            return this.run(null, callback);
        }
    }
    runDetached(_, callback) {
        new Promise(r => r(callback(this.item))).then(noop, noop);
    }
    async export() {
        return null;
    }
    get level() {
        return LogLevel;
    }
}
class NullLogItem {
    wrap(_, callback) {
        return callback(this);
    }
    log() {}
    set() {}
    runDetached(_, callback) {
        new Promise(r => r(callback(this))).then(noop, noop);
    }
    wrapDetached(_, callback) {
        return this.refDetached(null, callback);
    }
    run(callback) {
        return callback(this);
    }
    refDetached() {}
    get level() {
        return LogLevel;
    }
    get duration() {
        return 0;
    }
    catch(err) {
        return err;
    }
    child() {
        return this;
    }
    finish() {}
}
const Instance = new NullLogger();

class RelationWriter {
    constructor({roomId, ownUserId, fragmentIdComparer}) {
        this._roomId = roomId;
        this._ownUserId = ownUserId;
        this._fragmentIdComparer = fragmentIdComparer;
    }
    async writeRelation(sourceEntry, txn, log) {
        const {relatedEventId} = sourceEntry;
        if (relatedEventId) {
            const relation = getRelation(sourceEntry.event);
            if (relation) {
                txn.timelineRelations.add(this._roomId, relation.event_id, relation.rel_type, sourceEntry.id);
            }
            const target = await txn.timelineEvents.getByEventId(this._roomId, relatedEventId);
            if (target) {
                const updatedStorageEntries = await this._applyRelation(sourceEntry, target, txn, log);
                if (updatedStorageEntries) {
                    return updatedStorageEntries.map(e => {
                        txn.timelineEvents.update(e);
                        return new EventEntry(e, this._fragmentIdComparer);
                    });
                }
            }
        }
        return null;
    }
    async writeGapRelation(storageEntry, direction, txn, log) {
        const sourceEntry = new EventEntry(storageEntry, this._fragmentIdComparer);
        const result = await this.writeRelation(sourceEntry, txn, log);
        if (direction.isBackward && !isRedacted(storageEntry.event)) {
            const relations = await txn.timelineRelations.getAllForTarget(this._roomId, sourceEntry.id);
            if (relations.length) {
                for (const r of relations) {
                    const relationStorageEntry = await txn.timelineEvents.getByEventId(this._roomId, r.sourceEventId);
                    if (relationStorageEntry) {
                        const relationEntry = new EventEntry(relationStorageEntry, this._fragmentIdComparer);
                        await this._applyRelation(relationEntry, storageEntry, txn, log);
                    }
                }
            }
        }
        return result;
    }
    async _applyRelation(sourceEntry, targetStorageEntry, txn, log) {
        if (sourceEntry.eventType === REDACTION_TYPE) {
            return log.wrap("redact", async log => {
                const redactedEvent = targetStorageEntry.event;
                const relation = getRelation(redactedEvent);
                const redacted = this._applyRedaction(sourceEntry.event, targetStorageEntry, txn, log);
                if (redacted) {
                    const updated = [targetStorageEntry];
                    if (relation) {
                        const relationTargetStorageEntry = await this._reaggregateRelation(redactedEvent, relation, txn, log);
                        if (relationTargetStorageEntry) {
                            updated.push(relationTargetStorageEntry);
                        }
                    }
                    return updated;
                }
                return null;
            });
        } else {
            const relation = getRelation(sourceEntry.event);
            if (relation && !isRedacted(targetStorageEntry.event)) {
                const relType = relation.rel_type;
                if (relType === ANNOTATION_RELATION_TYPE) {
                    const aggregated = log.wrap("react", log => {
                        return this._aggregateAnnotation(sourceEntry.event, targetStorageEntry, log);
                    });
                    if (aggregated) {
                        return [targetStorageEntry];
                    }
                }
            }
        }
        return null;
    }
    _applyRedaction(redactionEvent, redactedStorageEntry, txn, log) {
        const redactedEvent = redactedStorageEntry.event;
        log.set("redactionId", redactionEvent.event_id);
        log.set("id", redactedEvent.event_id);
        const relation = getRelation(redactedEvent);
        if (relation) {
            txn.timelineRelations.remove(this._roomId, relation.event_id, relation.rel_type, redactedEvent.event_id);
        }
        txn.timelineRelations.removeAllForTarget(this._roomId, redactedEvent.event_id);
        for (const key of Object.keys(redactedEvent)) {
            if (!_REDACT_KEEP_KEY_MAP[key]) {
                delete redactedEvent[key];
            }
        }
        const {content} = redactedEvent;
        const keepMap = _REDACT_KEEP_CONTENT_MAP[redactedEvent.type];
        for (const key of Object.keys(content)) {
            if (!keepMap?.[key]) {
                delete content[key];
            }
        }
        redactedEvent.unsigned = redactedEvent.unsigned || {};
        redactedEvent.unsigned.redacted_because = redactionEvent;
        delete redactedStorageEntry.annotations;
        return true;
    }
    _aggregateAnnotation(annotationEvent, targetStorageEntry, log) {
        const relation = getRelation(annotationEvent);
        if (!relation) {
            return false;
        }
        let {annotations} = targetStorageEntry;
        if (!annotations) {
            targetStorageEntry.annotations = annotations = {};
        }
        let annotation = annotations[relation.key];
        if (!annotation) {
            annotations[relation.key] = annotation = {
                count: 0,
                me: false,
                firstTimestamp: Number.MAX_SAFE_INTEGER
            };
        }
        const sentByMe = annotationEvent.sender === this._ownUserId;
        annotation.me = annotation.me || sentByMe;
        annotation.count += 1;
        annotation.firstTimestamp = Math.min(
            annotation.firstTimestamp,
            annotationEvent.origin_server_ts
        );
        return true;
    }
    async _reaggregateRelation(redactedRelationEvent, redactedRelation, txn, log) {
        if (redactedRelation.rel_type === ANNOTATION_RELATION_TYPE) {
            return log.wrap("reaggregate annotations", log => this._reaggregateAnnotation(
                redactedRelation.event_id,
                redactedRelation.key,
                txn, log
            ));
        }
        return null;
    }
    async _reaggregateAnnotation(targetId, key, txn, log) {
        const target = await txn.timelineEvents.getByEventId(this._roomId, targetId);
        if (!target) {
            return null;
        }
        log.set("id", targetId);
        const relations = await txn.timelineRelations.getForTargetAndType(this._roomId, targetId, ANNOTATION_RELATION_TYPE);
        log.set("relations", relations.length);
        delete target.annotations[key];
        if (isObjectEmpty(target.annotations)) {
            delete target.annotations;
        }
        await Promise.all(relations.map(async relation => {
            const annotation = await txn.timelineEvents.getByEventId(this._roomId, relation.sourceEventId);
            if (!annotation) {
                log.log({l: "missing annotation", id: relation.sourceEventId});
            }
            if (getRelation(annotation.event).key === key) {
                this._aggregateAnnotation(annotation.event, target, log);
            }
        }));
        return target;
    }
}
function isObjectEmpty(obj) {
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            return false;
        }
    }
    return true;
}
const _REDACT_KEEP_KEY_MAP = [
    'event_id', 'type', 'room_id', 'user_id', 'sender', 'state_key', 'prev_state',
    'content', 'unsigned', 'origin_server_ts',
].reduce(function(ret, val) {
    ret[val] = 1; return ret;
}, {});
const _REDACT_KEEP_CONTENT_MAP = {
    'm.room.member': {'membership': 1},
    'm.room.create': {'creator': 1},
    'm.room.join_rules': {'join_rule': 1},
    'm.room.power_levels': {'ban': 1, 'events': 1, 'events_default': 1,
                            'kick': 1, 'redact': 1, 'state_default': 1,
                            'users': 1, 'users_default': 1,
                           },
    'm.room.aliases': {'aliases': 1},
};

class BaseObservableList extends BaseObservable {
    emitReset() {
        for(let h of this._handlers) {
            h.onReset(this);
        }
    }
    emitAdd(index, value) {
        for(let h of this._handlers) {
            h.onAdd(index, value, this);
        }
    }
    emitUpdate(index, value, params) {
        for(let h of this._handlers) {
            h.onUpdate(index, value, params, this);
        }
    }
    emitRemove(index, value) {
        for(let h of this._handlers) {
            h.onRemove(index, value, this);
        }
    }
    emitMove(fromIdx, toIdx, value) {
        for(let h of this._handlers) {
            h.onMove(fromIdx, toIdx, value, this);
        }
    }
    [Symbol.iterator]() {
        throw new Error("unimplemented");
    }
    get length() {
        throw new Error("unimplemented");
    }
}

function sortedIndex(array, value, comparator) {
    let low = 0;
    let high = array.length;
    while (low < high) {
        let mid = (low + high) >>> 1;
        let cmpResult = comparator(value, array[mid]);
        if (cmpResult > 0) {
            low = mid + 1;
        } else if (cmpResult < 0) {
            high = mid;
        } else {
            low = high = mid;
        }
    }
    return high;
}

class BaseObservableMap extends BaseObservable {
    emitReset() {
        for(let h of this._handlers) {
            h.onReset();
        }
    }
    emitAdd(key, value) {
        for(let h of this._handlers) {
            h.onAdd(key, value);
        }
    }
    emitUpdate(key, value, ...params) {
        for(let h of this._handlers) {
            h.onUpdate(key, value, ...params);
        }
    }
    emitRemove(key, value) {
        for(let h of this._handlers) {
            h.onRemove(key, value);
        }
    }
    [Symbol.iterator]() {
        throw new Error("unimplemented");
    }
    get size() {
        throw new Error("unimplemented");
    }
    get(key) {
        throw new Error("unimplemented");
    }
}

class ObservableMap extends BaseObservableMap {
    constructor(initialValues) {
        super();
        this._values = new Map(initialValues);
    }
    update(key, params) {
        const value = this._values.get(key);
        if (value !== undefined) {
            this._values.set(key, value);
            this.emitUpdate(key, value, params);
            return true;
        }
        return false;
    }
    add(key, value) {
        if (!this._values.has(key)) {
            this._values.set(key, value);
            this.emitAdd(key, value);
            return true;
        }
        return false;
    }
    remove(key) {
        const value = this._values.get(key);
        if (value !== undefined) {
            this._values.delete(key);
            this.emitRemove(key, value);
            return true;
        } else {
            return false;
        }
    }
    reset() {
        this._values.clear();
        this.emitReset();
    }
    get(key) {
        return this._values.get(key);
    }
    get size() {
        return this._values.size;
    }
    [Symbol.iterator]() {
        return this._values.entries();
    }
    values() {
        return this._values.values();
    }
    keys() {
        return this._values.keys();
    }
}

class SortedMapList extends BaseObservableList {
    constructor(sourceMap, comparator) {
        super();
        this._sourceMap = sourceMap;
        this._comparator = (a, b) => comparator(a.value, b.value);
        this._sortedPairs = null;
        this._mapSubscription = null;
    }
    onAdd(key, value) {
        const pair = {key, value};
        const idx = sortedIndex(this._sortedPairs, pair, this._comparator);
        this._sortedPairs.splice(idx, 0, pair);
        this.emitAdd(idx, value);
    }
    onRemove(key, value) {
        const pair = {key, value};
        const idx = sortedIndex(this._sortedPairs, pair, this._comparator);
        this._sortedPairs.splice(idx, 1);
        this.emitRemove(idx, value);
    }
    onUpdate(key, value, params) {
        if (!this._sortedPairs) {
            return;
        }
        const oldIdx = this._sortedPairs.findIndex(p => p.key === key);
        this._sortedPairs.splice(oldIdx, 1);
        const pair = {key, value};
        const newIdx = sortedIndex(this._sortedPairs, pair, this._comparator);
        this._sortedPairs.splice(newIdx, 0, pair);
        if (oldIdx !== newIdx) {
            this.emitMove(oldIdx, newIdx, value);
        }
        this.emitUpdate(newIdx, value, params);
    }
    onReset() {
        this._sortedPairs = [];
        this.emitReset();
    }
    onSubscribeFirst() {
        this._mapSubscription = this._sourceMap.subscribe(this);
        this._sortedPairs = new Array(this._sourceMap.size);
        let i = 0;
        for (let [key, value] of this._sourceMap) {
            this._sortedPairs[i] = {key, value};
            ++i;
        }
        this._sortedPairs.sort(this._comparator);
        super.onSubscribeFirst();
    }
    onUnsubscribeLast() {
        super.onUnsubscribeLast();
        this._sortedPairs = null;
        this._mapSubscription = this._mapSubscription();
    }
    get(index) {
        return this._sortedPairs[index].value;
    }
    get length() {
        return this._sourceMap.size;
    }
    [Symbol.iterator]() {
        const it = this._sortedPairs.values();
        return {
            next() {
                const v = it.next();
                if (v.value) {
                    v.value = v.value.value;
                }
                return v;
            }
        }
    }
}

class FilteredMap extends BaseObservableMap {
    constructor(source, filter) {
        super();
        this._source = source;
        this._filter = filter;
        this._included = null;
        this._subscription = null;
    }
    setFilter(filter) {
        this._filter = filter;
        if (this._subscription) {
            this._reapplyFilter();
        }
    }
    _reapplyFilter(silent = false) {
        if (this._filter) {
            const oldIncluded = this._included;
            this._included = this._included || new Map();
            for (const [key, value] of this._source) {
                const isIncluded = this._filter(value, key);
                this._included.set(key, isIncluded);
                if (!silent) {
                    const wasIncluded = oldIncluded ? oldIncluded.get(key) : true;
                    this._emitForUpdate(wasIncluded, isIncluded, key, value);
                }
            }
        } else {
            if (this._included && !silent) {
                for (const [key, value] of this._source) {
                    if (!this._included.get(key)) {
                        this.emitAdd(key, value);
                    }
                }
            }
            this._included = null;
        }
    }
    onAdd(key, value) {
        if (this._filter) {
            const included = this._filter(value, key);
            this._included.set(key, included);
            if (!included) {
                return;
            }
        }
        this.emitAdd(key, value);
    }
    onRemove(key, value) {
        const wasIncluded = !this._filter || this._included.get(key);
        this._included.delete(key);
        if (wasIncluded) {
            this.emitRemove(key, value);
        }
    }
    onUpdate(key, value, params) {
        if (!this._included) {
            return;
        }
        if (this._filter) {
            const wasIncluded = this._included.get(key);
            const isIncluded = this._filter(value, key);
            this._included.set(key, isIncluded);
            this._emitForUpdate(wasIncluded, isIncluded, key, value, params);
        }
        this.emitUpdate(key, value, params);
    }
    _emitForUpdate(wasIncluded, isIncluded, key, value, params = null) {
        if (wasIncluded && !isIncluded) {
            this.emitRemove(key, value);
        } else if (!wasIncluded && isIncluded) {
            this.emitAdd(key, value);
        } else if (wasIncluded && isIncluded) {
            this.emitUpdate(key, value, params);
        }
    }
    onSubscribeFirst() {
        this._subscription = this._source.subscribe(this);
        this._reapplyFilter(true);
        super.onSubscribeFirst();
    }
    onUnsubscribeLast() {
        super.onUnsubscribeLast();
        this._included = null;
        this._subscription = this._subscription();
    }
    onReset() {
        this._reapplyFilter();
        this.emitReset();
    }
    [Symbol.iterator]() {
        return new FilterIterator(this._source, this._included);
    }
    get size() {
        let count = 0;
        this._included.forEach(included => {
            if (included) {
                count += 1;
            }
        });
        return count;
    }
    get(key) {
        const value = this._source.get(key);
        if (value && this._filter(value, key)) {
            return value;
        }
    }
}
class FilterIterator {
    constructor(map, _included) {
        this._included = _included;
        this._sourceIterator = map[Symbol.iterator]();
    }
    next() {
        while (true) {
            const sourceResult = this._sourceIterator.next();
            if (sourceResult.done) {
                return sourceResult;
            }
            const key = sourceResult.value[0];
            if (this._included.get(key)) {
                return sourceResult;
            }
        }
    }
}

class MappedMap extends BaseObservableMap {
    constructor(source, mapper) {
        super();
        this._source = source;
        this._mapper = mapper;
        this._mappedValues = new Map();
    }
    _emitSpontaneousUpdate(key, params) {
        const value = this._mappedValues.get(key);
        if (value) {
            this.emitUpdate(key, value, params);
        }
    }
    onAdd(key, value) {
        const emitSpontaneousUpdate = this._emitSpontaneousUpdate.bind(this, key);
        const mappedValue = this._mapper(value, emitSpontaneousUpdate);
        this._mappedValues.set(key, mappedValue);
        this.emitAdd(key, mappedValue);
    }
    onRemove(key, _value) {
        const mappedValue = this._mappedValues.get(key);
        if (this._mappedValues.delete(key)) {
            this.emitRemove(key, mappedValue);
        }
    }
    onUpdate(key, value, params) {
        if (!this._mappedValues) {
            return;
        }
        const mappedValue = this._mappedValues.get(key);
        if (mappedValue !== undefined) {
            this.emitUpdate(key, mappedValue, params);
        }
    }
    onSubscribeFirst() {
        this._subscription = this._source.subscribe(this);
        for (let [key, value] of this._source) {
            const emitSpontaneousUpdate = this._emitSpontaneousUpdate.bind(this, key);
            const mappedValue = this._mapper(value, emitSpontaneousUpdate);
            this._mappedValues.set(key, mappedValue);
        }
        super.onSubscribeFirst();
    }
    onUnsubscribeLast() {
        super.onUnsubscribeLast();
        this._subscription = this._subscription();
        this._mappedValues.clear();
    }
    onReset() {
        this._mappedValues.clear();
        this.emitReset();
    }
    [Symbol.iterator]() {
        return this._mappedValues.entries();
    }
    get size() {
        return this._mappedValues.size;
    }
    get(key) {
        return this._mappedValues.get(key);
    }
}

class JoinedMap extends BaseObservableMap {
    constructor(sources) {
        super();
        this._sources = sources;
        this._subscriptions = null;
    }
    onAdd(source, key, value) {
        if (!this._isKeyAtSourceOccluded(source, key)) {
            const occludingValue = this._getValueFromOccludedSources(source, key);
            if (occludingValue !== undefined) {
                this.emitRemove(key, occludingValue);
            }
            this.emitAdd(key, value);
        }
    }
    onRemove(source, key, value) {
        if (!this._isKeyAtSourceOccluded(source, key)) {
            this.emitRemove(key, value);
            const occludedValue = this._getValueFromOccludedSources(source, key);
            if (occludedValue !== undefined) {
                this.emitAdd(key, occludedValue);
            }
        }
    }
    onUpdate(source, key, value, params) {
        if (!this._subscriptions) {
            return;
        }
        if (!this._isKeyAtSourceOccluded(source, key)) {
            this.emitUpdate(key, value, params);
        }
    }
    onReset() {
        this.emitReset();
    }
    onSubscribeFirst() {
        this._subscriptions = this._sources.map(source => new SourceSubscriptionHandler(source, this).subscribe());
        super.onSubscribeFirst();
    }
    _isKeyAtSourceOccluded(source, key) {
        const index = this._sources.indexOf(source);
        for (let i = 0; i < index; i += 1) {
            if (this._sources[i].get(key) !== undefined) {
                return true;
            }
        }
        return false;
    }
    _getValueFromOccludedSources(source, key) {
        const index = this._sources.indexOf(source);
        for (let i = index + 1; i < this._sources.length; i += 1) {
            const source = this._sources[i];
            const occludedValue = source.get(key);
            if (occludedValue !== undefined) {
                return occludedValue;
            }
        }
        return undefined;
    }
    onUnsubscribeLast() {
        super.onUnsubscribeLast();
        for (const s of this._subscriptions) {
            s.dispose();
        }
    }
    [Symbol.iterator]() {
        return new JoinedIterator(this._sources);
    }
    get size() {
        return this._sources.reduce((sum, s) => sum + s.size, 0);
    }
    get(key) {
        for (const s of this._sources) {
            const value = s.get(key);
            if (value) {
                return value;
            }
        }
        return null;
    }
}
class JoinedIterator {
    constructor(sources) {
        this._sources = sources;
        this._sourceIndex = -1;
        this._currentIterator = null;
        this._encounteredKeys = new Set();
    }
    next() {
        let result;
        while (!result) {
            if (!this._currentIterator) {
                this._sourceIndex += 1;
                if (this._sources.length <= this._sourceIndex) {
                    return {done: true};
                }
                this._currentIterator = this._sources[this._sourceIndex][Symbol.iterator]();
            }
            const sourceResult = this._currentIterator.next();
            if (sourceResult.done) {
                this._currentIterator = null;
                continue;
            } else {
                const key = sourceResult.value[0];
                if (!this._encounteredKeys.has(key)) {
                    this._encounteredKeys.add(key);
                    result = sourceResult;
                }
            }
        }
        return result;
    }
}
class SourceSubscriptionHandler {
    constructor(source, joinedMap) {
        this._source = source;
        this._joinedMap = joinedMap;
        this._subscription = null;
    }
    subscribe() {
        this._subscription = this._source.subscribe(this);
        return this;
    }
    dispose() {
        this._subscription = this._subscription();
    }
    onAdd(key, value) {
        this._joinedMap.onAdd(this._source, key, value);
    }
    onRemove(key, value) {
        this._joinedMap.onRemove(this._source, key, value);
    }
    onUpdate(key, value, params) {
        this._joinedMap.onUpdate(this._source, key, value, params);
    }
    onReset() {
        this._joinedMap.onReset(this._source);
    }
}

class ObservableArray extends BaseObservableList {
    constructor(initialValues = []) {
        super();
        this._items = initialValues;
    }
    append(item) {
        this._items.push(item);
        this.emitAdd(this._items.length - 1, item);
    }
    remove(idx) {
        const [item] = this._items.splice(idx, 1);
        this.emitRemove(idx, item);
    }
    insertMany(idx, items) {
        for(let item of items) {
            this.insert(idx, item);
            idx += 1;
        }
    }
    insert(idx, item) {
        this._items.splice(idx, 0, item);
        this.emitAdd(idx, item);
    }
    update(idx, item, params = null) {
        if (idx < this._items.length) {
            this._items[idx] = item;
            this.emitUpdate(idx, item, params);
        }
    }
    get array() {
        return this._items;
    }
    at(idx) {
        if (this._items && idx >= 0 && idx < this._items.length) {
            return this._items[idx];
        }
    }
    get length() {
        return this._items.length;
    }
    [Symbol.iterator]() {
        return this._items.values();
    }
}

function findAndUpdateInArray(predicate, array, observable, updater) {
    const index = array.findIndex(predicate);
    if (index !== -1) {
        const value = array[index];
        const params = updater(value);
        if (params !== false) {
            observable.emitUpdate(index, value, params);
        }
        return true;
    }
    return false;
}

class SortedArray extends BaseObservableList {
    constructor(comparator) {
        super();
        this._comparator = comparator;
        this._items = [];
    }
    setManyUnsorted(items) {
        this.setManySorted(items);
    }
    setManySorted(items) {
        for(let item of items) {
            this.set(item);
        }
    }
    findAndUpdate(predicate, updater) {
        return findAndUpdateInArray(predicate, this._items, this, updater);
    }
    getAndUpdate(item, updater, updateParams = null) {
        const idx = this.indexOf(item);
        if (idx !== -1) {
            const existingItem = this._items[idx];
            const newItem = updater(existingItem, item);
            this._items[idx] = newItem;
            this.emitUpdate(idx, newItem, updateParams);
        }
    }
    update(item, updateParams = null) {
        const idx = this.indexOf(item);
        if (idx !== -1) {
            this._items[idx] = item;
            this.emitUpdate(idx, item, updateParams);
        }
    }
    indexOf(item) {
        const idx = sortedIndex(this._items, item, this._comparator);
        if (idx < this._items.length && this._comparator(this._items[idx], item) === 0) {
            return idx;
        } else {
            return -1;
        }
    }
    _getNext(item) {
        let idx = sortedIndex(this._items, item, this._comparator);
        while(idx < this._items.length && this._comparator(this._items[idx], item) <= 0) {
            idx += 1;
        }
        return this.get(idx);
    }
    set(item, updateParams = null) {
        const idx = sortedIndex(this._items, item, this._comparator);
        if (idx >= this._items.length || this._comparator(this._items[idx], item) !== 0) {
            this._items.splice(idx, 0, item);
            this.emitAdd(idx, item);
        } else {
            this._items[idx] = item;
            this.emitUpdate(idx, item, updateParams);
        }
    }
    get(idx) {
        return this._items[idx];
    }
    remove(idx) {
        const item = this._items[idx];
        this._items.splice(idx, 1);
        this.emitRemove(idx, item);
    }
    get array() {
        return this._items;
    }
    get length() {
        return this._items.length;
    }
    [Symbol.iterator]() {
        return new Iterator(this);
    }
}
class Iterator {
    constructor(sortedArray) {
        this._sortedArray = sortedArray;
        this._current = null;
    }
    next() {
        if (this._sortedArray) {
            if (this._current) {
                this._current = this._sortedArray._getNext(this._current);
            } else {
                this._current = this._sortedArray.get(0);
            }
            if (this._current) {
                return {value: this._current};
            } else {
                this._sortedArray = null;
            }
        }
        if (!this._sortedArray) {
            return {done: true};
        }
    }
}

class BaseMappedList extends BaseObservableList {
    constructor(sourceList, mapper, updater, removeCallback) {
        super();
        this._sourceList = sourceList;
        this._mapper = mapper;
        this._updater = updater;
        this._removeCallback = removeCallback;
        this._mappedValues = null;
        this._sourceUnsubscribe = null;
    }
    findAndUpdate(predicate, updater) {
        return findAndUpdateInArray(predicate, this._mappedValues, this, updater);
    }
    get length() {
        return this._mappedValues.length;
    }
    [Symbol.iterator]() {
        return this._mappedValues.values();
    }
}
function runAdd(list, index, mappedValue) {
    list._mappedValues.splice(index, 0, mappedValue);
    list.emitAdd(index, mappedValue);
}
function runUpdate(list, index, value, params) {
    const mappedValue = list._mappedValues[index];
    if (list._updater) {
        list._updater(mappedValue, params, value);
    }
    list.emitUpdate(index, mappedValue, params);
}
function runRemove(list, index) {
    const mappedValue = list._mappedValues[index];
    list._mappedValues.splice(index, 1);
    if (list._removeCallback) {
        list._removeCallback(mappedValue);
    }
    list.emitRemove(index, mappedValue);
}
function runMove(list, fromIdx, toIdx) {
    const mappedValue = list._mappedValues[fromIdx];
    list._mappedValues.splice(fromIdx, 1);
    list._mappedValues.splice(toIdx, 0, mappedValue);
    list.emitMove(fromIdx, toIdx, mappedValue);
}
function runReset(list) {
    list._mappedValues = [];
    list.emitReset();
}

class AsyncMappedList extends BaseMappedList {
    constructor(sourceList, mapper, updater, removeCallback) {
        super(sourceList, mapper, updater, removeCallback);
        this._eventQueue = null;
    }
    onSubscribeFirst() {
        this._sourceUnsubscribe = this._sourceList.subscribe(this);
        this._eventQueue = [];
        this._mappedValues = [];
        let idx = 0;
        for (const item of this._sourceList) {
            this._eventQueue.push(new AddEvent(idx, item));
            idx += 1;
        }
        this._flush();
    }
    async _flush() {
        if (this._flushing) {
            return;
        }
        this._flushing = true;
        try {
            while (this._eventQueue.length) {
                const event = this._eventQueue.shift();
                await event.run(this);
            }
        } finally {
            this._flushing = false;
        }
    }
    onReset() {
        if (this._eventQueue) {
            this._eventQueue.push(new ResetEvent());
            this._flush();
        }
    }
    onAdd(index, value) {
        if (this._eventQueue) {
            this._eventQueue.push(new AddEvent(index, value));
            this._flush();
        }
    }
    onUpdate(index, value, params) {
        if (this._eventQueue) {
            this._eventQueue.push(new UpdateEvent(index, value, params));
            this._flush();
        }
    }
    onRemove(index) {
        if (this._eventQueue) {
            this._eventQueue.push(new RemoveEvent(index));
            this._flush();
        }
    }
    onMove(fromIdx, toIdx) {
        if (this._eventQueue) {
            this._eventQueue.push(new MoveEvent(fromIdx, toIdx));
            this._flush();
        }
    }
    onUnsubscribeLast() {
        this._sourceUnsubscribe();
        this._eventQueue = null;
        this._mappedValues = null;
    }
}
class AddEvent {
    constructor(index, value) {
        this.index = index;
        this.value = value;
    }
    async run(list) {
        const mappedValue = await list._mapper(this.value);
        runAdd(list, this.index, mappedValue);
    }
}
class UpdateEvent {
    constructor(index, value, params) {
        this.index = index;
        this.value = value;
        this.params = params;
    }
    async run(list) {
        runUpdate(list, this.index, this.value, this.params);
    }
}
class RemoveEvent {
    constructor(index) {
        this.index = index;
    }
    async run(list) {
        runRemove(list, this.index);
    }
}
class MoveEvent {
    constructor(fromIdx, toIdx) {
        this.fromIdx = fromIdx;
        this.toIdx = toIdx;
    }
    async run(list) {
        runMove(list, this.fromIdx, this.toIdx);
    }
}
class ResetEvent {
    async run(list) {
        runReset(list);
    }
}

class ConcatList extends BaseObservableList {
    constructor(...sourceLists) {
        super();
        this._sourceLists = sourceLists;
        this._sourceUnsubscribes = null;
    }
    _offsetForSource(sourceList) {
        const listIdx = this._sourceLists.indexOf(sourceList);
        let offset = 0;
        for (let i = 0; i < listIdx; ++i) {
            offset += this._sourceLists[i].length;
        }
        return offset;
    }
    onSubscribeFirst() {
        this._sourceUnsubscribes = this._sourceLists.map(sourceList => sourceList.subscribe(this));
    }
    onUnsubscribeLast() {
        for (const sourceUnsubscribe of this._sourceUnsubscribes) {
            sourceUnsubscribe();
        }
    }
    onReset() {
        this.emitReset();
        let idx = 0;
        for(const item of this) {
            this.emitAdd(idx, item);
            idx += 1;
        }
    }
    onAdd(index, value, sourceList) {
        this.emitAdd(this._offsetForSource(sourceList) + index, value);
    }
    onUpdate(index, value, params, sourceList) {
        if (!this._sourceUnsubscribes) {
            return;
        }
        this.emitUpdate(this._offsetForSource(sourceList) + index, value, params);
    }
    onRemove(index, value, sourceList) {
        this.emitRemove(this._offsetForSource(sourceList) + index, value);
    }
    onMove(fromIdx, toIdx, value, sourceList) {
        const offset = this._offsetForSource(sourceList);
        this.emitMove(offset + fromIdx, offset + toIdx, value);
    }
    get length() {
        let len = 0;
        for (let i = 0; i < this._sourceLists.length; ++i) {
            len += this._sourceLists[i].length;
        }
        return len;
    }
    [Symbol.iterator]() {
        let sourceListIdx = 0;
        let it = this._sourceLists[0][Symbol.iterator]();
        return {
            next: () => {
                let result = it.next();
                while (result.done) {
                    sourceListIdx += 1;
                    if (sourceListIdx >= this._sourceLists.length) {
                        return result;
                    }
                    it = this._sourceLists[sourceListIdx][Symbol.iterator]();
                    result = it.next();
                }
                return result;
            }
        }
    }
}

Object.assign(BaseObservableMap.prototype, {
    sortValues(comparator) {
        return new SortedMapList(this, comparator);
    },
    mapValues(mapper) {
        return new MappedMap(this, mapper);
    },
    filterValues(filter) {
        return new FilteredMap(this, filter);
    },
    join(...otherMaps) {
        return new JoinedMap([this].concat(otherMaps));
    }
});

class Direction {
    constructor(isForward) {
        this._isForward = isForward;
    }
    get isForward() {
        return this._isForward;
    }
    get isBackward() {
        return !this.isForward;
    }
    asApiString() {
        return this.isForward ? "f" : "b";
    }
    reverse() {
        return this.isForward ? Direction.Backward : Direction.Forward
    }
    static get Forward() {
        return _forward;
    }
    static get Backward() {
        return _backward;
    }
}
const _forward = Object.freeze(new Direction(true));
const _backward = Object.freeze(new Direction(false));

class FragmentBoundaryEntry extends BaseEntry {
    constructor(fragment, isFragmentStart, fragmentIdComparer) {
        super(fragmentIdComparer);
        this._fragment = fragment;
        this._isFragmentStart = isFragmentStart;
    }
    static start(fragment, fragmentIdComparer) {
        return new FragmentBoundaryEntry(fragment, true, fragmentIdComparer);
    }
    static end(fragment, fragmentIdComparer) {
        return new FragmentBoundaryEntry(fragment, false, fragmentIdComparer);
    }
    get started() {
        return this._isFragmentStart;
    }
    get hasEnded() {
        return !this.started;
    }
    get fragment() {
        return this._fragment;
    }
    get fragmentId() {
        return this._fragment.id;
    }
    get entryIndex() {
        if (this.started) {
            return KeyLimits.minStorageKey;
        } else {
            return KeyLimits.maxStorageKey;
        }
    }
    get isGap() {
        return !!this.token && !this.edgeReached;
    }
    get token() {
        if (this.started) {
            return this.fragment.previousToken;
        } else {
            return this.fragment.nextToken;
        }
    }
    set token(token) {
        if (this.started) {
            this.fragment.previousToken = token;
        } else {
            this.fragment.nextToken = token;
        }
    }
    get edgeReached() {
        if (this.started) {
            return this.fragment.startReached;
        } else {
            return this.fragment.endReached;
        }
    }
    set edgeReached(reached) {
        if (this.started) {
            this.fragment.startReached = reached;
        } else {
            this.fragment.endReached = reached;
        }
    }
    get linkedFragmentId() {
        if (this.started) {
            return this.fragment.previousId;
        } else {
            return this.fragment.nextId;
        }
    }
    set linkedFragmentId(id) {
        if (this.started) {
            this.fragment.previousId = id;
        } else {
            this.fragment.nextId = id;
        }
    }
    get hasLinkedFragment() {
        return isValidFragmentId(this.linkedFragmentId);
    }
    get direction() {
        if (this.started) {
            return Direction.Backward;
        } else {
            return Direction.Forward;
        }
    }
    withUpdatedFragment(fragment) {
        return new FragmentBoundaryEntry(fragment, this._isFragmentStart, this._fragmentIdComparer);
    }
    createNeighbourEntry(neighbour) {
        return new FragmentBoundaryEntry(neighbour, !this._isFragmentStart, this._fragmentIdComparer);
    }
    addLocalRelation() {}
    removeLocalRelation() {}
}

class ReaderRequest {
    constructor(fn, log) {
        this.decryptRequest = null;
        this._promise = fn(this, log);
    }
    complete() {
        return this._promise;
    }
    dispose() {
        if (this.decryptRequest) {
            this.decryptRequest.dispose();
            this.decryptRequest = null;
        }
    }
}
async function readRawTimelineEntriesWithTxn(roomId, eventKey, direction, amount, fragmentIdComparer, txn) {
    let entries = [];
    const timelineStore = txn.timelineEvents;
    const fragmentStore = txn.timelineFragments;
    while (entries.length < amount && eventKey) {
        let eventsWithinFragment;
        if (direction.isForward) {
            eventsWithinFragment = await timelineStore.eventsAfter(roomId, eventKey, amount);
        } else {
            eventsWithinFragment = await timelineStore.eventsBefore(roomId, eventKey, amount);
        }
        let eventEntries = eventsWithinFragment.map(e => new EventEntry(e, fragmentIdComparer));
        entries = directionalConcat(entries, eventEntries, direction);
        if (entries.length < amount) {
            const fragment = await fragmentStore.get(roomId, eventKey.fragmentId);
            let fragmentEntry = new FragmentBoundaryEntry(fragment, direction.isBackward, fragmentIdComparer);
            directionalAppend(entries, fragmentEntry, direction);
            if (!fragmentEntry.token && fragmentEntry.hasLinkedFragment) {
                const nextFragment = await fragmentStore.get(roomId, fragmentEntry.linkedFragmentId);
                fragmentIdComparer.add(nextFragment);
                const nextFragmentEntry = new FragmentBoundaryEntry(nextFragment, direction.isForward, fragmentIdComparer);
                directionalAppend(entries, nextFragmentEntry, direction);
                eventKey = nextFragmentEntry.asEventKey();
            } else {
                eventKey = null;
            }
        }
    }
    return entries;
}
class TimelineReader {
    constructor({roomId, storage, fragmentIdComparer}) {
        this._roomId = roomId;
        this._storage = storage;
        this._fragmentIdComparer = fragmentIdComparer;
        this._decryptEntries = null;
    }
    enableEncryption(decryptEntries) {
        this._decryptEntries = decryptEntries;
    }
    get readTxnStores() {
        const stores = [
            this._storage.storeNames.timelineEvents,
            this._storage.storeNames.timelineFragments,
        ];
        if (this._decryptEntries) {
            stores.push(this._storage.storeNames.inboundGroupSessions);
        }
        return stores;
    }
    readFrom(eventKey, direction, amount, log) {
        return new ReaderRequest(async (r, log) => {
            const txn = await this._storage.readTxn(this.readTxnStores);
            return await this._readFrom(eventKey, direction, amount, r, txn, log);
        }, log);
    }
    readFromEnd(amount, existingTxn = null, log) {
        return new ReaderRequest(async (r, log) => {
            const txn = existingTxn || await this._storage.readTxn(this.readTxnStores);
            const liveFragment = await txn.timelineFragments.liveFragment(this._roomId);
            let entries;
            if (!liveFragment) {
                entries = [];
            } else {
                this._fragmentIdComparer.add(liveFragment);
                const liveFragmentEntry = FragmentBoundaryEntry.end(liveFragment, this._fragmentIdComparer);
                const eventKey = liveFragmentEntry.asEventKey();
                entries = await this._readFrom(eventKey, Direction.Backward, amount, r, txn, log);
                entries.unshift(liveFragmentEntry);
            }
            return entries;
        }, log);
    }
    async _readFrom(eventKey, direction, amount, r, txn, log) {
        const entries = await readRawTimelineEntriesWithTxn(this._roomId, eventKey, direction, amount, this._fragmentIdComparer, txn);
        if (this._decryptEntries) {
            r.decryptRequest = this._decryptEntries(entries, txn, log);
            try {
                await r.decryptRequest.complete();
            } finally {
                r.decryptRequest = null;
            }
        }
        return entries;
    }
}

class PowerLevels {
    constructor({powerLevelEvent, createEvent, ownUserId, membership}) {
        this._plEvent = powerLevelEvent;
        this._createEvent = createEvent;
        this._ownUserId = ownUserId;
        this._membership = membership;
    }
    canRedactFromSender(userId) {
        if (userId === this._ownUserId && this._membership === "join") {
            return true;
        } else {
            return this.canRedact;
        }
    }
    canSendType(eventType) {
        return this._myLevel >= this._getEventTypeLevel(eventType);
    }
    get canRedact() {
        return this._myLevel >= this._getActionLevel("redact");
    }
    get _myLevel() {
        if (this._membership !== "join") {
            return Number.MIN_SAFE_INTEGER;
        }
        return this._getUserLevel(this._ownUserId);
    }
    _getUserLevel(userId) {
        if (this._plEvent) {
            let userLevel = this._plEvent.content?.users?.[userId];
            if (typeof userLevel !== "number") {
                userLevel = this._plEvent.content?.users_default;
            }
            if (typeof userLevel === "number") {
                return userLevel;
            }
        } else if (this._createEvent) {
            if (userId === this._createEvent.content?.creator) {
                return 100;
            }
        }
        return 0;
    }
    _getActionLevel(action) {
        const level = this._plEvent?.content[action];
        if (typeof level === "number") {
            return level;
        } else {
            return 50;
        }
    }
    _getEventTypeLevel(eventType) {
        const level = this._plEvent?.content.events?.[eventType];
        if (typeof level === "number") {
            return level;
        } else {
            const level = this._plEvent?.content.events_default;
            if (typeof level === "number") {
                return level;
            } else {
                return 0;
            }
        }
    }
}

class User {
    constructor(userId) {
        this._userId = userId;
    }
    get id() {
        return this._userId;
    }
}

class Timeline {
    constructor({roomId, storage, closeCallback, fragmentIdComparer, pendingEvents, clock}) {
        this._roomId = roomId;
        this._storage = storage;
        this._closeCallback = closeCallback;
        this._fragmentIdComparer = fragmentIdComparer;
        this._disposables = new Disposables();
        this._pendingEvents = pendingEvents;
        this._clock = clock;
        this._remoteEntries = new SortedArray((a, b) => a.compare(b));
        this._ownMember = null;
        this._timelineReader = new TimelineReader({
            roomId: this._roomId,
            storage: this._storage,
            fragmentIdComparer: this._fragmentIdComparer
        });
        this._readerRequest = null;
        this._allEntries = null;
        this._powerLevels = null;
    }
    async load(user, membership, log) {
        const txn = await this._storage.readTxn(this._timelineReader.readTxnStores.concat(
            this._storage.storeNames.roomMembers,
            this._storage.storeNames.roomState
        ));
        const memberData = await txn.roomMembers.get(this._roomId, user.id);
        if (memberData) {
            this._ownMember = new RoomMember(memberData);
        } else {
            this._ownMember = RoomMember.fromUserId(this._roomId, user.id, membership);
        }
        this._powerLevels = await this._loadPowerLevels(membership, txn);
        const readerRequest = this._disposables.track(this._timelineReader.readFromEnd(30, txn, log));
        try {
            const entries = await readerRequest.complete();
            this._setupEntries(entries);
        } finally {
            this._disposables.disposeTracked(readerRequest);
        }
    }
    async _loadPowerLevels(membership, txn) {
        const powerLevelsState = await txn.roomState.get(this._roomId, "m.room.power_levels", "");
        if (powerLevelsState) {
            return new PowerLevels({
                powerLevelEvent: powerLevelsState.event,
                ownUserId: this._ownMember.userId,
                membership
            });
        }
        const createState = await txn.roomState.get(this._roomId, "m.room.create", "");
        if (createState) {
            return new PowerLevels({
                createEvent: createState.event,
                ownUserId: this._ownMember.userId,
                membership
            });
        } else {
            return new PowerLevels({ownUserId: this._ownMember.userId, membership});
        }
    }
    _setupEntries(timelineEntries) {
        this._remoteEntries.setManySorted(timelineEntries);
        if (this._pendingEvents) {
            this._localEntries = new AsyncMappedList(this._pendingEvents,
                pe => this._mapPendingEventToEntry(pe),
                (pee, params) => {
                    pee.notifyUpdate(params);
                },
                pee => this._applyAndEmitLocalRelationChange(pee, target => target.removeLocalRelation(pee))
            );
        } else {
            this._localEntries = new ObservableArray();
        }
        this._allEntries = new ConcatList(this._remoteEntries, this._localEntries);
    }
    async _mapPendingEventToEntry(pe) {
        let redactingEntry;
        if (pe.eventType === REDACTION_TYPE) {
            redactingEntry = await this._getOrLoadEntry(pe.relatedTxnId, pe.relatedEventId);
        }
        const pee = new PendingEventEntry({
            pendingEvent: pe, member: this._ownMember,
            clock: this._clock, redactingEntry
        });
        this._applyAndEmitLocalRelationChange(pee, target => target.addLocalRelation(pee));
        return pee;
    }
    _applyAndEmitLocalRelationChange(pee, updater) {
        const updateOrFalse = e => {
            const params = updater(e);
            return params ? params : false;
        };
        this._findAndUpdateRelatedEntry(pee.pendingEvent.relatedTxnId, pee.relatedEventId, updateOrFalse);
        if (pee.redactingEntry) {
            const relatedTxnId = pee.redactingEntry.pendingEvent?.relatedTxnId;
            this._findAndUpdateRelatedEntry(relatedTxnId, pee.redactingEntry.relatedEventId, updateOrFalse);
        }
    }
    _findAndUpdateRelatedEntry(relatedTxnId, relatedEventId, updateOrFalse) {
        let found = false;
        if (relatedTxnId) {
            found = this._localEntries.findAndUpdate(
                e => e.id === relatedTxnId,
                updateOrFalse,
            );
        }
        if (!found && relatedEventId) {
            this._remoteEntries.findAndUpdate(
                e => e.id === relatedEventId,
                updateOrFalse
            );
        }
    }
    async getOwnAnnotationEntry(targetId, key) {
        const txn = await this._storage.readWriteTxn([
            this._storage.storeNames.timelineEvents,
            this._storage.storeNames.timelineRelations,
        ]);
        const relations = await txn.timelineRelations.getForTargetAndType(this._roomId, targetId, ANNOTATION_RELATION_TYPE);
        for (const relation of relations) {
            const annotation = await txn.timelineEvents.getByEventId(this._roomId, relation.sourceEventId);
            if (annotation && annotation.event.sender === this._ownMember.userId && getRelation(annotation.event).key === key) {
                const eventEntry = new EventEntry(annotation, this._fragmentIdComparer);
                this._addLocalRelationsToNewRemoteEntries([eventEntry]);
                return eventEntry;
            }
        }
        return null;
    }
    updateOwnMember(member) {
        this._ownMember = member;
    }
    _addLocalRelationsToNewRemoteEntries(entries) {
        if (!this._localEntries?.hasSubscriptions) {
            return;
        }
        for (const pee of this._localEntries) {
            if (pee.relatedEventId) {
                const relationTarget = entries.find(e => e.id === pee.relatedEventId);
                relationTarget?.addLocalRelation(pee);
            }
            if (pee.redactingEntry) {
                const eventId = pee.redactingEntry.relatedEventId;
                const relationTarget = entries.find(e => e.id === eventId);
                relationTarget?.addLocalRelation(pee);
            }
        }
    }
    static _entryUpdater(existingEntry, entry) {
        entry.updateFrom(existingEntry);
        return entry;
    }
    replaceEntries(entries) {
        this._addLocalRelationsToNewRemoteEntries(entries);
        for (const entry of entries) {
            this._remoteEntries.getAndUpdate(entry, Timeline._entryUpdater);
        }
    }
    addEntries(newEntries) {
        this._addLocalRelationsToNewRemoteEntries(newEntries);
        this._remoteEntries.setManySorted(newEntries);
    }
    async loadAtTop(amount) {
        if (this._disposables.isDisposed) {
            return true;
        }
        const firstEventEntry = this._remoteEntries.array.find(e => !!e.eventType);
        if (!firstEventEntry) {
            return true;
        }
        const readerRequest = this._disposables.track(this._timelineReader.readFrom(
            firstEventEntry.asEventKey(),
            Direction.Backward,
            amount
        ));
        try {
            const entries = await readerRequest.complete();
            this.addEntries(entries);
            return entries.length < amount;
        } finally {
            this._disposables.disposeTracked(readerRequest);
        }
    }
    async _getOrLoadEntry(txnId, eventId) {
        if (txnId) {
            for (const p of this._localEntries) {
                if (p.id === txnId) {
                    return p;
                }
            }
        }
        if (eventId) {
            const loadedEntry = this.getByEventId(eventId);
            if (loadedEntry) {
                return loadedEntry;
            } else {
                const txn = await this._storage.readWriteTxn([
                    this._storage.storeNames.timelineEvents,
                ]);
                const redactionTargetEntry = await txn.timelineEvents.getByEventId(this._roomId, eventId);
                if (redactionTargetEntry) {
                    return new EventEntry(redactionTargetEntry, this._fragmentIdComparer);
                }
            }
        }
        return null;
    }
    getByEventId(eventId) {
        for (let i = 0; i < this._remoteEntries.length; i += 1) {
            const entry = this._remoteEntries.get(i);
            if (entry.id === eventId) {
                return entry;
            }
        }
        return null;
    }
    get entries() {
        return this._allEntries;
    }
    get remoteEntries() {
        return this._remoteEntries.array;
    }
    dispose() {
        if (this._closeCallback) {
            this._disposables.dispose();
            this._closeCallback();
            this._closeCallback = null;
        }
    }
    enableEncryption(decryptEntries) {
        this._timelineReader.enableEncryption(decryptEntries);
    }
    get powerLevels() {
        return this._powerLevels;
    }
    get me() {
        return this._ownMember;
    }
}

async function loadMembers({roomId, storage}) {
    const txn = await storage.readTxn([
        storage.storeNames.roomMembers,
    ]);
    const memberDatas = await txn.roomMembers.getAll(roomId);
    return memberDatas.map(d => new RoomMember(d));
}
async function fetchMembers({summary, syncToken, roomId, hsApi, storage, setChangedMembersMap}, log) {
    const changedMembersDuringSync = new Map();
    setChangedMembersMap(changedMembersDuringSync);
    const memberResponse = await hsApi.members(roomId, {at: syncToken}, {log}).response();
    const txn = await storage.readWriteTxn([
        storage.storeNames.roomSummary,
        storage.storeNames.roomMembers,
    ]);
    let summaryChanges;
    let members;
    try {
        summaryChanges = summary.writeHasFetchedMembers(true, txn);
        const {roomMembers} = txn;
        const memberEvents = memberResponse.chunk;
        if (!Array.isArray(memberEvents)) {
            throw new Error("malformed");
        }
        log.set("members", memberEvents.length);
        members = await Promise.all(memberEvents.map(async memberEvent => {
            const userId = memberEvent?.state_key;
            if (!userId) {
                throw new Error("malformed");
            }
            const changedMember = changedMembersDuringSync.get(userId);
            if (changedMember) {
                return changedMember;
            } else {
                const member = RoomMember.fromMemberEvent(roomId, memberEvent);
                if (member) {
                    roomMembers.set(member.serialize());
                }
                return member;
            }
        }));
    } catch (err) {
        txn.abort();
        throw err;
    } finally {
        setChangedMembersMap(null);
    }
    await txn.complete();
    summary.applyChanges(summaryChanges);
    return members;
}
async function fetchOrLoadMembers(options, logger) {
    const {summary} = options;
    if (!summary.data.hasFetchedMembers) {
        return logger.wrapOrRun(options.log, "fetchMembers", log => fetchMembers(options, log));
    } else {
        return loadMembers(options);
    }
}

class RetainedValue {
    constructor(freeCallback) {
        this._freeCallback = freeCallback;
        this._retentionCount = 1;
    }
    retain() {
        this._retentionCount += 1;
    }
    release() {
        this._retentionCount -= 1;
        if (this._retentionCount === 0) {
            this._freeCallback();
        }
    }
}

class MemberList extends RetainedValue {
    constructor({members, closeCallback}) {
        super(closeCallback);
        this._members = new ObservableMap();
        for (const member of members) {
            this._members.add(member.userId, member);
        }
    }
    afterSync(memberChanges) {
        for (const [userId, memberChange] of memberChanges.entries()) {
            this._members.add(userId, memberChange.member);
        }
    }
    get members() {
        return this._members;
    }
}

function calculateRoomName(sortedMembers, summaryData) {
    const countWithoutMe = summaryData.joinCount + summaryData.inviteCount - 1;
    if (sortedMembers.length >= countWithoutMe) {
        if (sortedMembers.length > 1) {
            const lastMember = sortedMembers[sortedMembers.length - 1];
            const firstMembers = sortedMembers.slice(0, sortedMembers.length - 1);
            return firstMembers.map(m => m.name).join(", ") + " and " + lastMember.name;
        } else {
            return sortedMembers[0].name;
        }
    } else if (sortedMembers.length < countWithoutMe) {
        return sortedMembers.map(m => m.name).join(", ") + ` and ${countWithoutMe} others`;
    } else {
        return null;
    }
}
class Heroes {
    constructor(roomId) {
        this._roomId = roomId;
        this._members = new Map();
    }
    async calculateChanges(newHeroes, memberChanges, txn) {
        const updatedHeroMembers = new Map();
        const removedUserIds = [];
        for (const existingUserId of this._members.keys()) {
            if (newHeroes.indexOf(existingUserId) === -1) {
                removedUserIds.push(existingUserId);
            }
        }
        for (const [userId, memberChange] of memberChanges.entries()) {
            if (this._members.has(userId) || newHeroes.indexOf(userId) !== -1) {
                updatedHeroMembers.set(userId, memberChange.member);
            }
        }
        for (const userId of newHeroes) {
            if (!this._members.has(userId) && !updatedHeroMembers.has(userId)) {
                const memberData = await txn.roomMembers.get(this._roomId, userId);
                if (memberData) {
                    const member = new RoomMember(memberData);
                    updatedHeroMembers.set(member.userId, member);
                }
            }
        }
        return {updatedHeroMembers: updatedHeroMembers.values(), removedUserIds};
    }
    applyChanges({updatedHeroMembers, removedUserIds}, summaryData) {
        for (const userId of removedUserIds) {
            this._members.delete(userId);
        }
        for (const member of updatedHeroMembers) {
            this._members.set(member.userId, member);
        }
        const sortedMembers = Array.from(this._members.values()).sort((a, b) => a.name.localeCompare(b.name));
        this._roomName = calculateRoomName(sortedMembers, summaryData);
    }
    get roomName() {
        return this._roomName;
    }
    get roomAvatarUrl() {
        if (this._members.size === 1) {
            for (const member of this._members.values()) {
                return member.avatarUrl;
            }
        }
        return null;
    }
}

class ObservedEventMap {
    constructor(notifyEmpty) {
        this._map = new Map();
        this._notifyEmpty = notifyEmpty;
    }
    observe(eventId, eventEntry = null) {
        let observable = this._map.get(eventId);
        if (!observable) {
            observable = new ObservedEvent(this, eventEntry);
            this._map.set(eventId, observable);
        }
        return observable;
    }
    updateEvents(eventEntries) {
        for (let i = 0; i < eventEntries.length; i += 1) {
            const entry = eventEntries[i];
            const observable = this._map.get(entry.id);
            observable?.update(entry);
        }
    }
    _remove(observable) {
        this._map.delete(observable.get().id);
        if (this._map.size === 0) {
            this._notifyEmpty();
        }
    }
}
class ObservedEvent extends BaseObservableValue {
    constructor(eventMap, entry) {
        super();
        this._eventMap = eventMap;
        this._entry = entry;
        Promise.resolve().then(() => {
            if (!this.hasSubscriptions) {
                this._eventMap.remove(this);
                this._eventMap = null;
            }
        });
    }
    subscribe(handler) {
        if (!this._eventMap) {
            throw new Error("ObservedEvent expired, subscribe right after calling room.observeEvent()");
        }
        return super.subscribe(handler);
    }
    onUnsubscribeLast() {
        this._eventMap._remove(this);
        this._eventMap = null;
        super.onUnsubscribeLast();
    }
    update(entry) {
        this._entry = entry;
        this.emit(this._entry);
    }
    get() {
        return this._entry;
    }
}

function ensureLogItem(logItem) {
    return logItem || Instance.item;
}

const EVENT_ENCRYPTED_TYPE = "m.room.encrypted";
class BaseRoom extends EventEmitter {
    constructor({roomId, storage, hsApi, mediaRepository, emitCollectionChange, user, createRoomEncryption, getSyncToken, platform}) {
        super();
        this._roomId = roomId;
        this._storage = storage;
        this._hsApi = hsApi;
        this._mediaRepository = mediaRepository;
        this._summary = new RoomSummary(roomId);
        this._fragmentIdComparer = new FragmentIdComparer([]);
        this._emitCollectionChange = emitCollectionChange;
        this._timeline = null;
        this._user = user;
        this._changedMembersDuringSync = null;
        this._memberList = null;
        this._createRoomEncryption = createRoomEncryption;
        this._roomEncryption = null;
        this._getSyncToken = getSyncToken;
        this._platform = platform;
        this._observedEvents = null;
    }
    async _eventIdsToEntries(eventIds, txn) {
        const retryEntries = [];
        await Promise.all(eventIds.map(async eventId => {
            const storageEntry = await txn.timelineEvents.getByEventId(this._roomId, eventId);
            if (storageEntry) {
                retryEntries.push(new EventEntry(storageEntry, this._fragmentIdComparer));
            }
        }));
        return retryEntries;
    }
    _getAdditionalTimelineRetryEntries(otherRetryEntries, roomKeys) {
        let retryTimelineEntries = this._roomEncryption.filterUndecryptedEventEntriesForKeys(this._timeline.remoteEntries, roomKeys);
        const existingIds = otherRetryEntries.reduce((ids, e) => {ids.add(e.id); return ids;}, new Set());
        retryTimelineEntries = retryTimelineEntries.filter(e => !existingIds.has(e.id));
        return retryTimelineEntries;
    }
    async notifyRoomKey(roomKey, eventIds, log) {
        if (!this._roomEncryption) {
            return;
        }
        const txn = await this._storage.readTxn([
            this._storage.storeNames.timelineEvents,
            this._storage.storeNames.inboundGroupSessions,
        ]);
        let retryEntries = await this._eventIdsToEntries(eventIds, txn);
        if (this._timeline) {
            const retryTimelineEntries = this._getAdditionalTimelineRetryEntries(retryEntries, [roomKey]);
            retryEntries = retryEntries.concat(retryTimelineEntries);
        }
        if (retryEntries.length) {
            const decryptRequest = this._decryptEntries(DecryptionSource.Retry, retryEntries, txn, log);
            await decryptRequest.complete();
            this._timeline?.replaceEntries(retryEntries);
            const changes = this._summary.data.applyTimelineEntries(retryEntries, false, false);
            if (await this._summary.writeAndApplyData(changes, this._storage)) {
                this._emitUpdate();
            }
        }
    }
    _setEncryption(roomEncryption) {
        if (roomEncryption && !this._roomEncryption) {
            this._roomEncryption = roomEncryption;
            if (this._timeline) {
                this._timeline.enableEncryption(this._decryptEntries.bind(this, DecryptionSource.Timeline));
            }
            return true;
        }
        return false;
    }
    _decryptEntries(source, entries, inboundSessionTxn, log = null) {
        const request = new DecryptionRequest(async (r, log) => {
            if (!inboundSessionTxn) {
                inboundSessionTxn = await this._storage.readTxn([this._storage.storeNames.inboundGroupSessions]);
            }
            if (r.cancelled) return;
            const events = entries.filter(entry => {
                return entry.eventType === EVENT_ENCRYPTED_TYPE;
            }).map(entry => entry.event);
            r.preparation = await this._roomEncryption.prepareDecryptAll(events, null, source, inboundSessionTxn);
            if (r.cancelled) return;
            const changes = await r.preparation.decrypt();
            r.preparation = null;
            if (r.cancelled) return;
            const stores = [this._storage.storeNames.groupSessionDecryptions];
            const isTimelineOpen = this._isTimelineOpen;
            if (isTimelineOpen) {
                stores.push(this._storage.storeNames.deviceIdentities);
            }
            const writeTxn = await this._storage.readWriteTxn(stores);
            let decryption;
            try {
                decryption = await changes.write(writeTxn, log);
                if (isTimelineOpen) {
                    await decryption.verifySenders(writeTxn);
                }
            } catch (err) {
                writeTxn.abort();
                throw err;
            }
            await writeTxn.complete();
            decryption.applyToEntries(entries);
            if (this._observedEvents) {
                this._observedEvents.updateEvents(entries);
            }
        }, ensureLogItem(log));
        return request;
    }
    async _getSyncRetryDecryptEntries(newKeys, roomEncryption, txn) {
        const entriesPerKey = await Promise.all(newKeys.map(async key => {
            const retryEventIds = await roomEncryption.getEventIdsForMissingKey(key, txn);
            if (retryEventIds) {
                return this._eventIdsToEntries(retryEventIds, txn);
            }
        }));
        let retryEntries = entriesPerKey.reduce((allEntries, entries) => entries ? allEntries.concat(entries) : allEntries, []);
        if (this._timeline) {
            const retryTimelineEntries = this._getAdditionalTimelineRetryEntries(retryEntries, newKeys);
            const retryTimelineEntriesCopies = retryTimelineEntries.map(e => e.clone());
            retryEntries = retryEntries.concat(retryTimelineEntriesCopies);
        }
        return retryEntries;
    }
    async load(summary, txn, log) {
        log.set("id", this.id);
        try {
            if (summary) {
                this._summary.load(summary);
            }
            if (this._summary.data.encryption) {
                const roomEncryption = this._createRoomEncryption(this, this._summary.data.encryption);
                this._setEncryption(roomEncryption);
            }
            if (this._summary.data.needsHeroes) {
                this._heroes = new Heroes(this._roomId);
                const changes = await this._heroes.calculateChanges(this._summary.data.heroes, [], txn);
                this._heroes.applyChanges(changes, this._summary.data);
            }
        } catch (err) {
            throw new WrappedError(`Could not load room ${this._roomId}`, err);
        }
    }
    async loadMemberList(log = null) {
        if (this._memberList) {
            this._memberList.retain();
            return this._memberList;
        } else {
            const members = await fetchOrLoadMembers({
                summary: this._summary,
                roomId: this._roomId,
                hsApi: this._hsApi,
                storage: this._storage,
                syncToken: this._getSyncToken(),
                setChangedMembersMap: map => this._changedMembersDuringSync = map,
                log,
            }, this._platform.logger);
            this._memberList = new MemberList({
                members,
                closeCallback: () => { this._memberList = null; }
            });
            return this._memberList;
        }
    }
    fillGap(fragmentEntry, amount, log = null) {
        return this._platform.logger.wrapOrRun(log, "fillGap", async log => {
            log.set("id", this.id);
            log.set("fragment", fragmentEntry.fragmentId);
            log.set("dir", fragmentEntry.direction.asApiString());
            if (fragmentEntry.edgeReached) {
                log.set("edgeReached", true);
                return;
            }
            const response = await this._hsApi.messages(this._roomId, {
                from: fragmentEntry.token,
                dir: fragmentEntry.direction.asApiString(),
                limit: amount,
                filter: {
                    lazy_load_members: true,
                    include_redundant_members: true,
                }
            }, {log}).response();
            const txn = await this._storage.readWriteTxn([
                this._storage.storeNames.pendingEvents,
                this._storage.storeNames.timelineEvents,
                this._storage.storeNames.timelineRelations,
                this._storage.storeNames.timelineFragments,
            ]);
            let extraGapFillChanges;
            let gapResult;
            try {
                extraGapFillChanges = await this._writeGapFill(response.chunk, txn, log);
                const relationWriter = new RelationWriter({
                    roomId: this._roomId,
                    fragmentIdComparer: this._fragmentIdComparer,
                    ownUserId: this._user.id,
                });
                const gapWriter = new GapWriter({
                    roomId: this._roomId,
                    storage: this._storage,
                    fragmentIdComparer: this._fragmentIdComparer,
                    relationWriter
                });
                gapResult = await gapWriter.writeFragmentFill(fragmentEntry, response, txn, log);
            } catch (err) {
                txn.abort();
                throw err;
            }
            await txn.complete();
            if (this._roomEncryption) {
                const decryptRequest = this._decryptEntries(DecryptionSource.Timeline, gapResult.entries, null, log);
                await decryptRequest.complete();
            }
            for (const fragment of gapResult.fragments) {
                this._fragmentIdComparer.add(fragment);
            }
            if (extraGapFillChanges) {
                this._applyGapFill(extraGapFillChanges);
            }
            if (this._timeline) {
                this._timeline.replaceEntries(gapResult.updatedEntries);
                this._timeline.addEntries(gapResult.entries);
            }
        });
    }
    async _writeGapFill(chunk, txn, log) {}
    _applyGapFill() {}
    get name() {
        if (this._heroes) {
            return this._heroes.roomName;
        }
        const summaryData = this._summary.data;
        if (summaryData.name) {
            return summaryData.name;
        }
        if (summaryData.canonicalAlias) {
            return summaryData.canonicalAlias;
        }
        return null;
    }
    get id() {
        return this._roomId;
    }
    get avatarUrl() {
        if (this._summary.data.avatarUrl) {
            return this._summary.data.avatarUrl;
        } else if (this._heroes) {
            return this._heroes.roomAvatarUrl;
        }
        return null;
    }
    get lastMessageTimestamp() {
        return this._summary.data.lastMessageTimestamp;
    }
    get isLowPriority() {
        const tags = this._summary.data.tags;
        return !!(tags && tags['m.lowpriority']);
    }
    get isEncrypted() {
        return !!this._summary.data.encryption;
    }
    get isJoined() {
        return this.membership === "join";
    }
    get isLeft() {
        return this.membership === "leave";
    }
    get canonicalAlias() {
        return this._summary.data.canonicalAlias;
    }
    get joinedMemberCount() {
        return this._summary.data.joinCount;
    }
    get mediaRepository() {
        return this._mediaRepository;
    }
    get membership() {
        return this._summary.data.membership;
    }
    enableSessionBackup(sessionBackup) {
        this._roomEncryption?.enableSessionBackup(sessionBackup);
        if (this._timeline) {
            this._platform.logger.run("enableSessionBackup", log => {
                return this._roomEncryption.restoreMissingSessionsFromBackup(this._timeline.remoteEntries, log);
            });
        }
    }
    get _isTimelineOpen() {
        return !!this._timeline;
    }
    _emitUpdate() {
        this.emit("change");
        this._emitCollectionChange(this);
    }
    openTimeline(log = null) {
        return this._platform.logger.wrapOrRun(log, "open timeline", async log => {
            log.set("id", this.id);
            if (this._timeline) {
                throw new Error("not dealing with load race here for now");
            }
            this._timeline = new Timeline({
                roomId: this.id,
                storage: this._storage,
                fragmentIdComparer: this._fragmentIdComparer,
                pendingEvents: this._getPendingEvents(),
                closeCallback: () => {
                    this._timeline = null;
                    if (this._roomEncryption) {
                        this._roomEncryption.notifyTimelineClosed();
                    }
                },
                clock: this._platform.clock,
                logger: this._platform.logger,
            });
            try {
                if (this._roomEncryption) {
                    this._timeline.enableEncryption(this._decryptEntries.bind(this, DecryptionSource.Timeline));
                }
                await this._timeline.load(this._user, this.membership, log);
            } catch (err) {
                this._timeline.dispose();
                throw err;
            }
            return this._timeline;
        });
    }
    _getPendingEvents() { return null; }
    observeEvent(eventId) {
        if (!this._observedEvents) {
            this._observedEvents = new ObservedEventMap(() => {
                this._observedEvents = null;
            });
        }
        let entry = null;
        if (this._timeline) {
            entry = this._timeline.getByEventId(eventId);
        }
        const observable = this._observedEvents.observe(eventId, entry);
        if (!entry) {
            this._readEventById(eventId).then(entry => {
                observable.update(entry);
            }).catch(err => {
                console.warn(`could not load event ${eventId} from storage`, err);
            });
        }
        return observable;
    }
    async _readEventById(eventId) {
        let stores = [this._storage.storeNames.timelineEvents];
        if (this.isEncrypted) {
            stores.push(this._storage.storeNames.inboundGroupSessions);
        }
        const txn = await this._storage.readTxn(stores);
        const storageEntry = await txn.timelineEvents.getByEventId(this._roomId, eventId);
        if (storageEntry) {
            const entry = new EventEntry(storageEntry, this._fragmentIdComparer);
            if (entry.eventType === EVENT_ENCRYPTED_TYPE) {
                const request = this._decryptEntries(DecryptionSource.Timeline, [entry], txn);
                await request.complete();
            }
            return entry;
        }
    }
    dispose() {
        this._roomEncryption?.dispose();
        this._timeline?.dispose();
    }
}
class DecryptionRequest {
    constructor(decryptFn, log) {
        this._cancelled = false;
        this.preparation = null;
        this._promise = log.wrap("decryptEntries", log => decryptFn(this, log));
    }
    complete() {
        return this._promise;
    }
    get cancelled() {
        return this._cancelled;
    }
    dispose() {
        this._cancelled = true;
        if (this.preparation) {
            this.preparation.dispose();
        }
    }
}

function deduplicateEvents(events) {
    const eventIds = new Set();
    return events.filter(e => {
        if (eventIds.has(e.event_id)) {
            return false;
        } else {
            eventIds.add(e.event_id);
            return true;
        }
    });
}
class SyncWriter {
    constructor({roomId, fragmentIdComparer, memberWriter, relationWriter}) {
        this._roomId = roomId;
        this._memberWriter = memberWriter;
        this._relationWriter = relationWriter;
        this._fragmentIdComparer = fragmentIdComparer;
        this._lastLiveKey = null;
    }
    async load(txn, log) {
        const liveFragment = await txn.timelineFragments.liveFragment(this._roomId);
        if (liveFragment) {
            const [lastEvent] = await txn.timelineEvents.lastEvents(this._roomId, liveFragment.id, 1);
            const eventIndex = lastEvent ? lastEvent.eventIndex : EventKey.defaultLiveKey.eventIndex;
            this._lastLiveKey = new EventKey(liveFragment.id, eventIndex);
        }
        if (this._lastLiveKey) {
            log.set("live key", this._lastLiveKey.toString());
        }
    }
    async _createLiveFragment(txn, previousToken) {
        const liveFragment = await txn.timelineFragments.liveFragment(this._roomId);
        if (!liveFragment) {
            if (!previousToken) {
                previousToken = null;
            }
            const fragment = {
                roomId: this._roomId,
                id: EventKey.defaultLiveKey.fragmentId,
                previousId: null,
                nextId: null,
                previousToken: previousToken,
                nextToken: null
            };
            txn.timelineFragments.add(fragment);
            this._fragmentIdComparer.add(fragment);
            return fragment;
        } else {
            return liveFragment;
        }
    }
    async _replaceLiveFragment(oldFragmentId, newFragmentId, previousToken, txn) {
        const oldFragment = await txn.timelineFragments.get(this._roomId, oldFragmentId);
        if (!oldFragment) {
            throw new Error(`old live fragment doesn't exist: ${oldFragmentId}`);
        }
        oldFragment.nextId = newFragmentId;
        txn.timelineFragments.update(oldFragment);
        const newFragment = {
            roomId: this._roomId,
            id: newFragmentId,
            previousId: oldFragmentId,
            nextId: null,
            previousToken: previousToken,
            nextToken: null
        };
        txn.timelineFragments.add(newFragment);
        this._fragmentIdComparer.append(newFragmentId, oldFragmentId);
        return {oldFragment, newFragment};
    }
    async _ensureLiveFragment(currentKey, entries, timeline, txn, log) {
        if (!currentKey) {
            let liveFragment = await this._createLiveFragment(txn, timeline.prev_batch);
            currentKey = new EventKey(liveFragment.id, EventKey.defaultLiveKey.eventIndex);
            entries.push(FragmentBoundaryEntry.start(liveFragment, this._fragmentIdComparer));
            log.log({l: "live fragment", first: true, id: currentKey.fragmentId});
        } else if (timeline.limited) {
            const oldFragmentId = currentKey.fragmentId;
            currentKey = currentKey.nextFragmentKey();
            const {oldFragment, newFragment} = await this._replaceLiveFragment(oldFragmentId, currentKey.fragmentId, timeline.prev_batch, txn);
            entries.push(FragmentBoundaryEntry.end(oldFragment, this._fragmentIdComparer));
            entries.push(FragmentBoundaryEntry.start(newFragment, this._fragmentIdComparer));
            log.log({l: "live fragment", limited: true, id: currentKey.fragmentId});
        }
        return currentKey;
    }
    async _writeStateEvents(roomResponse, memberChanges, isLimited, txn, log) {
        const {state} = roomResponse;
        if (Array.isArray(state?.events)) {
            log.set("stateEvents", state.events.length);
            for (const event of state.events) {
                if (event.type === EVENT_TYPE) {
                    const memberChange = await this._memberWriter.writeStateMemberEvent(event, isLimited, txn);
                    if (memberChange) {
                        memberChanges.set(memberChange.userId, memberChange);
                    }
                } else {
                    txn.roomState.set(this._roomId, event);
                }
            }
        }
    }
    async _writeTimeline(timeline, currentKey, memberChanges, txn, log) {
        const entries = [];
        const updatedEntries = [];
        if (Array.isArray(timeline?.events) && timeline.events.length) {
            currentKey = await this._ensureLiveFragment(currentKey, entries, timeline, txn, log);
            const events = deduplicateEvents(timeline.events);
            log.set("timelineEvents", events.length);
            let timelineStateEventCount = 0;
            for(const event of events) {
                currentKey = currentKey.nextKey();
                const storageEntry = createEventEntry(currentKey, this._roomId, event);
                let member = await this._memberWriter.lookupMember(event.sender, event, events, txn);
                if (member) {
                    storageEntry.displayName = member.displayName;
                    storageEntry.avatarUrl = member.avatarUrl;
                }
                txn.timelineEvents.insert(storageEntry);
                const entry = new EventEntry(storageEntry, this._fragmentIdComparer);
                entries.push(entry);
                const updatedRelationTargetEntries = await this._relationWriter.writeRelation(entry, txn, log);
                if (updatedRelationTargetEntries) {
                    updatedEntries.push(...updatedRelationTargetEntries);
                }
                if (typeof event.state_key === "string") {
                    timelineStateEventCount += 1;
                    if (event.type === EVENT_TYPE) {
                        const memberChange = await this._memberWriter.writeTimelineMemberEvent(event, txn);
                        if (memberChange) {
                            memberChanges.set(memberChange.userId, memberChange);
                        }
                    } else {
                        txn.roomState.set(this._roomId, event);
                    }
                }
            }
            log.set("timelineStateEventCount", timelineStateEventCount);
        }
        return {currentKey, entries, updatedEntries};
    }
    async _handleRejoinOverlap(timeline, txn, log) {
        if (this._lastLiveKey) {
            const {fragmentId} = this._lastLiveKey;
            const [lastEvent] = await txn.timelineEvents.lastEvents(this._roomId, fragmentId, 1);
            if (lastEvent) {
                const lastEventId = lastEvent.event.event_id;
                const {events} = timeline;
                const index = events.findIndex(event => event.event_id === lastEventId);
                if (index !== -1) {
                    log.set("overlap_event_id", lastEventId);
                    return Object.assign({}, timeline, {
                        limited: false,
                        events: events.slice(index + 1),
                    });
                }
            }
        }
        if (!timeline.limited) {
            log.set("force_limited_without_overlap", true);
            return Object.assign({}, timeline, {limited: true});
        }
        return timeline;
    }
    async writeSync(roomResponse, isRejoin, txn, log) {
        let {timeline} = roomResponse;
        log.set("isRejoin", isRejoin);
        if (isRejoin) {
            timeline = await this._handleRejoinOverlap(timeline, txn, log);
        }
        const memberChanges = new Map();
        await this._writeStateEvents(roomResponse, memberChanges, timeline?.limited, txn, log);
        const {currentKey, entries, updatedEntries} =
            await this._writeTimeline(timeline, this._lastLiveKey, memberChanges, txn, log);
        log.set("memberChanges", memberChanges.size);
        return {entries, updatedEntries, newLiveKey: currentKey, memberChanges};
    }
    afterSync(newLiveKey) {
        this._lastLiveKey = newLiveKey;
    }
    get lastMessageKey() {
        return this._lastLiveKey;
    }
}

class BaseLRUCache {
    constructor(limit) {
        this._limit = limit;
        this._entries = [];
    }
    _get(findEntryFn) {
        const idx = this._entries.findIndex(findEntryFn);
        if (idx !== -1) {
            const entry = this._entries[idx];
            if (idx > 0) {
                this._entries.splice(idx, 1);
                this._entries.unshift(entry);
            }
            return entry;
        }
    }
    _set(value, findEntryFn) {
        let indexToRemove = this._entries.findIndex(findEntryFn);
        this._entries.unshift(value);
        if (indexToRemove === -1) {
            if (this._entries.length > this._limit) {
                indexToRemove = this._entries.length - 1;
            }
        } else {
            indexToRemove += 1;
        }
        if (indexToRemove !== -1) {
            this._onEvictEntry(this._entries[indexToRemove]);
            this._entries.splice(indexToRemove, 1);
        }
    }
    _onEvictEntry() {}
}
class LRUCache extends BaseLRUCache {
    constructor(limit, keyFn) {
        super(limit);
        this._keyFn = keyFn;
    }
    get(key) {
        return this._get(e => this._keyFn(e) === key);
    }
    set(value) {
        const key = this._keyFn(value);
        this._set(value, e => this._keyFn(e) === key);
    }
}

class MemberWriter {
    constructor(roomId) {
        this._roomId = roomId;
        this._cache = new LRUCache(5, member => member.userId);
    }
    writeTimelineMemberEvent(event, txn) {
        return this._writeMemberEvent(event, false, txn);
    }
    writeStateMemberEvent(event, isLimited, txn) {
        return this._writeMemberEvent(event, !isLimited, txn);
    }
    async _writeMemberEvent(event, isLazyLoadingMember, txn) {
        const userId = event.state_key;
        if (!userId) {
            return;
        }
        const member = RoomMember.fromMemberEvent(this._roomId, event);
        if (!member) {
            return;
        }
        let existingMember = this._cache.get(userId);
        if (!existingMember) {
            const memberData = await txn.roomMembers.get(this._roomId, userId);
            if (memberData) {
                existingMember = new RoomMember(memberData);
            }
        }
        if (!existingMember || !existingMember.equals(member)) {
            txn.roomMembers.set(member.serialize());
            this._cache.set(member);
            if (isLazyLoadingMember && !existingMember) {
                return new MemberChange(member, member.membership);
            }
            return new MemberChange(member, existingMember?.membership);
        }
    }
    async lookupMember(userId, event, timelineEvents, txn) {
        let member = this._cache.get(userId);
        if (!member) {
            const memberData = await txn.roomMembers.get(this._roomId, userId);
            if (memberData) {
                member = new RoomMember(memberData);
                this._cache.set(member);
            }
        }
        if (!member) {
            let foundEvent = false;
            let memberEventBefore;
            let firstMemberEvent;
            for (let i = timelineEvents.length - 1; i >= 0; i -= 1) {
                const e = timelineEvents[i];
                let matchingEvent;
                if (e.type === EVENT_TYPE && e.state_key === userId) {
                    matchingEvent = e;
                    firstMemberEvent = matchingEvent;
                }
                if (!foundEvent) {
                    if (e.event_id === event.event_id) {
                        foundEvent = true;
                    }
                } else if (matchingEvent) {
                    memberEventBefore = matchingEvent;
                    break;
                }
            }
            if (memberEventBefore) {
                member = RoomMember.fromMemberEvent(this._roomId, memberEventBefore);
            }
            else if (firstMemberEvent) {
                member = RoomMember.fromMemberEvent(this._roomId, firstMemberEvent);
            }
        }
        return member;
    }
}

function makeTxnId() {
    const n = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    const str = n.toString(16);
    return "t" + "0".repeat(14 - str.length) + str;
}
function isTxnId(txnId) {
	return txnId.startsWith("t") && txnId.length === 15;
}

class SendQueue {
    constructor({roomId, storage, hsApi, pendingEvents}) {
        pendingEvents = pendingEvents || [];
        this._roomId = roomId;
        this._storage = storage;
        this._hsApi = hsApi;
        this._pendingEvents = new SortedArray((a, b) => a.queueIndex - b.queueIndex);
        this._pendingEvents.setManyUnsorted(pendingEvents.map(data => this._createPendingEvent(data)));
        this._isSending = false;
        this._offline = false;
        this._roomEncryption = null;
        this._currentQueueIndex = 0;
    }
    _createPendingEvent(data, attachments = null) {
        const pendingEvent = new PendingEvent({
            data,
            remove: () => this._removeEvent(pendingEvent),
            emitUpdate: params => this._pendingEvents.update(pendingEvent, params),
            attachments
        });
        return pendingEvent;
    }
    enableEncryption(roomEncryption) {
        this._roomEncryption = roomEncryption;
    }
    _sendLoop(log) {
        this._isSending = true;
        this._sendLoopLogItem = log.runDetached("send queue flush", async log => {
            try {
                for (const pendingEvent of this._pendingEvents) {
                    await log.wrap("send event", async log => {
                        log.set("queueIndex", pendingEvent.queueIndex);
                        try {
                            this._currentQueueIndex = pendingEvent.queueIndex;
                            await this._sendEvent(pendingEvent, log);
                        } catch(err) {
                            if (err instanceof ConnectionError) {
                                this._offline = true;
                                log.set("offline", true);
                                pendingEvent.setWaiting();
                            } else {
                                log.catch(err);
                                const isPermanentError = err.name === "HomeServerError" && (
                                    err.statusCode === 400 ||
                                    err.statusCode === 403 ||
                                    err.statusCode === 404
                                );
                                if (isPermanentError) {
                                    log.set("remove", true);
                                    await pendingEvent.abort();
                                } else {
                                    pendingEvent.setError(err);
                                }
                            }
                        } finally {
                            this._currentQueueIndex = 0;
                        }
                    });
                }
            } finally {
                this._isSending = false;
                this._sendLoopLogItem = null;
            }
        });
    }
    async _sendEvent(pendingEvent, log) {
        if (pendingEvent.needsUpload) {
            await log.wrap("upload attachments", log => pendingEvent.uploadAttachments(this._hsApi, log));
            await this._tryUpdateEvent(pendingEvent);
        }
        if (pendingEvent.needsEncryption) {
            pendingEvent.setEncrypting();
            const {type, content} = await log.wrap("encrypt", log => this._roomEncryption.encrypt(
                pendingEvent.eventType, pendingEvent.content, this._hsApi, log));
            pendingEvent.setEncrypted(type, content);
            await this._tryUpdateEvent(pendingEvent);
        }
        if (pendingEvent.needsSending) {
            await pendingEvent.send(this._hsApi, log);
            const txn = await this._storage.readWriteTxn([this._storage.storeNames.pendingEvents]);
            try {
                await this._tryUpdateEventWithTxn(pendingEvent, txn);
                await this._resolveRemoteIdInPendingRelations(
                    pendingEvent.txnId, pendingEvent.remoteId, txn);
            } catch (err) {
                txn.abort();
                throw err;
            }
            await txn.complete();
        }
    }
    async _resolveRemoteIdInPendingRelations(txnId, remoteId, txn) {
        const relatedEventWithoutRemoteId = this._pendingEvents.array.filter(pe => {
            return pe.relatedTxnId === txnId && pe.relatedEventId !== remoteId;
        });
        for (const relatedPE of relatedEventWithoutRemoteId) {
            relatedPE.setRelatedEventId(remoteId);
            await this._tryUpdateEventWithTxn(relatedPE, txn);
        }
        return relatedEventWithoutRemoteId;
    }
    async removeRemoteEchos(events, txn, parentLog) {
        const removed = [];
        for (const event of events) {
            const txnId = event.unsigned && event.unsigned.transaction_id;
            let idx;
            if (txnId) {
                idx = this._pendingEvents.array.findIndex(pe => pe.txnId === txnId);
            } else {
                idx = this._pendingEvents.array.findIndex(pe => pe.remoteId === event.event_id);
            }
            if (idx !== -1) {
                const pendingEvent = this._pendingEvents.get(idx);
                const remoteId = event.event_id;
                parentLog.log({l: "removeRemoteEcho", queueIndex: pendingEvent.queueIndex, remoteId, txnId});
                txn.pendingEvents.remove(pendingEvent.roomId, pendingEvent.queueIndex);
                removed.push(pendingEvent);
                await this._resolveRemoteIdInPendingRelations(txnId, remoteId, txn);
            }
        }
        return removed;
    }
    async _removeEvent(pendingEvent) {
        let hasEvent = this._pendingEvents.array.indexOf(pendingEvent) !== -1;
        if (hasEvent) {
            const txn = await this._storage.readWriteTxn([this._storage.storeNames.pendingEvents]);
            try {
                txn.pendingEvents.remove(pendingEvent.roomId, pendingEvent.queueIndex);
            } catch (err) {
                txn.abort();
            }
            await txn.complete();
            const idx = this._pendingEvents.array.indexOf(pendingEvent);
            if (idx !== -1) {
                this._pendingEvents.remove(idx);
            }
        }
        pendingEvent.dispose();
    }
    emitRemovals(pendingEvents) {
        for (const pendingEvent of pendingEvents) {
            const idx = this._pendingEvents.array.indexOf(pendingEvent);
            if (idx !== -1) {
                this._pendingEvents.remove(idx);
            }
            pendingEvent.dispose();
        }
    }
    resumeSending(parentLog) {
        this._offline = false;
        if (this._pendingEvents.length) {
            parentLog.wrap("resumeSending", log => {
                log.set("id", this._roomId);
                log.set("pendingEvents", this._pendingEvents.length);
                if (!this._isSending) {
                    this._sendLoop(log);
                }
                if (this._sendLoopLogItem) {
                    log.refDetached(this._sendLoopLogItem);
                }
            });
        }
    }
    async enqueueEvent(eventType, content, attachments, log) {
        const relation = getRelationFromContent(content);
        let relatedTxnId = null;
        if (relation) {
            if (isTxnId(relation.event_id)) {
                relatedTxnId = relation.event_id;
                relation.event_id = null;
            }
            if (relation.rel_type === ANNOTATION_RELATION_TYPE) {
                const isAlreadyAnnotating = this._pendingEvents.array.some(pe => {
                    const r = getRelationFromContent(pe.content);
                    return pe.eventType === eventType && r && r.key === relation.key &&
                        (pe.relatedTxnId === relatedTxnId || r.event_id === relation.event_id);
                });
                if (isAlreadyAnnotating) {
                    log.set("already_annotating", true);
                    return;
                }
            }
        }
        await this._enqueueEvent(eventType, content, attachments, relatedTxnId, null, log);
    }
    async _enqueueEvent(eventType, content, attachments, relatedTxnId, relatedEventId, log) {
        const pendingEvent = await this._createAndStoreEvent(eventType, content, relatedTxnId, relatedEventId, attachments);
        this._pendingEvents.set(pendingEvent);
        log.set("queueIndex", pendingEvent.queueIndex);
        log.set("pendingEvents", this._pendingEvents.length);
        if (!this._isSending && !this._offline) {
            this._sendLoop(log);
        }
        if (this._sendLoopLogItem) {
            log.refDetached(this._sendLoopLogItem);
        }
    }
    async enqueueRedaction(eventIdOrTxnId, reason, log) {
        const isAlreadyRedacting = this._pendingEvents.array.some(pe => {
            return pe.eventType === REDACTION_TYPE &&
                (pe.relatedTxnId === eventIdOrTxnId || pe.relatedEventId === eventIdOrTxnId);
        });
        if (isAlreadyRedacting) {
            log.set("already_redacting", true);
            return;
        }
        let relatedTxnId;
        let relatedEventId;
        if (isTxnId(eventIdOrTxnId)) {
            relatedTxnId = eventIdOrTxnId;
            const txnId = eventIdOrTxnId;
            const pe = this._pendingEvents.array.find(pe => pe.txnId === txnId);
            if (pe && !pe.remoteId && pe.status !== SendStatus.Sending) {
                log.set("remove", relatedTxnId);
                await pe.abort();
                return;
            } else if (pe) {
                relatedEventId = pe.remoteId;
            } else {
                return;
            }
        } else {
            relatedEventId = eventIdOrTxnId;
            const pe = this._pendingEvents.array.find(pe => pe.remoteId === relatedEventId);
            if (pe) {
                relatedTxnId = pe.txnId;
            }
        }
        log.set("relatedTxnId", relatedTxnId);
        log.set("relatedEventId", relatedEventId);
        await this._enqueueEvent(REDACTION_TYPE, {reason}, null, relatedTxnId, relatedEventId, log);
    }
    get pendingEvents() {
        return this._pendingEvents;
    }
    async _tryUpdateEvent(pendingEvent) {
        const txn = await this._storage.readWriteTxn([this._storage.storeNames.pendingEvents]);
        try {
            this._tryUpdateEventWithTxn(pendingEvent, txn);
        } catch (err) {
            txn.abort();
            throw err;
        }
        await txn.complete();
    }
    async _tryUpdateEventWithTxn(pendingEvent, txn) {
        if (await txn.pendingEvents.exists(pendingEvent.roomId, pendingEvent.queueIndex)) {
            txn.pendingEvents.update(pendingEvent.data);
        }
    }
    async _createAndStoreEvent(eventType, content, relatedTxnId, relatedEventId, attachments) {
        const txn = await this._storage.readWriteTxn([this._storage.storeNames.pendingEvents]);
        let pendingEvent;
        try {
            const pendingEventsStore = txn.pendingEvents;
            const maxStorageQueueIndex = await pendingEventsStore.getMaxQueueIndex(this._roomId) || 0;
            const maxQueueIndex = Math.max(maxStorageQueueIndex, this._currentQueueIndex);
            const queueIndex = maxQueueIndex + 1;
            const needsEncryption = eventType !== REDACTION_TYPE &&
                eventType !== REACTION_TYPE &&
                !!this._roomEncryption;
            pendingEvent = this._createPendingEvent({
                roomId: this._roomId,
                queueIndex,
                eventType,
                content,
                relatedTxnId,
                relatedEventId,
                txnId: makeTxnId(),
                needsEncryption,
                needsUpload: !!attachments
            }, attachments);
            pendingEventsStore.add(pendingEvent.data);
        } catch (err) {
            txn.abort();
            throw err;
        }
        await txn.complete();
        return pendingEvent;
    }
    dispose() {
        for (const pe of this._pendingEvents) {
            pe.dispose();
        }
    }
}

class AttachmentUpload {
    constructor({filename, blob, platform}) {
        this._filename = filename;
        this._unencryptedBlob = blob;
        this._transferredBlob = this._unencryptedBlob;
        this._platform = platform;
        this._mxcUrl = null;
        this._encryptionInfo = null;
        this._uploadRequest = null;
        this._aborted = false;
        this._error = null;
        this._sentBytes = 0;
    }
    get size() {
        return this._transferredBlob.size;
    }
    get sentBytes() {
        return this._sentBytes;
    }
    abort() {
        this._uploadRequest?.abort();
    }
    get localPreview() {
        return this._unencryptedBlob;
    }
    async encrypt() {
        if (this._encryptionInfo) {
            throw new Error("already encrypted");
        }
        const {info, blob} = await encryptAttachment(this._platform, this._transferredBlob);
        this._transferredBlob = blob;
        this._encryptionInfo = info;
    }
    async upload(hsApi, progressCallback, log) {
        this._uploadRequest = hsApi.uploadAttachment(this._transferredBlob, this._filename, {
            uploadProgress: sentBytes => {
                this._sentBytes = sentBytes;
                progressCallback();
            },
            log
        });
        const {content_uri} = await this._uploadRequest.response();
        this._mxcUrl = content_uri;
    }
    applyToContent(urlPath, content) {
        if (!this._mxcUrl) {
            throw new Error("upload has not finished");
        }
        let prefix = urlPath.substr(0, urlPath.lastIndexOf("url"));
        setPath(`${prefix}info.size`, content, this._transferredBlob.size);
        setPath(`${prefix}info.mimetype`, content, this._unencryptedBlob.mimeType);
        if (this._encryptionInfo) {
            setPath(`${prefix}file`, content, Object.assign(this._encryptionInfo, {
                mimetype: this._unencryptedBlob.mimeType,
                url: this._mxcUrl
            }));
        } else {
            setPath(`${prefix}url`, content, this._mxcUrl);
        }
    }
    dispose() {
        this._unencryptedBlob.dispose();
        this._transferredBlob.dispose();
    }
}
function setPath(path, content, value) {
    const parts = path.split(".");
    let obj = content;
    for (let i = 0; i < (parts.length - 1); i += 1) {
        const key = parts[i];
        if (!obj[key]) {
            obj[key] = {};
        }
        obj = obj[key];
    }
    const propKey = parts[parts.length - 1];
    obj[propKey] = value;
}

const EVENT_ENCRYPTED_TYPE$1 = "m.room.encrypted";
class Room extends BaseRoom {
    constructor(options) {
        super(options);
        const {pendingEvents} = options;
        const relationWriter = new RelationWriter({
            roomId: this.id,
            fragmentIdComparer: this._fragmentIdComparer,
            ownUserId: this._user.id
        });
        this._syncWriter = new SyncWriter({
            roomId: this.id,
            fragmentIdComparer: this._fragmentIdComparer,
            relationWriter,
            memberWriter: new MemberWriter(this.id)
        });
        this._sendQueue = new SendQueue({roomId: this.id, storage: this._storage, hsApi: this._hsApi, pendingEvents});
    }
    _setEncryption(roomEncryption) {
        if (super._setEncryption(roomEncryption)) {
            this._sendQueue.enableEncryption(this._roomEncryption);
            return true;
        }
        return false;
    }
    async prepareSync(roomResponse, membership, invite, newKeys, txn, log) {
        log.set("id", this.id);
        if (newKeys) {
            log.set("newKeys", newKeys.length);
        }
        let summaryChanges = this._summary.data.applySyncResponse(roomResponse, membership);
        if (membership === "join" && invite) {
            summaryChanges = summaryChanges.applyInvite(invite);
        }
        let roomEncryption = this._roomEncryption;
        if (!roomEncryption && summaryChanges.encryption) {
            log.set("enableEncryption", true);
            roomEncryption = this._createRoomEncryption(this, summaryChanges.encryption);
        }
        let retryEntries;
        let decryptPreparation;
        if (roomEncryption) {
            let eventsToDecrypt = roomResponse?.timeline?.events || [];
            if (newKeys) {
                retryEntries = await this._getSyncRetryDecryptEntries(newKeys, roomEncryption, txn);
                if (retryEntries.length) {
                    log.set("retry", retryEntries.length);
                    eventsToDecrypt = eventsToDecrypt.concat(retryEntries.map(entry => entry.event));
                }
            }
            eventsToDecrypt = eventsToDecrypt.filter(event => {
                return event?.type === EVENT_ENCRYPTED_TYPE$1;
            });
            if (eventsToDecrypt.length) {
                decryptPreparation = await roomEncryption.prepareDecryptAll(
                    eventsToDecrypt, newKeys, DecryptionSource.Sync, txn);
            }
        }
        return {
            roomEncryption,
            summaryChanges,
            decryptPreparation,
            decryptChanges: null,
            retryEntries
        };
    }
    async afterPrepareSync(preparation, parentLog) {
        if (preparation.decryptPreparation) {
            await parentLog.wrap("decrypt", async log => {
                log.set("id", this.id);
                preparation.decryptChanges = await preparation.decryptPreparation.decrypt();
                preparation.decryptPreparation = null;
            }, parentLog.level.Detail);
        }
    }
    async writeSync(roomResponse, isInitialSync, {summaryChanges, decryptChanges, roomEncryption, retryEntries}, txn, log) {
        log.set("id", this.id);
        const isRejoin = summaryChanges.isNewJoin(this._summary.data);
        if (isRejoin) {
            txn.roomState.removeAllForRoom(this.id);
            txn.roomMembers.removeAllForRoom(this.id);
        }
        const {entries: newEntries, updatedEntries, newLiveKey, memberChanges} =
            await log.wrap("syncWriter", log => this._syncWriter.writeSync(roomResponse, isRejoin, txn, log), log.level.Detail);
        if (decryptChanges) {
            const decryption = await log.wrap("decryptChanges", log => decryptChanges.write(txn, log));
            log.set("decryptionResults", decryption.results.size);
            log.set("decryptionErrors", decryption.errors.size);
            if (this._isTimelineOpen) {
                await decryption.verifySenders(txn);
            }
            decryption.applyToEntries(newEntries);
            if (retryEntries?.length) {
                decryption.applyToEntries(retryEntries);
                updatedEntries.push(...retryEntries);
            }
        }
        log.set("newEntries", newEntries.length);
        log.set("updatedEntries", updatedEntries.length);
        let shouldFlushKeyShares = false;
        if (roomEncryption && this.isTrackingMembers && memberChanges?.size) {
            shouldFlushKeyShares = await roomEncryption.writeMemberChanges(memberChanges, txn, log);
            log.set("shouldFlushKeyShares", shouldFlushKeyShares);
        }
        const allEntries = newEntries.concat(updatedEntries);
        summaryChanges = summaryChanges.applyTimelineEntries(
            allEntries, isInitialSync, !this._isTimelineOpen, this._user.id);
        if (summaryChanges.membership !== "join") {
            txn.roomSummary.remove(this.id);
        } else {
            summaryChanges = this._summary.writeData(summaryChanges, txn);
        }
        if (summaryChanges) {
            log.set("summaryChanges", summaryChanges.diff(this._summary.data));
        }
        let heroChanges;
        if (summaryChanges?.needsHeroes) {
            if (!this._heroes) {
                this._heroes = new Heroes(this._roomId);
            }
            heroChanges = await this._heroes.calculateChanges(summaryChanges.heroes, memberChanges, txn);
        }
        let removedPendingEvents;
        if (Array.isArray(roomResponse.timeline?.events)) {
            removedPendingEvents = await this._sendQueue.removeRemoteEchos(roomResponse.timeline.events, txn, log);
        }
        return {
            summaryChanges,
            roomEncryption,
            newEntries,
            updatedEntries,
            newLiveKey,
            removedPendingEvents,
            memberChanges,
            heroChanges,
            shouldFlushKeyShares,
        };
    }
    afterSync(changes, log) {
        const {
            summaryChanges, newEntries, updatedEntries, newLiveKey,
            removedPendingEvents, memberChanges,
            heroChanges, roomEncryption
        } = changes;
        log.set("id", this.id);
        this._syncWriter.afterSync(newLiveKey);
        this._setEncryption(roomEncryption);
        if (memberChanges.size) {
            if (this._changedMembersDuringSync) {
                for (const [userId, memberChange] of memberChanges.entries()) {
                    this._changedMembersDuringSync.set(userId, memberChange.member);
                }
            }
            if (this._memberList) {
                this._memberList.afterSync(memberChanges);
            }
            if (this._timeline) {
                for (const [userId, memberChange] of memberChanges.entries()) {
                    if (userId === this._user.id) {
                        this._timeline.updateOwnMember(memberChange.member);
                        break;
                    }
                }
            }
        }
        let emitChange = false;
        if (summaryChanges) {
            this._summary.applyChanges(summaryChanges);
            if (!this._summary.data.needsHeroes) {
                this._heroes = null;
            }
            emitChange = true;
        }
        if (this._heroes && heroChanges) {
            const oldName = this.name;
            this._heroes.applyChanges(heroChanges, this._summary.data);
            if (oldName !== this.name) {
                emitChange = true;
            }
        }
        if (emitChange) {
            this._emitUpdate();
        }
        if (this._timeline) {
            this._timeline.replaceEntries(updatedEntries);
            this._timeline.addEntries(newEntries);
        }
        if (this._observedEvents) {
            this._observedEvents.updateEvents(updatedEntries);
            this._observedEvents.updateEvents(newEntries);
        }
        if (removedPendingEvents) {
            this._sendQueue.emitRemovals(removedPendingEvents);
        }
    }
    needsAfterSyncCompleted({shouldFlushKeyShares}) {
        return shouldFlushKeyShares;
    }
    async afterSyncCompleted(changes, log) {
        log.set("id", this.id);
        if (this._roomEncryption) {
            await this._roomEncryption.flushPendingRoomKeyShares(this._hsApi, null, log);
        }
    }
    start(pendingOperations, parentLog) {
        if (this._roomEncryption) {
            const roomKeyShares = pendingOperations?.get("share_room_key");
            if (roomKeyShares) {
                parentLog.wrapDetached("flush room keys", log => {
                    log.set("id", this.id);
                    return this._roomEncryption.flushPendingRoomKeyShares(this._hsApi, roomKeyShares, log);
                });
            }
        }
        this._sendQueue.resumeSending(parentLog);
    }
    async load(summary, txn, log) {
        try {
            await super.load(summary, txn, log);
            await this._syncWriter.load(txn, log);
        } catch (err) {
            throw new WrappedError(`Could not load room ${this._roomId}`, err);
        }
    }
    async _writeGapFill(gapChunk, txn, log) {
        const removedPendingEvents = await this._sendQueue.removeRemoteEchos(gapChunk, txn, log);
        return removedPendingEvents;
    }
    _applyGapFill(removedPendingEvents) {
        this._sendQueue.emitRemovals(removedPendingEvents);
    }
    sendEvent(eventType, content, attachments, log = null) {
        return this._platform.logger.wrapOrRun(log, "send", log => {
            log.set("id", this.id);
            return this._sendQueue.enqueueEvent(eventType, content, attachments, log);
        });
    }
    sendRedaction(eventIdOrTxnId, reason, log = null) {
        return this._platform.logger.wrapOrRun(log, "redact", log => {
            log.set("id", this.id);
            return this._sendQueue.enqueueRedaction(eventIdOrTxnId, reason, log);
        });
    }
    async ensureMessageKeyIsShared(log = null) {
        if (!this._roomEncryption) {
            return;
        }
        return this._platform.logger.wrapOrRun(log, "ensureMessageKeyIsShared", log => {
            log.set("id", this.id);
            return this._roomEncryption.ensureMessageKeyIsShared(this._hsApi, log);
        });
    }
    get isUnread() {
        return this._summary.data.isUnread;
    }
    get notificationCount() {
        return this._summary.data.notificationCount;
    }
    get highlightCount() {
        return this._summary.data.highlightCount;
    }
    get isTrackingMembers() {
        return this._summary.data.isTrackingMembers;
    }
    async _getLastEventId() {
        const lastKey = this._syncWriter.lastMessageKey;
        if (lastKey) {
            const txn = await this._storage.readTxn([
                this._storage.storeNames.timelineEvents,
            ]);
            const eventEntry = await txn.timelineEvents.get(this._roomId, lastKey);
            return eventEntry?.event?.event_id;
        }
    }
    async clearUnread(log = null) {
        if (this.isUnread || this.notificationCount) {
            return await this._platform.logger.wrapOrRun(log, "clearUnread", async log => {
                log.set("id", this.id);
                const txn = await this._storage.readWriteTxn([
                    this._storage.storeNames.roomSummary,
                ]);
                let data;
                try {
                    data = this._summary.writeClearUnread(txn);
                } catch (err) {
                    txn.abort();
                    throw err;
                }
                await txn.complete();
                this._summary.applyChanges(data);
                this._emitUpdate();
                try {
                    const lastEventId = await this._getLastEventId();
                    if (lastEventId) {
                        await this._hsApi.receipt(this._roomId, "m.read", lastEventId);
                    }
                } catch (err) {
                    if (err.name !== "ConnectionError") {
                        throw err;
                    }
                }
            });
        }
    }
    leave(log = null) {
        return this._platform.logger.wrapOrRun(log, "leave room", async log => {
            log.set("id", this.id);
            await this._hsApi.leave(this.id, {log}).response();
        });
    }
    _getPendingEvents() {
        return this._sendQueue.pendingEvents;
    }
    writeIsTrackingMembers(value, txn) {
        return this._summary.writeIsTrackingMembers(value, txn);
    }
    applyIsTrackingMembersChanges(changes) {
        this._summary.applyChanges(changes);
    }
    createAttachment(blob, filename) {
        return new AttachmentUpload({blob, filename, platform: this._platform});
    }
    dispose() {
        super.dispose();
        this._sendQueue.dispose();
    }
}

class ArchivedRoom extends BaseRoom {
    constructor(options) {
        super(options);
        this._releaseCallback = options.releaseCallback;
        this._forgetCallback = options.forgetCallback;
        this._retentionCount = 1;
        this._kickDetails = null;
        this._kickedBy = null;
    }
    retain() {
        this._retentionCount += 1;
    }
    release() {
        this._retentionCount -= 1;
        if (this._retentionCount === 0) {
            this._releaseCallback();
        }
    }
    async _getKickAuthor(sender, txn) {
        const senderMember = await txn.roomMembers.get(this.id, sender);
        if (senderMember) {
            return new RoomMember(senderMember);
        } else {
            return RoomMember.fromUserId(this.id, sender, "join");
        }
    }
    async load(archivedRoomSummary, txn, log) {
        const {summary, kickDetails} = archivedRoomSummary;
        this._kickDetails = kickDetails;
        if (this._kickDetails) {
            this._kickedBy = await this._getKickAuthor(this._kickDetails.sender, txn);
        }
        return super.load(summary, txn, log);
    }
    async writeSync(joinedSummaryData, roomResponse, membership, txn, log) {
        log.set("id", this.id);
        if (membership === "leave") {
            const newKickDetails = findKickDetails(roomResponse, this._user.id);
            if (newKickDetails || joinedSummaryData) {
                const kickDetails = newKickDetails || this._kickDetails;
                let kickedBy;
                if (newKickDetails) {
                    kickedBy = await this._getKickAuthor(newKickDetails.sender, txn);
                }
                const summaryData = joinedSummaryData || this._summary.data;
                txn.archivedRoomSummary.set({
                    summary: summaryData.serialize(),
                    kickDetails,
                });
                return {kickDetails, kickedBy, summaryData};
            }
        } else if (membership === "join") {
            txn.archivedRoomSummary.remove(this.id);
        }
        return {};
    }
    afterSync({summaryData, kickDetails, kickedBy}, log) {
        log.set("id", this.id);
        if (summaryData) {
            this._summary.applyChanges(summaryData);
        }
        if (kickDetails) {
            this._kickDetails = kickDetails;
        }
        if (kickedBy) {
            this._kickedBy = kickedBy;
        }
        this._emitUpdate();
    }
    get isKicked() {
        return this._kickDetails?.membership === "leave";
    }
    get isBanned() {
        return this._kickDetails?.membership === "ban";
    }
    get kickedBy() {
        return this._kickedBy;
    }
    get kickReason() {
        return this._kickDetails?.reason;
    }
    isArchived() {
        return true;
    }
    forget(log = null) {
        return this._platform.logger.wrapOrRun(log, "forget room", async log => {
            log.set("id", this.id);
            await this._hsApi.forget(this.id, {log}).response();
            const storeNames = this._storage.storeNames;
            const txn = await this._storage.readWriteTxn([
                storeNames.roomState,
                storeNames.archivedRoomSummary,
                storeNames.roomMembers,
                storeNames.timelineEvents,
                storeNames.timelineFragments,
                storeNames.pendingEvents,
                storeNames.inboundGroupSessions,
                storeNames.groupSessionDecryptions,
                storeNames.operations,
            ]);
            txn.roomState.removeAllForRoom(this.id);
            txn.archivedRoomSummary.remove(this.id);
            txn.roomMembers.removeAllForRoom(this.id);
            txn.timelineEvents.removeAllForRoom(this.id);
            txn.timelineFragments.removeAllForRoom(this.id);
            txn.pendingEvents.removeAllForRoom(this.id);
            txn.inboundGroupSessions.removeAllForRoom(this.id);
            txn.groupSessionDecryptions.removeAllForRoom(this.id);
            await txn.operations.removeAllForScope(this.id);
            await txn.complete();
            this._retentionCount = 0;
            this._releaseCallback();
            this._forgetCallback(this.id);
        });
    }
    join(log = null) {
        return this._platform.logger.wrapOrRun(log, "rejoin archived room", async log => {
            await this._hsApi.join(this.id, {log}).response();
        });
    }
}
function findKickDetails(roomResponse, ownUserId) {
    const kickEvent = reduceStateEvents(roomResponse, (kickEvent, event) => {
        if (event.type === EVENT_TYPE) {
            if (event.state_key === ownUserId && event.sender !== event.state_key) {
                kickEvent = event;
            }
        }
        return kickEvent;
    }, null);
    if (kickEvent) {
        return {
            membership: kickEvent.content?.membership,
            reason: kickEvent.content?.reason,
            sender: kickEvent.sender,
        };
    }
}

class RoomStatus {
    constructor(joined, invited, archived) {
        this.joined = joined;
        this.invited = invited;
        this.archived = archived;
    }
    withInvited() {
        if (this.invited) {
            return this;
        } else if (this.archived) {
            return RoomStatus.invitedAndArchived;
        } else {
            return RoomStatus.invited;
        }
    }
    withoutInvited() {
        if (!this.invited) {
            return this;
        } else if (this.joined) {
            return RoomStatus.joined;
        } else if (this.archived) {
            return RoomStatus.archived;
        } else {
            return RoomStatus.none;
        }
    }
    withoutArchived() {
        if (!this.archived) {
            return this;
        } else if (this.invited) {
            return RoomStatus.invited;
        } else {
            return RoomStatus.none;
        }
    }
}
RoomStatus.joined = new RoomStatus(true, false, false);
RoomStatus.archived = new RoomStatus(false, false, true);
RoomStatus.invited = new RoomStatus(false, true, false);
RoomStatus.invitedAndArchived = new RoomStatus(false, true, true);
RoomStatus.none = new RoomStatus(false, false, false);

class Invite extends EventEmitter {
    constructor({roomId, user, hsApi, mediaRepository, emitCollectionRemove, emitCollectionUpdate, platform}) {
        super();
        this._roomId = roomId;
        this._user = user;
        this._hsApi = hsApi;
        this._emitCollectionRemove = emitCollectionRemove;
        this._emitCollectionUpdate = emitCollectionUpdate;
        this._mediaRepository = mediaRepository;
        this._platform = platform;
        this._inviteData = null;
        this._accepting = false;
        this._rejecting = false;
        this._accepted = false;
        this._rejected = false;
    }
    get isInvite() {
        return true;
    }
    get id() {
        return this._roomId;
    }
    get name() {
        return this._inviteData.name || this._inviteData.canonicalAlias;
    }
    get isDirectMessage() {
        return this._inviteData.isDirectMessage;
    }
    get avatarUrl() {
        return this._inviteData.avatarUrl;
    }
    get timestamp() {
        return this._inviteData.timestamp;
    }
    get isEncrypted() {
        return this._inviteData.isEncrypted;
    }
    get inviter() {
        return this._inviter;
    }
    get isPublic() {
        return this._inviteData.joinRule === "public";
    }
    get canonicalAlias() {
        return this._inviteData.canonicalAlias;
    }
    async accept(log = null) {
        await this._platform.logger.wrapOrRun(log, "acceptInvite", async log => {
            this._accepting = true;
            this._emitChange("accepting");
            await this._hsApi.join(this._roomId, {log}).response();
        });
    }
    async reject(log = null) {
        await this._platform.logger.wrapOrRun(log, "rejectInvite", async log => {
            this._rejecting = true;
            this._emitChange("rejecting");
            await this._hsApi.leave(this._roomId, {log}).response();
        });
    }
    get accepting() {
        return this._accepting;
    }
    get accepted() {
        return this._accepted;
    }
    get rejecting() {
        return this._rejecting;
    }
    get rejected() {
        return this._rejected;
    }
    get mediaRepository() {
        return this._mediaRepository;
    }
    _emitChange(params) {
        this.emit("change");
        this._emitCollectionUpdate(this, params);
    }
    load(inviteData, log) {
        log.set("id", this.id);
        this._inviteData = inviteData;
        this._inviter = inviteData.inviter ? new RoomMember(inviteData.inviter) : null;
    }
    async writeSync(membership, roomResponse, txn, log) {
        if (membership === "invite") {
            log.set("id", this.id);
            log.set("add", true);
            const inviteState = roomResponse["invite_state"]?.events;
            if (!Array.isArray(inviteState)) {
                return null;
            }
            const summaryData = this._createSummaryData(inviteState);
            let heroes;
            if (!summaryData.name && !summaryData.canonicalAlias) {
                heroes = await this._createHeroes(inviteState);
            }
            const myInvite = this._getMyInvite(inviteState);
            if (!myInvite) {
                return null;
            }
            const inviter = this._getInviter(myInvite, inviteState);
            const inviteData = this._createData(inviteState, myInvite, inviter, summaryData, heroes);
            txn.invites.set(inviteData);
            return {inviteData, inviter};
        } else {
            log.set("id", this.id);
            log.set("membership", membership);
            txn.invites.remove(this.id);
            return {removed: true, membership};
        }
    }
    afterSync(changes, log) {
        log.set("id", this.id);
        if (changes) {
            if (changes.removed) {
                this._accepting = false;
                this._rejecting = false;
                if (changes.membership === "join") {
                    this._accepted = true;
                } else {
                    this._rejected = true;
                }
                this.emit("change");
            } else {
                this._inviteData = changes.inviteData;
                this._inviter = changes.inviter;
            }
        }
    }
    _createData(inviteState, myInvite, inviter, summaryData, heroes) {
        const name = heroes ? heroes.roomName : summaryData.name;
        const avatarUrl = heroes ? heroes.roomAvatarUrl : summaryData.avatarUrl;
        return {
            roomId: this.id,
            isEncrypted: !!summaryData.encryption,
            isDirectMessage: this._isDirectMessage(myInvite),
            name,
            avatarUrl,
            canonicalAlias: summaryData.canonicalAlias,
            timestamp: this._platform.clock.now(),
            joinRule: this._getJoinRule(inviteState),
            inviter: inviter?.serialize(),
        };
    }
    _isDirectMessage(myInvite) {
        return !!(myInvite?.content?.is_direct);
    }
    _createSummaryData(inviteState) {
        return inviteState.reduce(processStateEvent, new SummaryData(null, this.id));
    }
    async _createHeroes(inviteState) {
        const members = inviteState.filter(e => e.type === EVENT_TYPE);
        const otherMembers = members.filter(e => e.state_key !== this._user.id);
        const memberChanges = otherMembers.reduce((map, e) => {
            const member = RoomMember.fromMemberEvent(this.id, e);
            map.set(member.userId, new MemberChange(member, null));
            return map;
        }, new Map());
        const otherUserIds = otherMembers.map(e => e.state_key);
        const heroes = new Heroes(this.id);
        const changes = await heroes.calculateChanges(otherUserIds, memberChanges, null);
        const countSummary = new SummaryData(null, this.id);
        countSummary.joinCount = members.reduce((sum, e) => sum + (e.content?.membership === "join" ? 1 : 0), 0);
        countSummary.inviteCount = members.reduce((sum, e) => sum + (e.content?.membership === "invite" ? 1 : 0), 0);
        heroes.applyChanges(changes, countSummary);
        return heroes;
    }
    _getMyInvite(inviteState) {
        return inviteState.find(e => e.type === EVENT_TYPE && e.state_key === this._user.id);
    }
    _getInviter(myInvite, inviteState) {
        const inviterMemberEvent = inviteState.find(e => e.type === EVENT_TYPE && e.state_key === myInvite.sender);
        if (inviterMemberEvent) {
            return RoomMember.fromMemberEvent(this.id, inviterMemberEvent);
        }
    }
    _getJoinRule(inviteState) {
        const event = inviteState.find(e => e.type === "m.room.join_rules");
        if (event) {
            return event.content?.join_rule;
        }
        return null;
    }
}

class Pusher {
    constructor(description) {
        this._description = description;
    }
    static httpPusher(host, appId, pushkey, data) {
        return new Pusher({
            kind: "http",
            append: true,
            data: Object.assign({}, data, {url: host + "/_matrix/push/v1/notify"}),
            pushkey,
            app_id: appId,
            app_display_name: "Hydrogen",
            device_display_name: "Hydrogen",
            lang: "en"
        });
    }
    static createDefaultPayload(sessionId) {
        return {session_id: sessionId};
    }
    async enable(hsApi, log) {
        try {
            log.set("endpoint", new URL(this._description.data.endpoint).host);
        } catch {
            log.set("endpoint", null);
        }
        await hsApi.setPusher(this._description, {log}).response();
    }
    async disable(hsApi, log) {
        const deleteDescription = Object.assign({}, this._description, {kind: null});
        await hsApi.setPusher(deleteDescription, {log}).response();
    }
    serialize() {
        return this._description;
    }
    equals(pusher) {
        if (this._description.app_id !== pusher._description.app_id) {
            return false;
        }
        if (this._description.pushkey !== pusher._description.pushkey) {
            return false;
        }
        return JSON.stringify(this._description.data) === JSON.stringify(pusher._description.data);
    }
}

function groupBy(array, groupFn) {
    return groupByWithCreator(array, groupFn,
        () => {return [];},
        (array, value) => array.push(value)
    );
}
function groupByWithCreator(array, groupFn, createCollectionFn, addCollectionFn) {
    return array.reduce((map, value) => {
        const key = groupFn(value);
        let collection = map.get(key);
        if (!collection) {
            collection = createCollectionFn();
            map.set(key, collection);
        }
        addCollectionFn(collection, value);
        return map;
    }, new Map());
}
function countBy(events, mapper) {
    return events.reduce((counts, event) => {
        const mappedValue = mapper(event);
        if (!counts[mappedValue]) {
            counts[mappedValue] = 1;
        } else {
            counts[mappedValue] += 1;
        }
        return counts;
    }, {});
}

class DeviceMessageHandler {
    constructor({storage}) {
        this._storage = storage;
        this._olmDecryption = null;
        this._megolmDecryption = null;
    }
    enableEncryption({olmDecryption, megolmDecryption}) {
        this._olmDecryption = olmDecryption;
        this._megolmDecryption = megolmDecryption;
    }
    obtainSyncLock(toDeviceEvents) {
        return this._olmDecryption?.obtainDecryptionLock(toDeviceEvents);
    }
    async prepareSync(toDeviceEvents, lock, txn, log) {
        log.set("messageTypes", countBy(toDeviceEvents, e => e.type));
        const encryptedEvents = toDeviceEvents.filter(e => e.type === "m.room.encrypted");
        if (!this._olmDecryption) {
            log.log("can't decrypt, encryption not enabled", log.level.Warn);
            return;
        }
        const olmEvents = encryptedEvents.filter(e => e.content?.algorithm === OLM_ALGORITHM);
        if (olmEvents.length) {
            const olmDecryptChanges = await this._olmDecryption.decryptAll(olmEvents, lock, txn);
            log.set("decryptedTypes", countBy(olmDecryptChanges.results, r => r.event?.type));
            for (const err of olmDecryptChanges.errors) {
                log.child("decrypt_error").catch(err);
            }
            const newRoomKeys = this._megolmDecryption.roomKeysFromDeviceMessages(olmDecryptChanges.results, log);
            return new SyncPreparation(olmDecryptChanges, newRoomKeys);
        }
    }
    async writeSync(prep, txn) {
        prep.olmDecryptChanges.write(txn);
        await Promise.all(prep.newRoomKeys.map(key => this._megolmDecryption.writeRoomKey(key, txn)));
    }
}
class SyncPreparation {
    constructor(olmDecryptChanges, newRoomKeys) {
        this.olmDecryptChanges = olmDecryptChanges;
        this.newRoomKeys = newRoomKeys;
        this.newKeysByRoom = groupBy(newRoomKeys, r => r.roomId);
    }
    dispose() {
        if (this.newRoomKeys) {
            for (const k of this.newRoomKeys) {
                k.dispose();
            }
        }
    }
}

const ACCOUNT_SESSION_KEY = SESSION_KEY_PREFIX + "olmAccount";
const DEVICE_KEY_FLAG_SESSION_KEY = SESSION_KEY_PREFIX + "areDeviceKeysUploaded";
const SERVER_OTK_COUNT_SESSION_KEY = SESSION_KEY_PREFIX + "serverOTKCount";
class Account {
    static async load({olm, pickleKey, hsApi, userId, deviceId, olmWorker, txn}) {
        const pickledAccount = await txn.session.get(ACCOUNT_SESSION_KEY);
        if (pickledAccount) {
            const account = new olm.Account();
            const areDeviceKeysUploaded = await txn.session.get(DEVICE_KEY_FLAG_SESSION_KEY);
            account.unpickle(pickleKey, pickledAccount);
            const serverOTKCount = await txn.session.get(SERVER_OTK_COUNT_SESSION_KEY);
            return new Account({pickleKey, hsApi, account, userId,
                deviceId, areDeviceKeysUploaded, serverOTKCount, olm, olmWorker});
        }
    }
    static async create({olm, pickleKey, hsApi, userId, deviceId, olmWorker, storage}) {
        const account = new olm.Account();
        if (olmWorker) {
            await olmWorker.createAccountAndOTKs(account, account.max_number_of_one_time_keys());
        } else {
            account.create();
            account.generate_one_time_keys(account.max_number_of_one_time_keys());
        }
        const pickledAccount = account.pickle(pickleKey);
        const areDeviceKeysUploaded = false;
        const txn = await storage.readWriteTxn([
            storage.storeNames.session
        ]);
        try {
            txn.session.add(ACCOUNT_SESSION_KEY, pickledAccount);
            txn.session.add(DEVICE_KEY_FLAG_SESSION_KEY, areDeviceKeysUploaded);
            txn.session.add(SERVER_OTK_COUNT_SESSION_KEY, 0);
        } catch (err) {
            txn.abort();
            throw err;
        }
        await txn.complete();
        return new Account({pickleKey, hsApi, account, userId,
            deviceId, areDeviceKeysUploaded, serverOTKCount: 0, olm, olmWorker});
    }
    constructor({pickleKey, hsApi, account, userId, deviceId, areDeviceKeysUploaded, serverOTKCount, olm, olmWorker}) {
        this._olm = olm;
        this._pickleKey = pickleKey;
        this._hsApi = hsApi;
        this._account = account;
        this._userId = userId;
        this._deviceId = deviceId;
        this._areDeviceKeysUploaded = areDeviceKeysUploaded;
        this._serverOTKCount = serverOTKCount;
        this._olmWorker = olmWorker;
        this._identityKeys = JSON.parse(this._account.identity_keys());
    }
    get identityKeys() {
        return this._identityKeys;
    }
    async uploadKeys(storage, log) {
        const oneTimeKeys = JSON.parse(this._account.one_time_keys());
        const oneTimeKeysEntries = Object.entries(oneTimeKeys.curve25519);
        if (oneTimeKeysEntries.length || !this._areDeviceKeysUploaded) {
            const payload = {};
            if (!this._areDeviceKeysUploaded) {
                log.set("identity", true);
                const identityKeys = JSON.parse(this._account.identity_keys());
                payload.device_keys = this._deviceKeysPayload(identityKeys);
            }
            if (oneTimeKeysEntries.length) {
                log.set("otks", true);
                payload.one_time_keys = this._oneTimeKeysPayload(oneTimeKeysEntries);
            }
            const response = await this._hsApi.uploadKeys(payload, {log}).response();
            this._serverOTKCount = response?.one_time_key_counts?.signed_curve25519;
            log.set("serverOTKCount", this._serverOTKCount);
            await this._updateSessionStorage(storage, sessionStore => {
                if (oneTimeKeysEntries.length) {
                    this._account.mark_keys_as_published();
                    sessionStore.set(ACCOUNT_SESSION_KEY, this._account.pickle(this._pickleKey));
                    sessionStore.set(SERVER_OTK_COUNT_SESSION_KEY, this._serverOTKCount);
                }
                if (!this._areDeviceKeysUploaded) {
                    this._areDeviceKeysUploaded = true;
                    sessionStore.set(DEVICE_KEY_FLAG_SESSION_KEY, this._areDeviceKeysUploaded);
                }
            });
        }
    }
    async generateOTKsIfNeeded(storage, log) {
        const maxOTKs = this._account.max_number_of_one_time_keys();
        const keyLimit = Math.floor(maxOTKs / 2);
        if (this._serverOTKCount < keyLimit) {
            const oneTimeKeys = JSON.parse(this._account.one_time_keys());
            const oneTimeKeysEntries = Object.entries(oneTimeKeys.curve25519);
            const unpublishedOTKCount = oneTimeKeysEntries.length;
            const newKeyCount = keyLimit - unpublishedOTKCount - this._serverOTKCount;
            if (newKeyCount > 0) {
                await log.wrap("generate otks", log => {
                    log.set("max", maxOTKs);
                    log.set("server", this._serverOTKCount);
                    log.set("unpublished", unpublishedOTKCount);
                    log.set("new", newKeyCount);
                    log.set("limit", keyLimit);
                    this._account.generate_one_time_keys(newKeyCount);
                    this._updateSessionStorage(storage, sessionStore => {
                        sessionStore.set(ACCOUNT_SESSION_KEY, this._account.pickle(this._pickleKey));
                    });
                });
            }
            return true;
        }
        return false;
    }
    createInboundOlmSession(senderKey, body) {
        const newSession = new this._olm.Session();
        try {
            newSession.create_inbound_from(this._account, senderKey, body);
            return newSession;
        } catch (err) {
            newSession.free();
            throw err;
        }
    }
    async createOutboundOlmSession(theirIdentityKey, theirOneTimeKey) {
        const newSession = new this._olm.Session();
        try {
            if (this._olmWorker) {
                await this._olmWorker.createOutboundOlmSession(this._account, newSession, theirIdentityKey, theirOneTimeKey);
            } else {
                newSession.create_outbound(this._account, theirIdentityKey, theirOneTimeKey);
            }
            return newSession;
        } catch (err) {
            newSession.free();
            throw err;
        }
    }
    writeRemoveOneTimeKey(session, txn) {
        this._account.remove_one_time_keys(session);
        txn.session.set(ACCOUNT_SESSION_KEY, this._account.pickle(this._pickleKey));
    }
    writeSync(deviceOneTimeKeysCount, txn, log) {
        const otkCount = deviceOneTimeKeysCount.signed_curve25519 || 0;
        if (Number.isSafeInteger(otkCount) && otkCount !== this._serverOTKCount) {
            txn.session.set(SERVER_OTK_COUNT_SESSION_KEY, otkCount);
            log.set("otkCount", otkCount);
            return otkCount;
        }
    }
    afterSync(otkCount) {
        if (Number.isSafeInteger(otkCount)) {
            this._serverOTKCount = otkCount;
        }
    }
    _deviceKeysPayload(identityKeys) {
        const obj = {
            user_id: this._userId,
            device_id: this._deviceId,
            algorithms: [OLM_ALGORITHM, MEGOLM_ALGORITHM],
            keys: {}
        };
        for (const [algorithm, pubKey] of Object.entries(identityKeys)) {
            obj.keys[`${algorithm}:${this._deviceId}`] = pubKey;
        }
        this.signObject(obj);
        return obj;
    }
    _oneTimeKeysPayload(oneTimeKeysEntries) {
        const obj = {};
        for (const [keyId, pubKey] of oneTimeKeysEntries) {
            const keyObj = {
                key: pubKey
            };
            this.signObject(keyObj);
            obj[`signed_curve25519:${keyId}`] = keyObj;
        }
        return obj;
    }
    async _updateSessionStorage(storage, callback) {
        const txn = await storage.readWriteTxn([
            storage.storeNames.session
        ]);
        try {
            await callback(txn.session);
        } catch (err) {
            txn.abort();
            throw err;
        }
        await txn.complete();
    }
    signObject(obj) {
        const sigs = obj.signatures || {};
        const unsigned = obj.unsigned;
        delete obj.signatures;
        delete obj.unsigned;
        sigs[this._userId] = sigs[this._userId] || {};
        sigs[this._userId]["ed25519:" + this._deviceId] =
            this._account.sign(anotherJson.stringify(obj));
        obj.signatures = sigs;
        if (unsigned !== undefined) {
            obj.unsigned = unsigned;
        }
    }
}

class Lock {
    constructor() {
        this._promise = null;
        this._resolve = null;
    }
    tryTake() {
        if (!this._promise) {
            this._promise = new Promise(resolve => {
                this._resolve = resolve;
            });
            return true;
        }
        return false;
    }
    async take() {
        while(!this.tryTake()) {
            await this.released();
        }
    }
    get isTaken() {
        return !!this._promise;
    }
    release() {
        if (this._resolve) {
            this._promise = null;
            const resolve = this._resolve;
            this._resolve = null;
            resolve();
        }
    }
    released() {
        return this._promise;
    }
}
class MultiLock {
    constructor(locks) {
        this.locks = locks;
    }
    release() {
        for (const lock of this.locks) {
            lock.release();
        }
    }
}

function createSessionEntry(olmSession, senderKey, timestamp, pickleKey) {
    return {
        session: olmSession.pickle(pickleKey),
        sessionId: olmSession.session_id(),
        senderKey,
        lastUsed: timestamp,
    };
}
class Session {
    constructor(data, pickleKey, olm, isNew = false) {
        this.data = data;
        this._olm = olm;
        this._pickleKey = pickleKey;
        this.isNew = isNew;
        this.isModified = isNew;
    }
    static create(senderKey, olmSession, olm, pickleKey, timestamp) {
        const data = createSessionEntry(olmSession, senderKey, timestamp, pickleKey);
        return new Session(data, pickleKey, olm, true);
    }
    get id() {
        return this.data.sessionId;
    }
    load() {
        const session = new this._olm.Session();
        session.unpickle(this._pickleKey, this.data.session);
        return session;
    }
    unload(olmSession) {
        olmSession.free();
    }
    save(olmSession) {
        this.data.session = olmSession.pickle(this._pickleKey);
        this.isModified = true;
    }
}

class DecryptionResult {
    constructor(event, senderCurve25519Key, claimedKeys) {
        this.event = event;
        this.senderCurve25519Key = senderCurve25519Key;
        this.claimedEd25519Key = claimedKeys.ed25519;
        this._device = null;
        this._roomTracked = true;
    }
    setDevice(device) {
        this._device = device;
    }
    setRoomNotTrackedYet() {
        this._roomTracked = false;
    }
    get isVerified() {
        if (this._device) {
            const comesFromDevice = this._device.ed25519Key === this.claimedEd25519Key;
            return comesFromDevice;
        }
        return false;
    }
    get isUnverified() {
        if (this._device) {
            return !this.isVerified;
        } else if (this.isVerificationUnknown) {
            return false;
        } else {
            return true;
        }
    }
    get isVerificationUnknown() {
        return !this._device && !this._roomTracked;
    }
}

const SESSION_LIMIT_PER_SENDER_KEY = 4;
function isPreKeyMessage(message) {
    return message.type === 0;
}
function sortSessions(sessions) {
    sessions.sort((a, b) => {
        return b.data.lastUsed - a.data.lastUsed;
    });
}
class Decryption {
    constructor({account, pickleKey, now, ownUserId, storage, olm, senderKeyLock}) {
        this._account = account;
        this._pickleKey = pickleKey;
        this._now = now;
        this._ownUserId = ownUserId;
        this._storage = storage;
        this._olm = olm;
        this._senderKeyLock = senderKeyLock;
    }
    async obtainDecryptionLock(events) {
        const senderKeys = new Set();
        for (const event of events) {
            const senderKey = event.content?.["sender_key"];
            if (senderKey) {
                senderKeys.add(senderKey);
            }
        }
        const locks = await Promise.all(Array.from(senderKeys).map(senderKey => {
            return this._senderKeyLock.takeLock(senderKey);
        }));
        return new MultiLock(locks);
    }
    async decryptAll(events, lock, txn) {
        try {
            const eventsPerSenderKey = groupBy(events, event => event.content?.["sender_key"]);
            const timestamp = this._now();
            const senderKeyOperations = await Promise.all(Array.from(eventsPerSenderKey.entries()).map(([senderKey, events]) => {
                return this._decryptAllForSenderKey(senderKey, events, timestamp, txn);
            }));
            const results = senderKeyOperations.reduce((all, r) => all.concat(r.results), []);
            const errors = senderKeyOperations.reduce((all, r) => all.concat(r.errors), []);
            const senderKeyDecryptions = senderKeyOperations.map(r => r.senderKeyDecryption);
            return new DecryptionChanges(senderKeyDecryptions, results, errors, this._account, lock);
        } catch (err) {
            lock.release();
            throw err;
        }
    }
    async _decryptAllForSenderKey(senderKey, events, timestamp, readSessionsTxn) {
        const sessions = await this._getSessions(senderKey, readSessionsTxn);
        const senderKeyDecryption = new SenderKeyDecryption(senderKey, sessions, this._olm, timestamp);
        const results = [];
        const errors = [];
        for (const event of events) {
            try {
                const result = this._decryptForSenderKey(senderKeyDecryption, event, timestamp);
                results.push(result);
            } catch (err) {
                errors.push(err);
            }
        }
        return {results, errors, senderKeyDecryption};
    }
    _decryptForSenderKey(senderKeyDecryption, event, timestamp) {
        const senderKey = senderKeyDecryption.senderKey;
        const message = this._getMessageAndValidateEvent(event);
        let plaintext;
        try {
            plaintext = senderKeyDecryption.decrypt(message);
        } catch (err) {
            throw new DecryptionError("OLM_BAD_ENCRYPTED_MESSAGE", event, {senderKey, error: err.message});
        }
        if (typeof plaintext !== "string" && isPreKeyMessage(message)) {
            let createResult;
            try {
                createResult = this._createSessionAndDecrypt(senderKey, message, timestamp);
            } catch (error) {
                throw new DecryptionError(`Could not create inbound olm session: ${error.message}`, event, {senderKey, error});
            }
            senderKeyDecryption.addNewSession(createResult.session);
            plaintext = createResult.plaintext;
        }
        if (typeof plaintext === "string") {
            let payload;
            try {
                payload = JSON.parse(plaintext);
            } catch (error) {
                throw new DecryptionError("PLAINTEXT_NOT_JSON", event, {plaintext, error});
            }
            this._validatePayload(payload, event);
            return new DecryptionResult(payload, senderKey, payload.keys);
        } else {
            throw new DecryptionError("OLM_NO_MATCHING_SESSION", event,
                {knownSessionIds: senderKeyDecryption.sessions.map(s => s.id)});
        }
    }
    _createSessionAndDecrypt(senderKey, message, timestamp) {
        let plaintext;
        const olmSession = this._account.createInboundOlmSession(senderKey, message.body);
        try {
            plaintext = olmSession.decrypt(message.type, message.body);
            const session = Session.create(senderKey, olmSession, this._olm, this._pickleKey, timestamp);
            session.unload(olmSession);
            return {session, plaintext};
        } catch (err) {
            olmSession.free();
            throw err;
        }
    }
    _getMessageAndValidateEvent(event) {
        const ciphertext = event.content?.ciphertext;
        if (!ciphertext) {
            throw new DecryptionError("OLM_MISSING_CIPHERTEXT", event);
        }
        const message = ciphertext?.[this._account.identityKeys.curve25519];
        if (!message) {
            throw new DecryptionError("OLM_NOT_INCLUDED_IN_RECIPIENTS", event);
        }
        return message;
    }
    async _getSessions(senderKey, txn) {
        const sessionEntries = await txn.olmSessions.getAll(senderKey);
        const sessions = sessionEntries.map(s => new Session(s, this._pickleKey, this._olm));
        sortSessions(sessions);
        return sessions;
    }
    _validatePayload(payload, event) {
        if (payload.sender !== event.sender) {
            throw new DecryptionError("OLM_FORWARDED_MESSAGE", event, {sentBy: event.sender, encryptedBy: payload.sender});
        }
        if (payload.recipient !== this._ownUserId) {
            throw new DecryptionError("OLM_BAD_RECIPIENT", event, {recipient: payload.recipient});
        }
        if (payload.recipient_keys?.ed25519 !== this._account.identityKeys.ed25519) {
            throw new DecryptionError("OLM_BAD_RECIPIENT_KEY", event, {key: payload.recipient_keys?.ed25519});
        }
        if (!payload.type) {
            throw new DecryptionError("missing type on payload", event, {payload});
        }
        if (typeof payload.keys?.ed25519 !== "string") {
            throw new DecryptionError("Missing or invalid claimed ed25519 key on payload", event, {payload});
        }
    }
}
class SenderKeyDecryption {
    constructor(senderKey, sessions, olm, timestamp) {
        this.senderKey = senderKey;
        this.sessions = sessions;
        this._olm = olm;
        this._timestamp = timestamp;
    }
    addNewSession(session) {
        this.sessions.unshift(session);
    }
    decrypt(message) {
        for (const session of this.sessions) {
            const plaintext = this._decryptWithSession(session, message);
            if (typeof plaintext === "string") {
                sortSessions(this.sessions);
                return plaintext;
            }
        }
    }
    getModifiedSessions() {
        return this.sessions.filter(session => session.isModified);
    }
    get hasNewSessions() {
        return this.sessions.some(session => session.isNew);
    }
    _decryptWithSession(session, message) {
        const olmSession = session.load();
        try {
            if (isPreKeyMessage(message) && !olmSession.matches_inbound(message.body)) {
                return;
            }
            try {
                const plaintext = olmSession.decrypt(message.type, message.body);
                session.save(olmSession);
                session.lastUsed = this._timestamp;
                return plaintext;
            } catch (err) {
                if (isPreKeyMessage(message)) {
                    throw new Error(`Error decrypting prekey message with existing session id ${session.id}: ${err.message}`);
                }
                return;
            }
        } finally {
            session.unload(olmSession);
        }
    }
}
class DecryptionChanges {
    constructor(senderKeyDecryptions, results, errors, account, lock) {
        this._senderKeyDecryptions = senderKeyDecryptions;
        this._account = account;
        this.results = results;
        this.errors = errors;
        this._lock = lock;
    }
    get hasNewSessions() {
        return this._senderKeyDecryptions.some(skd => skd.hasNewSessions);
    }
    write(txn) {
        try {
            for (const senderKeyDecryption of this._senderKeyDecryptions) {
                for (const session of senderKeyDecryption.getModifiedSessions()) {
                    txn.olmSessions.set(session.data);
                    if (session.isNew) {
                        const olmSession = session.load();
                        try {
                            this._account.writeRemoveOneTimeKey(olmSession, txn);
                        } finally {
                            session.unload(olmSession);
                        }
                    }
                }
                if (senderKeyDecryption.sessions.length > SESSION_LIMIT_PER_SENDER_KEY) {
                    const {senderKey, sessions} = senderKeyDecryption;
                    for (let i = sessions.length - 1; i >= SESSION_LIMIT_PER_SENDER_KEY ; i -= 1) {
                        const session = sessions[i];
                        txn.olmSessions.remove(senderKey, session.id);
                    }
                }
            }
        } finally {
            this._lock.release();
        }
    }
}

function findFirstSessionId(sessionIds) {
    return sessionIds.reduce((first, sessionId) => {
        if (!first || sessionId < first) {
            return sessionId;
        } else {
            return first;
        }
    }, null);
}
const OTK_ALGORITHM = "signed_curve25519";
const MAX_BATCH_SIZE = 20;
class Encryption {
    constructor({account, olm, olmUtil, ownUserId, storage, now, pickleKey, senderKeyLock}) {
        this._account = account;
        this._olm = olm;
        this._olmUtil = olmUtil;
        this._ownUserId = ownUserId;
        this._storage = storage;
        this._now = now;
        this._pickleKey = pickleKey;
        this._senderKeyLock = senderKeyLock;
    }
    async encrypt(type, content, devices, hsApi, log) {
        let messages = [];
        for (let i = 0; i < devices.length ; i += MAX_BATCH_SIZE) {
            const batchDevices = devices.slice(i, i + MAX_BATCH_SIZE);
            const batchMessages = await this._encryptForMaxDevices(type, content, batchDevices, hsApi, log);
            messages = messages.concat(batchMessages);
        }
        return messages;
    }
    async _encryptForMaxDevices(type, content, devices, hsApi, log) {
        const locks = await Promise.all(devices.map(device => {
            return this._senderKeyLock.takeLock(device.curve25519Key);
        }));
        try {
            const {
                devicesWithoutSession,
                existingEncryptionTargets,
            } = await this._findExistingSessions(devices);
            const timestamp = this._now();
            let encryptionTargets = [];
            try {
                if (devicesWithoutSession.length) {
                    const newEncryptionTargets = await log.wrap("create sessions", log => this._createNewSessions(
                        devicesWithoutSession, hsApi, timestamp, log));
                    encryptionTargets = encryptionTargets.concat(newEncryptionTargets);
                }
                await this._loadSessions(existingEncryptionTargets);
                encryptionTargets = encryptionTargets.concat(existingEncryptionTargets);
                const encryptLog = {l: "encrypt", targets: encryptionTargets.length};
                const messages = log.wrap(encryptLog, () => encryptionTargets.map(target => {
                    const encryptedContent = this._encryptForDevice(type, content, target);
                    return new EncryptedMessage(encryptedContent, target.device);
                }));
                await this._storeSessions(encryptionTargets, timestamp);
                return messages;
            } finally {
                for (const target of encryptionTargets) {
                    target.dispose();
                }
            }
        } finally {
            for (const lock of locks) {
                lock.release();
            }
        }
    }
    async _findExistingSessions(devices) {
        const txn = await this._storage.readTxn([this._storage.storeNames.olmSessions]);
        const sessionIdsForDevice = await Promise.all(devices.map(async device => {
            return await txn.olmSessions.getSessionIds(device.curve25519Key);
        }));
        const devicesWithoutSession = devices.filter((_, i) => {
            const sessionIds = sessionIdsForDevice[i];
            return !(sessionIds?.length);
        });
        const existingEncryptionTargets = devices.map((device, i) => {
            const sessionIds = sessionIdsForDevice[i];
            if (sessionIds?.length > 0) {
                const sessionId = findFirstSessionId(sessionIds);
                return EncryptionTarget.fromSessionId(device, sessionId);
            }
        }).filter(target => !!target);
        return {devicesWithoutSession, existingEncryptionTargets};
    }
    _encryptForDevice(type, content, target) {
        const {session, device} = target;
        const plaintext = JSON.stringify(this._buildPlainTextMessageForDevice(type, content, device));
        const message = session.encrypt(plaintext);
        const encryptedContent = {
            algorithm: OLM_ALGORITHM,
            sender_key: this._account.identityKeys.curve25519,
            ciphertext: {
                [device.curve25519Key]: message
            }
        };
        return encryptedContent;
    }
    _buildPlainTextMessageForDevice(type, content, device) {
        return {
            keys: {
                "ed25519": this._account.identityKeys.ed25519
            },
            recipient_keys: {
                "ed25519": device.ed25519Key
            },
            recipient: device.userId,
            sender: this._ownUserId,
            content,
            type
        }
    }
    async _createNewSessions(devicesWithoutSession, hsApi, timestamp, log) {
        const newEncryptionTargets = await log.wrap("claim", log => this._claimOneTimeKeys(hsApi, devicesWithoutSession, log));
        try {
            for (const target of newEncryptionTargets) {
                const {device, oneTimeKey} = target;
                target.session = await this._account.createOutboundOlmSession(device.curve25519Key, oneTimeKey);
            }
            await this._storeSessions(newEncryptionTargets, timestamp);
        } catch (err) {
            for (const target of newEncryptionTargets) {
                target.dispose();
            }
            throw err;
        }
        return newEncryptionTargets;
    }
    async _claimOneTimeKeys(hsApi, deviceIdentities, log) {
        const devicesByUser = groupByWithCreator(deviceIdentities,
            device => device.userId,
            () => new Map(),
            (deviceMap, device) => deviceMap.set(device.deviceId, device)
        );
        const oneTimeKeys = Array.from(devicesByUser.entries()).reduce((usersObj, [userId, deviceMap]) => {
            usersObj[userId] = Array.from(deviceMap.values()).reduce((devicesObj, device) => {
                devicesObj[device.deviceId] = OTK_ALGORITHM;
                return devicesObj;
            }, {});
            return usersObj;
        }, {});
        const claimResponse = await hsApi.claimKeys({
            timeout: 10000,
            one_time_keys: oneTimeKeys
        }, {log}).response();
        if (Object.keys(claimResponse.failures).length) {
            log.log({l: "failures", servers: Object.keys(claimResponse.failures)}, log.level.Warn);
        }
        const userKeyMap = claimResponse?.["one_time_keys"];
        return this._verifyAndCreateOTKTargets(userKeyMap, devicesByUser);
    }
    _verifyAndCreateOTKTargets(userKeyMap, devicesByUser) {
        const verifiedEncryptionTargets = [];
        for (const [userId, userSection] of Object.entries(userKeyMap)) {
            for (const [deviceId, deviceSection] of Object.entries(userSection)) {
                const [firstPropName, keySection] = Object.entries(deviceSection)[0];
                const [keyAlgorithm] = firstPropName.split(":");
                if (keyAlgorithm === OTK_ALGORITHM) {
                    const device = devicesByUser.get(userId)?.get(deviceId);
                    if (device) {
                        const isValidSignature = verifyEd25519Signature(
                            this._olmUtil, userId, deviceId, device.ed25519Key, keySection);
                        if (isValidSignature) {
                            const target = EncryptionTarget.fromOTK(device, keySection.key);
                            verifiedEncryptionTargets.push(target);
                        }
                    }
                }
            }
        }
        return verifiedEncryptionTargets;
    }
    async _loadSessions(encryptionTargets) {
        const txn = await this._storage.readTxn([this._storage.storeNames.olmSessions]);
        let failed = false;
        try {
            await Promise.all(encryptionTargets.map(async encryptionTarget => {
                const sessionEntry = await txn.olmSessions.get(
                    encryptionTarget.device.curve25519Key, encryptionTarget.sessionId);
                if (sessionEntry && !failed) {
                    const olmSession = new this._olm.Session();
                    olmSession.unpickle(this._pickleKey, sessionEntry.session);
                    encryptionTarget.session = olmSession;
                }
            }));
        } catch (err) {
            failed = true;
            for (const target of encryptionTargets) {
                target.dispose();
            }
            throw err;
        }
    }
    async _storeSessions(encryptionTargets, timestamp) {
        const txn = await this._storage.readWriteTxn([this._storage.storeNames.olmSessions]);
        try {
            for (const target of encryptionTargets) {
                const sessionEntry = createSessionEntry(
                    target.session, target.device.curve25519Key, timestamp, this._pickleKey);
                txn.olmSessions.set(sessionEntry);
            }
        } catch (err) {
            txn.abort();
            throw err;
        }
        await txn.complete();
    }
}
class EncryptionTarget {
    constructor(device, oneTimeKey, sessionId) {
        this.device = device;
        this.oneTimeKey = oneTimeKey;
        this.sessionId = sessionId;
        this.session = null;
    }
    static fromOTK(device, oneTimeKey) {
        return new EncryptionTarget(device, oneTimeKey, null);
    }
    static fromSessionId(device, sessionId) {
        return new EncryptionTarget(device, null, sessionId);
    }
    dispose() {
        if (this.session) {
            this.session.free();
        }
    }
}
class EncryptedMessage {
    constructor(content, device) {
        this.content = content;
        this.device = device;
    }
}

class SessionInfo {
    constructor(roomId, senderKey, session, claimedKeys) {
        this.roomId = roomId;
        this.senderKey = senderKey;
        this.session = session;
        this.claimedKeys = claimedKeys;
        this._refCounter = 0;
    }
    get sessionId() {
        return this.session?.session_id();
    }
    retain() {
        this._refCounter += 1;
    }
    release() {
        this._refCounter -= 1;
        if (this._refCounter <= 0) {
            this.dispose();
        }
    }
    dispose() {
        this.session.free();
        this.session = null;
    }
}

class BaseRoomKey {
    constructor() {
        this._sessionInfo = null;
        this._isBetter = null;
        this._eventIds = null;
    }
    async createSessionInfo(olm, pickleKey, txn) {
        if (this._isBetter === false) {
            return;
        }
        const session = new olm.InboundGroupSession();
        try {
            this._loadSessionKey(session);
            this._isBetter = await this._isBetterThanKnown(session, olm, pickleKey, txn);
            if (this._isBetter) {
                const claimedKeys = {ed25519: this.claimedEd25519Key};
                this._sessionInfo = new SessionInfo(this.roomId, this.senderKey, session, claimedKeys);
                this._sessionInfo.retain();
                return this._sessionInfo;
            } else {
                session.free();
                return;
            }
        } catch (err) {
            this._sessionInfo = null;
            session.free();
            throw err;
        }
    }
    async _isBetterThanKnown(session, olm, pickleKey, txn) {
        let isBetter = true;
        const existingSessionEntry = await txn.inboundGroupSessions.get(this.roomId, this.senderKey, this.sessionId);
        if (existingSessionEntry?.session) {
            const existingSession = new olm.InboundGroupSession();
            try {
                existingSession.unpickle(pickleKey, existingSessionEntry.session);
                isBetter = session.first_known_index() < existingSession.first_known_index();
            } finally {
                existingSession.free();
            }
        }
        if (existingSessionEntry?.eventIds) {
            this._eventIds = existingSessionEntry.eventIds;
        }
        return isBetter;
    }
    async write(olm, pickleKey, txn) {
        if (this._isBetter === false) {
            return false;
        }
        if (!this._sessionInfo) {
            await this.createSessionInfo(olm, pickleKey, txn);
        }
        if (this._sessionInfo) {
            const session = this._sessionInfo.session;
            const sessionEntry = {
                roomId: this.roomId,
                senderKey: this.senderKey,
                sessionId: this.sessionId,
                session: session.pickle(pickleKey),
                claimedKeys: this._sessionInfo.claimedKeys,
            };
            txn.inboundGroupSessions.set(sessionEntry);
            this.dispose();
            return true;
        }
        return false;
    }
    get eventIds() {
        return this._eventIds;
    }
    dispose() {
        if (this._sessionInfo) {
            this._sessionInfo.release();
            this._sessionInfo = null;
        }
    }
}
class DeviceMessageRoomKey extends BaseRoomKey {
    constructor(decryptionResult) {
        super();
        this._decryptionResult = decryptionResult;
    }
    get roomId() { return this._decryptionResult.event.content?.["room_id"]; }
    get senderKey() { return this._decryptionResult.senderCurve25519Key; }
    get sessionId() { return this._decryptionResult.event.content?.["session_id"]; }
    get claimedEd25519Key() { return this._decryptionResult.claimedEd25519Key; }
    _loadSessionKey(session) {
        const sessionKey = this._decryptionResult.event.content?.["session_key"];
        session.create(sessionKey);
    }
}
class BackupRoomKey extends BaseRoomKey {
    constructor(roomId, sessionId, backupInfo) {
        super();
        this._roomId = roomId;
        this._sessionId = sessionId;
        this._backupInfo = backupInfo;
    }
    get roomId() { return this._roomId; }
    get senderKey() { return this._backupInfo["sender_key"]; }
    get sessionId() { return this._sessionId; }
    get claimedEd25519Key() { return this._backupInfo["sender_claimed_keys"]?.["ed25519"]; }
    _loadSessionKey(session) {
        const sessionKey = this._backupInfo["session_key"];
        session.import_session(sessionKey);
    }
}
function fromDeviceMessage(dr) {
    const roomId = dr.event.content?.["room_id"];
    const sessionId = dr.event.content?.["session_id"];
    const sessionKey = dr.event.content?.["session_key"];
    if (
        typeof roomId === "string" ||
        typeof sessionId === "string" ||
        typeof senderKey === "string" ||
        typeof sessionKey === "string"
    ) {
        return new DeviceMessageRoomKey(dr);
    }
}
function fromBackup(roomId, sessionId, sessionInfo) {
    const sessionKey = sessionInfo["session_key"];
    const senderKey = sessionInfo["sender_key"];
    const claimedEd25519Key = sessionInfo["sender_claimed_keys"]?.["ed25519"];
    if (
        typeof roomId === "string" &&
        typeof sessionId === "string" &&
        typeof senderKey === "string" &&
        typeof sessionKey === "string" &&
        typeof claimedEd25519Key === "string"
    ) {
        return new BackupRoomKey(roomId, sessionId, sessionInfo);
    }
}

class DecryptionChanges$1 {
    constructor(roomId, results, errors, replayEntries) {
        this._roomId = roomId;
        this._results = results;
        this._errors = errors;
        this._replayEntries = replayEntries;
    }
    async write(txn) {
        await Promise.all(this._replayEntries.map(async replayEntry => {
            try {
                this._handleReplayAttack(this._roomId, replayEntry, txn);
            } catch (err) {
                this._errors.set(replayEntry.eventId, err);
            }
        }));
        return {
            results: this._results,
            errors: this._errors
        };
    }
    async _handleReplayAttack(roomId, replayEntry, txn) {
        const {messageIndex, sessionId, eventId, timestamp} = replayEntry;
        const decryption = await txn.groupSessionDecryptions.get(roomId, sessionId, messageIndex);
        if (decryption && decryption.eventId !== eventId) {
            const decryptedEventIsBad = decryption.timestamp < timestamp;
            const badEventId = decryptedEventIsBad ? eventId : decryption.eventId;
            this._results.delete(eventId);
            throw new DecryptionError("MEGOLM_REPLAYED_INDEX", event, {
                messageIndex,
                badEventId,
                otherEventId: decryption.eventId
            });
        }
        if (!decryption) {
            txn.groupSessionDecryptions.set(roomId, sessionId, messageIndex, {
                eventId,
                timestamp
            });
        }
    }
}

function mergeMap(src, dst) {
    if (src) {
        for (const [key, value] of src.entries()) {
            dst.set(key, value);
        }
    }
}

class DecryptionPreparation {
    constructor(roomId, sessionDecryptions, errors) {
        this._roomId = roomId;
        this._sessionDecryptions = sessionDecryptions;
        this._initialErrors = errors;
    }
    async decrypt() {
        try {
            const errors = this._initialErrors;
            const results = new Map();
            const replayEntries = [];
            await Promise.all(this._sessionDecryptions.map(async sessionDecryption => {
                const sessionResult = await sessionDecryption.decryptAll();
                mergeMap(sessionResult.errors, errors);
                mergeMap(sessionResult.results, results);
                replayEntries.push(...sessionResult.replayEntries);
            }));
            return new DecryptionChanges$1(this._roomId, results, errors, replayEntries);
        } finally {
            this.dispose();
        }
    }
    dispose() {
        for (const sd of this._sessionDecryptions) {
            sd.dispose();
        }
    }
}

class ReplayDetectionEntry {
    constructor(sessionId, messageIndex, event) {
        this.sessionId = sessionId;
        this.messageIndex = messageIndex;
        this.eventId = event.event_id;
        this.timestamp = event.origin_server_ts;
    }
}

class SessionDecryption {
    constructor(sessionInfo, events, olmWorker) {
        sessionInfo.retain();
        this._sessionInfo = sessionInfo;
        this._events = events;
        this._olmWorker = olmWorker;
        this._decryptionRequests = olmWorker ? [] : null;
    }
    async decryptAll() {
        const replayEntries = [];
        const results = new Map();
        let errors;
        const roomId = this._sessionInfo.roomId;
        await Promise.all(this._events.map(async event => {
            try {
                const {session} = this._sessionInfo;
                const ciphertext = event.content.ciphertext;
                let decryptionResult;
                if (this._olmWorker) {
                    const request = this._olmWorker.megolmDecrypt(session, ciphertext);
                    this._decryptionRequests.push(request);
                    decryptionResult = await request.response();
                } else {
                    decryptionResult = session.decrypt(ciphertext);
                }
                const plaintext = decryptionResult.plaintext;
                const messageIndex = decryptionResult.message_index;
                let payload;
                try {
                    payload = JSON.parse(plaintext);
                } catch (err) {
                    throw new DecryptionError("PLAINTEXT_NOT_JSON", event, {plaintext, err});
                }
                if (payload.room_id !== roomId) {
                    throw new DecryptionError("MEGOLM_WRONG_ROOM", event,
                        {encryptedRoomId: payload.room_id, eventRoomId: roomId});
                }
                replayEntries.push(new ReplayDetectionEntry(session.session_id(), messageIndex, event));
                const result = new DecryptionResult(payload, this._sessionInfo.senderKey, this._sessionInfo.claimedKeys);
                results.set(event.event_id, result);
            } catch (err) {
                if (err.name === "AbortError") {
                    return;
                }
                if (!errors) {
                    errors = new Map();
                }
                errors.set(event.event_id, err);
            }
        }));
        return {results, errors, replayEntries};
    }
    dispose() {
        if (this._decryptionRequests) {
            for (const r of this._decryptionRequests) {
                r.abort();
            }
        }
        this._sessionInfo.release();
    }
}

const DEFAULT_CACHE_SIZE = 10;
class SessionCache extends BaseLRUCache {
    constructor(limit) {
        limit = typeof limit === "number" ? limit : DEFAULT_CACHE_SIZE;
        super(limit);
    }
    get(roomId, senderKey, sessionId) {
        return this._get(s => {
            return s.roomId === roomId &&
                s.senderKey === senderKey &&
                sessionId === s.sessionId;
        });
    }
    add(sessionInfo) {
        sessionInfo.retain();
        this._set(sessionInfo, s => {
            return s.roomId === sessionInfo.roomId &&
                s.senderKey === sessionInfo.senderKey &&
                s.sessionId === sessionInfo.sessionId;
        });
    }
    _onEvictEntry(sessionInfo) {
        sessionInfo.release();
    }
    dispose() {
        for (const sessionInfo of this._entries) {
            sessionInfo.release();
        }
    }
}

function getSenderKey(event) {
    return event.content?.["sender_key"];
}
function getSessionId(event) {
    return event.content?.["session_id"];
}
function getCiphertext(event) {
    return event.content?.ciphertext;
}
function validateEvent(event) {
    return typeof getSenderKey(event) === "string" &&
           typeof getSessionId(event) === "string" &&
           typeof getCiphertext(event) === "string";
}
class SessionKeyGroup {
    constructor() {
        this.events = [];
    }
    get senderKey() {
        return getSenderKey(this.events[0]);
    }
    get sessionId() {
        return getSessionId(this.events[0]);
    }
}
function groupEventsBySession(events) {
    return groupByWithCreator(events,
        event => `${getSenderKey(event)}|${getSessionId(event)}`,
        () => new SessionKeyGroup(),
        (group, event) => group.events.push(event)
    );
}

class Decryption$1 {
    constructor({pickleKey, olm, olmWorker}) {
        this._pickleKey = pickleKey;
        this._olm = olm;
        this._olmWorker = olmWorker;
    }
    createSessionCache(size) {
        return new SessionCache(size);
    }
    async addMissingKeyEventIds(roomId, senderKey, sessionId, eventIds, txn) {
        let sessionEntry = await txn.inboundGroupSessions.get(roomId, senderKey, sessionId);
        if (sessionEntry?.session) {
            return;
        }
        if (sessionEntry) {
            const uniqueEventIds = new Set(sessionEntry.eventIds);
            for (const id of eventIds) {
                uniqueEventIds.add(id);
            }
            sessionEntry.eventIds = Array.from(uniqueEventIds);
        } else {
            sessionEntry = {roomId, senderKey, sessionId, eventIds};
        }
        txn.inboundGroupSessions.set(sessionEntry);
    }
    async getEventIdsForMissingKey(roomId, senderKey, sessionId, txn) {
        const sessionEntry = await txn.inboundGroupSessions.get(roomId, senderKey, sessionId);
        if (sessionEntry && !sessionEntry.session) {
            return sessionEntry.eventIds;
        }
    }
    async hasSession(roomId, senderKey, sessionId, txn) {
        const sessionEntry = await txn.inboundGroupSessions.get(roomId, senderKey, sessionId);
        const isValidSession = typeof sessionEntry?.session === "string";
        return isValidSession;
    }
    async prepareDecryptAll(roomId, events, newKeys, sessionCache, txn) {
        const errors = new Map();
        const validEvents = [];
        for (const event of events) {
            if (validateEvent(event)) {
                validEvents.push(event);
            } else {
                errors.set(event.event_id, new DecryptionError("MEGOLM_INVALID_EVENT", event));
            }
        }
        const eventsBySession = groupEventsBySession(validEvents);
        const sessionDecryptions = [];
        await Promise.all(Array.from(eventsBySession.values()).map(async group => {
            const sessionInfo = await this._getSessionInfo(roomId, group.senderKey, group.sessionId, newKeys, sessionCache, txn);
            if (sessionInfo) {
                sessionDecryptions.push(new SessionDecryption(sessionInfo, group.events, this._olmWorker));
            } else {
                for (const event of group.events) {
                    errors.set(event.event_id, new DecryptionError("MEGOLM_NO_SESSION", event));
                }
            }
        }));
        return new DecryptionPreparation(roomId, sessionDecryptions, errors);
    }
    async _getSessionInfo(roomId, senderKey, sessionId, newKeys, sessionCache, txn) {
        let sessionInfo;
        if (newKeys) {
            const key = newKeys.find(k => k.roomId === roomId && k.senderKey === senderKey && k.sessionId === sessionId);
            if (key) {
                sessionInfo = await key.createSessionInfo(this._olm, this._pickleKey, txn);
                if (sessionInfo) {
                    sessionCache.add(sessionInfo);
                }
            }
        }
        if (!sessionInfo) {
            sessionInfo = sessionCache.get(roomId, senderKey, sessionId);
        }
        if (!sessionInfo) {
            const sessionEntry = await txn.inboundGroupSessions.get(roomId, senderKey, sessionId);
            if (sessionEntry && sessionEntry.session) {
                let session = new this._olm.InboundGroupSession();
                try {
                    session.unpickle(this._pickleKey, sessionEntry.session);
                    sessionInfo = new SessionInfo(roomId, senderKey, session, sessionEntry.claimedKeys);
                } catch (err) {
                    session.free();
                    throw err;
                }
                sessionCache.add(sessionInfo);
            }
        }
        return sessionInfo;
    }
    writeRoomKey(key, txn) {
        return key.write(this._olm, this._pickleKey, txn);
    }
    roomKeysFromDeviceMessages(decryptionResults, log) {
        let keys = [];
        for (const dr of decryptionResults) {
            if (dr.event?.type !== "m.room_key" || dr.event.content?.algorithm !== MEGOLM_ALGORITHM) {
                continue;
            }
            log.wrap("room_key", log => {
                const key = fromDeviceMessage(dr);
                if (key) {
                    log.set("roomId", key.roomId);
                    log.set("id", key.sessionId);
                    keys.push(key);
                } else {
                    log.logLevel = log.level.Warn;
                    log.set("invalid", true);
                }
            }, log.level.Detail);
        }
        return keys;
    }
    roomKeyFromBackup(roomId, sessionId, sessionInfo) {
        return fromBackup(roomId, sessionId, sessionInfo);
    }
}

class SessionBackup {
    constructor({backupInfo, decryption, hsApi}) {
        this._backupInfo = backupInfo;
        this._decryption = decryption;
        this._hsApi = hsApi;
    }
    async getSession(roomId, sessionId, log) {
        const sessionResponse = await this._hsApi.roomKeyForRoomAndSession(this._backupInfo.version, roomId, sessionId, {log}).response();
        const sessionInfo = this._decryption.decrypt(
            sessionResponse.session_data.ephemeral,
            sessionResponse.session_data.mac,
            sessionResponse.session_data.ciphertext,
        );
        return JSON.parse(sessionInfo);
    }
    get version() {
        return this._backupInfo.version;
    }
    dispose() {
        this._decryption.free();
    }
    static async fromSecretStorage({platform, olm, secretStorage, hsApi, txn}) {
        const base64PrivateKey = await secretStorage.readSecret("m.megolm_backup.v1", txn);
        if (base64PrivateKey) {
            const privateKey = new Uint8Array(platform.encoding.base64.decode(base64PrivateKey));
            const backupInfo = await hsApi.roomKeysVersion().response();
            const expectedPubKey = backupInfo.auth_data.public_key;
            const decryption = new olm.PkDecryption();
            try {
                const pubKey = decryption.init_with_private_key(privateKey);
                if (pubKey !== expectedPubKey) {
                    throw new Error(`Bad backup key, public key does not match. Calculated ${pubKey} but expected ${expectedPubKey}`);
                }
            } catch(err) {
                decryption.free();
                throw err;
            }
            return new SessionBackup({backupInfo, decryption, hsApi});
        }
    }
}

class Encryption$1 {
    constructor({pickleKey, olm, account, storage, now, ownDeviceId}) {
        this._pickleKey = pickleKey;
        this._olm = olm;
        this._account = account;
        this._storage = storage;
        this._now = now;
        this._ownDeviceId = ownDeviceId;
    }
    discardOutboundSession(roomId, txn) {
        txn.outboundGroupSessions.remove(roomId);
    }
    async createRoomKeyMessage(roomId, txn) {
        let sessionEntry = await txn.outboundGroupSessions.get(roomId);
        if (sessionEntry) {
            const session = new this._olm.OutboundGroupSession();
            try {
                session.unpickle(this._pickleKey, sessionEntry.session);
                return this._createRoomKeyMessage(session, roomId);
            } finally {
                session.free();
            }
        }
    }
    createWithheldMessage(roomMessage, code, reason) {
        return {
            algorithm: roomMessage.algorithm,
            code,
            reason,
            room_id: roomMessage.room_id,
            sender_key: this._account.identityKeys.curve25519,
            session_id: roomMessage.session_id
        };
    }
    async ensureOutboundSession(roomId, encryptionParams) {
        let session = new this._olm.OutboundGroupSession();
        try {
            const txn = await this._storage.readWriteTxn([
                this._storage.storeNames.inboundGroupSessions,
                this._storage.storeNames.outboundGroupSessions,
            ]);
            let roomKeyMessage;
            try {
                let sessionEntry = await txn.outboundGroupSessions.get(roomId);
                roomKeyMessage = this._readOrCreateSession(session, sessionEntry, roomId, encryptionParams, txn);
                if (roomKeyMessage) {
                    this._writeSession(this._now(), session, roomId, txn);
                }
            } catch (err) {
                txn.abort();
                throw err;
            }
            await txn.complete();
            return roomKeyMessage;
        } finally {
            session.free();
        }
    }
    _readOrCreateSession(session, sessionEntry, roomId, encryptionParams, txn) {
        if (sessionEntry) {
            session.unpickle(this._pickleKey, sessionEntry.session);
        }
        if (!sessionEntry || this._needsToRotate(session, sessionEntry.createdAt, encryptionParams)) {
            if (sessionEntry) {
                session.free();
                session = new this._olm.OutboundGroupSession();
            }
            session.create();
            const roomKeyMessage = this._createRoomKeyMessage(session, roomId);
            this._storeAsInboundSession(session, roomId, txn);
            return roomKeyMessage;
        }
    }
    _writeSession(createdAt, session, roomId, txn) {
        txn.outboundGroupSessions.set({
            roomId,
            session: session.pickle(this._pickleKey),
            createdAt,
        });
    }
    async encrypt(roomId, type, content, encryptionParams) {
        let session = new this._olm.OutboundGroupSession();
        try {
            const txn = await this._storage.readWriteTxn([
                this._storage.storeNames.inboundGroupSessions,
                this._storage.storeNames.outboundGroupSessions,
            ]);
            let roomKeyMessage;
            let encryptedContent;
            try {
                let sessionEntry = await txn.outboundGroupSessions.get(roomId);
                roomKeyMessage = this._readOrCreateSession(session, sessionEntry, roomId, encryptionParams, txn);
                encryptedContent = this._encryptContent(roomId, session, type, content);
                const createdAt = roomKeyMessage ? this._now() : sessionEntry.createdAt;
                this._writeSession(createdAt, session, roomId, txn);
            } catch (err) {
                txn.abort();
                throw err;
            }
            await txn.complete();
            return new EncryptionResult(encryptedContent, roomKeyMessage);
        } finally {
            if (session) {
                session.free();
            }
        }
    }
    _needsToRotate(session, createdAt, encryptionParams) {
        let rotationPeriodMs = 604800000;
        if (Number.isSafeInteger(encryptionParams?.rotation_period_ms)) {
            rotationPeriodMs = encryptionParams?.rotation_period_ms;
        }
        let rotationPeriodMsgs = 100;
        if (Number.isSafeInteger(encryptionParams?.rotation_period_msgs)) {
            rotationPeriodMsgs = encryptionParams?.rotation_period_msgs;
        }
        if (this._now() > (createdAt + rotationPeriodMs)) {
            return true;
        }
        if (session.message_index() >= rotationPeriodMsgs) {
            return true;
        }
    }
    _encryptContent(roomId, session, type, content) {
        const plaintext = JSON.stringify({
            room_id: roomId,
            type,
            content
        });
        const ciphertext = session.encrypt(plaintext);
        const encryptedContent = {
            algorithm: MEGOLM_ALGORITHM,
            sender_key: this._account.identityKeys.curve25519,
            ciphertext,
            session_id: session.session_id(),
            device_id: this._ownDeviceId
        };
        return encryptedContent;
    }
    _createRoomKeyMessage(session, roomId) {
        return {
            room_id: roomId,
            session_id: session.session_id(),
            session_key: session.session_key(),
            algorithm: MEGOLM_ALGORITHM,
            chain_index: session.message_index()
        }
    }
    _storeAsInboundSession(outboundSession, roomId, txn) {
        const {identityKeys} = this._account;
        const claimedKeys = {ed25519: identityKeys.ed25519};
        const session = new this._olm.InboundGroupSession();
        try {
            session.create(outboundSession.session_key());
            const sessionEntry = {
                roomId,
                senderKey: identityKeys.curve25519,
                sessionId: session.session_id(),
                session: session.pickle(this._pickleKey),
                claimedKeys,
            };
            txn.inboundGroupSessions.set(sessionEntry);
            return sessionEntry;
        } finally {
            session.free();
        }
    }
}
class EncryptionResult {
    constructor(content, roomKeyMessage) {
        this.content = content;
        this.roomKeyMessage = roomKeyMessage;
    }
}

const ENCRYPTED_TYPE = "m.room.encrypted";
const MIN_PRESHARE_INTERVAL = 60 * 1000;
class RoomEncryption {
    constructor({room, deviceTracker, olmEncryption, megolmEncryption, megolmDecryption, encryptionParams, storage, sessionBackup, notifyMissingMegolmSession, clock}) {
        this._room = room;
        this._deviceTracker = deviceTracker;
        this._olmEncryption = olmEncryption;
        this._megolmEncryption = megolmEncryption;
        this._megolmDecryption = megolmDecryption;
        this._encryptionParams = encryptionParams;
        this._megolmBackfillCache = this._megolmDecryption.createSessionCache();
        this._megolmSyncCache = this._megolmDecryption.createSessionCache(1);
        this._senderDeviceCache = new Map();
        this._storage = storage;
        this._sessionBackup = sessionBackup;
        this._notifyMissingMegolmSession = notifyMissingMegolmSession;
        this._clock = clock;
        this._isFlushingRoomKeyShares = false;
        this._lastKeyPreShareTime = null;
        this._keySharePromise = null;
        this._disposed = false;
    }
    enableSessionBackup(sessionBackup) {
        if (this._sessionBackup) {
            return;
        }
        this._sessionBackup = sessionBackup;
    }
    async restoreMissingSessionsFromBackup(entries, log) {
        const events = entries.filter(e => e.isEncrypted && !e.isDecrypted && e.event).map(e => e.event);
        const eventsBySession = groupEventsBySession(events);
        const groups = Array.from(eventsBySession.values());
        const txn = await this._storage.readTxn([this._storage.storeNames.inboundGroupSessions]);
        const hasSessions = await Promise.all(groups.map(async group => {
            return this._megolmDecryption.hasSession(this._room.id, group.senderKey, group.sessionId, txn);
        }));
        const missingSessions = groups.filter((_, i) => !hasSessions[i]);
        if (missingSessions.length) {
            for (var i = missingSessions.length - 1; i >= 0; i--) {
                const session = missingSessions[i];
                await log.wrap("session", log => this._requestMissingSessionFromBackup(session.senderKey, session.sessionId, log));
            }
        }
    }
    notifyTimelineClosed() {
        this._megolmBackfillCache.dispose();
        this._megolmBackfillCache = this._megolmDecryption.createSessionCache();
        this._senderDeviceCache = new Map();
    }
    async writeMemberChanges(memberChanges, txn, log) {
        let shouldFlush = false;
        const memberChangesArray = Array.from(memberChanges.values());
        if (memberChangesArray.some(m => m.hasLeft)) {
            log.log({
                l: "discardOutboundSession",
                leftUsers: memberChangesArray.filter(m => m.hasLeft).map(m => m.userId),
            });
            this._megolmEncryption.discardOutboundSession(this._room.id, txn);
        }
        if (memberChangesArray.some(m => m.hasJoined)) {
            shouldFlush = await this._addShareRoomKeyOperationForNewMembers(memberChangesArray, txn, log);
        }
        await this._deviceTracker.writeMemberChanges(this._room, memberChanges, txn);
        return shouldFlush;
    }
    async prepareDecryptAll(events, newKeys, source, txn) {
        const errors = new Map();
        const validEvents = [];
        for (const event of events) {
            if (event.redacted_because || event.unsigned?.redacted_because) {
                continue;
            }
            if (event.content?.algorithm !== MEGOLM_ALGORITHM) {
                errors.set(event.event_id, new Error("Unsupported algorithm: " + event.content?.algorithm));
            }
            validEvents.push(event);
        }
        let customCache;
        let sessionCache;
        if (source === DecryptionSource.Sync) {
            sessionCache = this._megolmSyncCache;
        } else if (source === DecryptionSource.Timeline) {
            sessionCache = this._megolmBackfillCache;
        } else if (source === DecryptionSource.Retry) {
            customCache = this._megolmDecryption.createSessionCache();
            sessionCache = customCache;
        } else {
            throw new Error("Unknown source: " + source);
        }
        const preparation = await this._megolmDecryption.prepareDecryptAll(
            this._room.id, validEvents, newKeys, sessionCache, txn);
        if (customCache) {
            customCache.dispose();
        }
        return new DecryptionPreparation$1(preparation, errors, source, this, events);
    }
    async _processDecryptionResults(events, results, errors, source, txn, log) {
        const missingSessionEvents = events.filter(event => {
            const error = errors.get(event.event_id);
            return error?.code === "MEGOLM_NO_SESSION";
        });
        if (!missingSessionEvents.length) {
            return;
        }
        const missingEventsBySession = groupEventsBySession(missingSessionEvents);
        if (source === DecryptionSource.Sync) {
            await Promise.all(Array.from(missingEventsBySession.values()).map(async group => {
                const eventIds = group.events.map(e => e.event_id);
                return this._megolmDecryption.addMissingKeyEventIds(
                    this._room.id, group.senderKey, group.sessionId, eventIds, txn);
            }));
        }
        if (!this._sessionBackup) {
            return;
        }
        log.wrapDetached("check key backup", async log => {
            log.set("source", source);
            log.set("events", missingSessionEvents.length);
            log.set("sessions", missingEventsBySession.size);
            if (source === DecryptionSource.Sync) {
                await this._clock.createTimeout(10000).elapsed();
                if (this._disposed) {
                    return;
                }
                const txn = await this._storage.readTxn([this._storage.storeNames.inboundGroupSessions]);
                await Promise.all(Array.from(missingEventsBySession).map(async ([key, group]) => {
                    if (await this._megolmDecryption.hasSession(this._room.id, group.senderKey, group.sessionId, txn)) {
                        missingEventsBySession.delete(key);
                    }
                }));
            }
            await Promise.all(Array.from(missingEventsBySession.values()).map(group => {
                return log.wrap("session", log => this._requestMissingSessionFromBackup(group.senderKey, group.sessionId, log));
            }));
        });
    }
    async _verifyDecryptionResult(result, txn) {
        let device = this._senderDeviceCache.get(result.senderCurve25519Key);
        if (!device) {
            device = await this._deviceTracker.getDeviceByCurve25519Key(result.senderCurve25519Key, txn);
            this._senderDeviceCache.set(result.senderCurve25519Key, device);
        }
        if (device) {
            result.setDevice(device);
        } else if (!this._room.isTrackingMembers) {
            result.setRoomNotTrackedYet();
        }
    }
    async _requestMissingSessionFromBackup(senderKey, sessionId, log) {
        if (!this._sessionBackup) {
            log.set("enabled", false);
            this._notifyMissingMegolmSession();
            return;
        }
        log.set("id", sessionId);
        log.set("senderKey", senderKey);
        try {
            const session = await this._sessionBackup.getSession(this._room.id, sessionId, log);
            if (session?.algorithm === MEGOLM_ALGORITHM) {
                if (session["sender_key"] !== senderKey) {
                    log.set("wrong_sender_key", session["sender_key"]);
                    log.logLevel = log.level.Warn;
                    return;
                }
                let roomKey = this._megolmDecryption.roomKeyFromBackup(this._room.id, sessionId, session);
                if (roomKey) {
                    let keyIsBestOne = false;
                    let retryEventIds;
                    try {
                        const txn = await this._storage.readWriteTxn([this._storage.storeNames.inboundGroupSessions]);
                        try {
                            keyIsBestOne = await this._megolmDecryption.writeRoomKey(roomKey, txn);
                            log.set("isBetter", keyIsBestOne);
                            if (keyIsBestOne) {
                                retryEventIds = roomKey.eventIds;
                            }
                        } catch (err) {
                            txn.abort();
                            throw err;
                        }
                        await txn.complete();
                    } finally {
                        roomKey.dispose();
                    }
                    if (keyIsBestOne) {
                        await log.wrap("retryDecryption", log => this._room.notifyRoomKey(roomKey, retryEventIds || [], log));
                    }
                }
            } else if (session?.algorithm) {
                log.set("unknown algorithm", session.algorithm);
            }
        } catch (err) {
            if (!(err.name === "HomeServerError" && err.errcode === "M_NOT_FOUND")) {
                log.set("not_found", true);
            } else {
                log.error = err;
                log.logLevel = log.level.Error;
            }
        }
    }
    getEventIdsForMissingKey(roomKey, txn) {
        return this._megolmDecryption.getEventIdsForMissingKey(this._room.id, roomKey.senderKey, roomKey.sessionId, txn);
    }
    async ensureMessageKeyIsShared(hsApi, log) {
        if (this._lastKeyPreShareTime?.measure() < MIN_PRESHARE_INTERVAL) {
            return;
        }
        this._lastKeyPreShareTime = this._clock.createMeasure();
        try {
            this._keySharePromise = (async () => {
                const roomKeyMessage = await this._megolmEncryption.ensureOutboundSession(this._room.id, this._encryptionParams);
                if (roomKeyMessage) {
                    await log.wrap("share key", log => this._shareNewRoomKey(roomKeyMessage, hsApi, log));
                }
            })();
            await this._keySharePromise;
        } finally {
            this._keySharePromise = null;
        }
    }
    async encrypt(type, content, hsApi, log) {
        if (this._keySharePromise) {
            log.set("waitForRunningKeyShare", true);
            await this._keySharePromise;
        }
        const megolmResult = await log.wrap("megolm encrypt", () => this._megolmEncryption.encrypt(this._room.id, type, content, this._encryptionParams));
        if (megolmResult.roomKeyMessage) {
            await log.wrap("share key", log => this._shareNewRoomKey(megolmResult.roomKeyMessage, hsApi, log));
        }
        return {
            type: ENCRYPTED_TYPE,
            content: megolmResult.content
        };
    }
    needsToShareKeys(memberChanges) {
        for (const m of memberChanges.values()) {
            if (m.hasJoined) {
                return true;
            }
        }
        return false;
    }
    async _shareNewRoomKey(roomKeyMessage, hsApi, log) {
        let writeOpTxn = await this._storage.readWriteTxn([this._storage.storeNames.operations]);
        let operation;
        try {
            operation = this._writeRoomKeyShareOperation(roomKeyMessage, null, writeOpTxn);
        } catch (err) {
            writeOpTxn.abort();
            throw err;
        }
        await this._processShareRoomKeyOperation(operation, hsApi, log);
    }
    async _addShareRoomKeyOperationForNewMembers(memberChangesArray, txn, log) {
        const userIds = memberChangesArray.filter(m => m.hasJoined).map(m => m.userId);
        const roomKeyMessage = await this._megolmEncryption.createRoomKeyMessage(
            this._room.id, txn);
        if (roomKeyMessage) {
            log.log({
                l: "share key for new members", userIds,
                id: roomKeyMessage.session_id,
                chain_index: roomKeyMessage.chain_index
            });
            this._writeRoomKeyShareOperation(roomKeyMessage, userIds, txn);
            return true;
        }
        return false;
    }
    async flushPendingRoomKeyShares(hsApi, operations, log) {
        if (this._isFlushingRoomKeyShares) {
            return;
        }
        this._isFlushingRoomKeyShares = true;
        try {
            if (!operations) {
                const txn = await this._storage.readTxn([this._storage.storeNames.operations]);
                operations = await txn.operations.getAllByTypeAndScope("share_room_key", this._room.id);
            }
            for (const operation of operations) {
                if (operation.type !== "share_room_key") {
                    continue;
                }
                await log.wrap("operation", log => this._processShareRoomKeyOperation(operation, hsApi, log));
            }
        } finally {
            this._isFlushingRoomKeyShares = false;
        }
    }
    _writeRoomKeyShareOperation(roomKeyMessage, userIds, txn) {
        const id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString();
        const operation = {
            id,
            type: "share_room_key",
            scope: this._room.id,
            userIds,
            roomKeyMessage,
        };
        txn.operations.add(operation);
        return operation;
    }
    async _processShareRoomKeyOperation(operation, hsApi, log) {
        log.set("id", operation.id);
        await this._deviceTracker.trackRoom(this._room, log);
        let devices;
        if (operation.userIds === null) {
            devices = await this._deviceTracker.devicesForTrackedRoom(this._room.id, hsApi, log);
            const userIds = Array.from(devices.reduce((set, device) => set.add(device.userId), new Set()));
            operation.userIds = userIds;
            await this._updateOperationsStore(operations => operations.update(operation));
        } else {
            devices = await this._deviceTracker.devicesForRoomMembers(this._room.id, operation.userIds, hsApi, log);
        }
        const messages = await log.wrap("olm encrypt", log => this._olmEncryption.encrypt(
            "m.room_key", operation.roomKeyMessage, devices, hsApi, log));
        const missingDevices = devices.filter(d => !messages.some(m => m.device === d));
        await log.wrap("send", log => this._sendMessagesToDevices(ENCRYPTED_TYPE, messages, hsApi, log));
        if (missingDevices.length) {
            await log.wrap("missingDevices", async log => {
                log.set("devices", missingDevices.map(d => d.deviceId));
                const unsentUserIds = operation.userIds.filter(userId => missingDevices.some(d => d.userId === userId));
                log.set("unsentUserIds", unsentUserIds);
                operation.userIds = unsentUserIds;
                await this._updateOperationsStore(operations => operations.update(operation));
                const withheldMessage = this._megolmEncryption.createWithheldMessage(operation.roomKeyMessage, "m.no_olm", "OTKs exhausted");
                await this._sendSharedMessageToDevices("org.matrix.room_key.withheld", withheldMessage, missingDevices, hsApi, log);
            });
        }
        await this._updateOperationsStore(operations => operations.remove(operation.id));
    }
    async _updateOperationsStore(callback) {
        const writeTxn = await this._storage.readWriteTxn([this._storage.storeNames.operations]);
        try {
            callback(writeTxn.operations);
        } catch (err) {
            writeTxn.abort();
            throw err;
        }
        await writeTxn.complete();
    }
    async _sendSharedMessageToDevices(type, message, devices, hsApi, log) {
        const devicesByUser = groupBy(devices, device => device.userId);
        const payload = {
            messages: Array.from(devicesByUser.entries()).reduce((userMap, [userId, devices]) => {
                userMap[userId] = devices.reduce((deviceMap, device) => {
                    deviceMap[device.deviceId] = message;
                    return deviceMap;
                }, {});
                return userMap;
            }, {})
        };
        const txnId = makeTxnId();
        await hsApi.sendToDevice(type, payload, txnId, {log}).response();
    }
    async _sendMessagesToDevices(type, messages, hsApi, log) {
        log.set("messages", messages.length);
        const messagesByUser = groupBy(messages, message => message.device.userId);
        const payload = {
            messages: Array.from(messagesByUser.entries()).reduce((userMap, [userId, messages]) => {
                userMap[userId] = messages.reduce((deviceMap, message) => {
                    deviceMap[message.device.deviceId] = message.content;
                    return deviceMap;
                }, {});
                return userMap;
            }, {})
        };
        const txnId = makeTxnId();
        await hsApi.sendToDevice(type, payload, txnId, {log}).response();
    }
    filterUndecryptedEventEntriesForKeys(entries, keys) {
        return entries.filter(entry => {
            if (entry.isEncrypted && !entry.isDecrypted) {
                const {event} = entry;
                if (event) {
                    const senderKey = event.content?.["sender_key"];
                    const sessionId = event.content?.["session_id"];
                    return keys.some(key => senderKey === key.senderKey && sessionId === key.sessionId);
                }
            }
            return false;
        });
    }
    dispose() {
        this._disposed = true;
        this._megolmBackfillCache.dispose();
        this._megolmSyncCache.dispose();
    }
}
class DecryptionPreparation$1 {
    constructor(megolmDecryptionPreparation, extraErrors, source, roomEncryption, events) {
        this._megolmDecryptionPreparation = megolmDecryptionPreparation;
        this._extraErrors = extraErrors;
        this._source = source;
        this._roomEncryption = roomEncryption;
        this._events = events;
    }
    async decrypt() {
        return new DecryptionChanges$2(
            await this._megolmDecryptionPreparation.decrypt(),
            this._extraErrors,
            this._source,
            this._roomEncryption,
            this._events);
    }
    dispose() {
        this._megolmDecryptionPreparation.dispose();
    }
}
class DecryptionChanges$2 {
    constructor(megolmDecryptionChanges, extraErrors, source, roomEncryption, events) {
        this._megolmDecryptionChanges = megolmDecryptionChanges;
        this._extraErrors = extraErrors;
        this._source = source;
        this._roomEncryption = roomEncryption;
        this._events = events;
    }
    async write(txn, log) {
        const {results, errors} = await this._megolmDecryptionChanges.write(txn);
        mergeMap(this._extraErrors, errors);
        await this._roomEncryption._processDecryptionResults(this._events, results, errors, this._source, txn, log);
        return new BatchDecryptionResult(results, errors, this._roomEncryption);
    }
}
class BatchDecryptionResult {
    constructor(results, errors, roomEncryption) {
        this.results = results;
        this.errors = errors;
        this._roomEncryption = roomEncryption;
    }
    applyToEntries(entries) {
        for (const entry of entries) {
            const result = this.results.get(entry.id);
            if (result) {
                entry.setDecryptionResult(result);
            } else {
                const error = this.errors.get(entry.id);
                if (error) {
                    entry.setDecryptionError(error);
                }
            }
        }
    }
    verifySenders(txn) {
        return Promise.all(Array.from(this.results.values()).map(result => {
            return this._roomEncryption._verifyDecryptionResult(result, txn);
        }));
    }
}

const TRACKING_STATUS_OUTDATED = 0;
const TRACKING_STATUS_UPTODATE = 1;
function deviceKeysAsDeviceIdentity(deviceSection) {
    const deviceId = deviceSection["device_id"];
    const userId = deviceSection["user_id"];
    return {
        userId,
        deviceId,
        ed25519Key: deviceSection.keys[`ed25519:${deviceId}`],
        curve25519Key: deviceSection.keys[`curve25519:${deviceId}`],
        algorithms: deviceSection.algorithms,
        displayName: deviceSection.unsigned?.device_display_name,
    };
}
class DeviceTracker {
    constructor({storage, getSyncToken, olmUtil, ownUserId, ownDeviceId}) {
        this._storage = storage;
        this._getSyncToken = getSyncToken;
        this._identityChangedForRoom = null;
        this._olmUtil = olmUtil;
        this._ownUserId = ownUserId;
        this._ownDeviceId = ownDeviceId;
    }
    async writeDeviceChanges(changed, txn, log) {
        const {userIdentities} = txn;
        log.set("changed", changed.length);
        await Promise.all(changed.map(async userId => {
            const user = await userIdentities.get(userId);
            if (user) {
                log.log({l: "outdated", id: userId});
                user.deviceTrackingStatus = TRACKING_STATUS_OUTDATED;
                userIdentities.set(user);
            }
        }));
    }
    writeMemberChanges(room, memberChanges, txn) {
        return Promise.all(Array.from(memberChanges.values()).map(async memberChange => {
            return this._applyMemberChange(memberChange, txn);
        }));
    }
    async trackRoom(room, log) {
        if (room.isTrackingMembers || !room.isEncrypted) {
            return;
        }
        const memberList = await room.loadMemberList(log);
        try {
            const txn = await this._storage.readWriteTxn([
                this._storage.storeNames.roomSummary,
                this._storage.storeNames.userIdentities,
            ]);
            let isTrackingChanges;
            try {
                isTrackingChanges = room.writeIsTrackingMembers(true, txn);
                const members = Array.from(memberList.members.values());
                log.set("members", members.length);
                await this._writeJoinedMembers(members, txn);
            } catch (err) {
                txn.abort();
                throw err;
            }
            await txn.complete();
            room.applyIsTrackingMembersChanges(isTrackingChanges);
        } finally {
            memberList.release();
        }
    }
    async _writeJoinedMembers(members, txn) {
        await Promise.all(members.map(async member => {
            if (member.membership === "join") {
                await this._writeMember(member, txn);
            }
        }));
    }
    async _writeMember(member, txn) {
        const {userIdentities} = txn;
        const identity = await userIdentities.get(member.userId);
        if (!identity) {
            userIdentities.set({
                userId: member.userId,
                roomIds: [member.roomId],
                deviceTrackingStatus: TRACKING_STATUS_OUTDATED,
            });
        } else {
            if (!identity.roomIds.includes(member.roomId)) {
                identity.roomIds.push(member.roomId);
                userIdentities.set(identity);
            }
        }
    }
    async _removeRoomFromUserIdentity(roomId, userId, txn) {
        const {userIdentities, deviceIdentities} = txn;
        const identity = await userIdentities.get(userId);
        if (identity) {
            identity.roomIds = identity.roomIds.filter(id => id !== roomId);
            if (identity.roomIds.length === 0) {
                userIdentities.remove(userId);
                deviceIdentities.removeAllForUser(userId);
            } else {
                userIdentities.set(identity);
            }
        }
    }
    async _applyMemberChange(memberChange, txn) {
        if (memberChange.hasJoined) {
            await this._writeMember(memberChange.member, txn);
        }
        else if (memberChange.hasLeft) {
            const {roomId} = memberChange;
            if (memberChange.userId === this._ownUserId) {
                const userIds = await txn.roomMembers.getAllUserIds(roomId);
                await Promise.all(userIds.map(userId => {
                    return this._removeRoomFromUserIdentity(roomId, userId, txn);
                }));
            } else {
                await this._removeRoomFromUserIdentity(roomId, memberChange.userId, txn);
            }
        }
    }
    async _queryKeys(userIds, hsApi, log) {
        const deviceKeyResponse = await hsApi.queryKeys({
            "timeout": 10000,
            "device_keys": userIds.reduce((deviceKeysMap, userId) => {
                deviceKeysMap[userId] = [];
                return deviceKeysMap;
            }, {}),
            "token": this._getSyncToken()
        }, {log}).response();
        const verifiedKeysPerUser = log.wrap("verify", log => this._filterVerifiedDeviceKeys(deviceKeyResponse["device_keys"], log));
        const txn = await this._storage.readWriteTxn([
            this._storage.storeNames.userIdentities,
            this._storage.storeNames.deviceIdentities,
        ]);
        let deviceIdentities;
        try {
            const devicesIdentitiesPerUser = await Promise.all(verifiedKeysPerUser.map(async ({userId, verifiedKeys}) => {
                const deviceIdentities = verifiedKeys.map(deviceKeysAsDeviceIdentity);
                return await this._storeQueriedDevicesForUserId(userId, deviceIdentities, txn);
            }));
            deviceIdentities = devicesIdentitiesPerUser.reduce((all, devices) => all.concat(devices), []);
            log.set("devices", deviceIdentities.length);
        } catch (err) {
            txn.abort();
            throw err;
        }
        await txn.complete();
        return deviceIdentities;
    }
    async _storeQueriedDevicesForUserId(userId, deviceIdentities, txn) {
        const knownDeviceIds = await txn.deviceIdentities.getAllDeviceIds(userId);
        for (const deviceId of knownDeviceIds) {
            if (deviceIdentities.every(di => di.deviceId !== deviceId)) {
                txn.deviceIdentities.remove(userId, deviceId);
            }
        }
        const allDeviceIdentities = [];
        const deviceIdentitiesToStore = [];
        deviceIdentities = await Promise.all(deviceIdentities.map(async deviceIdentity => {
            if (knownDeviceIds.includes(deviceIdentity.deviceId)) {
                const existingDevice = await txn.deviceIdentities.get(deviceIdentity.userId, deviceIdentity.deviceId);
                if (existingDevice.ed25519Key !== deviceIdentity.ed25519Key) {
                    allDeviceIdentities.push(existingDevice);
                }
            }
            allDeviceIdentities.push(deviceIdentity);
            deviceIdentitiesToStore.push(deviceIdentity);
        }));
        for (const deviceIdentity of deviceIdentitiesToStore) {
            txn.deviceIdentities.set(deviceIdentity);
        }
        const identity = await txn.userIdentities.get(userId);
        identity.deviceTrackingStatus = TRACKING_STATUS_UPTODATE;
        txn.userIdentities.set(identity);
        return allDeviceIdentities;
    }
    _filterVerifiedDeviceKeys(keyQueryDeviceKeysResponse, parentLog) {
        const curve25519Keys = new Set();
        const verifiedKeys = Object.entries(keyQueryDeviceKeysResponse).map(([userId, keysByDevice]) => {
            const verifiedEntries = Object.entries(keysByDevice).filter(([deviceId, deviceKeys]) => {
                const deviceIdOnKeys = deviceKeys["device_id"];
                const userIdOnKeys = deviceKeys["user_id"];
                if (userIdOnKeys !== userId) {
                    return false;
                }
                if (deviceIdOnKeys !== deviceId) {
                    return false;
                }
                const ed25519Key = deviceKeys.keys?.[`ed25519:${deviceId}`];
                const curve25519Key = deviceKeys.keys?.[`curve25519:${deviceId}`];
                if (typeof ed25519Key !== "string" || typeof curve25519Key !== "string") {
                    return false;
                }
                if (curve25519Keys.has(curve25519Key)) {
                    parentLog.log({
                        l: "ignore device with duplicate curve25519 key",
                        keys: deviceKeys
                    }, parentLog.level.Warn);
                    return false;
                }
                curve25519Keys.add(curve25519Key);
                const isValid = this._hasValidSignature(deviceKeys);
                if (!isValid) {
                    parentLog.log({
                        l: "ignore device with invalid signature",
                        keys: deviceKeys
                    }, parentLog.level.Warn);
                }
                return isValid;
            });
            const verifiedKeys = verifiedEntries.map(([, deviceKeys]) => deviceKeys);
            return {userId, verifiedKeys};
        });
        return verifiedKeys;
    }
    _hasValidSignature(deviceSection) {
        const deviceId = deviceSection["device_id"];
        const userId = deviceSection["user_id"];
        const ed25519Key = deviceSection?.keys?.[`${SIGNATURE_ALGORITHM}:${deviceId}`];
        return verifyEd25519Signature(this._olmUtil, userId, deviceId, ed25519Key, deviceSection);
    }
    async devicesForTrackedRoom(roomId, hsApi, log) {
        const txn = await this._storage.readTxn([
            this._storage.storeNames.roomMembers,
            this._storage.storeNames.userIdentities,
        ]);
        const userIds = await txn.roomMembers.getAllUserIds(roomId);
        return await this._devicesForUserIds(roomId, userIds, txn, hsApi, log);
    }
    async devicesForRoomMembers(roomId, userIds, hsApi, log) {
        const txn = await this._storage.readTxn([
            this._storage.storeNames.userIdentities,
        ]);
        return await this._devicesForUserIds(roomId, userIds, txn, hsApi, log);
    }
    async _devicesForUserIds(roomId, userIds, userIdentityTxn, hsApi, log) {
        const allMemberIdentities = await Promise.all(userIds.map(userId => userIdentityTxn.userIdentities.get(userId)));
        const identities = allMemberIdentities.filter(identity => {
            return identity && identity.roomIds.includes(roomId);
        });
        const upToDateIdentities = identities.filter(i => i.deviceTrackingStatus === TRACKING_STATUS_UPTODATE);
        const outdatedIdentities = identities.filter(i => i.deviceTrackingStatus === TRACKING_STATUS_OUTDATED);
        log.set("uptodate", upToDateIdentities.length);
        log.set("outdated", outdatedIdentities.length);
        let queriedDevices;
        if (outdatedIdentities.length) {
            queriedDevices = await this._queryKeys(outdatedIdentities.map(i => i.userId), hsApi, log);
        }
        const deviceTxn = await this._storage.readTxn([
            this._storage.storeNames.deviceIdentities,
        ]);
        const devicesPerUser = await Promise.all(upToDateIdentities.map(identity => {
            return deviceTxn.deviceIdentities.getAllForUserId(identity.userId);
        }));
        let flattenedDevices = devicesPerUser.reduce((all, devicesForUser) => all.concat(devicesForUser), []);
        if (queriedDevices && queriedDevices.length) {
            flattenedDevices = flattenedDevices.concat(queriedDevices);
        }
        const devices = flattenedDevices.filter(device => {
            const isOwnDevice = device.userId === this._ownUserId && device.deviceId === this._ownDeviceId;
            return !isOwnDevice;
        });
        return devices;
    }
    async getDeviceByCurve25519Key(curve25519Key, txn) {
        return await txn.deviceIdentities.getByCurve25519Key(curve25519Key);
    }
}

class LockMap {
    constructor() {
        this._map = new Map();
    }
    async takeLock(key) {
        let lock = this._map.get(key);
        if (lock) {
            await lock.take();
        } else {
            lock = new Lock();
            lock.tryTake();
            this._map.set(key, lock);
        }
        lock.released().then(() => {
            Promise.resolve().then(() => {
                if (!lock.isTaken) {
                    this._map.delete(key);
                }
            });
        });
        return lock;
    }
}

class KeyDescription {
    constructor(id, keyAccountData) {
        this._id = id;
        this._keyAccountData = keyAccountData;
    }
    get id() {
        return this._id;
    }
    get passphraseParams() {
        return this._keyAccountData?.content?.passphrase;
    }
    get algorithm() {
        return this._keyAccountData?.content?.algorithm;
    }
}
class Key {
    constructor(keyDescription, binaryKey) {
        this._keyDescription = keyDescription;
        this._binaryKey = binaryKey;
    }
    get id() {
        return this._keyDescription.id;
    }
    get binaryKey() {
        return this._binaryKey;
    }
    get algorithm() {
        return this._keyDescription.algorithm;
    }
}

const DEFAULT_ITERATIONS = 500000;
const DEFAULT_BITSIZE = 256;
async function keyFromPassphrase(keyDescription, passphrase, platform) {
    const {passphraseParams} = keyDescription;
    if (!passphraseParams) {
        throw new Error("not a passphrase key");
    }
    if (passphraseParams.algorithm !== "m.pbkdf2") {
        throw new Error(`Unsupported passphrase algorithm: ${passphraseParams.algorithm}`);
    }
    const {utf8} = platform.encoding;
    const keyBits = await platform.crypto.derive.pbkdf2(
        utf8.encode(passphrase),
        passphraseParams.iterations || DEFAULT_ITERATIONS,
        utf8.encode(passphraseParams.salt),
        "SHA-512",
        passphraseParams.bits || DEFAULT_BITSIZE);
    return new Key(keyDescription, keyBits);
}

const OLM_RECOVERY_KEY_PREFIX = [0x8B, 0x01];
function keyFromRecoveryKey(keyDescription, recoveryKey, olm, platform) {
    const result = platform.encoding.base58.decode(recoveryKey.replace(/ /g, ''));
    let parity = 0;
    for (const b of result) {
        parity ^= b;
    }
    if (parity !== 0) {
        throw new Error("Incorrect parity");
    }
    for (let i = 0; i < OLM_RECOVERY_KEY_PREFIX.length; ++i) {
        if (result[i] !== OLM_RECOVERY_KEY_PREFIX[i]) {
            throw new Error("Incorrect prefix");
        }
    }
    if (
        result.length !==
        OLM_RECOVERY_KEY_PREFIX.length + olm.PRIVATE_KEY_LENGTH + 1
    ) {
        throw new Error("Incorrect length");
    }
    const keyBits = Uint8Array.from(result.slice(
        OLM_RECOVERY_KEY_PREFIX.length,
        OLM_RECOVERY_KEY_PREFIX.length + olm.PRIVATE_KEY_LENGTH,
    ));
    return new Key(keyDescription, keyBits);
}

async function readDefaultKeyDescription(storage) {
    const txn = await storage.readTxn([
        storage.storeNames.accountData
    ]);
    const defaultKeyEvent = await txn.accountData.get("m.secret_storage.default_key");
    const id = defaultKeyEvent?.content?.key;
    if (!id) {
        return;
    }
    const keyAccountData = await txn.accountData.get(`m.secret_storage.key.${id}`);
    if (!keyAccountData) {
        return;
    }
    return new KeyDescription(id, keyAccountData);
}
async function writeKey(key, txn) {
    txn.session.set("ssssKey", {id: key.id, binaryKey: key.binaryKey});
}
async function readKey(txn) {
    const keyData = await txn.session.get("ssssKey");
    if (!keyData) {
        return;
    }
    const keyAccountData = await txn.accountData.get(`m.secret_storage.key.${keyData.id}`);
    return new Key(new KeyDescription(keyData.id, keyAccountData), keyData.binaryKey);
}
async function keyFromCredential(type, credential, storage, platform, olm) {
    const keyDescription = await readDefaultKeyDescription(storage);
    if (!keyDescription) {
        throw new Error("Could not find a default secret storage key in account data");
    }
    let key;
    if (type === "phrase") {
        key = await keyFromPassphrase(keyDescription, credential, platform);
    } else if (type === "key") {
        key = keyFromRecoveryKey(keyDescription, credential, olm, platform);
    } else {
        throw new Error(`Invalid type: ${type}`);
    }
    return key;
}

class SecretStorage {
    constructor({key, platform}) {
        this._key = key;
        this._platform = platform;
    }
    async readSecret(name, txn) {
        const accountData = await txn.accountData.get(name);
        if (!accountData) {
            return;
        }
        const encryptedData = accountData?.content?.encrypted?.[this._key.id];
        if (!encryptedData) {
            throw new Error(`Secret ${accountData.type} is not encrypted for key ${this._key.id}`);
        }
        if (this._key.algorithm === "m.secret_storage.v1.aes-hmac-sha2") {
            return await this._decryptAESSecret(accountData.type, encryptedData);
        } else {
            throw new Error(`Unsupported algorithm for key ${this._key.id}: ${this._key.algorithm}`);
        }
    }
    async _decryptAESSecret(type, encryptedData) {
        const {base64, utf8} = this._platform.encoding;
        const hkdfKey = await this._platform.crypto.derive.hkdf(
            this._key.binaryKey,
            new Uint8Array(8).buffer,
            utf8.encode(type),
            "SHA-256",
            512
        );
        const aesKey = hkdfKey.slice(0, 32);
        const hmacKey = hkdfKey.slice(32);
        const ciphertextBytes = base64.decode(encryptedData.ciphertext);
        const isVerified = await this._platform.crypto.hmac.verify(
            hmacKey, base64.decode(encryptedData.mac),
            ciphertextBytes, "SHA-256");
        if (!isVerified) {
            throw new Error("Bad MAC");
        }
        const plaintextBytes = await this._platform.crypto.aes.decryptCTR({
            key: aesKey,
            iv: base64.decode(encryptedData.iv),
            data: ciphertextBytes
        });
        return utf8.decode(plaintextBytes);
    }
}

const PICKLE_KEY = "DEFAULT_KEY";
const PUSHER_KEY = "pusher";
class Session$1 {
    constructor({storage, hsApi, sessionInfo, olm, olmWorker, platform, mediaRepository}) {
        this._platform = platform;
        this._storage = storage;
        this._hsApi = hsApi;
        this._mediaRepository = mediaRepository;
        this._syncInfo = null;
        this._sessionInfo = sessionInfo;
        this._rooms = new ObservableMap();
        this._roomUpdateCallback = (room, params) => this._rooms.update(room.id, params);
        this._activeArchivedRooms = new Map();
        this._invites = new ObservableMap();
        this._inviteUpdateCallback = (invite, params) => this._invites.update(invite.id, params);
        this._user = new User(sessionInfo.userId);
        this._deviceMessageHandler = new DeviceMessageHandler({storage});
        this._olm = olm;
        this._olmUtil = null;
        this._e2eeAccount = null;
        this._deviceTracker = null;
        this._olmEncryption = null;
        this._megolmEncryption = null;
        this._megolmDecryption = null;
        this._getSyncToken = () => this.syncToken;
        this._olmWorker = olmWorker;
        this._sessionBackup = null;
        this._hasSecretStorageKey = new ObservableValue(null);
        this._observedRoomStatus = new Map();
        if (olm) {
            this._olmUtil = new olm.Utility();
            this._deviceTracker = new DeviceTracker({
                storage,
                getSyncToken: this._getSyncToken,
                olmUtil: this._olmUtil,
                ownUserId: sessionInfo.userId,
                ownDeviceId: sessionInfo.deviceId,
            });
        }
        this._createRoomEncryption = this._createRoomEncryption.bind(this);
        this._forgetArchivedRoom = this._forgetArchivedRoom.bind(this);
        this.needsSessionBackup = new ObservableValue(false);
    }
    get fingerprintKey() {
        return this._e2eeAccount?.identityKeys.ed25519;
    }
    get hasSecretStorageKey() {
        return this._hasSecretStorageKey;
    }
    get deviceId() {
        return this._sessionInfo.deviceId;
    }
    get userId() {
        return this._sessionInfo.userId;
    }
    _setupEncryption() {
        const senderKeyLock = new LockMap();
        const olmDecryption = new Decryption({
            account: this._e2eeAccount,
            pickleKey: PICKLE_KEY,
            olm: this._olm,
            storage: this._storage,
            now: this._platform.clock.now,
            ownUserId: this._user.id,
            senderKeyLock
        });
        this._olmEncryption = new Encryption({
            account: this._e2eeAccount,
            pickleKey: PICKLE_KEY,
            olm: this._olm,
            storage: this._storage,
            now: this._platform.clock.now,
            ownUserId: this._user.id,
            olmUtil: this._olmUtil,
            senderKeyLock
        });
        this._megolmEncryption = new Encryption$1({
            account: this._e2eeAccount,
            pickleKey: PICKLE_KEY,
            olm: this._olm,
            storage: this._storage,
            now: this._platform.clock.now,
            ownDeviceId: this._sessionInfo.deviceId,
        });
        this._megolmDecryption = new Decryption$1({
            pickleKey: PICKLE_KEY,
            olm: this._olm,
            olmWorker: this._olmWorker,
        });
        this._deviceMessageHandler.enableEncryption({olmDecryption, megolmDecryption: this._megolmDecryption});
    }
    _createRoomEncryption(room, encryptionParams) {
        if (!this._olmEncryption) {
            throw new Error("creating room encryption before encryption got globally enabled");
        }
        if (encryptionParams.algorithm !== MEGOLM_ALGORITHM) {
            return null;
        }
        return new RoomEncryption({
            room,
            deviceTracker: this._deviceTracker,
            olmEncryption: this._olmEncryption,
            megolmEncryption: this._megolmEncryption,
            megolmDecryption: this._megolmDecryption,
            storage: this._storage,
            sessionBackup: this._sessionBackup,
            encryptionParams,
            notifyMissingMegolmSession: () => {
                if (!this._sessionBackup) {
                    this.needsSessionBackup.set(true);
                }
            },
            clock: this._platform.clock
        });
    }
    async enableSecretStorage(type, credential) {
        if (!this._olm) {
            throw new Error("olm required");
        }
        if (this._sessionBackup) {
            return false;
        }
        const key = await keyFromCredential(type, credential, this._storage, this._platform, this._olm);
        const readTxn = await this._storage.readTxn([
            this._storage.storeNames.accountData,
        ]);
        await this._createSessionBackup(key, readTxn);
        const writeTxn = await this._storage.readWriteTxn([
            this._storage.storeNames.session,
        ]);
        try {
            writeKey(key, writeTxn);
        } catch (err) {
            writeTxn.abort();
            throw err;
        }
        await writeTxn.complete();
        this._hasSecretStorageKey.set(true);
    }
    async _createSessionBackup(ssssKey, txn) {
        const secretStorage = new SecretStorage({key: ssssKey, platform: this._platform});
        this._sessionBackup = await SessionBackup.fromSecretStorage({
            platform: this._platform,
            olm: this._olm, secretStorage,
            hsApi: this._hsApi,
            txn
        });
        if (this._sessionBackup) {
            for (const room of this._rooms.values()) {
                if (room.isEncrypted) {
                    room.enableSessionBackup(this._sessionBackup);
                }
            }
        }
        this.needsSessionBackup.set(false);
    }
    get sessionBackup() {
        return this._sessionBackup;
    }
    async createIdentity(log) {
        if (this._olm) {
            if (!this._e2eeAccount) {
                this._e2eeAccount = await Account.create({
                    hsApi: this._hsApi,
                    olm: this._olm,
                    pickleKey: PICKLE_KEY,
                    userId: this._sessionInfo.userId,
                    deviceId: this._sessionInfo.deviceId,
                    olmWorker: this._olmWorker,
                    storage: this._storage,
                });
                log.set("keys", this._e2eeAccount.identityKeys);
                this._setupEncryption();
            }
            await this._e2eeAccount.generateOTKsIfNeeded(this._storage, log);
            await log.wrap("uploadKeys", log => this._e2eeAccount.uploadKeys(this._storage, log));
        }
    }
    async load(log) {
        const txn = await this._storage.readTxn([
            this._storage.storeNames.session,
            this._storage.storeNames.roomSummary,
            this._storage.storeNames.invites,
            this._storage.storeNames.roomMembers,
            this._storage.storeNames.timelineEvents,
            this._storage.storeNames.timelineFragments,
            this._storage.storeNames.pendingEvents,
        ]);
        this._syncInfo = await txn.session.get("sync");
        if (this._olm) {
            this._e2eeAccount = await Account.load({
                hsApi: this._hsApi,
                olm: this._olm,
                pickleKey: PICKLE_KEY,
                userId: this._sessionInfo.userId,
                deviceId: this._sessionInfo.deviceId,
                olmWorker: this._olmWorker,
                txn
            });
            if (this._e2eeAccount) {
                log.set("keys", this._e2eeAccount.identityKeys);
                this._setupEncryption();
            }
        }
        const pendingEventsByRoomId = await this._getPendingEventsByRoom(txn);
        const invites = await txn.invites.getAll();
        const inviteLoadPromise = Promise.all(invites.map(async inviteData => {
            const invite = this.createInvite(inviteData.roomId);
            log.wrap("invite", log => invite.load(inviteData, log));
            this._invites.add(invite.id, invite);
        }));
        const rooms = await txn.roomSummary.getAll();
        const roomLoadPromise = Promise.all(rooms.map(async summary => {
            const room = this.createRoom(summary.roomId, pendingEventsByRoomId.get(summary.roomId));
            await log.wrap("room", log => room.load(summary, txn, log));
            this._rooms.add(room.id, room);
        }));
        await Promise.all([inviteLoadPromise, roomLoadPromise]);
        for (const [roomId, invite] of this.invites) {
            const room = this.rooms.get(roomId);
            if (room) {
                room.setInvite(invite);
            }
        }
    }
    dispose() {
        this._olmWorker?.dispose();
        this._sessionBackup?.dispose();
        for (const room of this._rooms.values()) {
            room.dispose();
        }
    }
    async start(lastVersionResponse, log) {
        if (lastVersionResponse) {
            const txn = await this._storage.readWriteTxn([
                this._storage.storeNames.session
            ]);
            txn.session.set("serverVersions", lastVersionResponse);
            await txn.complete();
        }
        if (!this._sessionBackup) {
            const txn = await this._storage.readTxn([
                this._storage.storeNames.session,
                this._storage.storeNames.accountData,
            ]);
            const ssssKey = await readKey(txn);
            if (ssssKey) {
                await this._createSessionBackup(ssssKey, txn);
            }
            this._hasSecretStorageKey.set(!!ssssKey);
        }
        const opsTxn = await this._storage.readWriteTxn([
            this._storage.storeNames.operations
        ]);
        const operations = await opsTxn.operations.getAll();
        const operationsByScope = groupBy(operations, o => o.scope);
        for (const room of this._rooms.values()) {
            let roomOperationsByType;
            const roomOperations = operationsByScope.get(room.id);
            if (roomOperations) {
                roomOperationsByType = groupBy(roomOperations, r => r.type);
            }
            room.start(roomOperationsByType, log);
        }
    }
    async _getPendingEventsByRoom(txn) {
        const pendingEvents = await txn.pendingEvents.getAll();
        return pendingEvents.reduce((groups, pe) => {
            const group = groups.get(pe.roomId);
            if (group) {
                group.push(pe);
            } else {
                groups.set(pe.roomId, [pe]);
            }
            return groups;
        }, new Map());
    }
    get rooms() {
        return this._rooms;
    }
    createRoom(roomId, pendingEvents) {
        return new Room({
            roomId,
            getSyncToken: this._getSyncToken,
            storage: this._storage,
            emitCollectionChange: this._roomUpdateCallback,
            hsApi: this._hsApi,
            mediaRepository: this._mediaRepository,
            pendingEvents,
            user: this._user,
            createRoomEncryption: this._createRoomEncryption,
            platform: this._platform
        });
    }
    _createArchivedRoom(roomId) {
        const room = new ArchivedRoom({
            roomId,
            getSyncToken: this._getSyncToken,
            storage: this._storage,
            emitCollectionChange: () => {},
            releaseCallback: () => this._activeArchivedRooms.delete(roomId),
            forgetCallback: this._forgetArchivedRoom,
            hsApi: this._hsApi,
            mediaRepository: this._mediaRepository,
            user: this._user,
            createRoomEncryption: this._createRoomEncryption,
            platform: this._platform
        });
        this._activeArchivedRooms.set(roomId, room);
        return room;
    }
    get invites() {
        return this._invites;
    }
    createInvite(roomId) {
        return new Invite({
            roomId,
            hsApi: this._hsApi,
            emitCollectionUpdate: this._inviteUpdateCallback,
            mediaRepository: this._mediaRepository,
            user: this._user,
            platform: this._platform,
        });
    }
    async obtainSyncLock(syncResponse) {
        const toDeviceEvents = syncResponse.to_device?.events;
        if (Array.isArray(toDeviceEvents) && toDeviceEvents.length) {
            return await this._deviceMessageHandler.obtainSyncLock(toDeviceEvents);
        }
    }
    async prepareSync(syncResponse, lock, txn, log) {
        const toDeviceEvents = syncResponse.to_device?.events;
        if (Array.isArray(toDeviceEvents) && toDeviceEvents.length) {
            return await log.wrap("deviceMsgs", log => this._deviceMessageHandler.prepareSync(toDeviceEvents, lock, txn, log));
        }
    }
    async writeSync(syncResponse, syncFilterId, preparation, txn, log) {
        const changes = {
            syncInfo: null,
            e2eeAccountChanges: null,
        };
        const syncToken = syncResponse.next_batch;
        if (syncToken !== this.syncToken) {
            const syncInfo = {token: syncToken, filterId: syncFilterId};
            txn.session.set("sync", syncInfo);
            changes.syncInfo = syncInfo;
        }
        const deviceOneTimeKeysCount = syncResponse.device_one_time_keys_count;
        if (this._e2eeAccount && deviceOneTimeKeysCount) {
            changes.e2eeAccountChanges = this._e2eeAccount.writeSync(deviceOneTimeKeysCount, txn, log);
        }
        const deviceLists = syncResponse.device_lists;
        if (this._deviceTracker && Array.isArray(deviceLists?.changed) && deviceLists.changed.length) {
            await log.wrap("deviceLists", log => this._deviceTracker.writeDeviceChanges(deviceLists.changed, txn, log));
        }
        if (preparation) {
            await log.wrap("deviceMsgs", log => this._deviceMessageHandler.writeSync(preparation, txn, log));
        }
        const accountData = syncResponse["account_data"];
        if (Array.isArray(accountData?.events)) {
            for (const event of accountData.events) {
                if (typeof event.type === "string") {
                    txn.accountData.set(event);
                }
            }
        }
        return changes;
    }
    afterSync({syncInfo, e2eeAccountChanges}) {
        if (syncInfo) {
            this._syncInfo = syncInfo;
        }
        if (this._e2eeAccount) {
            this._e2eeAccount.afterSync(e2eeAccountChanges);
        }
    }
    async afterSyncCompleted(changes, isCatchupSync, log) {
        if (!isCatchupSync) {
            const needsToUploadOTKs = await this._e2eeAccount.generateOTKsIfNeeded(this._storage, log);
            if (needsToUploadOTKs) {
                await log.wrap("uploadKeys", log => this._e2eeAccount.uploadKeys(this._storage, log));
            }
        }
    }
    applyRoomCollectionChangesAfterSync(inviteStates, roomStates, archivedRoomStates) {
        for (const rs of roomStates) {
            if (rs.shouldAdd) {
                this._rooms.add(rs.id, rs.room);
            } else if (rs.shouldRemove) {
                this._rooms.remove(rs.id);
            }
        }
        for (const is of inviteStates) {
            if (is.shouldAdd) {
                this._invites.add(is.id, is.invite);
            } else if (is.shouldRemove) {
                this._invites.remove(is.id);
            }
        }
        if (this._observedRoomStatus.size !== 0) {
            for (const ars of archivedRoomStates) {
                if (ars.shouldAdd) {
                    this._observedRoomStatus.get(ars.id)?.set(RoomStatus.archived);
                }
            }
            for (const rs of roomStates) {
                if (rs.shouldAdd) {
                    this._observedRoomStatus.get(rs.id)?.set(RoomStatus.joined);
                }
            }
            for (const is of inviteStates) {
                const statusObservable = this._observedRoomStatus.get(is.id);
                if (statusObservable) {
                    if (is.shouldAdd) {
                        statusObservable.set(statusObservable.get().withInvited());
                    } else if (is.shouldRemove) {
                        statusObservable.set(statusObservable.get().withoutInvited());
                    }
                }
            }
        }
    }
    _forgetArchivedRoom(roomId) {
        const statusObservable = this._observedRoomStatus.get(roomId);
        if (statusObservable) {
            statusObservable.set(statusObservable.get().withoutArchived());
        }
    }
    get syncToken() {
        return this._syncInfo?.token;
    }
    get syncFilterId() {
        return this._syncInfo?.filterId;
    }
    get user() {
        return this._user;
    }
    get mediaRepository() {
        return this._mediaRepository;
    }
    enablePushNotifications(enable) {
        if (enable) {
            return this._enablePush();
        } else {
            return this._disablePush();
        }
    }
    async _enablePush() {
        return this._platform.logger.run("enablePush", async log => {
            const defaultPayload = Pusher.createDefaultPayload(this._sessionInfo.id);
            const pusher = await this._platform.notificationService.enablePush(Pusher, defaultPayload);
            if (!pusher) {
                log.set("no_pusher", true);
                return false;
            }
            await pusher.enable(this._hsApi, log);
            const txn = await this._storage.readWriteTxn([this._storage.storeNames.session]);
            txn.session.set(PUSHER_KEY, pusher.serialize());
            await txn.complete();
            return true;
        });
    }
    async _disablePush() {
        return this._platform.logger.run("disablePush", async log => {
            await this._platform.notificationService.disablePush();
            const readTxn = await this._storage.readTxn([this._storage.storeNames.session]);
            const pusherData = await readTxn.session.get(PUSHER_KEY);
            if (!pusherData) {
                return true;
            }
            const pusher = new Pusher(pusherData);
            await pusher.disable(this._hsApi, log);
            const txn = await this._storage.readWriteTxn([this._storage.storeNames.session]);
            txn.session.remove(PUSHER_KEY);
            await txn.complete();
            return true;
        });
    }
    async arePushNotificationsEnabled() {
        if (!await this._platform.notificationService.isPushEnabled()) {
            return false;
        }
        const readTxn = await this._storage.readTxn([this._storage.storeNames.session]);
        const pusherData = await readTxn.session.get(PUSHER_KEY);
        return !!pusherData;
    }
    async checkPusherEnabledOnHomeServer() {
        const readTxn = await this._storage.readTxn([this._storage.storeNames.session]);
        const pusherData = await readTxn.session.get(PUSHER_KEY);
        if (!pusherData) {
            return false;
        }
        const myPusher = new Pusher(pusherData);
        const serverPushersData = await this._hsApi.getPushers().response();
        const serverPushers = (serverPushersData?.pushers || []).map(data => new Pusher(data));
        return serverPushers.some(p => p.equals(myPusher));
    }
    async getRoomStatus(roomId) {
        const isJoined = !!this._rooms.get(roomId);
        if (isJoined) {
            return RoomStatus.joined;
        } else {
            const isInvited = !!this._invites.get(roomId);
            const txn = await this._storage.readTxn([this._storage.storeNames.archivedRoomSummary]);
            const isArchived = await txn.archivedRoomSummary.has(roomId);
            if (isInvited && isArchived) {
                return RoomStatus.invitedAndArchived;
            } else if (isInvited) {
                return RoomStatus.invited;
            } else if (isArchived) {
                return RoomStatus.archived;
            } else {
                return RoomStatus.none;
            }
        }
    }
    async observeRoomStatus(roomId) {
        let observable = this._observedRoomStatus.get(roomId);
        if (!observable) {
            const status = await this.getRoomStatus(roomId);
            observable = new RetainedObservableValue(status, () => {
                this._observedRoomStatus.delete(roomId);
            });
            this._observedRoomStatus.set(roomId, observable);
        }
        return observable;
    }
    createOrGetArchivedRoomForSync(roomId) {
        let archivedRoom = this._activeArchivedRooms.get(roomId);
        if (archivedRoom) {
            archivedRoom.retain();
        } else {
            archivedRoom = this._createArchivedRoom(roomId);
        }
        return archivedRoom;
    }
    loadArchivedRoom(roomId, log = null) {
        return this._platform.logger.wrapOrRun(log, "loadArchivedRoom", async log => {
            log.set("id", roomId);
            const activeArchivedRoom = this._activeArchivedRooms.get(roomId);
            if (activeArchivedRoom) {
                activeArchivedRoom.retain();
                return activeArchivedRoom;
            }
            const txn = await this._storage.readTxn([
                this._storage.storeNames.archivedRoomSummary,
                this._storage.storeNames.roomMembers,
            ]);
            const summary = await txn.archivedRoomSummary.get(roomId);
            if (summary) {
                const room = this._createArchivedRoom(roomId);
                await room.load(summary, txn, log);
                return room;
            }
        });
    }
    joinRoom(roomIdOrAlias, log = null) {
        return this._platform.logger.wrapOrRun(log, "joinRoom", async log => {
            const body = await this._hsApi.joinIdOrAlias(roomIdOrAlias, {log}).response();
            return body.room_id;
        });
    }
}

const LoadStatus = createEnum(
    "NotLoading",
    "Login",
    "LoginFailed",
    "Loading",
    "SessionSetup",
    "Migrating",
    "FirstSync",
    "Error",
    "Ready",
);
const LoginFailure = createEnum(
    "Connection",
    "Credentials",
    "Unknown",
);
function normalizeHomeserver(homeServer) {
    try {
        return new URL(homeServer).origin;
    } catch (err) {
        return new URL(`https://${homeServer}`).origin;
    }
}
class SessionContainer {
    constructor({platform, olmPromise, workerPromise}) {
        this._platform = platform;
        this._sessionStartedByReconnector = false;
        this._status = new ObservableValue(LoadStatus.NotLoading);
        this._error = null;
        this._loginFailure = null;
        this._reconnector = null;
        this._session = null;
        this._sync = null;
        this._sessionId = null;
        this._storage = null;
        this._requestScheduler = null;
        this._olmPromise = olmPromise;
        this._workerPromise = workerPromise;
    }
    createNewSessionId() {
        return (Math.floor(this._platform.random() * Number.MAX_SAFE_INTEGER)).toString();
    }
    get sessionId() {
        return this._sessionId;
    }
    async startWithExistingSession(sessionId) {
        if (this._status.get() !== LoadStatus.NotLoading) {
            return;
        }
        this._status.set(LoadStatus.Loading);
        await this._platform.logger.run("load session", async log => {
            log.set("id", sessionId);
            try {
                const sessionInfo = await this._platform.sessionInfoStorage.get(sessionId);
                if (!sessionInfo) {
                    throw new Error("Invalid session id: " + sessionId);
                }
                await this._loadSessionInfo(sessionInfo, false, log);
                log.set("status", this._status.get());
            } catch (err) {
                log.catch(err);
                this._error = err;
                this._status.set(LoadStatus.Error);
            }
        });
    }
    async startWithLogin(homeServer, username, password) {
        if (this._status.get() !== LoadStatus.NotLoading) {
            return;
        }
        await this._platform.logger.run("login", async log => {
            this._status.set(LoadStatus.Login);
            homeServer = normalizeHomeserver(homeServer);
            const clock = this._platform.clock;
            let sessionInfo;
            try {
                const request = this._platform.request;
                const hsApi = new HomeServerApi({homeServer, request});
                const loginData = await hsApi.passwordLogin(username, password, "Hydrogen", {log}).response();
                const sessionId = this.createNewSessionId();
                sessionInfo = {
                    id: sessionId,
                    deviceId: loginData.device_id,
                    userId: loginData.user_id,
                    homeServer: homeServer,
                    accessToken: loginData.access_token,
                    lastUsed: clock.now()
                };
                log.set("id", sessionId);
                await this._platform.sessionInfoStorage.add(sessionInfo);
            } catch (err) {
                this._error = err;
                if (err.name === "HomeServerError") {
                    if (err.errcode === "M_FORBIDDEN") {
                        this._loginFailure = LoginFailure.Credentials;
                    } else {
                        this._loginFailure = LoginFailure.Unknown;
                    }
                    log.set("loginFailure", this._loginFailure);
                    this._status.set(LoadStatus.LoginFailed);
                } else if (err.name === "ConnectionError") {
                    this._loginFailure = LoginFailure.Connection;
                    this._status.set(LoadStatus.LoginFailed);
                } else {
                    this._status.set(LoadStatus.Error);
                }
                return;
            }
            try {
                await this._loadSessionInfo(sessionInfo, true, log);
                log.set("status", this._status.get());
            } catch (err) {
                log.catch(err);
                this._error = err;
                this._status.set(LoadStatus.Error);
            }
        });
    }
    async _loadSessionInfo(sessionInfo, isNewLogin, log) {
        log.set("appVersion", this._platform.version);
        const clock = this._platform.clock;
        this._sessionStartedByReconnector = false;
        this._status.set(LoadStatus.Loading);
        this._reconnector = new Reconnector({
            onlineStatus: this._platform.onlineStatus,
            retryDelay: new ExponentialRetryDelay(clock.createTimeout),
            createMeasure: clock.createMeasure
        });
        const hsApi = new HomeServerApi({
            homeServer: sessionInfo.homeServer,
            accessToken: sessionInfo.accessToken,
            request: this._platform.request,
            reconnector: this._reconnector,
        });
        this._sessionId = sessionInfo.id;
        this._storage = await this._platform.storageFactory.create(sessionInfo.id);
        const filteredSessionInfo = {
            id: sessionInfo.id,
            deviceId: sessionInfo.deviceId,
            userId: sessionInfo.userId,
            homeServer: sessionInfo.homeServer,
        };
        const olm = await this._olmPromise;
        let olmWorker = null;
        if (this._workerPromise) {
            olmWorker = await this._workerPromise;
        }
        this._requestScheduler = new RequestScheduler({hsApi, clock});
        this._requestScheduler.start();
        const mediaRepository = new MediaRepository({
            homeServer: sessionInfo.homeServer,
            platform: this._platform,
        });
        this._session = new Session$1({
            storage: this._storage,
            sessionInfo: filteredSessionInfo,
            hsApi: this._requestScheduler.hsApi,
            olm,
            olmWorker,
            mediaRepository,
            platform: this._platform,
        });
        await this._session.load(log);
        if (isNewLogin) {
            this._status.set(LoadStatus.SessionSetup);
            await log.wrap("createIdentity", log => this._session.createIdentity(log));
        }
        this._sync = new Sync({hsApi: this._requestScheduler.hsApi, storage: this._storage, session: this._session, logger: this._platform.logger});
        this._reconnectSubscription = this._reconnector.connectionStatus.subscribe(state => {
            if (state === ConnectionStatus.Online) {
                this._platform.logger.runDetached("reconnect", async log => {
                    this._requestScheduler.start();
                    this._sync.start();
                    this._sessionStartedByReconnector = true;
                    await log.wrap("session start", log => this._session.start(this._reconnector.lastVersionsResponse, log));
                });
            }
        });
        await log.wrap("wait first sync", () => this._waitForFirstSync());
        this._status.set(LoadStatus.Ready);
        if (!this._sessionStartedByReconnector) {
            const lastVersionsResponse = await hsApi.versions({timeout: 10000, log}).response();
            await log.wrap("session start", log => this._session.start(lastVersionsResponse, log));
        }
    }
    async _waitForFirstSync() {
        this._sync.start();
        this._status.set(LoadStatus.FirstSync);
        this._waitForFirstSyncHandle = this._sync.status.waitFor(s => {
            if (s === SyncStatus.Stopped) {
                return this._sync.error?.name !== "ConnectionError";
            }
            return s === SyncStatus.Syncing;
        });
        try {
            await this._waitForFirstSyncHandle.promise;
            if (this._sync.status.get() === SyncStatus.Stopped && this._sync.error) {
                throw this._sync.error;
            }
        } catch (err) {
            if (err.name === "AbortError") {
                return;
            }
            throw err;
        } finally {
            this._waitForFirstSyncHandle = null;
        }
    }
    get loadStatus() {
        return this._status;
    }
    get loadError() {
        return this._error;
    }
    get sync() {
        return this._sync;
    }
    get session() {
        return this._session;
    }
    get reconnector() {
        return this._reconnector;
    }
    dispose() {
        if (this._reconnectSubscription) {
            this._reconnectSubscription();
            this._reconnectSubscription = null;
        }
        if (this._requestScheduler) {
            this._requestScheduler.stop();
        }
        if (this._sync) {
            this._sync.stop();
        }
        if (this._session) {
            this._session.dispose();
        }
        if (this._waitForFirstSyncHandle) {
            this._waitForFirstSyncHandle.dispose();
            this._waitForFirstSyncHandle = null;
        }
        if (this._storage) {
            this._storage.close();
            this._storage = null;
        }
    }
    async deleteSession() {
        if (this._sessionId) {
            await Promise.all([
                this._platform.storageFactory.delete(this._sessionId),
                this._platform.sessionInfoStorage.delete(this._sessionId),
            ]);
            this._sessionId = null;
        }
    }
}

class ViewModel extends EventEmitter {
    constructor(options = {}) {
        super();
        this.disposables = null;
        this._isDisposed = false;
        this._options = options;
    }
    childOptions(explicitOptions) {
        const {navigation, urlCreator, platform} = this._options;
        return Object.assign({navigation, urlCreator, platform}, explicitOptions);
    }
    getOption(name) {
        return this._options[name];
    }
    track(disposable) {
        if (!this.disposables) {
            this.disposables = new Disposables();
        }
        return this.disposables.track(disposable);
    }
    untrack(disposable) {
        if (this.disposables) {
            return this.disposables.untrack(disposable);
        }
        return null;
    }
    dispose() {
        if (this.disposables) {
            this.disposables.dispose();
        }
        this._isDisposed = true;
    }
    get isDisposed() {
        return this._isDisposed;
    }
    disposeTracked(disposable) {
        if (this.disposables) {
            return this.disposables.disposeTracked(disposable);
        }
        return null;
    }
    i18n(parts, ...expr) {
        let result = "";
        for (let i = 0; i < parts.length; ++i) {
            result = result + parts[i];
            if (i < expr.length) {
                result = result + expr[i];
            }
        }
        return result;
    }
    updateOptions(options) {
        this._options = Object.assign(this._options, options);
    }
    emitChange(changedProps) {
        if (this._options.emitChange) {
            this._options.emitChange(changedProps);
        } else {
            this.emit("change", changedProps);
        }
    }
    get platform() {
        return this._options.platform;
    }
    get clock() {
        return this._options.platform.clock;
    }
    get logger() {
        return this.platform.logger;
    }
    get urlCreator() {
        return this._options.urlCreator;
    }
    get navigation() {
        return this._options.navigation;
    }
}

function avatarInitials(name) {
    let firstChar = name.charAt(0);
    if (firstChar === "!" || firstChar === "@" || firstChar === "#") {
        firstChar = name.charAt(1);
    }
    return firstChar.toUpperCase();
}
function hashCode(str) {
    let hash = 0;
    let i;
    let chr;
    if (str.length === 0) {
        return hash;
    }
    for (i = 0; i < str.length; i++) {
        chr = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0;
    }
    return Math.abs(hash);
}
function getIdentifierColorNumber(id) {
    return (hashCode(id) % 8) + 1;
}
function getAvatarHttpUrl(avatarUrl, cssSize, platform, mediaRepository) {
    if (avatarUrl) {
        const imageSize = cssSize * platform.devicePixelRatio;
        return mediaRepository.mxcUrlThumbnail(avatarUrl, imageSize, imageSize, "crop");
    }
    return null;
}

const KIND_ORDER = ["invite", "room"];
class BaseTileViewModel extends ViewModel {
    constructor(options) {
        super(options);
        this._isOpen = false;
        this._hidden = false;
    }
    get hidden() {
        return this._hidden;
    }
    set hidden(value) {
        if (value !== this._hidden) {
            this._hidden = value;
            this.emitChange("hidden");
        }
    }
    close() {
        if (this._isOpen) {
            this._isOpen = false;
            this.emitChange("isOpen");
        }
    }
    open() {
        if (!this._isOpen) {
            this._isOpen = true;
            this.emitChange("isOpen");
        }
    }
    get isOpen() {
        return this._isOpen;
    }
    compare(other) {
        if (other.kind !== this.kind) {
            return KIND_ORDER.indexOf(this.kind) - KIND_ORDER.indexOf(other.kind);
        }
        return 0;
    }
    get avatarLetter() {
        return avatarInitials(this.name);
    }
    get avatarColorNumber() {
        return getIdentifierColorNumber(this._avatarSource.id);
    }
    avatarUrl(size) {
        return getAvatarHttpUrl(this._avatarSource.avatarUrl, size, this.platform, this._avatarSource.mediaRepository);
    }
    get avatarTitle() {
        return this.name;
    }
}

class RoomTileViewModel extends BaseTileViewModel {
    constructor(options) {
        super(options);
        const {room} = options;
        this._room = room;
        this._url = this.urlCreator.openRoomActionUrl(this._room.id);
    }
    get kind() {
        return "room";
    }
    get url() {
        return this._url;
    }
    compare(other) {
        const parentComparison = super.compare(other);
        if (parentComparison !== 0) {
            return parentComparison;
        }
        const myRoom = this._room;
        const theirRoom = other._room;
        if (myRoom.isLowPriority !== theirRoom.isLowPriority) {
            if (myRoom.isLowPriority) {
                return 1;
            }
            return -1;
        }
        const myTimestamp = myRoom.lastMessageTimestamp;
        const theirTimestamp = theirRoom.lastMessageTimestamp;
        const myTimestampValid = Number.isSafeInteger(myTimestamp);
        const theirTimestampValid = Number.isSafeInteger(theirTimestamp);
        if (myTimestampValid !== theirTimestampValid) {
            if (!theirTimestampValid) {
                return -1;
            }
            return 1;
        }
        const timeDiff = theirTimestamp - myTimestamp;
        if (timeDiff === 0 || !theirTimestampValid || !myTimestampValid) {
            const nameCmp = this.name.localeCompare(other.name);
            if (nameCmp === 0) {
                return this._room.id.localeCompare(other._room.id);
            }
            return nameCmp;
        }
        return timeDiff;
    }
    get isUnread() {
        return this._room.isUnread;
    }
    get name() {
        return this._room.name || this.i18n`Empty Room`;
    }
    get badgeCount() {
        return this._room.notificationCount;
    }
    get isHighlighted() {
        return this._room.highlightCount !== 0;
    }
    get _avatarSource() {
        return this._room;
    }
}

class InviteTileViewModel extends BaseTileViewModel {
    constructor(options) {
        super(options);
        const {invite} = options;
        this._invite = invite;
        this._url = this.urlCreator.openRoomActionUrl(this._invite.id);
    }
    get busy() {
        return this._invite.accepting || this._invite.rejecting;
    }
    get kind() {
        return "invite";
    }
    get url() {
        return this._url;
    }
    compare(other) {
        const parentComparison = super.compare(other);
        if (parentComparison !== 0) {
            return parentComparison;
        }
        return other._invite.timestamp - this._invite.timestamp;
    }
    get name() {
        return this._invite.name;
    }
    get _avatarSource() {
        return this._invite;
    }
}

class RoomFilter {
    constructor(query) {
        this._parts = query.split(" ").map(s => s.toLowerCase().trim());
    }
    matches(roomTileVM) {
        const name = roomTileVM.name.toLowerCase();
        return this._parts.every(p => name.includes(p));
    }
}

class ApplyMap extends BaseObservableMap {
    constructor(source, apply) {
        super();
        this._source = source;
        this._apply = apply;
        this._subscription = null;
    }
    setApply(apply) {
        this._apply = apply;
        if (apply) {
            this.applyOnce(this._apply);
        }
    }
    applyOnce(apply) {
        for (const [key, value] of this._source) {
            apply(key, value);
        }
    }
    onAdd(key, value) {
        if (this._apply) {
            this._apply(key, value);
        }
        this.emitAdd(key, value);
    }
    onRemove(key, value) {
        this.emitRemove(key, value);
    }
    onUpdate(key, value, params) {
        if (this._apply) {
            this._apply(key, value, params);
        }
        this.emitUpdate(key, value, params);
    }
    onSubscribeFirst() {
        this._subscription = this._source.subscribe(this);
        if (this._apply) {
            this.applyOnce(this._apply);
        }
        super.onSubscribeFirst();
    }
    onUnsubscribeLast() {
        super.onUnsubscribeLast();
        this._subscription = this._subscription();
    }
    onReset() {
        if (this._apply) {
            this.applyOnce(this._apply);
        }
        this.emitReset();
    }
    [Symbol.iterator]() {
        return this._source[Symbol.iterator]();
    }
    get size() {
        return this._source.size;
    }
    get(key) {
        return this._source.get(key);
    }
}

class LeftPanelViewModel extends ViewModel {
    constructor(options) {
        super(options);
        const {rooms, invites} = options;
        this._tileViewModelsMap = this._mapTileViewModels(rooms, invites);
        this._tileViewModelsFilterMap = new ApplyMap(this._tileViewModelsMap);
        this._tileViewModels = this._tileViewModelsFilterMap.sortValues((a, b) => a.compare(b));
        this._currentTileVM = null;
        this._setupNavigation();
        this._closeUrl = this.urlCreator.urlForSegment("session");
        this._settingsUrl = this.urlCreator.urlForSegment("settings");
    }
    _mapTileViewModels(rooms, invites) {
        return invites.join(rooms).mapValues((roomOrInvite, emitChange) => {
            let vm;
            if (roomOrInvite.isInvite) {
                vm = new InviteTileViewModel(this.childOptions({invite: roomOrInvite, emitChange}));
            } else {
                vm = new RoomTileViewModel(this.childOptions({room: roomOrInvite, emitChange}));
            }
            const isOpen = this.navigation.path.get("room")?.value === roomOrInvite.id;
            if (isOpen) {
                vm.open();
                this._updateCurrentVM(vm);
            }
            return vm;
        });
    }
    _updateCurrentVM(vm) {
        this._currentTileVM?.close();
        this._currentTileVM = vm;
    }
    get closeUrl() {
        return this._closeUrl;
    }
    get settingsUrl() {
        return this._settingsUrl;
    }
    _setupNavigation() {
        const roomObservable = this.navigation.observe("room");
        this.track(roomObservable.subscribe(roomId => this._open(roomId)));
        const gridObservable = this.navigation.observe("rooms");
        this.gridEnabled = !!gridObservable.get();
        this.track(gridObservable.subscribe(roomIds => {
            const changed = this.gridEnabled ^ !!roomIds;
            this.gridEnabled = !!roomIds;
            if (changed) {
                this.emitChange("gridEnabled");
            }
        }));
    }
    _open(roomId) {
        this._currentTileVM?.close();
        this._currentTileVM = null;
        if (roomId) {
            this._currentTileVM = this._tileViewModelsMap.get(roomId);
            this._currentTileVM?.open();
        }
    }
    _pathForDetails(path) {
        const details = this.navigation.path.get("details");
        return details?.value ? path.with(details) : path;
    }
    toggleGrid() {
        const room = this.navigation.path.get("room");
        let path = this.navigation.path.until("session");
        if (this.gridEnabled) {
            if (room) {
                path = path.with(room);
                path = this._pathForDetails(path);
            }
        } else {
            if (room) {
                path = path.with(this.navigation.segment("rooms", [room.value]));
                path = path.with(room);
                path = this._pathForDetails(path);
            } else {
                path = path.with(this.navigation.segment("rooms", []));
                path = path.with(this.navigation.segment("empty-grid-tile", 0));
            }
        }
        this.navigation.applyPath(path);
    }
    get tileViewModels() {
        return this._tileViewModels;
    }
    clearFilter() {
        this._tileViewModelsFilterMap.setApply(null);
        this._tileViewModelsFilterMap.applyOnce((roomId, vm) => vm.hidden = false);
    }
    setFilter(query) {
        query = query.trim();
        if (query.length === 0) {
            this.clearFilter();
        } else {
            const filter = new RoomFilter(query);
            this._tileViewModelsFilterMap.setApply((roomId, vm) => {
                vm.hidden = !filter.matches(vm);
            });
        }
    }
}

class UpdateAction {
    constructor(remove, update, replace, updateParams) {
        this._remove = remove;
        this._update = update;
        this._replace = replace;
        this._updateParams = updateParams;
    }
    get shouldReplace() {
        return this._replace;
    }
    get shouldRemove() {
        return this._remove;
    }
    get shouldUpdate() {
        return this._update;
    }
    get updateParams() {
        return this._updateParams;
    }
    static Remove() {
        return new UpdateAction(true, false, false, null);
    }
    static Update(newParams) {
        return new UpdateAction(false, true, false, newParams);
    }
    static Nothing() {
        return new UpdateAction(false, false, false, null);
    }
    static Replace(params) {
        return new UpdateAction(false, false, true, params);
    }
}

class TilesCollection extends BaseObservableList {
    constructor(entries, tileCreator) {
        super();
        this._entries = entries;
        this._tiles = null;
        this._entrySubscription = null;
        this._tileCreator = tileCreator;
        this._emitSpontanousUpdate = this._emitSpontanousUpdate.bind(this);
    }
    _emitSpontanousUpdate(tile, params) {
        const entry = tile.lowerEntry;
        const tileIdx = this._findTileIdx(entry);
        this.emitUpdate(tileIdx, tile, params);
    }
    onSubscribeFirst() {
        this._entrySubscription = this._entries.subscribe(this);
        this._populateTiles();
    }
    _populateTiles() {
        this._tiles = [];
        let currentTile = null;
        for (let entry of this._entries) {
            if (!currentTile || !currentTile.tryIncludeEntry(entry)) {
                currentTile = this._tileCreator(entry);
                if (currentTile) {
                    this._tiles.push(currentTile);
                }
            }
        }
        let prevTile = null;
        for (let tile of this._tiles) {
            if (prevTile) {
                prevTile.updateNextSibling(tile);
            }
            tile.updatePreviousSibling(prevTile);
            prevTile = tile;
        }
        if (prevTile) {
            prevTile.updateNextSibling(null);
        }
        for (const tile of this._tiles) {
            tile.setUpdateEmit(this._emitSpontanousUpdate);
        }
    }
    _findTileIdx(entry) {
        return sortedIndex(this._tiles, entry, (entry, tile) => {
            return -tile.compareEntry(entry);
        });
    }
    _findTileAtIdx(entry, idx) {
        const tile = this._getTileAtIdx(idx);
        if (tile && tile.compareEntry(entry) === 0) {
            return tile;
        }
    }
    _getTileAtIdx(tileIdx) {
        if (tileIdx >= 0 && tileIdx < this._tiles.length) {
            return this._tiles[tileIdx];
        }
        return null;
    }
    onUnsubscribeLast() {
        this._entrySubscription = this._entrySubscription();
        for(let i = 0; i < this._tiles.length; i+= 1) {
            this._tiles[i].dispose();
        }
        this._tiles = null;
    }
    onReset() {
        this._buildInitialTiles();
        this.emitReset();
    }
    onAdd(index, entry) {
        const tileIdx = this._findTileIdx(entry);
        const prevTile = this._getTileAtIdx(tileIdx - 1);
        if (prevTile && prevTile.tryIncludeEntry(entry)) {
            this.emitUpdate(tileIdx - 1, prevTile);
            return;
        }
        const nextTile = this._getTileAtIdx(tileIdx);
        if (nextTile && nextTile.tryIncludeEntry(entry)) {
            this.emitUpdate(tileIdx, nextTile);
            return;
        }
        const newTile = this._tileCreator(entry);
        if (newTile) {
            if (prevTile) {
                prevTile.updateNextSibling(newTile);
                newTile.updatePreviousSibling(prevTile);
            }
            if (nextTile) {
                newTile.updateNextSibling(nextTile);
                nextTile.updatePreviousSibling(newTile);
            }
            this._tiles.splice(tileIdx, 0, newTile);
            this.emitAdd(tileIdx, newTile);
            newTile.setUpdateEmit(this._emitSpontanousUpdate);
        }
    }
    onUpdate(index, entry, params) {
        if (!this._tiles) {
            return;
        }
        const tileIdx = this._findTileIdx(entry);
        const tile = this._findTileAtIdx(entry, tileIdx);
        if (tile) {
            const action = tile.updateEntry(entry, params);
            if (action.shouldReplace) {
                const newTile = this._tileCreator(entry);
                if (newTile) {
                    this._replaceTile(tileIdx, tile, newTile, action.updateParams);
                    newTile.setUpdateEmit(this._emitSpontanousUpdate);
                } else {
                    this._removeTile(tileIdx, tile);
                }
            }
            if (action.shouldRemove) {
                this._removeTile(tileIdx, tile);
            }
            if (action.shouldUpdate) {
                this.emitUpdate(tileIdx, tile, action.updateParams);
            }
        }
    }
    _replaceTile(tileIdx, existingTile, newTile, updateParams) {
        existingTile.dispose();
        const prevTile = this._getTileAtIdx(tileIdx - 1);
        const nextTile = this._getTileAtIdx(tileIdx + 1);
        this._tiles[tileIdx] = newTile;
        prevTile?.updateNextSibling(newTile);
        newTile.updatePreviousSibling(prevTile);
        newTile.updateNextSibling(nextTile);
        nextTile?.updatePreviousSibling(newTile);
        this.emitUpdate(tileIdx, newTile, updateParams);
    }
    _removeTile(tileIdx, tile) {
        const prevTile = this._getTileAtIdx(tileIdx - 1);
        const nextTile = this._getTileAtIdx(tileIdx + 1);
        this._tiles.splice(tileIdx, 1);
        tile.dispose();
        this.emitRemove(tileIdx, tile);
        prevTile?.updateNextSibling(nextTile);
        nextTile?.updatePreviousSibling(prevTile);
    }
    onRemove(index, entry) {
        const tileIdx = this._findTileIdx(entry);
        const tile = this._findTileAtIdx(entry, tileIdx);
        if (tile) {
            const removeTile = tile.removeEntry(entry);
            if (removeTile) {
                this._removeTile(tileIdx, tile);
            } else {
                this.emitUpdate(tileIdx, tile);
            }
        }
    }
    onMove(fromIdx, toIdx, value) {
    }
    [Symbol.iterator]() {
        return this._tiles.values();
    }
    get length() {
        return this._tiles.length;
    }
    getFirst() {
        return this._tiles[0];
    }
}

class SimpleTile extends ViewModel {
    constructor(options) {
        super(options);
        this._entry = options.entry;
    }
    get shape() {
        return null;
    }
    get isContinuation() {
        return false;
    }
    get hasDateSeparator() {
        return false;
    }
    get internalId() {
        return this._entry.asEventKey().toString();
    }
    get isPending() {
        return this._entry.isPending;
    }
    get isUnsent() {
        return this._entry.isPending && this._entry.pendingEvent.status !== SendStatus.Sent;
    }
    get canAbortSending() {
        return this._entry.isPending &&
            !this._entry.pendingEvent.hasStartedSending;
    }
    abortSending() {
        this._entry.pendingEvent?.abort();
    }
    setUpdateEmit(emitUpdate) {
        this.updateOptions({emitChange: paramName => {
            if (emitUpdate) {
                emitUpdate(this, paramName);
            }
        }});
    }
    get upperEntry() {
        return this._entry;
    }
    get lowerEntry() {
        return this._entry;
    }
    compareEntry(entry) {
        return this._entry.compare(entry);
    }
    updateEntry(entry, param) {
        const renderedAsRedacted = this.shape === "redacted";
        if (!entry.isGap && entry.isRedacted !== renderedAsRedacted) {
            return UpdateAction.Replace("shape");
        } else {
            this._entry = entry;
            return UpdateAction.Update(param);
        }
    }
    removeEntry(entry) {
        return true;
    }
    tryIncludeEntry() {
        return false;
    }
    updatePreviousSibling(prev) {
    }
    updateNextSibling(next) {
    }
    dispose() {
        this.setUpdateEmit(null);
        super.dispose();
    }
    get _room() {
        return this._options.room;
    }
    get _timeline() {
        return this._options.timeline;
    }
    get _powerLevels() {
        return this._timeline.powerLevels;
    }
    get _ownMember() {
        return this._options.timeline.me;
    }
}

class GapTile extends SimpleTile {
    constructor(options) {
        super(options);
        this._loading = false;
        this._error = null;
    }
    async fill() {
        if (!this._loading) {
            this._loading = true;
            this.emitChange("isLoading");
            try {
                await this._room.fillGap(this._entry, 10);
            } catch (err) {
                console.error(`room.fillGap(): ${err.message}:\n${err.stack}`);
                this._error = err;
                this.emitChange("error");
                throw err;
            } finally {
                this._loading = false;
                this.emitChange("isLoading");
            }
        }
        return this._entry.edgeReached;
    }
    updateEntry(entry, params) {
        super.updateEntry(entry, params);
        if (!entry.isGap) {
            return UpdateAction.Remove();
        } else {
            return UpdateAction.Nothing();
        }
    }
    get shape() {
        return "gap";
    }
    get isLoading() {
        return this._loading;
    }
    get error() {
        if (this._error) {
            const dir = this._entry.prev_batch ? "previous" : "next";
            return `Could not load ${dir} messages: ${this._error.message}`;
        }
        return null;
    }
}

class ReactionsViewModel {
    constructor(parentTile) {
        this._parentTile = parentTile;
        this._map = new ObservableMap();
        this._reactions = this._map.sortValues((a, b) => a._compare(b));
    }
    update(annotations, pendingAnnotations) {
        if (annotations) {
            for (const key in annotations) {
                if (annotations.hasOwnProperty(key)) {
                    const annotation = annotations[key];
                    const reaction = this._map.get(key);
                    if (reaction) {
                        if (reaction._tryUpdate(annotation)) {
                            this._map.update(key);
                        }
                    } else {
                        this._map.add(key, new ReactionViewModel(key, annotation, null, this._parentTile));
                    }
                }
            }
        }
        if (pendingAnnotations) {
            for (const [key, annotation] of pendingAnnotations.entries()) {
                const reaction = this._map.get(key);
                if (reaction) {
                    reaction._tryUpdatePending(annotation);
                    this._map.update(key);
                } else {
                    this._map.add(key, new ReactionViewModel(key, null, annotation, this._parentTile));
                }
            }
        }
        for (const existingKey of this._map.keys()) {
            const hasPending = pendingAnnotations?.has(existingKey);
            const hasRemote = annotations?.hasOwnProperty(existingKey);
            if (!hasRemote && !hasPending) {
                this._map.remove(existingKey);
            } else if (!hasRemote) {
                if (this._map.get(existingKey)._tryUpdate(null)) {
                    this._map.update(existingKey);
                }
            } else if (!hasPending) {
                if (this._map.get(existingKey)._tryUpdatePending(null)) {
                    this._map.update(existingKey);
                }
            }
        }
    }
    get reactions() {
        return this._reactions;
    }
    getReaction(key) {
        return this._map.get(key);
    }
}
class ReactionViewModel {
    constructor(key, annotation, pending, parentTile) {
        this._key = key;
        this._annotation = annotation;
        this._pending = pending;
        this._parentTile = parentTile;
        this._isToggling = false;
    }
    _tryUpdate(annotation) {
        const oneSetAndOtherNot = !!this._annotation !== !!annotation;
        const bothSet = this._annotation && annotation;
        const areDifferent = bothSet &&  (
            annotation.me !== this._annotation.me ||
            annotation.count !== this._annotation.count ||
            annotation.firstTimestamp !== this._annotation.firstTimestamp
        );
        if (oneSetAndOtherNot || areDifferent) {
            this._annotation = annotation;
            return true;
        }
        return false;
    }
    _tryUpdatePending(pending) {
        if (!pending && !this._pending) {
            return false;
        }
        this._pending = pending;
        return true;
    }
    get key() {
        return this._key;
    }
    get count() {
        return (this._pending?.count || 0) + (this._annotation?.count || 0);
    }
    get isPending() {
        return this._pending !== null;
    }
    get isActive() {
        return this._annotation?.me || this.isPending;
    }
    get firstTimestamp() {
        let ts = Number.MAX_SAFE_INTEGER;
        if (this._annotation) {
            ts = Math.min(ts, this._annotation.firstTimestamp);
        }
        if (this._pending) {
            ts = Math.min(ts, this._pending.firstTimestamp);
        }
        return ts;
    }
    _compare(other) {
        if (other === this) {
            return 0;
        }
        if (this.count !== other.count) {
            return other.count - this.count;
        } else {
            const cmp = this.firstTimestamp - other.firstTimestamp;
            if (cmp === 0) {
                return this.key < other.key ? -1 : 1;
            }
            return cmp;
        }
    }
    async toggle(log = null) {
        if (this._isToggling) {
            console.log("busy toggling reaction already");
            return;
        }
        this._isToggling = true;
        try {
            await this._parentTile.toggleReaction(this.key, log);
        } finally {
            this._isToggling = false;
        }
    }
}

class BaseMessageTile extends SimpleTile {
    constructor(options) {
        super(options);
        this._date = this._entry.timestamp ? new Date(this._entry.timestamp) : null;
        this._isContinuation = false;
        this._reactions = null;
        if (this._entry.annotations || this._entry.pendingAnnotations) {
            this._updateReactions();
        }
    }
    get _mediaRepository() {
        return this._room.mediaRepository;
    }
    get displayName() {
        return this._entry.displayName || this.sender;
    }
    get sender() {
        return this._entry.sender;
    }
    get avatarColorNumber() {
        return getIdentifierColorNumber(this._entry.sender);
    }
    avatarUrl(size) {
        return getAvatarHttpUrl(this._entry.avatarUrl, size, this.platform, this._mediaRepository);
    }
    get avatarLetter() {
        return avatarInitials(this.sender);
    }
    get avatarTitle() {
        return this.displayName;
    }
    get date() {
        return this._date && this._date.toLocaleDateString({}, {month: "numeric", day: "numeric"});
    }
    get time() {
        return this._date && this._date.toLocaleTimeString({}, {hour: "numeric", minute: "2-digit"});
    }
    get isOwn() {
        return this._entry.sender === this._ownMember.userId;
    }
    get isContinuation() {
        return this._isContinuation;
    }
    get isUnverified() {
        return this._entry.isUnverified;
    }
    _getContent() {
        return this._entry.content;
    }
    updatePreviousSibling(prev) {
        super.updatePreviousSibling(prev);
        let isContinuation = false;
        if (prev && prev instanceof BaseMessageTile && prev.sender === this.sender) {
            const myTimestamp = this._entry.timestamp;
            const otherTimestamp = prev._entry.timestamp;
            isContinuation = (myTimestamp - otherTimestamp) < (5 * 60 * 1000);
        }
        if (isContinuation !== this._isContinuation) {
            this._isContinuation = isContinuation;
            this.emitChange("isContinuation");
        }
    }
    updateEntry(entry, param) {
        const action = super.updateEntry(entry, param);
        if (action.shouldUpdate) {
            this._updateReactions();
        }
        return action;
    }
    redact(reason, log) {
        return this._room.sendRedaction(this._entry.id, reason, log);
    }
    get canRedact() {
        return this._powerLevels.canRedactFromSender(this._entry.sender);
    }
    get reactions() {
        if (this.shape !== "redacted") {
            return this._reactions;
        }
        return null;
    }
    get canReact() {
        return this._powerLevels.canSendType("m.reaction");
    }
    react(key, log = null) {
        return this.logger.wrapOrRun(log, "react", async log => {
            if (!this.canReact) {
                log.set("powerlevel_lacking", true);
                return;
            }
            if (this._entry.haveAnnotation(key)) {
                log.set("already_reacted", true);
                return;
            }
            const redaction = this._entry.pendingAnnotations?.get(key)?.redactionEntry;
            if (redaction && !redaction.pendingEvent.hasStartedSending) {
                log.set("abort_redaction", true);
                await redaction.pendingEvent.abort();
            } else {
                await this._room.sendEvent("m.reaction", this._entry.annotate(key), null, log);
            }
        });
    }
    redactReaction(key, log = null) {
        return this.logger.wrapOrRun(log, "redactReaction", async log => {
            if (!this._powerLevels.canRedactFromSender(this._ownMember.userId)) {
                log.set("powerlevel_lacking", true);
                return;
            }
            if (!this._entry.haveAnnotation(key)) {
                log.set("not_yet_reacted", true);
                return;
            }
            let entry = this._entry.pendingAnnotations?.get(key)?.annotationEntry;
            if (!entry) {
                entry = await this._timeline.getOwnAnnotationEntry(this._entry.id, key);
            }
            if (entry) {
                await this._room.sendRedaction(entry.id, null, log);
            } else {
                log.set("no_reaction", true);
            }
        });
    }
    toggleReaction(key, log = null) {
        return this.logger.wrapOrRun(log, "toggleReaction", async log => {
            if (this._entry.haveAnnotation(key)) {
                await this.redactReaction(key, log);
            } else {
                await this.react(key, log);
            }
        });
    }
    _updateReactions() {
        const {annotations, pendingAnnotations} = this._entry;
        if (!annotations && !pendingAnnotations) {
            if (this._reactions) {
                this._reactions = null;
            }
        } else {
            if (!this._reactions) {
                this._reactions = new ReactionsViewModel(this);
            }
            this._reactions.update(annotations, pendingAnnotations);
        }
    }
}

const scheme = "(?:https|http|ftp):\\/\\/";
const noSpaceNorPunctuation = "[^\\s.,?!)]";
const hostCharacter = "[a-zA-Z0-9:.\\[\\]-]";
const host = `${hostCharacter}*(?=${hostCharacter})${noSpaceNorPunctuation}`;
const pathOrFragment = `(?:[\\/#](?:[^\\s]*${noSpaceNorPunctuation})?)`;
const urlRegex = `${scheme}${host}${pathOrFragment}?`;
const regex = new RegExp(urlRegex, "gi");

function linkify(text, callback) {
    const matches = text.matchAll(regex);
    let curr = 0;
    for (let match of matches) {
        const precedingText = text.slice(curr, match.index);
        callback(precedingText, false);
        callback(match[0], true);
        const len = match[0].length;
        curr = match.index + len;
    }
    const remainingText = text.slice(curr);
    callback(remainingText, false);
}

function parsePlainBody(body) {
    const parts = [];
    const lines = body.split("\n");
    const linkifyCallback = (text, isLink) => {
        if (isLink) {
            parts.push(new LinkPart(text, text));
        } else {
            parts.push(new TextPart(text));
        }
    };
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (line.length) {
            linkify(line, linkifyCallback);
        }
        const isLastLine = i >= (lines.length - 1);
        if (!isLastLine) {
            parts.push(new NewLinePart());
        }
    }
    return new MessageBody(body, parts);
}
function stringAsBody(body) {
    return new MessageBody(body, [new TextPart(body)]);
}
class NewLinePart {
    get type() { return "newline"; }
}
class LinkPart {
    constructor(url, text) {
        this.url = url;
        this.text = text;
    }
    get type() { return "link"; }
}
class TextPart {
    constructor(text) {
        this.text = text;
    }
    get type() { return "text"; }
}
class MessageBody {
    constructor(sourceString, parts) {
        this.sourceString = sourceString;
        this.parts = parts;
    }
}

class BaseTextTile extends BaseMessageTile {
    constructor(options) {
        super(options);
        this._messageBody = null;
    }
    get shape() {
        return "message";
    }
    _parseBody(bodyString) {
        return stringAsBody(bodyString);
    }
    get body() {
        const body = this._getBodyAsString();
        if (!this._messageBody || this._messageBody.sourceString !== body) {
            this._messageBody = this._parseBody(body);
        }
        return this._messageBody;
    }
}

class TextTile extends BaseTextTile {
    _getBodyAsString() {
        const content = this._getContent();
        let body = content?.body || "";
        if (content.msgtype === "m.emote") {
            body = `* ${this.displayName} ${body}`;
        }
        return body;
    }
    _parseBody(bodyString) {
        return parsePlainBody(bodyString);
    }
}

class RedactedTile extends BaseMessageTile {
    get shape() {
        return "redacted";
    }
    get description() {
        const {redactionReason} = this._entry;
        if (this.isRedacting) {
            if (redactionReason) {
                return this.i18n`This message is being deleted (${redactionReason})…`;
            } else {
                return this.i18n`This message is being deleted…`;
            }
        } else {
            if (redactionReason) {
                return this.i18n`This message has been deleted (${redactionReason}).`;
            } else {
                return this.i18n`This message has been deleted.`;
            }
        }
    }
    get isRedacting() {
        return this._entry.isRedacting;
    }
    get canRedact() {
        return false;
    }
    abortPendingRedaction() {
        return this._entry.abortPendingRedaction();
    }
}

const MAX_HEIGHT = 300;
const MAX_WIDTH = 400;
class BaseMediaTile extends BaseMessageTile {
    constructor(options) {
        super(options);
        this._decryptedThumbnail = null;
        this._decryptedFile = null;
        this._error = null;
        if (!this.isPending) {
            this._tryLoadEncryptedThumbnail();
        }
    }
    get isUploading() {
        return this.isPending && this._entry.pendingEvent.status === SendStatus.UploadingAttachments;
    }
    get uploadPercentage() {
        const {pendingEvent} = this._entry;
        return pendingEvent && Math.round((pendingEvent.attachmentsSentBytes / pendingEvent.attachmentsTotalBytes) * 100);
    }
    get sendStatus() {
        const {pendingEvent} = this._entry;
        switch (pendingEvent?.status) {
            case SendStatus.Waiting:
                return this.i18n`Waiting…`;
            case SendStatus.EncryptingAttachments:
            case SendStatus.Encrypting:
                return this.i18n`Encrypting…`;
            case SendStatus.UploadingAttachments:
                return this.i18n`Uploading…`;
            case SendStatus.Sending:
                return this.i18n`Sending…`;
            case SendStatus.Error:
                return this.i18n`Error: ${pendingEvent.error.message}`;
            default:
                return "";
        }
    }
    get thumbnailUrl() {
        if (this._decryptedThumbnail) {
            return this._decryptedThumbnail.url;
        } else {
            const thumbnailMxc = this._getContent().info?.thumbnail_url;
            if (thumbnailMxc) {
                return this._mediaRepository.mxcUrlThumbnail(thumbnailMxc, this.width, this.height, "scale");
            }
        }
        if (this._entry.isPending) {
            const attachment = this._entry.pendingEvent.getAttachment("info.thumbnail_url");
            return attachment && attachment.localPreview.url;
        }
        if (this._isMainResourceImage()) {
            if (this._decryptedFile) {
                return this._decryptedFile.url;
            } else {
                const mxcUrl = this._getContent()?.url;
                if (typeof mxcUrl === "string") {
                    return this._mediaRepository.mxcUrlThumbnail(mxcUrl, this.width, this.height, "scale");
                }
            }
        }
        return "";
    }
    get width() {
        const info = this._getContent()?.info;
        return Math.round(info?.w * this._scaleFactor());
    }
    get height() {
        const info = this._getContent()?.info;
        return Math.round(info?.h * this._scaleFactor());
    }
    get mimeType() {
        const info = this._getContent()?.info;
        return info?.mimetype;
    }
    get label() {
        return this._getContent().body;
    }
    get error() {
        if (this._error) {
            return `Could not load media: ${this._error.message}`;
        }
        return null;
    }
    setViewError(err) {
        this._error = err;
        this.emitChange("error");
    }
    async _loadEncryptedFile(file) {
        const blob = await this._mediaRepository.downloadEncryptedFile(file, true);
        if (this.isDisposed) {
            blob.dispose();
            return;
        }
        return this.track(blob);
    }
    async _tryLoadEncryptedThumbnail() {
        try {
            const thumbnailFile = this._getContent().info?.thumbnail_file;
            const file = this._getContent().file;
            if (thumbnailFile) {
                this._decryptedThumbnail = await this._loadEncryptedFile(thumbnailFile);
                this.emitChange("thumbnailUrl");
            } else if (file && this._isMainResourceImage()) {
                this._decryptedFile = await this._loadEncryptedFile(file);
                this.emitChange("thumbnailUrl");
            }
        } catch (err) {
            this._error = err;
            this.emitChange("error");
        }
    }
    _scaleFactor() {
        const info = this._getContent()?.info;
        const scaleHeightFactor = MAX_HEIGHT / info?.h;
        const scaleWidthFactor = MAX_WIDTH / info?.w;
        return Math.min(scaleWidthFactor, scaleHeightFactor, 1);
    }
    _isMainResourceImage() {
        return true;
    }
}

class ImageTile extends BaseMediaTile {
    constructor(options) {
        super(options);
        this._lightboxUrl = this.urlCreator.urlForSegments([
            this.navigation.segment("room", this._room.id),
            this.navigation.segment("lightbox", this._entry.id)
        ]);
    }
    get lightboxUrl() {
        if (!this.isPending) {
            return this._lightboxUrl;
        }
        return "";
    }
    get shape() {
        return "image";
    }
}

class VideoTile extends BaseMediaTile {
    async loadVideo() {
        const file = this._getContent().file;
        if (file && !this._decryptedFile) {
            this._decryptedFile = await this._loadEncryptedFile(file);
            this.emitChange("videoUrl");
        }
    }
    get videoUrl() {
        if (this._decryptedFile) {
            return this._decryptedFile.url;
        }
        const mxcUrl = this._getContent()?.url;
        if (typeof mxcUrl === "string") {
            return this._mediaRepository.mxcUrl(mxcUrl);
        }
        return "";
    }
    get shape() {
        return "video";
    }
    _isMainResourceImage() {
        return false;
    }
}

function formatSize(size, decimals = 2) {
    if (Number.isSafeInteger(size)) {
        const base = Math.min(3, Math.floor(Math.log(size) / Math.log(1024)));
        const formattedSize = Math.round(size / Math.pow(1024, base)).toFixed(decimals);
        switch (base) {
            case 0: return `${formattedSize} bytes`;
            case 1: return `${formattedSize} KB`;
            case 2: return `${formattedSize} MB`;
            case 3: return `${formattedSize} GB`;
        }
    }
}

class FileTile extends BaseMessageTile {
    constructor(options) {
        super(options);
        this._downloadError = null;
        this._downloading = false;
    }
    async download() {
        if (this._downloading || this.isPending) {
            return;
        }
        const content = this._getContent();
        const filename = content.body;
        this._downloading = true;
        this.emitChange("label");
        let blob;
        try {
            blob = await this._mediaRepository.downloadAttachment(content);
            this.platform.saveFileAs(blob, filename);
        } catch (err) {
            this._downloadError = err;
        } finally {
            blob?.dispose();
            this._downloading = false;
        }
        this.emitChange("label");
    }
    get label() {
        if (this._downloadError) {
            return `Could not download file: ${this._downloadError.message}`;
        }
        const content = this._getContent();
        const filename = content.body;
        if (this._entry.isPending) {
            const {pendingEvent} = this._entry;
            switch (pendingEvent?.status) {
                case SendStatus.Waiting:
                    return this.i18n`Waiting to send ${filename}…`;
                case SendStatus.EncryptingAttachments:
                case SendStatus.Encrypting:
                    return this.i18n`Encrypting ${filename}…`;
                case SendStatus.UploadingAttachments:{
                    const percent = Math.round((pendingEvent.attachmentsSentBytes / pendingEvent.attachmentsTotalBytes) * 100);
                    return this.i18n`Uploading ${filename}: ${percent}%`;
                }
                case SendStatus.Sending:
                case SendStatus.Sent:
                    return this.i18n`Sending ${filename}…`;
                case SendStatus.Error:
                    return this.i18n`Error: could not send ${filename}: ${pendingEvent.error.message}`;
                default:
                    return `Unknown send status for ${filename}`;
            }
        } else {
            const size = formatSize(this._getContent().info?.size);
            if (this._downloading) {
                return this.i18n`Downloading ${filename} (${size})…`;
            } else {
                return this.i18n`Download ${filename} (${size})`;
            }
        }
    }
    get shape() {
        return "file";
    }
}

class LocationTile extends BaseMessageTile {
    get mapsLink() {
        const geoUri = this._getContent().geo_uri;
        const [lat, long] = geoUri.split(":")[1].split(",");
        return `maps:${lat} ${long}`;
    }
    get label() {
        return `${this.sender} sent their location, click to see it in maps.`;
    }
}

class RoomNameTile extends SimpleTile {
    get shape() {
        return "announcement";
    }
    get announcement() {
        const content = this._entry.content;
        return `${this._entry.displayName || this._entry.sender} named the room "${content?.name}"`
    }
}

class RoomMemberTile extends SimpleTile {
    get shape() {
        return "announcement";
    }
    get announcement() {
        const {sender, content, prevContent, stateKey} = this._entry;
        const senderName =  this._entry.displayName || sender;
        const targetName = sender === stateKey ? senderName : (this._entry.content?.displayname || stateKey);
        const membership = content && content.membership;
        const prevMembership = prevContent && prevContent.membership;
        if (prevMembership === "join" && membership === "join") {
            if (content.avatar_url !== prevContent.avatar_url) {
                return `${senderName} changed their avatar`;
            } else if (content.displayname !== prevContent.displayname) {
                if (!content.displayname) {
                    return `${stateKey} removed their name (${prevContent.displayname})`;
                }
                return `${prevContent.displayname ?? stateKey} changed their name to ${content.displayname}`;
            }
        } else if (membership === "join") {
            return `${targetName} joined the room`;
        } else if (membership === "invite") {
            return `${targetName} was invited to the room by ${senderName}`;
        } else if (prevMembership === "invite") {
            if (membership === "join") {
                return `${targetName} accepted the invitation to join the room`;
            } else if (membership === "leave") {
                return `${targetName} declined the invitation to join the room`;
            }
        } else if (membership === "leave") {
            if (stateKey === sender) {
                return `${targetName} left the room`;
            } else {
                const reason = content.reason;
                return `${targetName} was kicked from the room by ${senderName}${reason ? `: ${reason}` : ""}`;
            }
        } else if (membership === "ban") {
            return `${targetName} was banned from the room by ${senderName}`;
        }
        return `${sender} membership changed to ${content.membership}`;
    }
}

class EncryptedEventTile extends BaseTextTile {
    updateEntry(entry, params) {
        const parentResult = super.updateEntry(entry, params);
        if (entry.eventType !== "m.room.encrypted") {
            return UpdateAction.Replace("shape");
        } else {
            return parentResult;
        }
    }
    get shape() {
        return "message-status"
    }
    _getBodyAsString() {
        const decryptionError = this._entry.decryptionError;
        const code = decryptionError?.code;
        if (code === "MEGOLM_NO_SESSION") {
            return this.i18n`The sender hasn't sent us the key for this message yet.`;
        } else {
            return decryptionError?.message || this.i18n`Could not decrypt message because of unknown reason.`;
        }
    }
}

class EncryptionEnabledTile extends SimpleTile {
    get shape() {
        return "announcement";
    }
    get announcement() {
        const senderName =  this._entry.displayName || this._entry.sender;
        return this.i18n`${senderName} has enabled end-to-end encryption`;
    }
}

class MissingAttachmentTile extends BaseMessageTile {
    get shape() {
        return "missing-attachment"
    }
    get label() {
        const name = this._getContent().body;
        const msgtype = this._getContent().msgtype;
        if (msgtype === "m.image") {
            return this.i18n`The image ${name} wasn't fully sent previously and could not be recovered.`;
        } else {
            return this.i18n`The file ${name} wasn't fully sent previously and could not be recovered.`;
        }
    }
}

function tilesCreator(baseOptions) {
    return function tilesCreator(entry, emitUpdate) {
        const options = Object.assign({entry, emitUpdate}, baseOptions);
        if (entry.isGap) {
            return new GapTile(options);
        } else if (entry.isPending && entry.pendingEvent.isMissingAttachments) {
            return new MissingAttachmentTile(options);
        } else if (entry.eventType) {
            switch (entry.eventType) {
                case "m.room.message": {
                    if (entry.isRedacted) {
                        return new RedactedTile(options);
                    }
                    const content = entry.content;
                    const msgtype = content && content.msgtype;
                    switch (msgtype) {
                        case "m.text":
                        case "m.notice":
                        case "m.emote":
                            return new TextTile(options);
                        case "m.image":
                            return new ImageTile(options);
                        case "m.video":
                            return new VideoTile(options);
                        case "m.file":
                            return new FileTile(options);
                        case "m.location":
                            return new LocationTile(options);
                        default:
                            return null;
                    }
                }
                case "m.room.name":
                    return new RoomNameTile(options);
                case "m.room.member":
                    return new RoomMemberTile(options);
                case "m.room.encrypted":
                    return new EncryptedEventTile(options);
                case "m.room.encryption":
                    return new EncryptionEnabledTile(options);
                default:
                    return null;
            }
        }
    }
}

class TimelineViewModel extends ViewModel {
    constructor(options) {
        super(options);
        const {room, timeline} = options;
        this._timeline = this.track(timeline);
        this._tiles = new TilesCollection(timeline.entries, tilesCreator(this.childOptions({room, timeline})));
    }
    async loadAtTop() {
        if (this.isDisposed) {
            return true;
        }
        const firstTile = this._tiles.getFirst();
        if (firstTile?.shape === "gap") {
            return await firstTile.fill();
        } else {
            const topReached = await this._timeline.loadAtTop(10);
            return topReached;
        }
    }
    unloadAtTop(tileAmount) {
    }
    loadAtBottom() {
    }
    unloadAtBottom(tileAmount) {
    }
    get tiles() {
        return this._tiles;
    }
}

class RoomViewModel extends ViewModel {
    constructor(options) {
        super(options);
        const {room} = options;
        this._room = room;
        this._timelineVM = null;
        this._onRoomChange = this._onRoomChange.bind(this);
        this._timelineError = null;
        this._sendError = null;
        this._composerVM = null;
        if (room.isArchived) {
            this._composerVM = new ArchivedViewModel(this.childOptions({archivedRoom: room}));
        } else {
            this._composerVM = new ComposerViewModel(this);
        }
        this._clearUnreadTimout = null;
        this._closeUrl = this.urlCreator.urlUntilSegment("session");
    }
    async load() {
        this._room.on("change", this._onRoomChange);
        try {
            const timeline = await this._room.openTimeline();
            const timelineVM = this.track(new TimelineViewModel(this.childOptions({
                room: this._room,
                timeline,
            })));
            this._timelineVM = timelineVM;
            this.emitChange("timelineViewModel");
        } catch (err) {
            console.error(`room.openTimeline(): ${err.message}:\n${err.stack}`);
            this._timelineError = err;
            this.emitChange("error");
        }
        this._clearUnreadAfterDelay();
    }
    async _clearUnreadAfterDelay() {
        if (this._room.isArchived || this._clearUnreadTimout) {
            return;
        }
        this._clearUnreadTimout = this.clock.createTimeout(2000);
        try {
            await this._clearUnreadTimout.elapsed();
            await this._room.clearUnread();
            this._clearUnreadTimout = null;
        } catch (err) {
            if (err.name !== "AbortError") {
                throw err;
            }
        }
    }
    focus() {
        this._clearUnreadAfterDelay();
    }
    dispose() {
        super.dispose();
        this._room.off("change", this._onRoomChange);
        if (this._room.isArchived) {
            this._room.release();
        }
        if (this._clearUnreadTimout) {
            this._clearUnreadTimout.abort();
            this._clearUnreadTimout = null;
        }
    }
    _onRoomChange() {
        if (this._room.isArchived) {
            this._composerVM.emitChange();
        }
        this.emitChange();
    }
    get kind() { return "room"; }
    get closeUrl() { return this._closeUrl; }
    get name() { return this._room.name || this.i18n`Empty Room`; }
    get id() { return this._room.id; }
    get timelineViewModel() { return this._timelineVM; }
    get isEncrypted() { return this._room.isEncrypted; }
    get error() {
        if (this._timelineError) {
            return `Something went wrong loading the timeline: ${this._timelineError.message}`;
        }
        if (this._sendError) {
            return `Something went wrong sending your message: ${this._sendError.message}`;
        }
        return "";
    }
    get avatarLetter() {
        return avatarInitials(this.name);
    }
    get avatarColorNumber() {
        return getIdentifierColorNumber(this._room.id)
    }
    avatarUrl(size) {
        return getAvatarHttpUrl(this._room.avatarUrl, size, this.platform, this._room.mediaRepository);
    }
    get avatarTitle() {
        return this.name;
    }
    get canLeave() {
        return this._room.isJoined;
    }
    leaveRoom() {
        this._room.leave();
    }
    get canForget() {
        return this._room.isArchived;
    }
    forgetRoom() {
        this._room.forget();
    }
    get canRejoin() {
        return this._room.isArchived;
    }
    rejoinRoom() {
        this._room.join();
    }
    async _sendMessage(message) {
        if (!this._room.isArchived && message) {
            try {
                let msgtype = "m.text";
                if (message.startsWith("/me ")) {
                    message = message.substr(4).trim();
                    msgtype = "m.emote";
                }
                await this._room.sendEvent("m.room.message", {msgtype, body: message});
            } catch (err) {
                console.error(`room.sendMessage(): ${err.message}:\n${err.stack}`);
                this._sendError = err;
                this._timelineError = null;
                this.emitChange("error");
                return false;
            }
            return true;
        }
        return false;
    }
    async _pickAndSendFile() {
        try {
            const file = await this.platform.openFile();
            if (!file) {
                return;
            }
            return this._sendFile(file);
        } catch (err) {
            console.error(err);
        }
    }
    async _sendFile(file) {
        const content = {
            body: file.name,
            msgtype: "m.file"
        };
        await this._room.sendEvent("m.room.message", content, {
            "url": this._room.createAttachment(file.blob, file.name)
        });
    }
    async _pickAndSendVideo() {
        try {
            if (!this.platform.hasReadPixelPermission()) {
                alert("Please allow canvas image data access, so we can scale your images down.");
                return;
            }
            const file = await this.platform.openFile("video/*");
            if (!file) {
                return;
            }
            if (!file.blob.mimeType.startsWith("video/")) {
                return this._sendFile(file);
            }
            let video;
            try {
                video = await this.platform.loadVideo(file.blob);
            } catch (err) {
                if (err instanceof window.MediaError && err.code === 4) {
                    throw new Error(`this browser does not support videos of type ${file?.blob.mimeType}.`);
                } else {
                    throw err;
                }
            }
            const content = {
                body: file.name,
                msgtype: "m.video",
                info: videoToInfo(video)
            };
            const attachments = {
                "url": this._room.createAttachment(video.blob, file.name),
            };
            const limit = await this.platform.settingsStorage.getInt("sentImageSizeLimit");
            const maxDimension = limit || Math.min(video.maxDimension, 800);
            const thumbnail = await video.scale(maxDimension);
            content.info.thumbnail_info = imageToInfo(thumbnail);
            attachments["info.thumbnail_url"] =
                this._room.createAttachment(thumbnail.blob, file.name);
            await this._room.sendEvent("m.room.message", content, attachments);
        } catch (err) {
            this._sendError = err;
            this.emitChange("error");
            console.error(err.stack);
        }
    }
    async _pickAndSendPicture() {
        try {
            if (!this.platform.hasReadPixelPermission()) {
                alert("Please allow canvas image data access, so we can scale your images down.");
                return;
            }
            const file = await this.platform.openFile("image/*");
            if (!file) {
                return;
            }
            if (!file.blob.mimeType.startsWith("image/")) {
                return this._sendFile(file);
            }
            let image = await this.platform.loadImage(file.blob);
            const limit = await this.platform.settingsStorage.getInt("sentImageSizeLimit");
            if (limit && image.maxDimension > limit) {
                image = await image.scale(limit);
            }
            const content = {
                body: file.name,
                msgtype: "m.image",
                info: imageToInfo(image)
            };
            const attachments = {
                "url": this._room.createAttachment(image.blob, file.name),
            };
            if (image.maxDimension > 600) {
                const thumbnail = await image.scale(400);
                content.info.thumbnail_info = imageToInfo(thumbnail);
                attachments["info.thumbnail_url"] =
                    this._room.createAttachment(thumbnail.blob, file.name);
            }
            await this._room.sendEvent("m.room.message", content, attachments);
        } catch (err) {
            this._sendError = err;
            this.emitChange("error");
            console.error(err.stack);
        }
    }
    get composerViewModel() {
        return this._composerVM;
    }
    openDetailsPanel() {
        let path = this.navigation.path.until("room");
        path = path.with(this.navigation.segment("details", true));
        this.navigation.applyPath(path);
    }
}
class ComposerViewModel extends ViewModel {
    constructor(roomVM) {
        super();
        this._roomVM = roomVM;
        this._isEmpty = true;
    }
    get isEncrypted() {
        return this._roomVM.isEncrypted;
    }
    sendMessage(message) {
        const success = this._roomVM._sendMessage(message);
        if (success) {
            this._isEmpty = true;
            this.emitChange("canSend");
        }
        return success;
    }
    sendPicture() {
        this._roomVM._pickAndSendPicture();
    }
    sendFile() {
        this._roomVM._pickAndSendFile();
    }
    sendVideo() {
        this._roomVM._pickAndSendVideo();
    }
    get canSend() {
        return !this._isEmpty;
    }
    async setInput(text) {
        const wasEmpty = this._isEmpty;
        this._isEmpty = text.length === 0;
        if (wasEmpty && !this._isEmpty) {
            this._roomVM._room.ensureMessageKeyIsShared();
        }
        if (wasEmpty !== this._isEmpty) {
            this.emitChange("canSend");
        }
    }
    get kind() {
        return "composer";
    }
}
function imageToInfo(image) {
    return {
        w: image.width,
        h: image.height,
        mimetype: image.blob.mimeType,
        size: image.blob.size
    };
}
function videoToInfo(video) {
    const info = imageToInfo(video);
    info.duration = video.duration;
    return info;
}
class ArchivedViewModel extends ViewModel {
    constructor(options) {
        super(options);
        this._archivedRoom = options.archivedRoom;
    }
    get description() {
        if (this._archivedRoom.isKicked) {
            if (this._archivedRoom.kickReason) {
                return this.i18n`You were kicked from the room by ${this._archivedRoom.kickedBy.name} because: ${this._archivedRoom.kickReason}`;
            } else {
                return this.i18n`You were kicked from the room by ${this._archivedRoom.kickedBy.name}.`;
            }
        } else if (this._archivedRoom.isBanned) {
            if (this._archivedRoom.kickReason) {
                return this.i18n`You were banned from the room by ${this._archivedRoom.kickedBy.name} because: ${this._archivedRoom.kickReason}`;
            } else {
                return this.i18n`You were banned from the room by ${this._archivedRoom.kickedBy.name}.`;
            }
        } else {
            return this.i18n`You left this room`;
        }
    }
    get kind() {
        return "archived";
    }
}

class RoomDetailsViewModel extends ViewModel {
    constructor(options) {
        super(options);
        this._room = options.room;
        this._onRoomChange = this._onRoomChange.bind(this);
        this._room.on("change", this._onRoomChange);
    }
    get roomId() {
        return this._room.id;
    }
    get canonicalAlias() {
        return this._room.canonicalAlias;
    }
    get name() {
        return this._room.name;
    }
    get isEncrypted() {
        return !!this._room.isEncrypted;
    }
    get memberCount() {
        return this._room.joinedMemberCount;
    }
    get avatarLetter() {
        return avatarInitials(this.name);
    }
    get avatarColorNumber() {
        return getIdentifierColorNumber(this.roomId)
    }
    avatarUrl(size) {
        return getAvatarHttpUrl(this._room.avatarUrl, size, this.platform, this._room.mediaRepository);
    }
    get avatarTitle() {
        return this.name;
    }
    _onRoomChange() {
        this.emitChange();
    }
    closePanel() {
        const path = this.navigation.path.until("room");
        this.navigation.applyPath(path);
    }
    dispose() {
        super.dispose();
        this._room.off("change", this._onRoomChange);
    }
}

class UnknownRoomViewModel extends ViewModel {
    constructor(options) {
        super(options);
        const {roomIdOrAlias, session} = options;
        this._session = session;
        this.roomIdOrAlias = roomIdOrAlias;
        this._error = null;
        this._busy = false;
    }
    get error() {
        return this._error?.message;
    }
    async join() {
        this._busy = true;
        this.emitChange("busy");
        try {
            const roomId = await this._session.joinRoom(this.roomIdOrAlias);
            this.navigation.push("room", roomId);
        } catch (err) {
            this._error = err;
            this._busy = false;
            this.emitChange("error");
        }
    }
    get busy() {
        return this._busy;
    }
    get kind() {
        return "unknown";
    }
}

class InviteViewModel extends ViewModel {
    constructor(options) {
        super(options);
        const {invite, mediaRepository} = options;
        this._invite = invite;
        this._mediaRepository = mediaRepository;
        this._onInviteChange = this._onInviteChange.bind(this);
        this._error = null;
        this._closeUrl = this.urlCreator.urlUntilSegment("session");
        this._invite.on("change", this._onInviteChange);
        this._inviter = null;
        if (this._invite.inviter) {
            this._inviter = new RoomMemberViewModel(this._invite.inviter, mediaRepository, this.platform);
        }
        this._roomDescription = this._createRoomDescription();
    }
    get kind() { return "invite"; }
    get closeUrl() { return this._closeUrl; }
    get name() { return this._invite.name; }
    get id() { return this._invite.id; }
    get isEncrypted() { return this._invite.isEncrypted; }
    get isDirectMessage() { return this._invite.isDirectMessage; }
    get inviter() { return this._inviter; }
    get busy() { return this._invite.accepting || this._invite.rejecting; }
    get error() {
        if (this._error) {
            return `Something went wrong: ${this._error.message}`;
        }
        return "";
    }
    get avatarLetter() {
        return avatarInitials(this.name);
    }
    get avatarColorNumber() {
        return getIdentifierColorNumber(this._invite.id)
    }
    avatarUrl(size) {
        return getAvatarHttpUrl(this._invite.avatarUrl, size, this.platform, this._mediaRepository);
    }
    _createRoomDescription() {
        const parts = [];
        if (this._invite.isPublic) {
            parts.push("Public room");
        } else {
            parts.push("Private room");
        }
        if (this._invite.canonicalAlias) {
            parts.push(this._invite.canonicalAlias);
        }
        return parts.join(" • ")
    }
    get roomDescription() {
        return this._roomDescription;
    }
    get avatarTitle() {
        return this.name;
    }
    focus() {}
    async accept() {
        try {
            await this._invite.accept();
        } catch (err) {
            this._error = err;
            this.emitChange("error");
        }
    }
    async reject() {
        try {
            await this._invite.reject();
        } catch (err) {
            this._error = err;
            this.emitChange("error");
        }
    }
    _onInviteChange() {
        this.emitChange();
    }
    dispose() {
        super.dispose();
        this._invite.off("change", this._onInviteChange);
    }
}
class RoomMemberViewModel {
    constructor(member, mediaRepository, platform) {
        this._member = member;
        this._mediaRepository = mediaRepository;
        this._platform = platform;
    }
    get id() {
        return this._member.userId;
    }
    get name() {
        return this._member.name;
    }
    get avatarLetter() {
        return avatarInitials(this.name);
    }
    get avatarColorNumber() {
        return getIdentifierColorNumber(this._member.userId);
    }
    avatarUrl(size) {
        return getAvatarHttpUrl(this._member.avatarUrl, size, this._platform, this._mediaRepository);
    }
    get avatarTitle() {
        return this.name;
    }
}

class LightboxViewModel extends ViewModel {
    constructor(options) {
        super(options);
        this._eventId = options.eventId;
        this._unencryptedImageUrl = null;
        this._decryptedImage = null;
        this._closeUrl = this.urlCreator.urlUntilSegment("room");
        this._eventEntry = null;
        this._date = null;
        this._subscribeToEvent(options.room, options.eventId);
    }
    _subscribeToEvent(room, eventId) {
        const eventObservable = room.observeEvent(eventId);
        this.track(eventObservable.subscribe(eventEntry => {
            this._loadEvent(room, eventEntry);
        }));
        this._loadEvent(room, eventObservable.get());
    }
    async _loadEvent(room, eventEntry) {
        if (!eventEntry) {
            return;
        }
        const {mediaRepository} = room;
        this._eventEntry = eventEntry;
        const {content} = this._eventEntry;
        this._date = this._eventEntry.timestamp ? new Date(this._eventEntry.timestamp) : null;
        if (content.url) {
            this._unencryptedImageUrl = mediaRepository.mxcUrl(content.url);
            this.emitChange("imageUrl");
        } else if (content.file) {
            this._decryptedImage = this.track(await mediaRepository.downloadEncryptedFile(content.file));
            this.emitChange("imageUrl");
        }
    }
    get imageWidth() {
        return this._eventEntry?.content?.info?.w;
    }
    get imageHeight() {
        return this._eventEntry?.content?.info?.h;
    }
    get name() {
        return this._eventEntry?.content?.body;
    }
    get sender() {
        return this._eventEntry?.displayName;
    }
    get imageUrl() {
        if (this._decryptedImage) {
            return this._decryptedImage.url;
        } else if (this._unencryptedImageUrl) {
            return this._unencryptedImageUrl;
        } else {
            return "";
        }
    }
    get date() {
        return this._date && this._date.toLocaleDateString({}, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }
    get time() {
        return this._date && this._date.toLocaleTimeString({}, {hour: "numeric", minute: "2-digit"});
    }
    get closeUrl() {
        return this._closeUrl;
    }
    close() {
        this.platform.history.pushUrl(this.closeUrl);
    }
}

const SessionStatus = createEnum(
    "Disconnected",
    "Connecting",
    "FirstSync",
    "Sending",
    "Syncing",
    "SyncError"
);
class SessionStatusViewModel extends ViewModel {
    constructor(options) {
        super(options);
        const {sync, reconnector, session} = options;
        this._sync = sync;
        this._reconnector = reconnector;
        this._status = this._calculateState(reconnector.connectionStatus.get(), sync.status.get());
        this._session = session;
        this._setupSessionBackupUrl = this.urlCreator.urlForSegment("settings");
        this._dismissSecretStorage = false;
    }
    start() {
        const update = () => this._updateStatus();
        this.track(this._sync.status.subscribe(update));
        this.track(this._reconnector.connectionStatus.subscribe(update));
        this.track(this._session.needsSessionBackup.subscribe(() => {
            this.emitChange();
        }));
    }
    get setupSessionBackupUrl () {
        return this._setupSessionBackupUrl;
    }
    get isShown() {
        return (this._session.needsSessionBackup.get() && !this._dismissSecretStorage) || this._status !== SessionStatus.Syncing;
    }
    get statusLabel() {
        switch (this._status) {
            case SessionStatus.Disconnected:{
                const retryIn = Math.round(this._reconnector.retryIn / 1000);
                return this.i18n`Disconnected, trying to reconnect in ${retryIn}s…`;
            }
            case SessionStatus.Connecting:
                return this.i18n`Trying to reconnect now…`;
            case SessionStatus.FirstSync:
                return this.i18n`Catching up with your conversations…`;
            case SessionStatus.SyncError:
                return this.i18n`Sync failed because of ${this._sync.error}`;
        }
        if (this._session.needsSessionBackup.get()) {
            return this.i18n`Set up session backup to decrypt older messages.`;
        }
        return "";
    }
    get isWaiting() {
        switch (this._status) {
            case SessionStatus.Connecting:
            case SessionStatus.FirstSync:
                return true;
            default:
                return false;
        }
    }
    _updateStatus() {
        const newStatus = this._calculateState(
            this._reconnector.connectionStatus.get(),
            this._sync.status.get()
        );
        if (newStatus !== this._status) {
            if (newStatus === SessionStatus.Disconnected) {
                this._retryTimer = this.track(this.clock.createInterval(() => {
                    this.emitChange("statusLabel");
                }, 1000));
            } else {
                this._retryTimer = this.disposeTracked(this._retryTimer);
            }
            this._status = newStatus;
            this.emitChange();
        }
    }
    _calculateState(connectionStatus, syncStatus) {
        if (connectionStatus !== ConnectionStatus.Online) {
            switch (connectionStatus) {
                case ConnectionStatus.Reconnecting:
                    return SessionStatus.Connecting;
                case ConnectionStatus.Waiting:
                    return SessionStatus.Disconnected;
            }
        } else if (syncStatus !== SyncStatus.Syncing) {
            switch (syncStatus) {
                case SyncStatus.InitialSync:
                case SyncStatus.CatchupSync:
                    return SessionStatus.FirstSync;
                case SyncStatus.Stopped:
                    return SessionStatus.SyncError;
            }
        }
 else {
            return SessionStatus.Syncing;
        }
    }
    get isConnectNowShown() {
        return this._status === SessionStatus.Disconnected;
    }
    get isSecretStorageShown() {
        return this._status === SessionStatus.Syncing && this._session.needsSessionBackup.get() && !this._dismissSecretStorage;
    }
    get canDismiss() {
        return this.isSecretStorageShown;
    }
    dismiss() {
        if (this.isSecretStorageShown) {
            this._dismissSecretStorage = true;
            this.emitChange();
        }
    }
    connectNow() {
        if (this.isConnectNowShown) {
            this._reconnector.tryNow();
        }
    }
}

class Navigation {
    constructor(allowsChild) {
        this._allowsChild = allowsChild;
        this._path = new Path([], allowsChild);
        this._observables = new Map();
        this._pathObservable = new ObservableValue(this._path);
    }
    get pathObservable() {
        return this._pathObservable;
    }
    get path() {
        return this._path;
    }
    push(type, value = undefined) {
        return this.applyPath(this.path.with(new Segment(type, value)));
    }
    applyPath(path) {
        const oldPath = this._path;
        this._path = path;
        for (let i = oldPath.segments.length - 1; i >= 0; i -= 1) {
            const segment = oldPath.segments[i];
            if (!this._path.get(segment.type)) {
                const observable = this._observables.get(segment.type);
                observable?.emitIfChanged();
            }
        }
        for (const segment of this._path.segments) {
            const observable = this._observables.get(segment.type);
            observable?.emitIfChanged();
        }
        this._pathObservable.set(this._path);
    }
    observe(type) {
        let observable = this._observables.get(type);
        if (!observable) {
            observable = new SegmentObservable(this, type);
            this._observables.set(type, observable);
        }
        return observable;
    }
    pathFrom(segments) {
        let parent;
        let i;
        for (i = 0; i < segments.length; i += 1) {
            if (!this._allowsChild(parent, segments[i])) {
                return new Path(segments.slice(0, i), this._allowsChild);
            }
            parent = segments[i];
        }
        return new Path(segments, this._allowsChild);
    }
    segment(type, value) {
        return new Segment(type, value);
    }
}
function segmentValueEqual(a, b) {
    if (a === b) {
        return true;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        const len = Math.max(a.length, b.length);
        for (let i = 0; i < len; i += 1) {
            if (a[i] !== b[i]) {
                return false;
            }
        }
        return true;
    }
    return false;
}
class Segment {
    constructor(type, value) {
        this.type = type;
        this.value = value === undefined ? true : value;
    }
}
class Path {
    constructor(segments = [], allowsChild) {
        this._segments = segments;
        this._allowsChild = allowsChild;
    }
    clone() {
        return new Path(this._segments.slice(), this._allowsChild);
    }
    with(segment) {
        let index = this._segments.length - 1;
        do {
            if (this._allowsChild(this._segments[index], segment)) {
                const newSegments = this._segments.slice(0, index + 1);
                newSegments.push(segment);
                return new Path(newSegments, this._allowsChild);
            }
            index -= 1;
        } while(index >= -1);
        return null;
    }
    until(type) {
        const index = this._segments.findIndex(s => s.type === type);
        if (index !== -1) {
            return new Path(this._segments.slice(0, index + 1), this._allowsChild)
        }
        return new Path([], this._allowsChild);
    }
    get(type) {
        return this._segments.find(s => s.type === type);
    }
    replace(segment) {
        const index = this._segments.findIndex(s => s.type === segment.type);
        if (index !== -1) {
            const parent = this._segments[index - 1];
            if (this._allowsChild(parent, segment)) {
                const child = this._segments[index + 1];
                if (!child || this._allowsChild(segment, child)) {
                    const newSegments = this._segments.slice();
                    newSegments[index] = segment;
                    return new Path(newSegments, this._allowsChild);
                }
            }
        }
        return null;
    }
    get segments() {
        return this._segments;
    }
}
class SegmentObservable extends BaseObservableValue {
    constructor(navigation, type) {
        super();
        this._navigation = navigation;
        this._type = type;
        this._lastSetValue = navigation.path.get(type)?.value;
    }
    get() {
        const path = this._navigation.path;
        const segment = path.get(this._type);
        const value = segment?.value;
        return value;
    }
    emitIfChanged() {
        const newValue = this.get();
        if (!segmentValueEqual(newValue, this._lastSetValue)) {
            this._lastSetValue = newValue;
            this.emit(newValue);
        }
    }
}

class URLRouter {
    constructor({history, navigation, parseUrlPath, stringifyPath}) {
        this._history = history;
        this._navigation = navigation;
        this._parseUrlPath = parseUrlPath;
        this._stringifyPath = stringifyPath;
        this._subscription = null;
        this._pathSubscription = null;
        this._isApplyingUrl = false;
        this._defaultSessionId = this._getLastSessionId();
    }
    _getLastSessionId() {
        const navPath = this._urlAsNavPath(this._history.getLastUrl() || "");
        const sessionId = navPath.get("session")?.value;
        if (typeof sessionId === "string") {
            return sessionId;
        }
        return null;
    }
    attach() {
        this._subscription = this._history.subscribe(url => this._applyUrl(url));
        this._pathSubscription = this._navigation.pathObservable.subscribe(path => this._applyNavPathToHistory(path));
        this._applyUrl(this._history.get());
    }
    dispose() {
        this._subscription = this._subscription();
        this._pathSubscription = this._pathSubscription();
    }
    _applyNavPathToHistory(path) {
        const url = this.urlForPath(path);
        if (url !== this._history.get()) {
            if (this._isApplyingUrl) {
                this._history.replaceUrlSilently(url);
            } else {
                this._history.pushUrlSilently(url);
            }
        }
    }
    _applyNavPathToNavigation(navPath) {
        this._isApplyingUrl = true;
        this._navigation.applyPath(navPath);
        this._isApplyingUrl = false;
    }
    _urlAsNavPath(url) {
        const urlPath = this._history.urlAsPath(url);
        return this._navigation.pathFrom(this._parseUrlPath(urlPath, this._navigation.path, this._defaultSessionId));
    }
    _applyUrl(url) {
        const navPath = this._urlAsNavPath(url);
        this._applyNavPathToNavigation(navPath);
    }
    pushUrl(url) {
        this._history.pushUrl(url);
    }
    tryRestoreLastUrl() {
        const lastNavPath = this._urlAsNavPath(this._history.getLastUrl() || "");
        if (lastNavPath.segments.length !== 0) {
            this._applyNavPathToNavigation(lastNavPath);
            return true;
        }
        return false;
    }
    urlForSegments(segments) {
        let path = this._navigation.path;
        for (const segment of segments) {
            path = path.with(segment);
            if (!path) {
                return;
            }
        }
        return this.urlForPath(path);
    }
    urlForSegment(type, value) {
        return this.urlForSegments([this._navigation.segment(type, value)]);
    }
    urlUntilSegment(type) {
        return this.urlForPath(this._navigation.path.until(type));
    }
    urlForPath(path) {
        return this._history.pathAsUrl(this._stringifyPath(path));
    }
    openRoomActionUrl(roomId) {
        const urlPath = `${this._stringifyPath(this._navigation.path.until("session"))}/open-room/${roomId}`;
        return this._history.pathAsUrl(urlPath);
    }
}

function createNavigation() {
    return new Navigation(allowsChild);
}
function createRouter({history, navigation}) {
    return new URLRouter({history, navigation, stringifyPath, parseUrlPath});
}
function allowsChild(parent, child) {
    const {type} = child;
    switch (parent?.type) {
        case undefined:
            return type === "login"  || type === "session";
        case "session":
            return type === "room" || type === "rooms" || type === "settings";
        case "rooms":
            return type === "room" || type === "empty-grid-tile";
        case "room":
            return type === "lightbox" || type === "details";
        default:
            return false;
    }
}
function roomsSegmentWithRoom(rooms, roomId, path) {
    if(!rooms.value.includes(roomId)) {
        const emptyGridTile = path.get("empty-grid-tile");
        const oldRoom = path.get("room");
        let index = 0;
        if (emptyGridTile) {
            index = emptyGridTile.value;
        } else if (oldRoom) {
            index = rooms.value.indexOf(oldRoom.value);
        }
        const roomIds = rooms.value.slice();
        roomIds[index] = roomId;
        return new Segment("rooms", roomIds);
    } else {
        return rooms;
    }
}
function parseUrlPath(urlPath, currentNavPath, defaultSessionId) {
    const parts = urlPath.substr(1).split("/");
    const iterator = parts[Symbol.iterator]();
    const segments = [];
    let next;
    while (!(next = iterator.next()).done) {
        const type = next.value;
        if (type === "rooms") {
            const roomsValue = iterator.next().value;
            if (roomsValue === undefined) { break; }
            const roomIds = roomsValue.split(",");
            segments.push(new Segment(type, roomIds));
            const selectedIndex = parseInt(iterator.next().value || "0", 10);
            const roomId = roomIds[selectedIndex];
            if (roomId) {
                segments.push(new Segment("room", roomId));
            } else {
                segments.push(new Segment("empty-grid-tile", selectedIndex));
            }
        } else if (type === "open-room") {
            const roomId = iterator.next().value;
            if (!roomId) { break; }
            const rooms = currentNavPath.get("rooms");
            if (rooms) {
                segments.push(roomsSegmentWithRoom(rooms, roomId, currentNavPath));
            }
            segments.push(new Segment("room", roomId));
            if (currentNavPath.get("details")?.value) {
                segments.push(new Segment("details"));
            }
        } else if (type === "last-session") {
            let sessionSegment = currentNavPath.get("session");
            if (typeof sessionSegment?.value !== "string" && defaultSessionId) {
                sessionSegment = new Segment("session", defaultSessionId);
            }
            if (sessionSegment) {
                segments.push(sessionSegment);
            }
        } else {
            const value = iterator.next().value;
            segments.push(new Segment(type, value));
        }
    }
    return segments;
}
function stringifyPath(path) {
    let urlPath = "";
    let prevSegment;
    for (const segment of path.segments) {
        switch (segment.type) {
            case "rooms":
                urlPath += `/rooms/${segment.value.join(",")}`;
                break;
            case "empty-grid-tile":
                urlPath += `/${segment.value}`;
                break;
            case "room":
                if (prevSegment?.type === "rooms") {
                    const index = prevSegment.value.indexOf(segment.value);
                    urlPath += `/${index}`;
                } else {
                    urlPath += `/${segment.type}/${segment.value}`;
                }
                break;
            default:
                urlPath += `/${segment.type}`;
                if (segment.value && segment.value !== true) {
                    urlPath += `/${segment.value}`;
                }
        }
        prevSegment = segment;
    }
    return urlPath;
}

function dedupeSparse(roomIds) {
    return roomIds.map((id, idx) => {
        if (roomIds.slice(0, idx).includes(id)) {
            return undefined;
        } else {
            return id;
        }
    });
}
class RoomGridViewModel extends ViewModel {
    constructor(options) {
        super(options);
        this._width = options.width;
        this._height = options.height;
        this._createRoomViewModelObservable = options.createRoomViewModelObservable;
        this._selectedIndex = 0;
        this._viewModelsObservables = [];
        this._setupNavigation();
    }
    _setupNavigation() {
        const focusTileIndex = this.navigation.observe("empty-grid-tile");
        this.track(focusTileIndex.subscribe(index => {
            if (typeof index === "number") {
                this._setFocusIndex(index);
            }
        }));
        if (typeof focusTileIndex.get() === "number") {
            this._selectedIndex = focusTileIndex.get();
        }
        const focusedRoom = this.navigation.observe("room");
        this.track(focusedRoom.subscribe(roomId => {
            if (roomId) {
                this._setFocusRoom(roomId);
            }
        }));
    }
    roomViewModelAt(i) {
        return this._viewModelsObservables[i]?.get();
    }
    get focusIndex() {
        return this._selectedIndex;
    }
    get width() {
        return this._width;
    }
    get height() {
        return this._height;
    }
    _switchToRoom(roomId) {
        const detailsShown = !!this.navigation.path.get("details")?.value;
        let path = this.navigation.path.until("rooms");
        path = path.with(this.navigation.segment("room", roomId));
        if (detailsShown) {
            path = path.with(this.navigation.segment("details", true));
        }
        this.navigation.applyPath(path);
    }
    focusTile(index) {
        if (index === this._selectedIndex) {
            return;
        }
        const vmo = this._viewModelsObservables[index];
        if (vmo) {
            this._switchToRoom(vmo.id);
        } else {
            this.navigation.push("empty-grid-tile", index);
        }
    }
    initializeRoomIdsAndTransferVM(roomIds, existingRoomVM) {
        roomIds = dedupeSparse(roomIds);
        let transfered = false;
        if (existingRoomVM) {
            const index = roomIds.indexOf(existingRoomVM.id);
            if (index !== -1) {
                this._viewModelsObservables[index] = this.track(existingRoomVM);
                existingRoomVM.subscribe(viewModel => this._refreshRoomViewModel(viewModel));
                transfered = true;
            }
        }
        this.setRoomIds(roomIds);
        const focusedRoom = this.navigation.path.get("room");
        if (focusedRoom) {
            const index = this._viewModelsObservables.findIndex(vmo => vmo && vmo.id === focusedRoom.value);
            if (index !== -1) {
                this._selectedIndex = index;
            }
        }
        return transfered;
    }
    setRoomIds(roomIds) {
        roomIds = dedupeSparse(roomIds);
        let changed = false;
        const len = this._height * this._width;
        for (let i = 0; i < len; i += 1) {
            const newId = roomIds[i];
            const vmo = this._viewModelsObservables[i];
            if ((!vmo && newId) || (vmo && vmo.id !== newId)) {
                if (vmo) {
                    this._viewModelsObservables[i] = this.disposeTracked(vmo);
                }
                if (newId) {
                    const vmo = this._createRoomViewModelObservable(newId);
                    this._viewModelsObservables[i] = this.track(vmo);
                    vmo.subscribe(viewModel => this._refreshRoomViewModel(viewModel));
                    vmo.initialize();
                }
                changed = true;
            }
        }
        if (changed) {
            this.emitChange();
        }
        return changed;
    }
    _refreshRoomViewModel(viewModel) {
        this.emitChange();
        viewModel?.focus();
    }
    releaseRoomViewModel(roomId) {
        const index = this._viewModelsObservables.findIndex(vmo => vmo && vmo.id === roomId);
        if (index !== -1) {
            const vmo = this._viewModelsObservables[index];
            this.untrack(vmo);
            vmo.unsubscribeAll();
            this._viewModelsObservables[index] = null;
            return vmo;
        }
    }
    _setFocusIndex(idx) {
        if (idx === this._selectedIndex || idx >= (this._width * this._height)) {
            return;
        }
        this._selectedIndex = idx;
        const vmo = this._viewModelsObservables[this._selectedIndex];
        vmo?.get()?.focus();
        this.emitChange("focusIndex");
    }
    _setFocusRoom(roomId) {
        const index = this._viewModelsObservables.findIndex(vmo => vmo?.id === roomId);
        if (index >= 0) {
            this._setFocusIndex(index);
        }
    }
}

class SessionBackupViewModel extends ViewModel {
    constructor(options) {
        super(options);
        this._session = options.session;
        this._showKeySetup = true;
        this._error = null;
        this._isBusy = false;
        this.track(this._session.hasSecretStorageKey.subscribe(() => {
            this.emitChange("status");
        }));
    }
    get isBusy() {
        return this._isBusy;
    }
    get backupVersion() {
        return this._session.sessionBackup?.version;
    }
    get status() {
        if (this._session.sessionBackup) {
            return "enabled";
        } else {
            if (this._session.hasSecretStorageKey.get() === false) {
                return this._showKeySetup ? "setupKey" : "setupPhrase";
            } else {
                return "pending";
            }
        }
    }
    get error() {
        return this._error?.message;
    }
    showPhraseSetup() {
        this._showKeySetup = false;
        this.emitChange("status");
    }
    showKeySetup() {
        this._showKeySetup = true;
        this.emitChange("status");
    }
    async enterSecurityPhrase(passphrase) {
        if (passphrase) {
            try {
                this._isBusy = true;
                this.emitChange("isBusy");
                await this._session.enableSecretStorage("phrase", passphrase);
            } catch (err) {
                console.error(err);
                this._error = err;
                this.emitChange("error");
            } finally {
                this._isBusy = false;
                this.emitChange("");
            }
        }
    }
    async enterSecurityKey(securityKey) {
        if (securityKey) {
            try {
                this._isBusy = true;
                this.emitChange("isBusy");
                await this._session.enableSecretStorage("key", securityKey);
            } catch (err) {
                console.error(err);
                this._error = err;
                this.emitChange("error");
            } finally {
                this._isBusy = false;
                this.emitChange("");
            }
        }
    }
}

class PushNotificationStatus {
    constructor() {
        this.supported = null;
        this.enabled = false;
        this.updating = false;
        this.enabledOnServer = null;
        this.serverError = null;
    }
}
function formatKey(key) {
    const partLength = 4;
    const partCount = Math.ceil(key.length / partLength);
    let formattedKey = "";
    for (let i = 0; i < partCount; i += 1) {
        formattedKey += (formattedKey.length ? " " : "") + key.slice(i * partLength, (i + 1) * partLength);
    }
    return formattedKey;
}
class SettingsViewModel extends ViewModel {
    constructor(options) {
        super(options);
        this._updateService = options.updateService;
        const session = options.session;
        this._session = session;
        this._sessionBackupViewModel = this.track(new SessionBackupViewModel(this.childOptions({session})));
        this._closeUrl = this.urlCreator.urlUntilSegment("session");
        this._estimate = null;
        this.sentImageSizeLimit = null;
        this.minSentImageSizeLimit = 400;
        this.maxSentImageSizeLimit = 4000;
        this.pushNotifications = new PushNotificationStatus();
    }
    setSentImageSizeLimit(size) {
        if (size > this.maxSentImageSizeLimit || size < this.minSentImageSizeLimit) {
            this.sentImageSizeLimit = null;
            this.platform.settingsStorage.remove("sentImageSizeLimit");
        } else {
            this.sentImageSizeLimit = Math.round(size);
            this.platform.settingsStorage.setInt("sentImageSizeLimit", size);
        }
        this.emitChange("sentImageSizeLimit");
    }
    async load() {
        this._estimate = await this.platform.estimateStorageUsage();
        this.sentImageSizeLimit = await this.platform.settingsStorage.getInt("sentImageSizeLimit");
        this.pushNotifications.supported = await this.platform.notificationService.supportsPush();
        this.pushNotifications.enabled = await this._session.arePushNotificationsEnabled();
        this.emitChange("");
    }
    get closeUrl() {
        return this._closeUrl;
    }
    get fingerprintKey() {
        return formatKey(this._session.fingerprintKey);
    }
    get deviceId() {
        return this._session.deviceId;
    }
    get userId() {
        return this._session.userId;
    }
    get version() {
        const {updateService} = this.platform;
        if (updateService) {
            return `${updateService.version} (${updateService.buildHash})`;
        }
        return this.i18n`development version`;
    }
    checkForUpdate() {
        this.platform.updateService?.checkForUpdate();
    }
    get showUpdateButton() {
        return !!this.platform.updateService;
    }
    get sessionBackupViewModel() {
        return this._sessionBackupViewModel;
    }
    get storageQuota() {
        return this._formatBytes(this._estimate?.quota);
    }
    get storageUsage() {
        return this._formatBytes(this._estimate?.usage);
    }
    _formatBytes(n) {
        if (typeof n === "number") {
            return Math.round(n / (1024 * 1024)).toFixed(1) + " MB";
        } else {
            return this.i18n`unknown`;
        }
    }
    async exportLogs() {
        const logExport = await this.logger.export();
        this.platform.saveFileAs(logExport.asBlob(), `hydrogen-logs-${this.platform.clock.now()}.json`);
    }
    async togglePushNotifications() {
        this.pushNotifications.updating = true;
        this.pushNotifications.enabledOnServer = null;
        this.pushNotifications.serverError = null;
        this.emitChange("pushNotifications.updating");
        try {
            if (await this._session.enablePushNotifications(!this.pushNotifications.enabled)) {
                this.pushNotifications.enabled = !this.pushNotifications.enabled;
                if (this.pushNotifications.enabled) {
                    this.platform.notificationService.showNotification(this.i18n`Push notifications are now enabled`);
                }
            }
        } finally {
        this.pushNotifications.updating = false;
            this.emitChange("pushNotifications.updating");
        }
    }
    async checkPushEnabledOnServer() {
        this.pushNotifications.enabledOnServer = null;
        this.pushNotifications.serverError = null;
        try {
            this.pushNotifications.enabledOnServer = await this._session.checkPusherEnabledOnHomeServer();
            this.emitChange("pushNotifications.enabledOnServer");
        } catch (err) {
            this.pushNotifications.serverError = err;
            this.emitChange("pushNotifications.serverError");
        }
    }
}

class RoomViewModelObservable extends ObservableValue {
    constructor(sessionViewModel, roomId) {
        super(null);
        this._statusSubscription = null;
        this._sessionViewModel = sessionViewModel;
        this.id = roomId;
    }
    async initialize() {
        const {session} = this._sessionViewModel._sessionContainer;
        const statusObservable = await session.observeRoomStatus(this.id);
        this.set(await this._statusToViewModel(statusObservable.get()));
        this._statusSubscription = statusObservable.subscribe(async status => {
            this.get()?.dispose();
            this.set(await this._statusToViewModel(status));
        });
    }
    async _statusToViewModel(status) {
        if (status.invited) {
            return this._sessionViewModel._createInviteViewModel(this.id);
        } else if (status.joined) {
            return this._sessionViewModel._createRoomViewModel(this.id);
        } else if (status.archived) {
            return await this._sessionViewModel._createArchivedRoomViewModel(this.id);
        } else {
            return this._sessionViewModel._createUnknownRoomViewModel(this.id);
        }
    }
    dispose() {
        if (this._statusSubscription) {
            this._statusSubscription = this._statusSubscription();
        }
        this.unsubscribeAll();
        this.get()?.dispose();
    }
}

class SessionViewModel extends ViewModel {
    constructor(options) {
        super(options);
        const {sessionContainer} = options;
        this._sessionContainer = this.track(sessionContainer);
        this._sessionStatusViewModel = this.track(new SessionStatusViewModel(this.childOptions({
            sync: sessionContainer.sync,
            reconnector: sessionContainer.reconnector,
            session: sessionContainer.session,
        })));
        this._leftPanelViewModel = this.track(new LeftPanelViewModel(this.childOptions({
            invites: this._sessionContainer.session.invites,
            rooms: this._sessionContainer.session.rooms
        })));
        this._settingsViewModel = null;
        this._roomViewModelObservable = null;
        this._gridViewModel = null;
        this._setupNavigation();
    }
    _setupNavigation() {
        const gridRooms = this.navigation.observe("rooms");
        this.track(gridRooms.subscribe(roomIds => {
            this._updateGrid(roomIds);
        }));
        if (gridRooms.get()) {
            this._updateGrid(gridRooms.get());
        }
        const currentRoomId = this.navigation.observe("room");
        this.track(currentRoomId.subscribe(roomId => {
            if (!this._gridViewModel) {
                this._updateRoom(roomId);
            }
            this._updateRoomDetails();
        }));
        if (!this._gridViewModel) {
            this._updateRoom(currentRoomId.get());
        }
        const settings = this.navigation.observe("settings");
        this.track(settings.subscribe(settingsOpen => {
            this._updateSettings(settingsOpen);
        }));
        this._updateSettings(settings.get());
        const lightbox = this.navigation.observe("lightbox");
        this.track(lightbox.subscribe(eventId => {
            this._updateLightbox(eventId);
        }));
        this._updateLightbox(lightbox.get());
        const details = this.navigation.observe("details");
        this.track(details.subscribe(() => this._updateRoomDetails()));
        this._updateRoomDetails();
    }
    get id() {
        return this._sessionContainer.sessionId;
    }
    start() {
        this._sessionStatusViewModel.start();
    }
    get activeMiddleViewModel() {
        return this._roomViewModelObservable?.get() || this._gridViewModel || this._settingsViewModel;
    }
    get roomGridViewModel() {
        return this._gridViewModel;
    }
    get leftPanelViewModel() {
        return this._leftPanelViewModel;
    }
    get sessionStatusViewModel() {
        return this._sessionStatusViewModel;
    }
    get settingsViewModel() {
        return this._settingsViewModel;
    }
    get currentRoomViewModel() {
        return this._roomViewModelObservable?.get();
    }
    get roomDetailsViewModel() {
        return this._roomDetailsViewModel;
    }
    _updateGrid(roomIds) {
        const changed = !(this._gridViewModel && roomIds);
        const currentRoomId = this.navigation.path.get("room");
        if (roomIds) {
            if (!this._gridViewModel) {
                this._gridViewModel = this.track(new RoomGridViewModel(this.childOptions({
                    width: 3,
                    height: 2,
                    createRoomViewModelObservable: roomId => new RoomViewModelObservable(this, roomId),
                })));
                this._roomViewModelObservable?.unsubscribeAll();
                if (this._gridViewModel.initializeRoomIdsAndTransferVM(roomIds, this._roomViewModelObservable)) {
                    this._roomViewModelObservable = this.untrack(this._roomViewModelObservable);
                } else if (this._roomViewModelObservable) {
                    this._roomViewModelObservable = this.disposeTracked(this._roomViewModelObservable);
                }
            } else {
                this._gridViewModel.setRoomIds(roomIds);
            }
        } else if (this._gridViewModel && !roomIds) {
            if (currentRoomId) {
                const vmo = this._gridViewModel.releaseRoomViewModel(currentRoomId.value);
                if (vmo) {
                    this._roomViewModelObservable = this.track(vmo);
                    this._roomViewModelObservable.subscribe(() => {
                        this.emitChange("activeMiddleViewModel");
                    });
                }
            }
            this._gridViewModel = this.disposeTracked(this._gridViewModel);
        }
        if (changed) {
            this.emitChange("activeMiddleViewModel");
        }
    }
    _createRoomViewModel(roomId) {
        const room = this._sessionContainer.session.rooms.get(roomId);
        if (room) {
            const roomVM = new RoomViewModel(this.childOptions({room}));
            roomVM.load();
            return roomVM;
        }
        return null;
    }
    _createUnknownRoomViewModel(roomIdOrAlias) {
        return new UnknownRoomViewModel(this.childOptions({
            roomIdOrAlias,
            session: this._sessionContainer.session,
        }));
    }
    async _createArchivedRoomViewModel(roomId) {
        const room = await this._sessionContainer.session.loadArchivedRoom(roomId);
        if (room) {
            const roomVM = new RoomViewModel(this.childOptions({room}));
            roomVM.load();
            return roomVM;
        }
        return null;
    }
    _createInviteViewModel(roomId) {
        const invite = this._sessionContainer.session.invites.get(roomId);
        if (invite) {
            return new InviteViewModel(this.childOptions({
                invite,
                mediaRepository: this._sessionContainer.session.mediaRepository,
            }));
        }
        return null;
    }
    _updateRoom(roomId) {
        if (this._roomViewModelObservable?.id === roomId) {
            return;
        }
        if (this._roomViewModelObservable) {
            this._roomViewModelObservable = this.disposeTracked(this._roomViewModelObservable);
        }
        if (!roomId) {
            this.emitChange("activeMiddleViewModel");
            return;
        }
        const vmo = new RoomViewModelObservable(this, roomId);
        this._roomViewModelObservable = this.track(vmo);
        this._roomViewModelObservable.subscribe(() => {
            this.emitChange("activeMiddleViewModel");
        });
        vmo.initialize();
    }
    _updateSettings(settingsOpen) {
        if (this._settingsViewModel) {
            this._settingsViewModel = this.disposeTracked(this._settingsViewModel);
        }
        if (settingsOpen) {
            this._settingsViewModel = this.track(new SettingsViewModel(this.childOptions({
                session: this._sessionContainer.session,
            })));
            this._settingsViewModel.load();
        }
        this.emitChange("activeMiddleViewModel");
    }
    _updateLightbox(eventId) {
        if (this._lightboxViewModel) {
            this._lightboxViewModel = this.disposeTracked(this._lightboxViewModel);
        }
        if (eventId) {
            const room = this._roomFromNavigation();
            this._lightboxViewModel = this.track(new LightboxViewModel(this.childOptions({eventId, room})));
        }
        this.emitChange("lightboxViewModel");
    }
    get lightboxViewModel() {
        return this._lightboxViewModel;
    }
    _roomFromNavigation() {
        const roomId = this.navigation.path.get("room")?.value;
        const room = this._sessionContainer.session.rooms.get(roomId);
        return room;
    }
    _updateRoomDetails() {
        this._roomDetailsViewModel = this.disposeTracked(this._roomDetailsViewModel);
        const enable = !!this.navigation.path.get("details")?.value;
        if (enable) {
            const room = this._roomFromNavigation();
            if (!room) { return; }
            this._roomDetailsViewModel = this.track(new RoomDetailsViewModel(this.childOptions({room})));
        }
        this.emitChange("roomDetailsViewModel");
    }
}

class SessionLoadViewModel extends ViewModel {
    constructor(options) {
        super(options);
        const {createAndStartSessionContainer, ready, homeserver, deleteSessionOnCancel} = options;
        this._createAndStartSessionContainer = createAndStartSessionContainer;
        this._ready = ready;
        this._homeserver = homeserver;
        this._deleteSessionOnCancel = deleteSessionOnCancel;
        this._loading = false;
        this._error = null;
        this.backUrl = this.urlCreator.urlForSegment("session", true);
    }
    async start() {
        if (this._loading) {
            return;
        }
        try {
            this._loading = true;
            this.emitChange("loading");
            this._sessionContainer = this._createAndStartSessionContainer();
            this._waitHandle = this._sessionContainer.loadStatus.waitFor(s => {
                this.emitChange("loadLabel");
                const isCatchupSync = s === LoadStatus.FirstSync &&
                    this._sessionContainer.sync.status.get() === SyncStatus.CatchupSync;
                return isCatchupSync ||
                    s === LoadStatus.LoginFailed ||
                    s === LoadStatus.Error ||
                    s === LoadStatus.Ready;
            });
            try {
                await this._waitHandle.promise;
            } catch (err) {
                return;
            }
            const loadStatus = this._sessionContainer.loadStatus.get();
            const loadError = this._sessionContainer.loadError;
            if (loadStatus === LoadStatus.FirstSync || loadStatus === LoadStatus.Ready) {
                const sessionContainer = this._sessionContainer;
                this._sessionContainer = null;
                this._ready(sessionContainer);
            }
            if (loadError) {
                console.error("session load error", loadError);
            }
        } catch (err) {
            this._error = err;
            console.error("error thrown during session load", err.stack);
        } finally {
            this._loading = false;
            this.emitChange("loading");
        }
    }
    dispose() {
        if (this._sessionContainer) {
            this._sessionContainer.dispose();
            this._sessionContainer = null;
        }
        if (this._waitHandle) {
            this._waitHandle.dispose();
            this._waitHandle = null;
        }
    }
    get loading() {
        return this._loading;
    }
    get loadLabel() {
        const sc = this._sessionContainer;
        const error = this._error || (sc && sc.loadError);
        if (error || (sc && sc.loadStatus.get() === LoadStatus.Error)) {
            return `Something went wrong: ${error && error.message}.`;
        }
        if (sc) {
            switch (sc.loadStatus.get()) {
                case LoadStatus.NotLoading:
                    return `Preparing…`;
                case LoadStatus.Login:
                    return `Checking your login and password…`;
                case LoadStatus.LoginFailed:
                    switch (sc.loginFailure) {
                        case LoginFailure.LoginFailure:
                            return `Your username and/or password don't seem to be correct.`;
                        case LoginFailure.Connection:
                            return `Can't connect to ${this._homeserver}.`;
                        case LoginFailure.Unknown:
                            return `Something went wrong while checking your login and password.`;
                    }
                    break;
                case LoadStatus.SessionSetup:
                    return `Setting up your encryption keys…`;
                case LoadStatus.Loading:
                    return `Loading your conversations…`;
                case LoadStatus.FirstSync:
                    return `Getting your conversations from the server…`;
                default:
                    return this._sessionContainer.loadStatus.get();
            }
        }
        return `Preparing…`;
    }
}

class LoginViewModel extends ViewModel {
    constructor(options) {
        super(options);
        const {ready, defaultHomeServer, createSessionContainer} = options;
        this._createSessionContainer = createSessionContainer;
        this._ready = ready;
        this._defaultHomeServer = defaultHomeServer;
        this._sessionContainer = null;
        this._loadViewModel = null;
        this._loadViewModelSubscription = null;
    }
    get defaultHomeServer() { return this._defaultHomeServer; }
    get loadViewModel() {return this._loadViewModel; }
    get isBusy() {
        if (!this._loadViewModel) {
            return false;
        } else {
            return this._loadViewModel.loading;
        }
    }
    async login(username, password, homeserver) {
        this._loadViewModelSubscription = this.disposeTracked(this._loadViewModelSubscription);
        if (this._loadViewModel) {
            this._loadViewModel = this.disposeTracked(this._loadViewModel);
        }
        this._loadViewModel = this.track(new SessionLoadViewModel(this.childOptions({
            createAndStartSessionContainer: () => {
                this._sessionContainer = this._createSessionContainer();
                this._sessionContainer.startWithLogin(homeserver, username, password);
                return this._sessionContainer;
            },
            ready: sessionContainer => {
                this._sessionContainer = null;
                this._ready(sessionContainer);
            },
            homeserver,
        })));
        this._loadViewModel.start();
        this.emitChange("loadViewModel");
        this._loadViewModelSubscription = this.track(this._loadViewModel.disposableOn("change", () => {
            if (!this._loadViewModel.loading) {
                this._loadViewModelSubscription = this.disposeTracked(this._loadViewModelSubscription);
            }
            this.emitChange("isBusy");
        }));
    }
    get cancelUrl() {
        return this.urlCreator.urlForSegment("session");
    }
    dispose() {
        super.dispose();
        if (this._sessionContainer) {
            this._sessionContainer.deleteSession();
        }
    }
}

class SessionItemViewModel extends ViewModel {
    constructor(options, pickerVM) {
        super(options);
        this._pickerVM = pickerVM;
        this._sessionInfo = options.sessionInfo;
        this._isDeleting = false;
        this._isClearing = false;
        this._error = null;
        this._exportDataUrl = null;
    }
    get error() {
        return this._error && this._error.message;
    }
    async delete() {
        this._isDeleting = true;
        this.emitChange("isDeleting");
        try {
            await this._pickerVM.delete(this.id);
        } catch(err) {
            this._error = err;
            console.error(err);
            this.emitChange("error");
        } finally {
            this._isDeleting = false;
            this.emitChange("isDeleting");
        }
    }
    async clear() {
        this._isClearing = true;
        this.emitChange();
        try {
            await this._pickerVM.clear(this.id);
        } catch(err) {
            this._error = err;
            console.error(err);
            this.emitChange("error");
        } finally {
            this._isClearing = false;
            this.emitChange("isClearing");
        }
    }
    get isDeleting() {
        return this._isDeleting;
    }
    get isClearing() {
        return this._isClearing;
    }
    get id() {
        return this._sessionInfo.id;
    }
    get openUrl() {
        return this.urlCreator.urlForSegment("session", this.id);
    }
    get label() {
        const {userId, comment} =  this._sessionInfo;
        if (comment) {
            return `${userId} (${comment})`;
        } else {
            return userId;
        }
    }
    get sessionInfo() {
        return this._sessionInfo;
    }
    get exportDataUrl() {
        return this._exportDataUrl;
    }
    async export() {
        try {
            const data = await this._pickerVM._exportData(this._sessionInfo.id);
            const json = JSON.stringify(data, undefined, 2);
            const blob = new Blob([json], {type: "application/json"});
            this._exportDataUrl = URL.createObjectURL(blob);
            this.emitChange("exportDataUrl");
        } catch (err) {
            alert(err.message);
            console.error(err);
        }
    }
    clearExport() {
        if (this._exportDataUrl) {
            URL.revokeObjectURL(this._exportDataUrl);
            this._exportDataUrl = null;
            this.emitChange("exportDataUrl");
        }
    }
    get avatarColorNumber() {
        return getIdentifierColorNumber(this._sessionInfo.userId);
    }
    get avatarInitials() {
        return avatarInitials(this._sessionInfo.userId);
    }
}
class SessionPickerViewModel extends ViewModel {
    constructor(options) {
        super(options);
        this._sessions = new SortedArray((s1, s2) => s1.id.localeCompare(s2.id));
        this._loadViewModel = null;
        this._error = null;
    }
    async load() {
        const sessions = await this.platform.sessionInfoStorage.getAll();
        this._sessions.setManyUnsorted(sessions.map(s => {
            return new SessionItemViewModel(this.childOptions({sessionInfo: s}), this);
        }));
    }
    get loadViewModel() {
        return this._loadViewModel;
    }
    async _exportData(id) {
        const sessionInfo = await this.platform.sessionInfoStorage.get(id);
        const stores = await this.platform.storageFactory.export(id);
        const data = {sessionInfo, stores};
        return data;
    }
    async import(json) {
        try {
            const data = JSON.parse(json);
            const {sessionInfo} = data;
            sessionInfo.comment = `Imported on ${new Date().toLocaleString()} from id ${sessionInfo.id}.`;
            sessionInfo.id = this._createSessionContainer().createNewSessionId();
            await this.platform.storageFactory.import(sessionInfo.id, data.stores);
            await this.platform.sessionInfoStorage.add(sessionInfo);
            this._sessions.set(new SessionItemViewModel(sessionInfo, this));
        } catch (err) {
            alert(err.message);
            console.error(err);
        }
    }
    async delete(id) {
        const idx = this._sessions.array.findIndex(s => s.id === id);
        await this.platform.sessionInfoStorage.delete(id);
        await this.platform.storageFactory.delete(id);
        this._sessions.remove(idx);
    }
    async clear(id) {
        await this.platform.storageFactory.delete(id);
    }
    get sessions() {
        return this._sessions;
    }
    get cancelUrl() {
        return this.urlCreator.urlForSegment("login");
    }
}

class RootViewModel extends ViewModel {
    constructor(options) {
        super(options);
        this._createSessionContainer = options.createSessionContainer;
        this._error = null;
        this._sessionPickerViewModel = null;
        this._sessionLoadViewModel = null;
        this._loginViewModel = null;
        this._sessionViewModel = null;
        this._pendingSessionContainer = null;
    }
    async load() {
        this.track(this.navigation.observe("login").subscribe(() => this._applyNavigation()));
        this.track(this.navigation.observe("session").subscribe(() => this._applyNavigation()));
        this._applyNavigation(true);
    }
    async _applyNavigation(shouldRestoreLastUrl) {
        const isLogin = this.navigation.observe("login").get();
        const sessionId = this.navigation.observe("session").get();
        if (isLogin) {
            if (this.activeSection !== "login") {
                this._showLogin();
            }
        } else if (sessionId === true) {
            if (this.activeSection !== "picker") {
                this._showPicker();
            }
        } else if (sessionId) {
            if (!this._sessionViewModel || this._sessionViewModel.id !== sessionId) {
                if (this._pendingSessionContainer && this._pendingSessionContainer.sessionId === sessionId) {
                    const sessionContainer = this._pendingSessionContainer;
                    this._pendingSessionContainer = null;
                    this._showSession(sessionContainer);
                } else {
                    if (this._pendingSessionContainer) {
                        this._pendingSessionContainer.dispose();
                        this._pendingSessionContainer = null;
                    }
                    this._showSessionLoader(sessionId);
                }
            }
        } else {
            try {
                if (!(shouldRestoreLastUrl && this.urlCreator.tryRestoreLastUrl())) {
                    const sessionInfos = await this.platform.sessionInfoStorage.getAll();
                    if (sessionInfos.length === 0) {
                        this.navigation.push("login");
                    } else if (sessionInfos.length === 1) {
                        this.navigation.push("session", sessionInfos[0].id);
                    } else {
                        this.navigation.push("session");
                    }
                }
            } catch (err) {
                this._setSection(() => this._error = err);
            }
        }
    }
    async _showPicker() {
        this._setSection(() => {
            this._sessionPickerViewModel = new SessionPickerViewModel(this.childOptions());
        });
        try {
            await this._sessionPickerViewModel.load();
        } catch (err) {
            this._setSection(() => this._error = err);
        }
    }
    _showLogin() {
        this._setSection(() => {
            this._loginViewModel = new LoginViewModel(this.childOptions({
                defaultHomeServer: this.platform.config["defaultHomeServer"],
                createSessionContainer: this._createSessionContainer,
                ready: sessionContainer => {
                    this._pendingSessionContainer = sessionContainer;
                    this.navigation.push("session", sessionContainer.sessionId);
                },
            }));
        });
    }
    _showSession(sessionContainer) {
        this._setSection(() => {
            this._sessionViewModel = new SessionViewModel(this.childOptions({sessionContainer}));
            this._sessionViewModel.start();
        });
    }
    _showSessionLoader(sessionId) {
        this._setSection(() => {
            this._sessionLoadViewModel = new SessionLoadViewModel(this.childOptions({
                createAndStartSessionContainer: () => {
                    const sessionContainer = this._createSessionContainer();
                    sessionContainer.startWithExistingSession(sessionId);
                    return sessionContainer;
                },
                ready: sessionContainer => this._showSession(sessionContainer)
            }));
            this._sessionLoadViewModel.start();
        });
    }
    get activeSection() {
        if (this._error) {
            return "error";
        } else if (this._sessionViewModel) {
            return "session";
        } else if (this._loginViewModel) {
            return "login";
        } else if (this._sessionPickerViewModel) {
            return "picker";
        } else if (this._sessionLoadViewModel) {
            return "loading";
        } else {
            return "redirecting";
        }
    }
    _setSection(setter) {
        this._error = null;
        this._sessionPickerViewModel = this.disposeTracked(this._sessionPickerViewModel);
        this._sessionLoadViewModel = this.disposeTracked(this._sessionLoadViewModel);
        this._loginViewModel = this.disposeTracked(this._loginViewModel);
        this._sessionViewModel = this.disposeTracked(this._sessionViewModel);
        setter();
        this._sessionPickerViewModel && this.track(this._sessionPickerViewModel);
        this._sessionLoadViewModel && this.track(this._sessionLoadViewModel);
        this._loginViewModel && this.track(this._loginViewModel);
        this._sessionViewModel && this.track(this._sessionViewModel);
        this.emitChange("activeSection");
    }
    get error() { return this._error; }
    get sessionViewModel() { return this._sessionViewModel; }
    get loginViewModel() { return this._loginViewModel; }
    get sessionPickerViewModel() { return this._sessionPickerViewModel; }
    get sessionLoadViewModel() { return this._sessionLoadViewModel; }
}

async function main(platform) {
    try {
        const navigation = createNavigation();
        platform.setNavigation(navigation);
        const urlRouter = createRouter({navigation, history: platform.history});
        urlRouter.attach();
        const olmPromise = platform.loadOlm();
        const workerPromise = platform.loadOlmWorker();
        const vm = new RootViewModel({
            createSessionContainer: () => {
                return new SessionContainer({platform, olmPromise, workerPromise});
            },
            platform,
            urlCreator: urlRouter,
            navigation,
        });
        await vm.load();
        platform.createAndMountRootView(vm);
    } catch(err) {
        console.error(`${err.message}:\n${err.stack}`);
    }
}

export { Platform, main };

// @license-end
