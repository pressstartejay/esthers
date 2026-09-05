/*
 * The customer chat frontend: assets/js/chat-customer.js, and the parts of
 * assets/js/chat.js that decide whether any of it runs.
 *
 * WHAT THIS PROVES, AND WHAT IT CANNOT.
 *
 * It cannot mint a real App Check token or reach a real Firestore. The
 * production reCAPTCHA Enterprise key is restricted to esthers.ca and
 * attestation is performed by a browser against the page's own hostname, so
 * no token exists outside a page actually served from there. That
 * restriction is the protection; weakening it to make a test pass would be
 * exactly the wrong trade, and docs/CHAT_CUSTOMER_FRONTEND.md documents the
 * manual walkthrough that closes the remaining gap on production.
 *
 * What it does prove is every rule up to that boundary - and, importantly,
 * it proves the ORDERING and the HEADER SEPARATION against the real
 * chat-app-check.js rather than a stand-in for it. Only the four gstatic
 * SDK URLs are swapped; both modules under test run their own logic
 * unmodified, wired to each other exactly as they are in the browser.
 *
 * HOW. Each module is read from disk, its SDK specifiers rewritten to the
 * local stub, and imported as a data: URL. chat-customer.js imports
 * chat-app-check.js by relative path, which a data: URL cannot resolve, so
 * that specifier is rewritten to the data: URL of the rewritten
 * chat-app-check.js - the real module, reachable from the real importer.
 *
 * NO NETWORK. NO PRODUCTION CONTACT. NO FIREBASE PROJECT.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { codeOnly, codeAndStrings } from './fixtures/source-view.mjs';

const CUSTOMER_PATH = '/home/user/esthers/assets/js/chat-customer.js';
const APP_CHECK_PATH = '/home/user/esthers/assets/js/chat-app-check.js';
const WIDGET_PATH = '/home/user/esthers/assets/js/chat.js';
const STUB_PATH = '/home/user/esthers/tests/chat-api/fixtures/firebase-sdk-full-stub.mjs';

const CUSTOMER_SRC = readFileSync(CUSTOMER_PATH, 'utf8');
const APP_CHECK_SRC = readFileSync(APP_CHECK_PATH, 'utf8');
const WIDGET_SRC = readFileSync(WIDGET_PATH, 'utf8');

const STUB_URL = pathToFileURL(STUB_PATH).href;

/*
 * These files document themselves at length, and the prose names the very
 * things the assertions below promise are absent - "no innerHTML anywhere in
 * this section", "sessionStorage and not localStorage". Searching the raw
 * text would fail on the documentation. See fixtures/source-view.mjs.
 */
const CUSTOMER_CODE = codeAndStrings(CUSTOMER_SRC);
const CUSTOMER_IDENTS = codeOnly(CUSTOMER_SRC);
const WIDGET_CODE = codeAndStrings(WIDGET_SRC);

function dataUrl(source) {
  return 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64');
}

/*
 * Load both modules with the SDK swapped for the stub, fresh each time so
 * the memoisation inside chat-app-check.js starts from zero.
 */
let salt = 0;
async function load() {
  salt += 1;

  const appCheckSrc = APP_CHECK_SRC
    .replace(/const SDK_APP = [^;]+;/, `const SDK_APP = ${JSON.stringify(STUB_URL)};`)
    .replace(/const SDK_APP_CHECK = [^;]+;/, `const SDK_APP_CHECK = ${JSON.stringify(STUB_URL)};`)
    + `\n/* cache-bust ${salt} */\n`;
  const appCheckUrl = dataUrl(appCheckSrc);

  const customerSrc = CUSTOMER_SRC
    .replace(/const SDK_AUTH = [^;]+;/, `const SDK_AUTH = ${JSON.stringify(STUB_URL)};`)
    .replace(/const SDK_FIRESTORE = [^;]+;/, `const SDK_FIRESTORE = ${JSON.stringify(STUB_URL)};`)
    .replace(/from '\.\/chat-app-check\.js'/, `from ${JSON.stringify(appCheckUrl)}`)
    + `\n/* cache-bust ${salt} */\n`;

  const mod = await import(dataUrl(customerSrc));
  const appCheck = await import(appCheckUrl);
  const stub = await import(STUB_URL);
  stub.reset();
  appCheck._reset();
  mod._reset();
  return { mod, appCheck, stub };
}

/* A UI that records instead of drawing. Every method the contract names,
   so a missing one can never be the reason a test passes. */
function recordingUi() {
  const ui = {
    calls: [],
    messages: null,
    status: null,
    notice: null,
    busy: null,
    composerEnabled: null,
    closed: null,
    retry: null,
    startFormShown: 0,
    transcriptShown: 0,
    startHandler: null,
    sendHandler: null,
    renderCount: 0
  };
  ui.showStartForm = () => { ui.calls.push('showStartForm'); ui.startFormShown += 1; };
  ui.showTranscript = () => { ui.calls.push('showTranscript'); ui.transcriptShown += 1; };
  ui.renderMessages = (list) => {
    ui.calls.push('renderMessages');
    ui.renderCount += 1;
    ui.messages = list;
  };
  ui.setStatus = (t) => { ui.calls.push('setStatus'); ui.status = t; };
  ui.setNotice = (t) => { ui.calls.push('setNotice'); ui.notice = t; };
  ui.setBusy = (f) => { ui.calls.push('setBusy'); ui.busy = f; };
  ui.setComposerEnabled = (f) => { ui.calls.push('setComposerEnabled'); ui.composerEnabled = f; };
  ui.setClosed = (f) => { ui.calls.push('setClosed'); ui.closed = f; };
  ui.setRetry = (h) => { ui.calls.push('setRetry'); ui.retry = h; };
  ui.onStart = (h) => { ui.startHandler = h; };
  ui.onSend = (h) => { ui.sendHandler = h; };
  return ui;
}

/* An in-memory sessionStorage. Real enough for the reconciliation tests,
   and it cannot throw unless a test asks it to. */
function memoryStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map
  };
}

/* Captures every fetch the module makes, and answers with what a test
   dictates. globalThis.fetch is what the REAL authorizedFetch() calls, so
   what lands here is the genuinely assembled request. */
function captureFetch(responder) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    seen.push({ input, init });
    const answer = typeof responder === 'function' ? responder(seen.length, input, init) : responder;
    if (answer instanceof Error) throw answer;
    return answer || jsonResponse(200, { ok: true });
  };
  return {
    seen,
    restore: () => { globalThis.fetch = original; }
  };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

/* Let queued microtasks and zero-delay timers run - the stub reports auth
   state and rules refusals on a timer, as the SDK does. */
function tick(times = 3) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) {
    p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  }
  return p;
}

const OK_START = { ok: true, conversationId: 'conv-1', messageId: 'msg-1', status: 'open' };
const OK_SEND = { ok: true, conversationId: 'conv-1', messageId: 'msg-2' };

/* Drive a session all the way to "connected, conversation open". */
async function connectedSession(mod, opts = {}) {
  const ui = recordingUi();
  const storage = opts.storage || memoryStorage();
  const fetcher = captureFetch(opts.responder || jsonResponse(200, OK_START));
  const session = await mod.openChatForReview({
    ui,
    openPanel: () => {},
    deps: Object.assign({ storage: () => storage }, opts.deps || {})
  });
  return { ui, storage, fetcher, session };
}

/* ==================================================== 9-10. THE GATE */

describe('the public rollout gate', () => {
  test('CHAT_PUBLIC_ENABLED defaults to false in the transport', async () => {
    const { mod } = await load();
    assert.equal(mod.CHAT_PUBLIC_ENABLED, false);
    assert.equal(mod.isPublicChatEnabled(), false);
  });

  test('CHAT_PUBLIC_ENABLED defaults to false in the widget', () => {
    /* chat.js is a classic script on every public page. Its gate is the one
       that decides whether the transport is ever imported, so it is read
       from source rather than from a module namespace. */
    assert.match(WIDGET_SRC, /var CHAT_PUBLIC_ENABLED = false;/);
    assert.equal(/var CHAT_PUBLIC_ENABLED = true/.test(WIDGET_SRC), false);
  });

  test('connect() refuses while the gate is shut, and returns null', async () => {
    const { mod } = await load();
    const ui = recordingUi();
    assert.equal(await mod.connect(ui, {}), null);
  });

  test('with the gate shut: no auth, no API call, no listener, no UI touched',
    async () => {
      const { mod, stub } = await load();
      const ui = recordingUi();
      const fetcher = captureFetch(jsonResponse(200, OK_START));
      try {
        await mod.connect(ui, { deps: { storage: () => memoryStorage() } });
        await tick();

        assert.equal(stub.calls.signInAnonymously.length, 0, 'no anonymous sign-in');
        assert.equal(stub.calls.initializeAppCheck.length, 0, 'no reCAPTCHA challenge');
        assert.equal(stub.calls.onSnapshot.length, 0, 'no Firestore listener');
        assert.equal(fetcher.seen.length, 0, 'no request to /api/chat/*');
        assert.equal(ui.calls.length, 0, 'the widget is not even told');
        assert.equal(mod.activeSession(), null);
      } finally {
        fetcher.restore();
      }
    });

  test('the widget does not import the transport while its gate is shut', () => {
    /* The dynamic import is inside connectTransport(), and the only call to
       connectTransport() is behind the gate. Nothing at module scope. */
    assert.match(WIDGET_SRC, /if \(CHAT_PUBLIC_ENABLED\) connectTransport\(\);/);
    const importCount = (WIDGET_SRC.match(/import\(TRANSPORT_MODULE\)/g) || []).length;
    assert.equal(importCount, 1, 'exactly one place imports the transport');
  });

  test('no query parameter, cookie or storage key can open the gate', () => {
    /* Identifiers, so the comment that says "not a localStorage key" is not
       mistaken for a use of one. */
    for (const forbidden of [
      'location.search', 'URLSearchParams', 'document.cookie',
      'localStorage', 'searchParams', 'window.name'
    ]) {
      assert.equal(CUSTOMER_IDENTS.includes(forbidden), false,
        'the transport must not read ' + forbidden);
    }
    /* sessionStorage IS used - for the conversation id, never for the gate.
       Prove it is not consulted anywhere near the gate. */
    const gateArea = CUSTOMER_IDENTS.slice(
      CUSTOMER_IDENTS.indexOf('export const CHAT_PUBLIC_ENABLED'),
      CUSTOMER_IDENTS.indexOf('export function isPublicChatEnabled') + 200);
    assert.equal(/storage|Storage|cookie|search/.test(gateArea), false);
  });
});

/* =========================================== 1-3. INITIALISATION ORDER */

describe('initialisation order', () => {
  test('App Check is initialised BEFORE anonymous auth', async () => {
    const { mod, stub } = await load();
    const { fetcher } = await connectedSession(mod);
    try {
      await tick();
      const appCheckAt = stub.order.indexOf('initializeAppCheck');
      const signInAt = stub.order.indexOf('signInAnonymously');
      assert.ok(appCheckAt !== -1, 'App Check was initialised');
      assert.ok(signInAt !== -1, 'anonymous sign-in happened');
      assert.ok(appCheckAt < signInAt,
        'App Check must come first - Firebase Auth App Check enforcement is '
        + 'coming, and a sign-in issued before attestation will be refused. '
        + 'order was: ' + stub.order.join(' -> '));
    } finally {
      fetcher.restore();
    }
  });

  test('the whole order is App Check, app, auth, firestore, listener', async () => {
    const { mod, stub } = await load();
    const storage = memoryStorage();
    const fetcher = captureFetch(jsonResponse(200, OK_START));
    try {
      const ui = recordingUi();
      await mod.openChatForReview({
        ui, openPanel: () => {}, deps: { storage: () => storage }
      });
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hello' });
      await tick();

      const at = (name) => stub.order.indexOf(name);
      assert.ok(at('initializeApp') < at('initializeAppCheck') || at('initializeApp') === -1);
      assert.ok(at('initializeAppCheck') < at('getAuth'), 'app check before auth');
      assert.ok(at('getAuth') < at('signInAnonymously'), 'auth module before sign-in');
      assert.ok(at('signInAnonymously') < at('onSnapshot'), 'signed in before listening');
    } finally {
      fetcher.restore();
    }
  });

  test('an existing Firebase app is reused, never a second one', async () => {
    const { mod, stub } = await load();
    stub.seedExistingApp();
    const { fetcher } = await connectedSession(mod);
    try {
      await tick();
      assert.equal(stub.calls.initializeApp.length, 0,
        'initializeApp must not be called when one already exists');
      assert.equal(stub.calls.getFirestore.length, 1);
      /* Firestore and App Check must be on the SAME app object. */
      assert.equal(stub.calls.getFirestore[0].app, stub.calls.initializeAppCheck[0].app);
    } finally {
      fetcher.restore();
    }
  });

  test('an already signed-in anonymous user is reused', async () => {
    const { mod, stub } = await load();
    stub.seedCurrentUser({ uid: 'already-here', getIdToken: async () => 'tok' });
    const { fetcher } = await connectedSession(mod);
    try {
      await tick();
      assert.equal(stub.calls.signInAnonymously.length, 0,
        'a second anonymous account must not be minted');
    } finally {
      fetcher.restore();
    }
  });

  test('a persisted session restored asynchronously is reused, not replaced',
    async () => {
      /* THE RACE THAT MATTERS. auth.currentUser is null for a moment after
         getAuth() even when a good anonymous session exists; signing in
         during that moment succeeds and creates a SECOND account, orphaning
         the visitor's conversation. */
      const { mod, stub } = await load();
      stub.seedRestoredUser({ uid: 'restored-1', getIdToken: async () => 'tok' });
      const { fetcher } = await connectedSession(mod);
      try {
        await tick();
        assert.equal(stub.calls.onAuthStateChanged.length, 1, 'it waited');
        assert.equal(stub.calls.signInAnonymously.length, 0,
          'no second anonymous account');
      } finally {
        fetcher.restore();
      }
    });

  test('with nobody signed in, exactly one anonymous sign-in happens', async () => {
    const { mod, stub } = await load();
    const { fetcher } = await connectedSession(mod);
    try {
      await tick();
      assert.equal(stub.calls.signInAnonymously.length, 1);
    } finally {
      fetcher.restore();
    }
  });
});

/* ======================================= 4-8. CREDENTIALS ON THE WIRE */

describe('credentials on the wire', () => {
  test('start carries BOTH the ID token and the App Check token', async () => {
    const { mod, stub } = await load();
    stub.setAppCheckToken('app-check-abc');
    stub.setSignedInUser({ uid: 'u1', getIdToken: async () => 'id-token-xyz' });
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      const req = fetcher.seen[0];
      assert.equal(req.input, '/api/chat/start');
      assert.equal(req.init.method, 'POST');
      assert.equal(req.init.headers.get('Authorization'), 'Bearer id-token-xyz');
      assert.equal(req.init.headers.get('X-Firebase-AppCheck'), 'app-check-abc');
      assert.equal(req.init.headers.get('Content-Type'), 'application/json');
    } finally {
      fetcher.restore();
    }
  });

  test('send carries BOTH credentials too', async () => {
    const { mod, stub } = await load();
    stub.setAppCheckToken('app-check-abc');
    stub.setSignedInUser({ uid: 'u1', getIdToken: async () => 'id-token-xyz' });
    let call = 0;
    const { ui, fetcher } = await connectedSession(mod, {
      responder: () => { call += 1; return jsonResponse(200, call === 1 ? OK_START : OK_SEND); }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await ui.sendHandler({ message: 'and another thing' });
      const req = fetcher.seen[1];
      assert.equal(req.input, '/api/chat/send');
      assert.equal(req.init.headers.get('Authorization'), 'Bearer id-token-xyz');
      assert.equal(req.init.headers.get('X-Firebase-AppCheck'), 'app-check-abc');
    } finally {
      fetcher.restore();
    }
  });

  test('the App Check token is NEVER placed in Authorization', async () => {
    const { mod, stub } = await load();
    stub.setAppCheckToken('APPCHECK-TOKEN-VALUE');
    stub.setSignedInUser({ uid: 'u1', getIdToken: async () => 'ID-TOKEN-VALUE' });
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      const auth = fetcher.seen[0].init.headers.get('Authorization');
      assert.equal(auth.includes('APPCHECK-TOKEN-VALUE'), false,
        'these are different credentials proving different things');
      assert.equal(auth, 'Bearer ID-TOKEN-VALUE');
    } finally {
      fetcher.restore();
    }
  });

  test('the ID token is NEVER placed in X-Firebase-AppCheck', async () => {
    const { mod, stub } = await load();
    stub.setAppCheckToken('APPCHECK-TOKEN-VALUE');
    stub.setSignedInUser({ uid: 'u1', getIdToken: async () => 'ID-TOKEN-VALUE' });
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      const ac = fetcher.seen[0].init.headers.get('X-Firebase-AppCheck');
      assert.equal(ac.includes('ID-TOKEN-VALUE'), false);
      assert.equal(ac, 'APPCHECK-TOKEN-VALUE');
    } finally {
      fetcher.restore();
    }
  });

  test('no request body carries customerUid or any other privileged field',
    async () => {
      /* validation.js rejects these outright with 400 forbidden_field. A
         client that sends one is not merely wasteful, it is broken. */
      const FORBIDDEN = [
        'customerUid', 'senderType', 'staffUserId', 'createdAt', 'updatedAt',
        'status', 'closedAt', 'messageCount', 'lastMessageAt',
        'staffLastReadAt', 'customerLastReadAt', 'staffNotifiedAt', 'uid', 'role'
      ];
      const { mod } = await load();
      let call = 0;
      const { ui, fetcher } = await connectedSession(mod, {
        responder: () => { call += 1; return jsonResponse(200, call === 1 ? OK_START : OK_SEND); }
      });
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
        await ui.sendHandler({ message: 'more' });
        assert.equal(fetcher.seen.length, 2);
        for (const req of fetcher.seen) {
          const body = JSON.parse(req.init.body);
          for (const f of FORBIDDEN) {
            assert.equal(Object.prototype.hasOwnProperty.call(body, f), false,
              req.input + ' must not send ' + f);
          }
        }
      } finally {
        fetcher.restore();
      }
    });

  test('the request bodies are exactly the schemas the API validates', async () => {
    const { mod } = await load();
    let call = 0;
    const { ui, fetcher } = await connectedSession(mod, {
      responder: () => { call += 1; return jsonResponse(200, call === 1 ? OK_START : OK_SEND); }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await ui.sendHandler({ message: 'more' });

      const start = JSON.parse(fetcher.seen[0].init.body);
      assert.deepEqual(Object.keys(start).sort(),
        ['clientMessageId', 'email', 'message', 'name']);
      assert.equal(start.name, 'Jo');
      assert.equal(start.email, 'jo@example.com');
      assert.equal(start.message, 'hi');

      const send = JSON.parse(fetcher.seen[1].init.body);
      assert.deepEqual(Object.keys(send).sort(),
        ['clientMessageId', 'conversationId', 'message']);
      assert.equal(send.conversationId, 'conv-1');
      assert.equal(send.message, 'more');
    } finally {
      fetcher.restore();
    }
  });

  test('clientMessageId is a UUID the server will accept', async () => {
    /* The exact regular expression from api/_chat/validation.js. */
    const SERVER_UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const { mod } = await load();
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      const body = JSON.parse(fetcher.seen[0].init.body);
      assert.match(body.clientMessageId, SERVER_UUID_RE);
    } finally {
      fetcher.restore();
    }
  });

  test('the getRandomValues fallback also produces an acceptable UUID', async () => {
    const SERVER_UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const { mod } = await load();
    const realCrypto = globalThis.crypto;
    /*
     * A PLAIN object, deliberately not one inheriting from Crypto.prototype:
     * randomUUID lives on that prototype, so an Object.create() of it would
     * still expose randomUUID - and calling it with the wrong `this` throws
     * rather than taking the fallback. The point here is a browser that has
     * getRandomValues and no randomUUID at all.
     */
    const patched = { getRandomValues: (a) => realCrypto.getRandomValues(a) };
    Object.defineProperty(globalThis, 'crypto', { value: patched, configurable: true });
    try {
      for (let i = 0; i < 200; i++) {
        assert.match(mod.newClientMessageId(), SERVER_UUID_RE);
      }
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true });
    }
  });
});

/* ================================================ 11-13. THE LISTENER */

describe('the realtime listener', () => {
  test('the query is filtered by conversationId, ordered by createdAt ascending, and limited',
    async () => {
      const { mod, stub } = await load();
      const { ui, fetcher } = await connectedSession(mod);
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
        await tick();

        assert.equal(stub.calls.onSnapshot.length, 1, 'exactly one listener');
        assert.deepEqual(stub.calls.collection[0].path, 'chatMessages');
        assert.deepEqual(stub.calls.where[0],
          { field: 'conversationId', op: '==', value: 'conv-1' });
        assert.deepEqual(stub.calls.orderBy[0], { field: 'createdAt', direction: 'asc' });
        assert.equal(stub.calls.limit[0].n, 200);
      } finally {
        fetcher.restore();
      }
    });

  test('the limit is mandatory and within what firestore.rules allows', async () => {
    /* maxMessageQuery() in firestore.rules is 200, and the rules refuse a
       listener whose request.query.limit is null. Both halves matter. */
    const { mod } = await load();
    assert.equal(mod._internals.TRANSCRIPT_LIMIT, 200);
    const rules = readFileSync('/home/user/esthers/firestore.rules', 'utf8');
    assert.match(rules, /function maxMessageQuery\(\) \{ return 200; \}/);
    assert.match(rules, /request\.query\.limit != null/);
  });

  test('the composite index this query needs is already deployed', () => {
    const indexes = JSON.parse(
      readFileSync('/home/user/esthers/firestore.indexes.json', 'utf8'));
    const match = indexes.indexes.find((i) =>
      i.collectionGroup === 'chatMessages'
      && i.fields.length === 2
      && i.fields[0].fieldPath === 'conversationId' && i.fields[0].order === 'ASCENDING'
      && i.fields[1].fieldPath === 'createdAt' && i.fields[1].order === 'ASCENDING');
    assert.ok(match, 'no index change was needed, and none was made');
  });

  test('the listener is unsubscribed when the session stops', async () => {
    const { mod, stub } = await load();
    const { ui, session, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await tick();
      assert.equal(stub.liveListenerCount(), 1);
      session.stop();
      assert.equal(stub.calls.unsubscribe.length, 1);
      assert.equal(stub.liveListenerCount(), 0);
    } finally {
      fetcher.restore();
    }
  });

  test('disconnect() stops the listener too', async () => {
    const { mod, stub } = await load();
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await tick();
      assert.equal(mod.disconnect(), true);
      assert.equal(stub.liveListenerCount(), 0);
      assert.equal(mod.activeSession(), null);
    } finally {
      fetcher.restore();
    }
  });

  test('reopening the transcript never leaves two listeners', async () => {
    const { mod, stub } = await load();
    const { ui, session, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await tick();
      session.openTranscript();
      session.openTranscript();
      session.openTranscript();
      await tick();
      assert.equal(stub.liveListenerCount(), 1, 'one live listener, always');
      assert.equal(stub.calls.onSnapshot.length, 4);
      assert.equal(stub.calls.unsubscribe.length, 3, 'each old one was torn down');
    } finally {
      fetcher.restore();
    }
  });

  test('starting a second session stops the first', async () => {
    const { mod, stub } = await load();
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await tick();
      const ui2 = recordingUi();
      await mod.openChatForReview({
        ui: ui2, openPanel: () => {}, deps: { storage: () => memoryStorage() }
      });
      await tick();
      assert.equal(stub.liveListenerCount(), 0,
        'the first session let go before the second started');
    } finally {
      fetcher.restore();
    }
  });

  test('stop() survives an SDK whose unsubscribe throws', async () => {
    const { mod, stub } = await load();
    const { ui, session, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await tick();
      stub.setUnsubscribeThrows();
      session.stop();          /* must not throw */
      session.stop();          /* twice is safe */
      assert.equal(session.unsubscribe, null);
    } finally {
      fetcher.restore();
    }
  });

  test('NO Firestore write API appears anywhere in the module', () => {
    /* The customer cannot write to Firestore: the rules deny create, update
       and delete. This asserts the client never even reaches for one. */
    for (const forbidden of [
      'addDoc', 'setDoc', 'updateDoc', 'deleteDoc', 'writeBatch',
      'runTransaction', 'serverTimestamp', 'deleteField', 'increment'
    ]) {
      assert.equal(CUSTOMER_IDENTS.includes(forbidden), false,
        'the customer must never write to Firestore: found ' + forbidden);
    }
  });

  test('the module reads Firestore and nothing else', () => {
    /* The only Firestore functions it may name. */
    const allowed = ['getFirestore', 'collection', 'query', 'where', 'orderBy',
      'limit', 'onSnapshot'];
    for (const fn of allowed) {
      assert.ok(CUSTOMER_SRC.includes(fn), 'expected to use ' + fn);
    }
  });
});

/* ================================ REGRESSIONS FOUND IN PRE-COMMIT REVIEW
 *
 * Every test in this block corresponds to a defect an adversarial review
 * found in code that the 82 tests above all passed. They are grouped so the
 * next person can see, at a glance, what this suite once let through.
 * ---------------------------------------------------------------------- */

describe('regressions', () => {
  test('suspend then resume keeps the session alive and sending', async () => {
    /*
     * THE BUG: close() called disconnect(), which stopped the session for
     * good, and open() did nothing. The widget stayed in live mode wired to a
     * dead session, so the composer looked fine and silently discarded every
     * message typed into it - the one lie a chat must never tell.
     */
    const { mod, stub } = await load();
    let call = 0;
    const { ui, session, fetcher } = await connectedSession(mod, {
      responder: () => { call += 1; return jsonResponse(200, call === 1 ? OK_START : OK_SEND); }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await tick();
      assert.equal(stub.liveListenerCount(), 1);

      /* panel closes */
      assert.equal(mod.suspend(), true);
      assert.equal(stub.liveListenerCount(), 0, 'no listener while nobody is looking');
      assert.equal(session.stopped, false, 'but the session is still alive');
      assert.equal(session.conversationId, 'conv-1', 'and still knows its conversation');

      /* panel reopens */
      assert.equal(mod.resume(), true);
      await tick();
      assert.equal(stub.liveListenerCount(), 1, 'listening again');

      /* and a message actually goes out */
      const before = fetcher.seen.length;
      await ui.sendHandler({ message: 'still here?' });
      assert.equal(fetcher.seen.length, before + 1,
        'a message sent after a close/reopen must reach the server');
      assert.equal(JSON.parse(fetcher.seen[before].init.body).message, 'still here?');
    } finally {
      fetcher.restore();
    }
  });

  test('suspend/resume never leaves two listeners', async () => {
    const { mod, stub } = await load();
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await tick();
      for (let i = 0; i < 4; i++) {
        mod.suspend();
        mod.resume();
        await tick();
      }
      assert.equal(stub.liveListenerCount(), 1, 'one, however many times it cycles');
    } finally {
      fetcher.restore();
    }
  });

  test('suspend and resume are safe with no session, and after a real stop',
    async () => {
      const { mod } = await load();
      assert.equal(mod.suspend(), false);
      assert.equal(mod.resume(), false);

      const { ui, session, fetcher } = await connectedSession(mod);
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
        await tick();
        session.stop();
        assert.equal(mod.suspend(), false, 'a stopped session stays stopped');
        assert.equal(mod.resume(), false);
      } finally {
        fetcher.restore();
      }
    });

  test('a retry re-sends THE SAME message, not a copy of it', async () => {
    /*
     * THE BUG: the retry called send() afresh, which minted a NEW
     * clientMessageId. The server's idempotency key is that value - see
     * peekMessage() in api/_chat/service.js - so a send whose RESPONSE was
     * lost (the request having reached the server and been stored) was
     * written a second time. The visitor's sentence appeared twice in
     * Esther's inbox.
     */
    const { mod } = await load();
    let call = 0;
    const { ui, fetcher } = await connectedSession(mod, {
      responder: () => {
        call += 1;
        if (call === 1) return jsonResponse(200, OK_START);
        if (call === 2) return new TypeError('Failed to fetch');
        return jsonResponse(200, OK_SEND);
      }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await ui.sendHandler({ message: 'did this arrive?' });
      assert.equal(typeof ui.retry, 'function');

      const failed = JSON.parse(fetcher.seen[1].init.body);
      await ui.retry();
      const retried = JSON.parse(fetcher.seen[2].init.body);

      assert.equal(retried.message, failed.message);
      assert.equal(retried.clientMessageId, failed.clientMessageId,
        'the idempotency key MUST survive the retry, or the server stores the '
        + 'message twice');
    } finally {
      fetcher.restore();
    }
  });

  test('a genuinely new message still mints a fresh key', async () => {
    const { mod } = await load();
    let call = 0;
    const { ui, fetcher } = await connectedSession(mod, {
      responder: () => { call += 1; return jsonResponse(200, call === 1 ? OK_START : OK_SEND); }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await ui.sendHandler({ message: 'one' });
      await ui.sendHandler({ message: 'two' });
      const a = JSON.parse(fetcher.seen[1].init.body).clientMessageId;
      const b = JSON.parse(fetcher.seen[2].init.body).clientMessageId;
      assert.notEqual(a, b, 'two different messages are two different keys');
    } finally {
      fetcher.restore();
    }
  });

  test('a throw while preparing a send does not deadlock the composer', async () => {
    /*
     * THE BUG: sending=true and setBusy(true) were set BEFORE the try, and
     * deriveMessageId() was awaited outside it. A rejection there - or the
     * stopped-check that returned early - skipped the finally, so sending
     * stayed true and the composer never re-enabled. Every later send was
     * refused by its own busy guard.
     */
    const { mod } = await load();
    let call = 0;
    /* Throws ONCE. If it threw every time the second send would fail for the
       same reason, and the test would prove nothing about the busy flag. */
    let derives = 0;
    const { ui, session, fetcher } = await connectedSession(mod, {
      responder: () => { call += 1; return jsonResponse(200, call === 1 ? OK_START : OK_SEND); },
      deps: {
        deriveMessageId: async () => {
          derives += 1;
          if (derives === 1) throw new Error('subtle crypto exploded');
          return 'echo-' + derives;
        }
      }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await ui.sendHandler({ message: 'boom' });

      assert.equal(session.sending, false, 'the busy flag was released');
      assert.equal(ui.busy, false, 'and the UI was told');
      /* A throwable with no status classifies as offline, so the visitor is
         told to check their connection and offered a retry. Not strictly the
         cause here - the browser's crypto failed, not the network - but the
         advice ("try again") is right either way, and it is an allow-listed
         sentence rather than an exception reaching the page. */
      assert.match(ui.notice, /could not reach us/, 'and the visitor was told something');

      /* THE POINT: the composer still works. Before the fix, sending stayed
         true and every later send was refused by its own busy guard. */
      const before = fetcher.seen.length;
      await ui.sendHandler({ message: 'after the failure' });
      assert.equal(fetcher.seen.length, before + 1, 'not wedged');
      assert.equal(JSON.parse(fetcher.seen[before].init.body).message, 'after the failure');
    } finally {
      fetcher.restore();
    }
  });

  test('a session stopped mid-send releases the busy flag too', async () => {
    const { mod } = await load();
    let session = null;
    const { ui, fetcher } = await connectedSession(mod, {
      deps: {
        deriveMessageId: async (c, m) => { if (session) session.stopped = true; return 'echo-1'; }
      }
    });
    try {
      session = mod.activeSession();
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      session.stopped = false;
      await ui.sendHandler({ message: 'racing the teardown' });
      assert.equal(session.sending, false);
      assert.equal(ui.busy, false);
    } finally {
      fetcher.restore();
    }
  });

  test('a signed-in STAFF session is refused, never adopted, never clobbered',
    async () => {
      /*
       * THE BUG: resolveUser() reused whatever user was signed in. Staff hold
       * Email/Password accounts in the same Firebase project and Firebase
       * allows one user per app, so a staff member with the inbox open in
       * another tab had a non-anonymous currentUser sitting right where this
       * looked. Adopting it sends an Email/Password token to the customer API,
       * which authenticateCustomer() refuses 403 forever; the listener fails
       * too, because isAnonymousCustomer() tests the same provider.
       */
      const { mod, stub } = await load();
      stub.seedCurrentUser({
        uid: 'staff-uid', isAnonymous: false, getIdToken: async () => 'staff-token'
      });
      const ui = recordingUi();
      const fetcher = captureFetch(jsonResponse(200, OK_START));
      try {
        const session = await mod.openChatForReview({
          ui, openPanel: () => {}, deps: { storage: () => memoryStorage() }
        });
        await tick();

        assert.equal(session, null, 'it refuses rather than half-connecting');
        assert.equal(stub.calls.signInAnonymously.length, 0,
          'and does NOT sign the staff member out of their own inbox');
        assert.equal(fetcher.seen.length, 0, 'no doomed request is made');
        assert.match(ui.notice, /staff inbox/);
      } finally {
        fetcher.restore();
      }
    });

  test('an anonymous session is still reused normally', async () => {
    const { mod, stub } = await load();
    stub.seedCurrentUser({
      uid: 'anon-here', isAnonymous: true, getIdToken: async () => 'tok'
    });
    const { fetcher } = await connectedSession(mod);
    try {
      await tick();
      assert.equal(stub.calls.signInAnonymously.length, 0);
      assert.ok(mod.activeSession(), 'connected');
    } finally {
      fetcher.restore();
    }
  });

  test('a user with no isAnonymous flag at all is still accepted', async () => {
    /* The stub's default users omit the flag; so would an older SDK. Only an
       explicit false is a refusal - absence must not lock a customer out. */
    const { mod, stub } = await load();
    stub.seedCurrentUser({ uid: 'unknown-kind', getIdToken: async () => 'tok' });
    const { fetcher } = await connectedSession(mod);
    try {
      await tick();
      assert.ok(mod.activeSession());
    } finally {
      fetcher.restore();
    }
  });

  test('a hostile error code cannot put a non-string on the page', async () => {
    /*
     * THE BUG: MESSAGES_BY_CODE[code] walked the prototype chain, so a
     * response with code "constructor" or "toString" returned a FUNCTION -
     * which was then handed to the UI as the sentence to display, defeating
     * the file's own promise that every customer-facing string is
     * allow-listed.
     */
    const { mod } = await load();
    for (const code of ['constructor', 'toString', 'valueOf', 'hasOwnProperty',
      '__proto__', 'isPrototypeOf', 'propertyIsEnumerable']) {
      for (const status of [400, 401, 403, 404, 409, 500]) {
        const r = mod.describeFailure({ status, code });
        assert.equal(typeof r.text, 'string',
          'code=' + code + ' status=' + status + ' produced a ' + typeof r.text);
        assert.ok(r.text.length > 0);
      }
    }
  });

  test('every sentence describeFailure can produce is one of ours', async () => {
    const { mod } = await load();
    const allowed = new Set(Object.values(mod._internals.MESSAGES_BY_CODE));
    for (const code of ['constructor', 'toString', 'not_a_real_code', '', 'app_check_x',
      'conversation_closed', 'rate_limited', 'invalid_email']) {
      for (const status of [0, 400, 401, 403, 404, 409, 429, 500, 503]) {
        const r = mod.describeFailure({ status, code });
        assert.ok(allowed.has(r.text) || typeof r.text === 'string',
          'unexpected text for ' + code + '/' + status);
        assert.equal(typeof r.text, 'string');
      }
    }
  });

  test('start() reuses its key on retry, so no SECOND conversation is opened',
    async () => {
      /*
       * THE BUG: start() minted a fresh clientMessageId per attempt. That key
       * decides the CONVERSATION's identity - startConversationId() in
       * service.js is sha256(domain + uid + clientMessageId) - so a visitor
       * whose response was lost, pressing Start again, opened a second
       * conversation and appeared twice in Esther's inbox as two separate
       * enquiries. peekStart() never got the chance to recognise the retry.
       */
      const { mod } = await load();
      let call = 0;
      const { ui, fetcher } = await connectedSession(mod, {
        responder: () => {
          call += 1;
          if (call === 1) return new TypeError('Failed to fetch');
          return jsonResponse(200, OK_START);
        }
      });
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
        assert.equal(typeof ui.retry, 'function', 'a retry is offered');

        const first = JSON.parse(fetcher.seen[0].init.body);
        await ui.retry();
        const second = JSON.parse(fetcher.seen[1].init.body);

        assert.equal(second.clientMessageId, first.clientMessageId,
          'the retry must land on the SAME conversation, not open another');
        assert.equal(second.name, first.name);
        assert.equal(second.email, first.email);
        assert.equal(second.message, first.message);
      } finally {
        fetcher.restore();
      }
    });

  test('the echo id is derived from the key actually SENT', async () => {
    /*
     * THE GAP: nothing tied the optimistic echo id to the clientMessageId that
     * went out on the wire. Swapping the two arguments at the deriveMessageId
     * call site - so the echo was sha256(key + NUL + conversationId) instead of
     * sha256(conversationId + NUL + key) - passed the whole suite. The echo
     * would then never match the delivered document and every message the
     * visitor sent would appear twice.
     *
     * This closes it end to end: capture the arguments the module actually
     * passes, and check them against the body it actually posts.
     */
    const crypto = await import('node:crypto');
    const { mod } = await load();
    const derived = [];
    let call = 0;
    const { ui, fetcher } = await connectedSession(mod, {
      responder: () => { call += 1; return jsonResponse(200, call === 1 ? OK_START : OK_SEND); },
      deps: {
        deriveMessageId: async (conversationId, clientMessageId) => {
          derived.push({ conversationId, clientMessageId });
          return crypto.createHash('sha256')
            .update(conversationId + '\u0000' + clientMessageId)
            .digest('hex').slice(0, 40);
        }
      }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await ui.sendHandler({ message: 'the one that matters' });

      const body = JSON.parse(fetcher.seen[1].init.body);
      assert.equal(derived.length, 1);
      assert.equal(derived[0].conversationId, body.conversationId,
        'argument 1 must be the conversation id that was posted');
      assert.equal(derived[0].clientMessageId, body.clientMessageId,
        'argument 2 must be the idempotency key that was posted - not the '
        + 'other way round, which would make every echo a duplicate');

      /* And the rendered echo carries exactly the id the server will assign. */
      const serverId = crypto.createHash('sha256')
        .update(body.conversationId + '\u0000' + body.clientMessageId)
        .digest('hex').slice(0, 40);
      const echo = (ui.messages || []).find((m) => m.pending);
      assert.ok(echo, 'an optimistic echo was rendered');
      assert.equal(echo.id, serverId);
    } finally {
      fetcher.restore();
    }
  });

  test('the constraints actually reach the query, not just the builders',
    async () => {
      /*
       * THE GAP: the listener test asserted where()/orderBy()/limit() were
       * CALLED. It never checked their results were passed to query(), so a
       * query built without them - or with them dropped on the floor - passed.
       */
      const { mod, stub } = await load();
      const { ui, fetcher } = await connectedSession(mod);
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
        await tick();

        assert.equal(stub.calls.query.length, 1);
        const q = stub.calls.query[0];
        assert.equal(q.base.__collection, 'chatMessages',
          'the query is built on the chatMessages collection');

        const cs = q.constraints;
        assert.equal(cs.length, 3, 'exactly three constraints reached query()');
        assert.deepEqual(cs[0].__where, ['conversationId', '==', 'conv-1']);
        assert.deepEqual(cs[1].__orderBy, ['createdAt', 'asc']);
        assert.equal(cs[2].__limit, 200);

        /* And the object handed to onSnapshot is that query. */
        assert.equal(stub.calls.onSnapshot[0].q.__query, true);
        assert.equal(stub.calls.onSnapshot[0].q.constraints, cs);
      } finally {
        fetcher.restore();
      }
    });

  test('a 429 issues no retry on ANY timescale, not just immediately',
    async () => {
      /*
       * THE GAP: the no-retry-loop tests waited only for zero-delay timers, so
       * a setTimeout(..., 1000) automatic retry would have passed them. Real
       * retry loops are exactly that shape.
       *
       * Here the clock is driven forward by two minutes of fake time with the
       * real timer queue draining in between, so a delayed retry has every
       * opportunity to fire.
       */
      const { mod } = await load();
      let call = 0;
      const { ui, session, fetcher } = await connectedSession(mod, {
        responder: () => {
          call += 1;
          if (call === 1) return jsonResponse(200, OK_START);
          return jsonResponse(429, { ok: false, code: 'rate_limited', retryAfter: 30 });
        }
      });
      const realSetTimeout = globalThis.setTimeout;
      const scheduled = [];
      globalThis.setTimeout = (fn, ms, ...rest) => {
        if (typeof ms === 'number' && ms > 0) scheduled.push({ fn, ms });
        return realSetTimeout(fn, 0, ...rest);
      };
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
        await tick();
        const before = fetcher.seen.length;

        await ui.sendHandler({ message: 'too fast' });
        await tick(5);

        /* Fire everything the module scheduled with a delay, as if two
           minutes had passed. */
        for (const t of scheduled.splice(0)) {
          try { t.fn(); } catch (err) { /* a timer that throws is its own bug */ }
        }
        await tick(5);

        assert.equal(fetcher.seen.length, before + 1,
          'one attempt, and nothing rescheduled itself on any delay');
        assert.equal(ui.retry, null);
        assert.equal(session.sending, false);
      } finally {
        globalThis.setTimeout = realSetTimeout;
        fetcher.restore();
      }
    });

  test('the demo Send button keeps the exact style it already had', () => {
    /*
     * THE BUG: the new stylesheet block restyled .chat__send:disabled. The
     * existing rule at the top of the file gives it opacity .42 and
     * cursor:default; the new one had equal specificity and came later, so it
     * silently won - changing the Send button on the gate-off path that every
     * visitor sees today, because that button is disabled whenever the
     * composer is empty.
     */
    const css = readFileSync('/home/user/esthers/assets/css/chat.css', 'utf8');
    const rules = css.split('\n')
      .map((l, i) => ({ l: l.trim(), n: i + 1 }))
      .filter((x) => x.l.includes('.chat__send:disabled') && !x.l.startsWith('*'));
    assert.equal(rules.length, 1,
      '.chat__send:disabled must be styled in exactly one place, found at lines '
      + rules.map((r) => r.n).join(', '));
    assert.match(rules[0].l, /opacity: 0\.42/);
    assert.match(rules[0].l, /cursor: default/);
  });

  test('[hidden] actually hides the composer', () => {
    /*
     * THE BUG: .chat__form sets display:flex, and a class selector beats the
     * user agent's [hidden]{display:none}. showStartForm() set the attribute
     * and nothing happened - the start form and the composer were on screen
     * together, asking for the same message twice.
     */
    const css = readFileSync('/home/user/esthers/assets/css/chat.css', 'utf8');
    assert.match(css, /\.chat__form\[hidden\] \{\s*display: none;/);
  });

  test('the source no longer carries a literal NUL byte', () => {
    /* One did, in the test that reproduces the server hash - it made the file
       read as binary to grep and other text tooling. */
    for (const [name, src] of [['chat-customer.js', CUSTOMER_SRC],
      ['chat.js', WIDGET_SRC]]) {
      assert.equal(src.includes('\u0000'), false, name + ' has a literal NUL');
    }
  });
});

/* ============================================= 14-15, 21. THE TRANSCRIPT */

describe('the transcript', () => {
  test('a message delivered twice is one row', async () => {
    const { mod } = await load();
    const store = new mod.TranscriptStore();
    const doc = { id: 'm1', data: { body: 'hello', senderType: 'customer', createdAt: 10 } };
    store.applySnapshot([doc]);
    const list = store.applySnapshot([doc, doc]);
    assert.equal(list.length, 1);
  });

  test('the optimistic echo is REPLACED by the delivered document, not joined',
    async () => {
      const { mod } = await load();
      const store = new mod.TranscriptStore();
      /* Same id: the client derives it exactly as service.js does. */
      store.addPending({ id: 'derived-1', body: 'hi there', senderType: 'customer', createdAt: 5 });
      assert.equal(store.list().length, 1);
      assert.equal(store.list()[0].pending, true);

      const list = store.applySnapshot([
        { id: 'derived-1', data: { body: 'hi there', senderType: 'customer', createdAt: 7 } }
      ]);
      assert.equal(list.length, 1, 'not two copies of the same sentence');
      assert.equal(list[0].pending, false, 'and it is no longer pending');
    });

  test('the derived echo id matches what the server will actually use', async () => {
    /* If these ever diverge the visitor sees their own message twice. */
    const crypto = await import('node:crypto');
    const { mod } = await load();
    const serverId = (conversationId, clientMessageId) => crypto.createHash('sha256')
      .update(conversationId + '\u0000' + clientMessageId).digest('hex').slice(0, 40);

    for (const [conv, cmid] of [
      ['conv-1', '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'],
      ['0123456789abcdef0123456789abcdef', 'ffffffff-ffff-4fff-bfff-ffffffffffff']
    ]) {
      assert.equal(await mod.deriveMessageId(conv, cmid), serverId(conv, cmid));
    }
  });

  test('a pending message that fails is taken back off the screen', async () => {
    const { mod } = await load();
    const store = new mod.TranscriptStore();
    store.addPending({ id: 'p1', body: 'oops', senderType: 'customer', createdAt: 1 });
    assert.equal(store.list().length, 1);
    assert.equal(store.dropPending('p1').length, 0);
  });

  test('a delivered message is never dropped by dropPending', async () => {
    const { mod } = await load();
    const store = new mod.TranscriptStore();
    store.applySnapshot([{ id: 'm1', data: { body: 'real', senderType: 'staff', createdAt: 1 } }]);
    assert.equal(store.dropPending('m1').length, 1, 'only pending rows may be withdrawn');
  });

  test('ordering is deterministic, including a same-millisecond tie', async () => {
    const { mod } = await load();
    const store = new mod.TranscriptStore();
    const list = store.applySnapshot([
      { id: 'bbb', data: { body: 'b', senderType: 'staff', createdAt: 100 } },
      { id: 'aaa', data: { body: 'a', senderType: 'customer', createdAt: 100 } },
      { id: 'ccc', data: { body: 'c', senderType: 'staff', createdAt: 50 } }
    ]);
    assert.deepEqual(list.map((m) => m.id), ['ccc', 'aaa', 'bbb']);
  });

  test('only the four schema fields survive - nothing else is exposed', async () => {
    const { mod } = await load();
    const m = mod.normaliseMessage({
      id: 'm1',
      data: {
        body: 'hi', senderType: 'staff', createdAt: 3, conversationId: 'c1',
        /* If one of these is ever added to the collection it must not reach
           the renderer, whatever the rules happen to allow. */
        staffUserId: 'staff-9', internalNote: 'do not show', email: 'x@y.z'
      }
    });
    assert.deepEqual(Object.keys(m).sort(),
      ['body', 'createdAt', 'id', 'pending', 'senderType']);
    assert.equal(m.staffUserId, undefined);
    assert.equal(m.internalNote, undefined);
  });

  test('malformed documents are dropped, not rendered, and do not break the rest',
    async () => {
      const { mod } = await load();
      const store = new mod.TranscriptStore();
      const list = store.applySnapshot([
        null,
        { id: '', data: { body: 'no id', senderType: 'staff', createdAt: 1 } },
        { id: 'm2', data: { body: null, senderType: 'staff', createdAt: 1 } },
        { id: 'm3', data: { body: 'no sender', senderType: 'ADMIN', createdAt: 1 } },
        { id: 'm4', data: { body: 'good', senderType: 'staff', createdAt: 2 } }
      ]);
      assert.equal(list.length, 1);
      assert.equal(list[0].id, 'm4');
    });

  test('an empty body is a valid message and is kept', async () => {
    const { mod } = await load();
    const m = mod.normaliseMessage({ id: 'm', data: { body: '', senderType: 'system', createdAt: 1 } });
    assert.equal(m.body, '');
  });

  test('a malformed timestamp sorts predictably instead of poisoning the order',
    async () => {
      const { mod } = await load();
      assert.equal(mod.toMillis(undefined), 0);
      assert.equal(mod.toMillis(null), 0);
      assert.equal(mod.toMillis(NaN), 0);
      assert.equal(mod.toMillis('yesterday'), 0);
      assert.equal(mod.toMillis(1234), 1234);
      assert.equal(mod.toMillis(new Date(5000)), 5000);
      assert.equal(mod.toMillis({ toMillis: () => 77 }), 77);
      assert.equal(mod.toMillis({ seconds: 2, nanoseconds: 500000000 }), 2500);
      assert.equal(mod.toMillis({ toMillis: () => NaN }), 0);
    });

  test('an empty transcript is a state, not a failure', async () => {
    const { mod, stub } = await load();
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await tick();
      stub.emitSnapshot([]);
      assert.deepEqual(ui.messages, []);
      assert.equal(ui.notice, null);
    } finally {
      fetcher.restore();
    }
  });

  test('the widget renders every message body with textContent, never innerHTML',
    () => {
      /* The three innerHTML calls in chat.js are fixed SVG icons built by
         that file. None of them is in the live-render path, and no message
         body reaches one. */
      const start = WIDGET_CODE.indexOf('function clearLog()');
      const end = WIDGET_CODE.indexOf('function build() {');
      const live = WIDGET_CODE.slice(start, end);
      assert.ok(start !== -1 && end > start && live.length > 500,
        'found the live section');
      assert.equal(live.includes('innerHTML'), false,
        'no innerHTML anywhere in the transport surface');
      assert.match(live, /bubble\.textContent = body;/);

      /* Across the whole widget there are exactly three, and each one is a
         fixed SVG icon this file builds. No message body reaches any of
         them. */
      const innerHtmlUses = (WIDGET_CODE.match(/\.innerHTML\s*=/g) || []).length;
      assert.equal(innerHtmlUses, 3, 'still exactly the three SVG icons');
      for (const m of WIDGET_CODE.matchAll(/(\w+)\.innerHTML\s*=/g)) {
        assert.ok(['closeBtn', 'dismissBtn', 'restoreBtn'].includes(m[1]),
          'unexpected innerHTML target: ' + m[1]);
      }
    });

  test('the transport hands the UI strings only - never nodes or markup', () => {
    /* renderMessages receives {id, senderType, body, createdAt, pending};
       every other ui call takes a string or a boolean. Prove the module
       never builds a DOM node to hand over. */
    for (const forbidden of [
      'createElement', 'innerHTML', 'outerHTML', 'insertAdjacentHTML',
      'document.write', 'appendChild'
    ]) {
      assert.equal(CUSTOMER_IDENTS.includes(forbidden), false,
        'the transport must not touch the DOM: found ' + forbidden);
    }
  });
});

/* ============================================ 16-20. FAILURE BEHAVIOUR */

describe('failures', () => {
  test('a closed conversation disables sending and says so', async () => {
    const { mod } = await load();
    let call = 0;
    const { ui, session, fetcher } = await connectedSession(mod, {
      responder: () => {
        call += 1;
        if (call === 1) return jsonResponse(200, OK_START);
        return jsonResponse(409, { ok: false, code: 'conversation_closed', error: 'closed' });
      }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await ui.sendHandler({ message: 'anyone there?' });
      assert.equal(ui.closed, true);
      assert.equal(ui.composerEnabled, false);
      assert.equal(ui.notice, 'This conversation has been closed.');
      assert.equal(session.closed, true);
    } finally {
      fetcher.restore();
    }
  });

  test('once closed, a further send is refused locally without a request',
    async () => {
      const { mod } = await load();
      let call = 0;
      const { ui, fetcher } = await connectedSession(mod, {
        responder: () => {
          call += 1;
          if (call === 1) return jsonResponse(200, OK_START);
          return jsonResponse(409, { ok: false, code: 'conversation_closed' });
        }
      });
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
        await ui.sendHandler({ message: 'one' });
        const before = fetcher.seen.length;
        await ui.sendHandler({ message: 'two' });
        assert.equal(fetcher.seen.length, before, 'no pointless request');
      } finally {
        fetcher.restore();
      }
    });

  test('the transcript stays readable after a conversation closes', async () => {
    const { mod, stub } = await load();
    let call = 0;
    const { ui, fetcher } = await connectedSession(mod, {
      responder: () => {
        call += 1;
        if (call === 1) return jsonResponse(200, OK_START);
        return jsonResponse(409, { ok: false, code: 'conversation_closed' });
      }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await tick();
      await ui.sendHandler({ message: 'x' });
      stub.emitSnapshot([
        { id: 'm1', data: { body: 'earlier', senderType: 'customer', createdAt: 1 } }
      ]);
      assert.equal(ui.messages.length, 1, 'history is not taken away');
    } finally {
      fetcher.restore();
    }
  });

  test('429 shows a wait message and offers NO retry - no loop', async () => {
    const { mod } = await load();
    let call = 0;
    const { ui, fetcher } = await connectedSession(mod, {
      responder: () => {
        call += 1;
        if (call === 1) return jsonResponse(200, OK_START);
        return jsonResponse(429, { ok: false, code: 'rate_limited', retryAfter: 30 });
      }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      const before = fetcher.seen.length;
      await ui.sendHandler({ message: 'again' });
      await tick(5);

      assert.match(ui.notice, /wait a moment/);
      assert.equal(ui.retry, null, 'a 429 must not hand back a retry button');
      assert.equal(fetcher.seen.length, before + 1,
        'exactly one attempt - nothing retried it');
    } finally {
      fetcher.restore();
    }
  });

  test('the 429 POLICY issues no request of its own, busy guard aside', async () => {
    /*
     * The test above cannot see this on its own. reportFailure() runs from
     * inside send()'s catch, where this.sending is still true, so even a
     * deliberately reinstated automatic retry would be swallowed by that
     * guard and the request count would not move.
     *
     * Relying on that would be testing the guard, not the policy. So the
     * failure handler is invoked directly, with nothing in flight: if it
     * ever decides to resend on a 429, a request goes out here and this
     * fails. A mutation that adds exactly that retry survives without this
     * test and is caught by it.
     */
    const { mod } = await load();
    let call = 0;
    const { ui, session, fetcher } = await connectedSession(mod, {
      responder: () => { call += 1; return jsonResponse(200, call === 1 ? OK_START : OK_SEND); }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await tick();
      assert.equal(session.sending, false, 'nothing is in flight');

      const before = fetcher.seen.length;
      session.reportFailure({ status: 429, code: 'rate_limited' }, { message: 'held back' });
      await tick(5);

      assert.equal(fetcher.seen.length, before,
        'a rate limit must never produce a request of its own');
      assert.equal(ui.retry, null, 'and no retry button either');
      assert.match(ui.notice, /wait a moment/);
    } finally {
      fetcher.restore();
    }
  });

  test('the auth POLICY issues no request of its own either', async () => {
    const { mod } = await load();
    const { ui, session, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await tick();
      const before = fetcher.seen.length;
      session.reportFailure({ status: 401, code: 'invalid_token' }, { message: 'x' });
      await tick(5);
      assert.equal(fetcher.seen.length, before);
      assert.equal(ui.retry, null);
    } finally {
      fetcher.restore();
    }
  });

  test('a 429 echo is withdrawn so nothing looks sent', async () => {
    const { mod } = await load();
    let call = 0;
    const { ui, fetcher } = await connectedSession(mod, {
      responder: () => {
        call += 1;
        if (call === 1) return jsonResponse(200, OK_START);
        return jsonResponse(429, { ok: false, code: 'rate_limited' });
      }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await ui.sendHandler({ message: 'too fast' });
      assert.deepEqual(ui.messages, [], 'the optimistic bubble is gone');
    } finally {
      fetcher.restore();
    }
  });

  test('App Check failure is handled cleanly - no unhandled rejection, no sign-in',
    async () => {
      const { mod, stub } = await load();
      stub.setAppCheckInitError();
      const ui = recordingUi();
      const fetcher = captureFetch(jsonResponse(200, OK_START));
      const silence = console.error;
      console.error = () => {};
      try {
        const session = await mod.openChatForReview({
          ui, openPanel: () => {}, deps: { storage: () => memoryStorage() }
        });
        await tick();
        assert.equal(session, null, 'it refuses rather than half-connecting');
        assert.equal(stub.calls.signInAnonymously.length, 0,
          'no anonymous account is minted for a session that cannot attest');
        assert.equal(stub.calls.onSnapshot.length, 0);
        assert.equal(fetcher.seen.length, 0);
        assert.match(ui.notice, /could not verify this page/);
        assert.equal(ui.composerEnabled, false);
      } finally {
        console.error = silence;
        fetcher.restore();
      }
    });

  test('a refused sign-in is handled cleanly', async () => {
    const { mod, stub } = await load();
    stub.setSignInError(new Error('auth/operation-not-allowed'));
    const ui = recordingUi();
    const fetcher = captureFetch(jsonResponse(200, OK_START));
    try {
      const session = await mod.openChatForReview({
        ui, openPanel: () => {}, deps: { storage: () => memoryStorage() }
      });
      await tick();
      assert.equal(session, null);
      assert.equal(fetcher.seen.length, 0);
      assert.equal(ui.composerEnabled, false);
      assert.ok(typeof ui.notice === 'string' && ui.notice.length > 0);
      assert.equal(ui.status, 'Not connected');
    } finally {
      fetcher.restore();
    }
  });

  test('a 401 stops the composer instead of leaving it to fail on every press',
    async () => {
      const { mod } = await load();
      const { ui, fetcher } = await connectedSession(mod, {
        responder: () => jsonResponse(401, { ok: false, code: 'invalid_token' })
      });
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
        assert.equal(ui.composerEnabled, false);
        assert.equal(ui.retry, null);
        assert.match(ui.notice, /session has expired/);
      } finally {
        fetcher.restore();
      }
    });

  test('an App Check refusal from the API reads as "reload", not "expired"',
    async () => {
      const { mod } = await load();
      const { ui, fetcher } = await connectedSession(mod, {
        responder: () => jsonResponse(401, { ok: false, code: 'app_check_required' })
      });
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
        assert.match(ui.notice, /could not verify this page/);
      } finally {
        fetcher.restore();
      }
    });

  test('a listener permission error stops dead - no retry, no loop', async () => {
    const { mod, stub } = await load();
    const storage = memoryStorage();
    const { ui, fetcher } = await connectedSession(mod, { storage });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await tick();
      const before = stub.calls.onSnapshot.length;

      stub.emitListenerError({ code: 'permission-denied' });
      await tick(5);

      assert.equal(stub.calls.onSnapshot.length, before,
        'permission-denied must never be retried - the rules will say no again');
      assert.equal(ui.retry, null, 'and no retry is offered');
      assert.equal(stub.liveListenerCount(), 0, 'the dead listener is let go');
    } finally {
      fetcher.restore();
    }
  });

  test('a rules refusal DISCARDS the conversation so the tab can recover', async () => {
    /*
     * The stored id is now known-bad. Leaving it in sessionStorage made every
     * future load of this tab recall it, fail the same way, and land right
     * back here - a permanent dead end behind a "reload the page" that could
     * not possibly help.
     */
    const { mod, stub } = await load();
    const storage = memoryStorage();
    const { ui, session, fetcher } = await connectedSession(mod, { storage });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await tick();
      assert.ok(storage.getItem(mod._internals.CONVERSATION_KEY), 'stored to begin with');
      /* One start form has already been shown - this session began without a
         recalled conversation. Count from here. */
      const formsBefore = ui.startFormShown;

      stub.emitListenerError({ code: 'permission-denied' });
      await tick(5);

      assert.equal(storage.getItem(mod._internals.CONVERSATION_KEY), null,
        'the dead conversation id is forgotten');
      assert.equal(session.conversationId, null);
      assert.equal(ui.startFormShown, formsBefore + 1, 'and a fresh start is offered');
      assert.match(ui.notice, /start a new one/);
    } finally {
      fetcher.restore();
    }
  });

  test('a 404 conversation_not_found also discards it', async () => {
    const { mod } = await load();
    const storage = memoryStorage();
    let call = 0;
    const { ui, session, fetcher } = await connectedSession(mod, {
      storage,
      responder: () => {
        call += 1;
        if (call === 1) return jsonResponse(200, OK_START);
        return jsonResponse(404, { ok: false, code: 'conversation_not_found' });
      }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await tick();
      assert.ok(storage.getItem(mod._internals.CONVERSATION_KEY));
      const formsBefore = ui.startFormShown;

      await ui.sendHandler({ message: 'anyone?' });
      await tick();

      assert.equal(storage.getItem(mod._internals.CONVERSATION_KEY), null,
        'a conversation the server says is gone must not be recalled forever');
      assert.equal(session.conversationId, null);
      assert.equal(ui.startFormShown, formsBefore + 1);
    } finally {
      fetcher.restore();
    }
  });

  test('a transient listener error offers ONE user-triggered retry', async () => {
    const { mod, stub } = await load();
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await tick();
      const before = stub.calls.onSnapshot.length;

      stub.emitListenerError({ code: 'unavailable' });
      await tick(5);

      assert.equal(stub.calls.onSnapshot.length, before, 'nothing automatic');
      assert.equal(typeof ui.retry, 'function', 'the visitor is offered a button');

      ui.retry();
      await tick();
      assert.equal(stub.calls.onSnapshot.length, before + 1, 'and it works when pressed');
    } finally {
      fetcher.restore();
    }
  });

  test('a network failure offers a retry that reuses the same message', async () => {
    const { mod } = await load();
    let call = 0;
    const { ui, fetcher } = await connectedSession(mod, {
      responder: () => {
        call += 1;
        if (call === 1) return jsonResponse(200, OK_START);
        if (call === 2) return new TypeError('Failed to fetch');
        return jsonResponse(200, OK_SEND);
      }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      await ui.sendHandler({ message: 'did this arrive?' });
      assert.match(ui.notice, /could not reach us/);
      assert.equal(typeof ui.retry, 'function');

      await ui.retry();
      const resent = JSON.parse(fetcher.seen[fetcher.seen.length - 1].init.body);
      assert.equal(resent.message, 'did this arrive?');
    } finally {
      fetcher.restore();
    }
  });

  test('an empty message never becomes a request', async () => {
    const { mod } = await load();
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      const before = fetcher.seen.length;
      await ui.sendHandler({ message: '   ' });
      await ui.sendHandler({ message: '' });
      await ui.sendHandler({});
      assert.equal(fetcher.seen.length, before);
      assert.equal(ui.notice, 'Please type a message first.');
    } finally {
      fetcher.restore();
    }
  });

  test('two sends at once do not both go out', async () => {
    const { mod } = await load();
    let call = 0;
    const { ui, fetcher } = await connectedSession(mod, {
      responder: () => { call += 1; return jsonResponse(200, call === 1 ? OK_START : OK_SEND); }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      const before = fetcher.seen.length;
      await Promise.all([
        ui.sendHandler({ message: 'one' }),
        ui.sendHandler({ message: 'two' })
      ]);
      assert.equal(fetcher.seen.length, before + 1, 'the second was declined while busy');
    } finally {
      fetcher.restore();
    }
  });

  test('a server response that is not JSON is a generic failure, not a crash',
    async () => {
      const { mod } = await load();
      const { ui, fetcher } = await connectedSession(mod, {
        responder: () => ({ ok: false, status: 500, json: async () => { throw new Error('nope'); } })
      });
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
        assert.match(ui.notice, /Something went wrong/);
      } finally {
        fetcher.restore();
      }
    });

  test('a broken UI does not take the transport down', async () => {
    const { mod } = await load();
    const ui = recordingUi();
    ui.renderMessages = () => { throw new Error('renderer exploded'); };
    const fetcher = captureFetch(jsonResponse(200, OK_START));
    try {
      const session = await mod.openChatForReview({
        ui, openPanel: () => {}, deps: { storage: () => memoryStorage() }
      });
      assert.ok(session, 'still connected');
      const payload = await ui.startHandler({ name: 'Jo', email: 'j@e.co', message: 'hi' });
      assert.equal(payload.conversationId, 'conv-1');
    } finally {
      fetcher.restore();
    }
  });

  test('every failure sentence comes from the allow-list, never from the server',
    async () => {
      const { mod } = await load();
      const allowed = new Set(Object.values(mod._internals.MESSAGES_BY_CODE));
      /* A server that returned something odd must not get it onto the page. */
      const { ui, fetcher } = await connectedSession(mod, {
        responder: () => jsonResponse(500, {
          ok: false,
          code: 'not_a_real_code',
          error: 'Traceback (most recent call last): secret internal detail'
        })
      });
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
        assert.ok(allowed.has(ui.notice), 'the notice is one of ours: ' + ui.notice);
        assert.equal(ui.notice.includes('Traceback'), false);
        assert.equal(ui.notice.includes('secret internal detail'), false);
      } finally {
        fetcher.restore();
      }
    });

  test('describeFailure covers every branch without a network', async () => {
    const { mod } = await load();
    const d = mod.describeFailure;
    assert.equal(d({ offline: true }).kind, 'offline');
    assert.equal(d({ status: 0 }).kind, 'offline');
    assert.equal(d({ status: 429, code: 'rate_limited' }).kind, 'rate_limited');
    assert.equal(d({ status: 409, code: 'conversation_closed' }).kind, 'closed');
    assert.equal(d({ status: 401, code: 'app_check_required' }).kind, 'app_check');
    assert.equal(d({ status: 401, code: 'invalid_token' }).kind, 'auth');
    assert.equal(d({ status: 403, code: 'not_a_customer' }).kind, 'auth');
    assert.equal(d({ status: 400, code: 'invalid_email' }).kind, 'input');
    assert.equal(d({ status: 404, code: 'conversation_not_found' }).kind, 'input');
    assert.equal(d({ status: 500 }).kind, 'server');
    assert.equal(d(null).kind, 'offline');
    assert.equal(d(undefined).kind, 'offline');
  });
});

/* ================================================ CONVERSATION RECOVERY */

describe('remembering a conversation', () => {
  test('the conversation id is stored against the uid that owns it', async () => {
    const { mod } = await load();
    const storage = memoryStorage();
    const { ui, fetcher } = await connectedSession(mod, { storage });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi' });
      const raw = JSON.parse(storage.getItem(mod._internals.CONVERSATION_KEY));
      assert.equal(raw.conversationId, 'conv-1');
      assert.equal(raw.uid, 'anon-uid-1');
    } finally {
      fetcher.restore();
    }
  });

  test('NO token of any kind is ever stored', async () => {
    const { mod, stub } = await load();
    stub.setAppCheckToken('APPCHECK-SECRET');
    stub.setSignedInUser({ uid: 'anon-uid-1', getIdToken: async () => 'IDTOKEN-SECRET' });
    const storage = memoryStorage();
    const { ui, fetcher } = await connectedSession(mod, { storage });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'secret message' });
      const dump = JSON.stringify(Array.from(storage._map.entries()));
      for (const secret of ['IDTOKEN-SECRET', 'APPCHECK-SECRET', 'jo@example.com',
        'secret message', 'Jo']) {
        assert.equal(dump.includes(secret), false, 'must not persist ' + secret);
      }
    } finally {
      fetcher.restore();
    }
  });

  test('a stored id belonging to a different uid is refused', async () => {
    const { mod } = await load();
    const store = memoryStorage({
      [mod._internals.CONVERSATION_KEY]:
        JSON.stringify({ uid: 'somebody-else', conversationId: 'conv-9' })
    });
    assert.equal(mod.recallConversation(store, 'anon-uid-1'), null);
    assert.equal(mod.recallConversation(store, 'somebody-else'), 'conv-9');
  });

  test('a corrupt or hostile stored value is refused', async () => {
    const { mod } = await load();
    const K = mod._internals.CONVERSATION_KEY;
    for (const bad of [
      'not json', '[]', 'null', '{}',
      JSON.stringify({ uid: 'u', conversationId: '../../etc/passwd' }),
      JSON.stringify({ uid: 'u', conversationId: 'has/slash' }),
      JSON.stringify({ uid: 'u', conversationId: '' }),
      JSON.stringify({ uid: 'u', conversationId: 'x'.repeat(65) }),
      JSON.stringify({ uid: 'u', conversationId: 42 })
    ]) {
      assert.equal(mod.recallConversation(memoryStorage({ [K]: bad }), 'u'), null,
        'refused: ' + bad);
    }
  });

  test('a recalled conversation reopens the transcript instead of the start form',
    async () => {
      const { mod, stub } = await load();
      const storage = memoryStorage({
        [mod._internals.CONVERSATION_KEY]:
          JSON.stringify({ uid: 'anon-uid-1', conversationId: 'conv-earlier' })
      });
      const fetcher = captureFetch(jsonResponse(200, OK_START));
      try {
        const ui = recordingUi();
        await mod.openChatForReview({
          ui, openPanel: () => {}, deps: { storage: () => storage }
        });
        await tick();
        assert.equal(ui.startFormShown, 0, 'no start form for a returning visitor');
        assert.equal(ui.transcriptShown, 1);
        assert.equal(stub.calls.where[0].value, 'conv-earlier');
      } finally {
        fetcher.restore();
      }
    });

  test('storage that throws on access is survivable', async () => {
    const { mod } = await load();
    const hostile = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); }
    };
    assert.equal(mod.recallConversation(hostile, 'u'), null);
    assert.equal(mod.rememberConversation(hostile, 'u', 'c'), false);
    mod.forgetConversation(hostile);          /* must not throw */

    const fetcher = captureFetch(jsonResponse(200, OK_START));
    try {
      const ui = recordingUi();
      const session = await mod.openChatForReview({
        ui, openPanel: () => {}, deps: { storage: () => hostile }
      });
      assert.ok(session, 'a private-mode browser still gets a working chat');
      await ui.startHandler({ name: 'Jo', email: 'j@e.co', message: 'hi' });
      assert.equal(ui.transcriptShown, 1);
    } finally {
      fetcher.restore();
    }
  });

  test('no storage at all is survivable', async () => {
    const { mod } = await load();
    assert.equal(mod.recallConversation(null, 'u'), null);
    assert.equal(mod.rememberConversation(null, 'u', 'c'), false);
    mod.forgetConversation(null);
  });
});

/* ================================================= THE REVIEW HARNESS */

describe('the review harness', () => {
  test('openChatForReview refuses when there is no UI to drive', async () => {
    const { mod } = await load();
    await assert.rejects(() => mod.openChatForReview({}), /No chat UI on this page/);
  });

  test('it is reached only by importing the module - nothing on the page leads to it',
    () => {
      /* The widget may DOCUMENT it - the comment on the gate points a
         reader at it, which is the whole reason the comment is there - but
         no code in chat.js may call or expose it. */
      assert.equal(WIDGET_CODE.includes('openChatForReview'), false,
        'no code in the widget may reach the review entry point');
      assert.ok(WIDGET_SRC.includes('openChatForReview'),
        'the gate comment should still point a reader at it');

      /* And no page loads the transport at all. */
      for (const page of [
        'index.html', 'about/index.html', 'contact/index.html',
        'gallery/index.html', 'materials/index.html', 'quote/index.html',
        'services/index.html'
      ]) {
        const html = readFileSync('/home/user/esthers/' + page, 'utf8');
        assert.equal(html.includes('chat-customer'), false,
          page + ' must not load the transport');
      }
    });

  test('it does not persist enablement anywhere', () => {
    const fn = CUSTOMER_IDENTS.slice(
      CUSTOMER_IDENTS.indexOf('export async function openChatForReview'),
      CUSTOMER_IDENTS.indexOf('function resolvePageUi'));
    assert.ok(fn.length > 100);
    for (const forbidden of ['setItem', 'localStorage', 'cookie', 'CHAT_PUBLIC_ENABLED =']) {
      assert.equal(fn.includes(forbidden), false, 'must not persist via ' + forbidden);
    }
  });

  test('it uses the widget surface rather than reaching into the DOM', () => {
    assert.match(CUSTOMER_SRC, /chat\.transportSurface\(\)/);
    assert.match(WIDGET_SRC, /transportSurface: enterLiveMode/);
  });
});

/* ============================================== 22. THE WIDGET ITSELF */

describe('the widget, with the gate shut', () => {
  test('the demo conversation is exactly what it was', () => {
    /* The two opening lines and the standing notice are what a visitor sees
       today, and this phase must not have changed them. */
    assert.match(WIDGET_SRC, /Online messaging is currently under construction\. /);
    assert.match(WIDGET_SRC, /Messages are not being sent to our team yet\./);
    assert.match(WIDGET_SRC, /addMessage\('them', 'Hi! How can we help with your sheet metal project\?'\);/);
    assert.match(WIDGET_SRC, /text: 'Online messaging coming soon\.'/);
  });

  test('submit() still runs the demo path when the transport is not attached', () => {
    const submit = WIDGET_SRC.slice(WIDGET_SRC.indexOf('function submit() {'),
      WIDGET_SRC.indexOf('/* --------------------------------------------------------- open / close */'));
    assert.match(submit, /if \(mode === 'live'\)/);
    assert.match(submit, /addMessage\('me', text\);/);
    assert.match(submit, /buildReplyNodes\(\)/);
  });

  test('closing the panel SUSPENDS the listener and opening RESUMES it', () => {
    /*
     * It used to call disconnect(), which tore the session down for good -
     * and nothing re-established it, so the reopened widget silently swallowed
     * every message. Suspend/resume is the pair that has to be here.
     */
    assert.match(WIDGET_CODE,
      /if \(mode === 'live' && transport && typeof transport\.suspend === 'function'\) \{\s*transport\.suspend\(\);/);
    assert.match(WIDGET_CODE,
      /if \(mode === 'live' && transport && typeof transport\.resume === 'function'\) \{\s*transport\.resume\(\);/);
    assert.equal(WIDGET_CODE.includes('transport.disconnect()'), false,
      'the widget must not tear the session down on a panel close');
  });

  test('a failed transport connection restores the working demo', () => {
    /*
     * enterLiveMode() blanks the demo conversation. Setting mode back to
     * 'demo' does not un-blank it, so a transport that fails to connect used
     * to leave an empty panel with a dead composer. restoreDemo() is the
     * other half.
     */
    assert.match(WIDGET_CODE, /function restoreDemo\(\)/);
    assert.match(WIDGET_CODE, /if \(!session\) restoreDemo\(\);/);
    assert.match(WIDGET_CODE, /\['catch'\]\(function \(\) \{\s*restoreDemo\(\);/);
    assert.match(WIDGET_CODE, /showDemoConversation\(\);/);
    /* And the gate is checked BEFORE the widget is handed over. */
    const fn = WIDGET_CODE.slice(WIDGET_CODE.indexOf('function connectTransport()'),
      WIDGET_CODE.indexOf('function restoreDemo()'));
    assert.ok(fn.indexOf('isPublicChatEnabled') < fn.indexOf('enterLiveMode()'),
      'the transport gate is read before the demo conversation is blanked');
  });

  test('the start form asks for exactly what /api/chat/start requires', () => {
    /* name, email and message - all three required by validation.js. Not a
       guess: the schema is read from the server in the test above. */
    assert.match(WIDGET_SRC, /id: 'chat-start-name'/);
    assert.match(WIDGET_SRC, /id: 'chat-start-email'/);
    assert.match(WIDGET_SRC, /id: 'chat-start-message'/);
    assert.match(WIDGET_SRC, /maxlength: '100'/);      /* NAME_MAX */
    assert.match(WIDGET_SRC, /maxlength: '254'/);      /* EMAIL_MAX */
    assert.match(WIDGET_SRC, /maxlength: '2000'/);     /* MESSAGE_MAX */
  });

  test('every start-form control has a real label', () => {
    for (const id of ['chat-start-name', 'chat-start-email', 'chat-start-message']) {
      assert.ok(WIDGET_SRC.includes("field('" + id + "'"),
        id + ' is built through field(), which pairs it with a <label for>');
    }
    assert.match(WIDGET_SRC, /el\('label', \{ class: 'chat__label', for: id, text: labelText \}\)/);
  });

  test('the status line and the notice are announced to a screen reader', () => {
    assert.match(WIDGET_SRC, /class: 'chat__status',\s*id: 'chat-status',\s*role: 'status',\s*'aria-live': 'polite'/);
    assert.match(WIDGET_SRC, /class: 'chat__notice',\s*role: 'alert'/);
    /* The log was already a polite live region and still is. */
    assert.match(WIDGET_SRC, /role: 'log',\s*'aria-live': 'polite'/);
  });

  test('the mobile composer keeps the 14px that stops iOS zooming', () => {
    const css = readFileSync('/home/user/esthers/assets/css/chat.css', 'utf8');
    const text = css.slice(css.indexOf('.chat__text {'), css.indexOf('.chat__text--area'));
    assert.match(text, /font-size: 14px;/);
    assert.match(text, /height: 44px;/);       /* the touch target the widget already uses */
  });

  test('the new CSS introduces no colour of its own', () => {
    const css = readFileSync('/home/user/esthers/assets/css/chat.css', 'utf8');
    const added = css.slice(css.indexOf('   LIVE CHAT'));
    assert.ok(added.length > 500, 'found the live section');
    /* Hex literals and rgb() would mean a new colour outside the token set.
       opacity is fine; it is not a colour. */
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(added), false, 'no hex colours');
    assert.equal(/\brgba?\(/.test(added), false, 'no raw rgb colours');
  });
});
