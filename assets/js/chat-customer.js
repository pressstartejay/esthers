/* =========================================================================
 * Esther's - the customer half of chat: identity, transport and transcript.
 *
 * ####################################################################
 * ##                                                                ##
 * ##  PUBLIC CHAT IS OFF. CHAT_PUBLIC_ENABLED is false below, and   ##
 * ##  nothing in this file runs until something imports it. No page ##
 * ##  imports it. Ordinary visitors still see the mascot saying     ##
 * ##  "Online messaging coming soon."                               ##
 * ##                                                                ##
 * ##  It exists so the real flow can be reviewed, and exercised by  ##
 * ##  hand from DevTools on esthers.ca, before it is switched on.   ##
 * ##  See openChatForReview() at the foot of this file.             ##
 * ##                                                                ##
 * ####################################################################
 *
 * WHAT THIS FILE IS
 *
 * chat.js owns the widget: the mascot, the panel, dragging, focus, the CSS
 * classes. This file owns everything the widget cannot see - who the visitor
 * is, how a message reaches Esther's, and how a reply comes back. The two
 * meet at a small interface (the `ui` object, documented under THE UI
 * CONTRACT below) so that neither has to know how the other works, and so
 * every rule in here can be tested without a browser.
 *
 * THE SHAPE OF THE SYSTEM, AND WHY IT IS ASYMMETRIC
 *
 *   customer WRITE  ->  POST /api/chat/{start,send}  ->  Admin SDK -> Firestore
 *   customer READ   ->  onSnapshot() straight at Firestore, no server involved
 *
 * Writes go through the API because that is where authorisation, validation,
 * rate limiting and idempotency live, and because a browser must never be
 * able to write a transcript. Reads go direct because a realtime transcript
 * is what a chat IS, and polling an API for it would be slower, chattier and
 * worse in every way. The asymmetry is the design, not an inconsistency.
 *
 * The customer therefore CANNOT write to Firestore - firestore.rules denies
 * create, update and delete outright - and this file imports no Firestore
 * write function at all. That absence is asserted by test.
 *
 * INITIALISATION ORDER IS A SECURITY PROPERTY
 *
 *   1. App Check      attest that this is the real site
 *   2. Firebase app   the one shared instance, from chat-app-check.js
 *   3. anonymous auth prove who (well: which browser) is asking
 *   4. API + listener the actual work
 *
 * App Check comes first and the order is not negotiable. Firebase
 * Authentication App Check enforcement is OFF today and will be turned ON;
 * on that day, a signInAnonymously() issued before attestation is a request
 * Google refuses. Writing the order correctly now means that switch is a
 * console setting rather than a code change made under pressure.
 *
 * Plain ES module on the site's no-build architecture, and the same pinned
 * Firebase SDK version as chat-app-check.js - imported from it rather than
 * repeated, so the two can never drift apart.
 * ========================================================================= */

import {
  SDK_VERSION,
  getFirebaseApp,
  initAppCheck,
  authorizedFetch
} from './chat-app-check.js';

/* -------------------------------------------------------------------------
 * THE ROLLOUT GATE
 *
 * False, and it must stay false until the launch checklist in
 * docs/CHAT_APP_CHECK.md is finished. While it is false:
 *
 *   - no Firebase Auth session is created
 *   - no reCAPTCHA challenge is issued
 *   - no request is made to /api/chat/*
 *   - no Firestore listener is opened
 *
 * A source constant on purpose. It cannot be flipped by a query string, a
 * cookie, a localStorage key or anything else a visitor can reach - turning
 * chat on is a commit, a review and a deploy, which is the correct weight for
 * the decision. connect() refuses when it is false; the ONLY other way in is
 * openChatForReview(), which a person has to type into a console.
 * ---------------------------------------------------------------------- */
export const CHAT_PUBLIC_ENABLED = false;

export function isPublicChatEnabled() {
  return CHAT_PUBLIC_ENABLED === true;
}

/* ------------------------------------------------------------------ SDK */

/* Same version as chat-app-check.js, taken FROM it. Two independently
   pinned copies of the Firebase SDK on one page is two copies of a large
   library and, worse, two incompatible ideas of what an app instance is. */
const SDK_AUTH = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/firebase-auth.js';
const SDK_FIRESTORE = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/firebase-firestore.js';

/* ------------------------------------------------------------ constants */

const MESSAGES_COLLECTION = 'chatMessages';

/*
 * The transcript ceiling. It is not a nicety: firestore.rules REFUSES a
 * listener that supplies no limit, and refuses one above 200 -
 * maxMessageQuery() there. A query without .limit() is denied outright, so
 * this constant is load-bearing rather than defensive.
 */
const TRANSCRIPT_LIMIT = 200;

const API_START = '/api/chat/start';
const API_SEND = '/api/chat/send';

/* Where a recovered conversation id is remembered. Per TAB, deliberately:
   see rememberConversation() for why this is sessionStorage and not
   localStorage, and for what is NOT stored here. */
const CONVERSATION_KEY = 'esthers.chat.conversation';

/*
 * The separator in the two server-side hashes, reproduced exactly.
 * service.js joins with a NUL because neither a uid nor a UUID can contain
 * one, which makes the concatenation unambiguous. Written as an escape so no
 * literal control character sits in this source file.
 */
const NUL = '\u0000';

/* ------------------------------------------------------- what a person reads
 *
 * EVERY customer-facing sentence is in this table, and the only way to
 * produce one is to look up an allow-listed code. The server's own `error`
 * string is deliberately NOT displayed, even though it is written for a
 * person: echoing a server-supplied string into the page is a habit that
 * works right up until the day some error path returns something it should
 * not have. Unknown code, unknown status, no response at all - they all land
 * on the same generic sentence.
 * ---------------------------------------------------------------------- */

const GENERIC = 'Something went wrong at our end. Please try again in a moment.';
const RELOAD = 'We could not verify this page. Please reload and try again.';
const EXPIRED = 'Your session has expired. Please reload the page.';
const OFFLINE = 'We could not reach us just now. Check your connection and try again.';
const BUSY = 'You have sent a lot of messages just now. Please wait a moment before sending another.';
const UNAVAILABLE = 'Messaging is unavailable right now. Please call us or use the Quote Request form.';

/*
 * A lookup that cannot be walked into the prototype chain.
 *
 * `code` comes off a JSON response, so it can be any string a server - or
 * anything pretending to be one - chooses to send. MESSAGES_BY_CODE[code]
 * with code = 'constructor' or 'toString' returns a FUNCTION, and that
 * function would have been handed to the UI as the sentence to display. The
 * table promises every customer-facing string is allow-listed; an own-property
 * check is what makes that true rather than nearly true.
 */
function messageForCode(code) {
  if (typeof code !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(MESSAGES_BY_CODE, code)) return null;
  const text = MESSAGES_BY_CODE[code];
  return typeof text === 'string' ? text : null;
}

const MESSAGES_BY_CODE = {
  /* App identity - the page could not prove it is ours. */
  app_check_required: RELOAD,
  app_check_invalid: RELOAD,
  app_check_unavailable: RELOAD,

  /* Session. */
  missing_authorization: EXPIRED,
  bad_authorization: EXPIRED,
  invalid_token: EXPIRED,
  not_a_customer: RELOAD,
  /* A staff Email/Password session is signed in on this browser. Firebase
     allows one user per app, so customer chat cannot open a session without
     ending theirs. Said plainly rather than as a mystifying "reload". */
  staff_session_active: 'You are signed in to the staff inbox in this browser, '
    + 'so customer chat cannot start here. Please use a private window.',

  /* The visitor's own input. These are the only ones a person can act on,
     so they are the only ones that say anything specific. */
  invalid_name: 'Please give us a name we can use.',
  invalid_email: 'Please give us an email address we can reply to.',
  empty_message: 'Please type a message first.',
  invalid_message: 'That message contains characters we cannot send.',
  message_too_long: 'That message is too long. Please shorten it a little.',
  forbidden_field: GENERIC,
  invalid_client_message_id: GENERIC,
  invalid_conversation_id: 'We could not find that conversation. Please start a new one.',

  /* Conversation state. */
  conversation_not_found: 'We could not find that conversation. Please start a new one.',
  conversation_closed: 'This conversation has been closed.',
  idempotency_conflict: GENERIC,

  /* Pace. */
  rate_limited: BUSY,

  /* Ours. */
  service_unavailable: GENERIC,
  server_error: GENERIC
};

/*
 * Turn a failure into { code, text, kind } and nothing else.
 *
 * `kind` is what the caller branches on; `text` is what a person reads.
 * Pure, so the whole table is testable without a network.
 */
export function describeFailure(failure) {
  const f = failure || {};
  const status = typeof f.status === 'number' ? f.status : 0;
  const code = typeof f.code === 'string' ? f.code : '';

  if (f.offline === true || status === 0) {
    return { code: 'offline', text: OFFLINE, kind: 'offline' };
  }
  if (status === 429) {
    return { code: 'rate_limited', text: BUSY, kind: 'rate_limited' };
  }
  if (code === 'conversation_closed') {
    return { code: code, text: messageForCode(code), kind: 'closed' };
  }
  if (code.indexOf('app_check') === 0) {
    return { code: code, text: RELOAD, kind: 'app_check' };
  }
  if (status === 401 || status === 403) {
    return {
      code: code || 'invalid_token',
      text: messageForCode(code) || EXPIRED,
      kind: 'auth'
    };
  }
  if (status === 400 || status === 404 || status === 409) {
    return {
      code: code || 'server_error',
      text: messageForCode(code) || GENERIC,
      kind: 'input'
    };
  }
  return { code: code || 'server_error', text: messageForCode(code) || GENERIC, kind: 'server' };
}

/* An API refusal, carrying only what describeFailure() is allowed to read. */
class ChatApiError extends Error {
  constructor(status, code, retryAfter) {
    super('chat api ' + status);
    this.name = 'ChatApiError';
    this.status = status;
    this.code = typeof code === 'string' ? code : '';
    this.retryAfter = typeof retryAfter === 'number' ? retryAfter : null;
  }
}

/* A request that never reached a server. Distinct from a 500: the visitor
   can usefully retry this one, and telling them so is the difference between
   "try again" and "we are broken". */
class ChatNetworkError extends Error {
  constructor() {
    super('chat network');
    this.name = 'ChatNetworkError';
    this.status = 0;
    this.offline = true;
  }
}

/* ------------------------------------------------------------ identifiers */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/*
 * The idempotency key for one outbound message.
 *
 * randomUUID() where it exists, and a getRandomValues() version 4 otherwise -
 * randomUUID needs a secure context, and while esthers.ca is https, a module
 * that throws on an older browser instead of degrading is a module that
 * chooses to be broken. Both paths produce something validation.js accepts;
 * a test checks the fallback against the server's own regular expression.
 */
export function newClientMessageId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    const id = c.randomUUID();
    if (UUID_RE.test(id)) return id;
  }
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;          /* version 4 */
    b[8] = (b[8] & 0x3f) | 0x80;          /* variant 10xx */
    const hex = [];
    for (let i = 0; i < 16; i++) hex.push(b[i].toString(16).padStart(2, '0'));
    return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-'
      + hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-'
      + hex.slice(10, 16).join('');
  }
  throw new Error('no source of randomness');
}

/*
 * The document id the server WILL give this message.
 *
 * service.js derives it as sha256(conversationId + NUL + clientMessageId)
 * truncated to 40 hex characters, and that is reproduced exactly here -
 * separator included, which is why NUL is a named constant rather than a
 * character typed twice in two files.
 *
 * It is what makes an optimistic echo safe: the message we put on screen the
 * instant Send is pressed carries the same id as the document the listener
 * delivers a moment later, so the merge in TranscriptStore replaces it rather
 * than showing the visitor their own sentence twice.
 *
 * Returns null when SubtleCrypto is unavailable. The caller then simply does
 * not echo, and the message appears when the listener delivers it - slower,
 * still correct, never duplicated.
 */
export async function deriveMessageId(conversationId, clientMessageId) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle || typeof subtle.digest !== 'function') return null;
  const encoded = new TextEncoder().encode(conversationId + NUL + clientMessageId);
  let digest;
  try {
    digest = await subtle.digest('SHA-256', encoded);
  } catch (err) {
    return null;
  }
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex.slice(0, 40);
}

/* ------------------------------------------------------- transcript store
 *
 * Pure, and separate from anything that draws. It holds the messages the
 * listener has delivered plus any still in flight, keyed by id, and answers
 * one question: what should be on screen, in what order?
 * ---------------------------------------------------------------------- */

export class TranscriptStore {
  constructor() {
    this.byId = new Map();
  }

  /*
   * Replace everything with what the listener just delivered.
   *
   * A Firestore snapshot is the WHOLE result set, not a delta, so replacing
   * is correct and is also what stops a duplicate: a message that arrives
   * twice in two snapshots is one entry in the map both times.
   *
   * Pending messages are carried across, minus any the snapshot now
   * contains - that is the optimistic echo being retired by the real thing.
   */
  applySnapshot(docs) {
    const pending = [];
    for (const m of this.byId.values()) if (m.pending) pending.push(m);
    this.byId = new Map();
    for (const doc of docs || []) {
      const m = normaliseMessage(doc);
      if (m) this.byId.set(m.id, m);
    }
    for (const p of pending) if (!this.byId.has(p.id)) this.byId.set(p.id, p);
    return this.list();
  }

  /* An optimistic echo. Same id the server will use, so it is replaced
     rather than joined by the delivered document. */
  addPending(message) {
    const m = normaliseMessage(message);
    if (!m || !m.id) return this.list();
    m.pending = true;
    this.byId.set(m.id, m);
    return this.list();
  }

  /* A send that failed for good. Take the echo back off the screen rather
     than leaving a message the visitor believes was delivered. */
  dropPending(id) {
    const m = this.byId.get(id);
    if (m && m.pending) this.byId.delete(id);
    return this.list();
  }

  hasPending() {
    for (const m of this.byId.values()) if (m.pending) return true;
    return false;
  }

  clear() {
    this.byId = new Map();
    return this.list();
  }

  /*
   * Deterministic order.
   *
   * createdAt first, then id as the tie-break. The tie-break is not
   * decoration: two messages written in the same millisecond would otherwise
   * swap places between renders, and a transcript that reorders itself while
   * you read it is worse than one that is slightly wrong.
   */
  list() {
    const all = Array.from(this.byId.values());
    all.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
    return all;
  }
}

/*
 * One message, reduced to the four things the transcript may contain.
 *
 * An ALLOW-LIST, not a copy. firestore.rules lets the customer read the
 * whole message document, and the schema promises it holds only
 * conversationId, createdAt, senderType and body - but a promise upstream is
 * not a reason to hand whatever arrives to the renderer. If a field is ever
 * added to that collection it stops here.
 *
 * A malformed document is dropped rather than rendered: null body, missing
 * senderType, a createdAt that is not a time. One bad row must not empty the
 * transcript.
 */
export function normaliseMessage(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const id = typeof doc.id === 'string' && doc.id ? doc.id : null;
  if (!id) return null;

  const data = doc.data && typeof doc.data === 'object' ? doc.data : doc;
  const body = typeof data.body === 'string' ? data.body : null;
  if (body === null) return null;

  const senderType = data.senderType === 'customer' || data.senderType === 'staff'
    || data.senderType === 'system'
    ? data.senderType
    : null;
  if (!senderType) return null;

  return {
    id: id,
    senderType: senderType,
    body: body,
    createdAt: toMillis(data.createdAt),
    pending: false
  };
}

/*
 * Firestore Timestamp, Date, or number, to milliseconds.
 *
 * 0 rather than null for anything unreadable, so sorting stays total. A
 * message with an unreadable time sorts to the top, which is visible and
 * therefore fixable; NaN would poison the comparator and shuffle the whole
 * transcript.
 */
export function toMillis(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return isFinite(value) ? value : 0;
  if (typeof value.toMillis === 'function') {
    const n = value.toMillis();
    return typeof n === 'number' && isFinite(n) ? n : 0;
  }
  if (value instanceof Date) {
    const n = value.getTime();
    return isFinite(n) ? n : 0;
  }
  if (typeof value.seconds === 'number') {
    const ns = typeof value.nanoseconds === 'number' ? value.nanoseconds : 0;
    return value.seconds * 1000 + Math.floor(ns / 1e6);
  }
  return 0;
}

/* --------------------------------------------------------------- storage
 *
 * The conversation id, and NOTHING else.
 *
 * WHAT IS NEVER STORED: the Firebase ID token, the App Check token, the
 * visitor's name, their email, or any message. Tokens are short-lived
 * credentials that belong in memory; the rest is the transcript's business
 * and the transcript lives in Firestore.
 *
 * WHY sessionStorage. The conversation id is not a credential - ownership is
 * checked against the verified uid on every read and write, by the API and
 * again by firestore.rules - so this is convenience, not access. Per-tab is
 * the honest lifetime for that convenience: a reload keeps your thread, a
 * shared or public machine does not hand it to the next person.
 *
 * The stored record carries the uid it belongs to and is refused if that
 * does not match the session actually signed in. Firebase can hand a browser
 * a different anonymous uid - cleared storage, a new profile - and reusing
 * another uid's conversation id would produce a listener the rules deny and
 * a send the API 404s. Checking is cheaper than explaining.
 *
 * Every access is wrapped: private modes and blocked-storage settings throw
 * on read, not only on write.
 * ---------------------------------------------------------------------- */

export function rememberConversation(store, uid, conversationId) {
  if (!store || !uid || !conversationId) return false;
  try {
    store.setItem(CONVERSATION_KEY, JSON.stringify({ uid: uid, conversationId: conversationId }));
    return true;
  } catch (err) {
    return false;
  }
}

export function recallConversation(store, uid) {
  if (!store || !uid) return null;
  let raw;
  try {
    raw = store.getItem(CONVERSATION_KEY);
  } catch (err) {
    return null;
  }
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.uid !== uid) return null;                       /* somebody else's */
  const id = parsed.conversationId;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return id;
}

export function forgetConversation(store) {
  if (!store) return;
  try {
    store.removeItem(CONVERSATION_KEY);
  } catch (err) {
    /* Nothing to do, and nothing worth telling anyone. */
  }
}

/* --------------------------------------------------------------- identity */

/*
 * The steps, in the order the comment at the top of this file insists on.
 * Broken out so a test can assert the order by observing the SDK, rather
 * than by reading the code and hoping.
 */
async function establishIdentity(deps) {
  /* 1. APP CHECK, FIRST, ALWAYS. */
  const appCheck = await deps.initAppCheck();
  if (!appCheck) {
    /*
     * Fail closed, and do it here rather than three calls later.
     *
     * App Check enforcement is already ON for /api/chat/*, so without a
     * token every write is going to be refused anyway. Stopping now means
     * we do not mint an anonymous Firebase account for a session that
     * cannot send anything - an account that would then sit in the project
     * forever, attached to nothing.
     */
    throw new ChatApiError(401, 'app_check_unavailable', null);
  }

  /* 2. THE SHARED APP. Memoised inside chat-app-check.js; this is the same
        instance App Check just attached itself to, never a second one. */
  const app = await deps.getFirebaseApp();
  if (!app) throw new ChatApiError(503, 'service_unavailable', null);

  /* 3. ANONYMOUS AUTH. */
  const authMod = await deps.loadAuth();
  const auth = authMod.getAuth(app);
  const user = await resolveUser(authMod, auth);
  if (!user || typeof user.uid !== 'string' || !user.uid) {
    throw new ChatApiError(401, 'invalid_token', null);
  }

  return { app: app, auth: auth, authMod: authMod, user: user };
}

/*
 * The signed-in anonymous user, reusing one if there already is one.
 *
 * THE WAIT IS THE WHOLE POINT. auth.currentUser is null for a moment after
 * getAuth() even when this browser has a perfectly good persisted anonymous
 * session, because the SDK restores it asynchronously. Calling
 * signInAnonymously() during that moment does not fail - it succeeds, and
 * mints a SECOND anonymous account. The visitor loses their conversation
 * (the old uid owned it), Esther's inbox gains a stranger, and the project
 * accumulates an orphan account per reload. So: settle first, sign in only
 * if there is genuinely nobody there.
 */
async function resolveUser(authMod, auth) {
  if (auth.currentUser) return requireAnonymous(auth.currentUser);

  const restored = await new Promise((resolve) => {
    let done = false;
    let unsubscribe = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (typeof unsubscribe === 'function') unsubscribe();
      resolve(value);
    };
    try {
      unsubscribe = authMod.onAuthStateChanged(auth, (u) => finish(u || null), () => finish(null));
    } catch (err) {
      finish(null);
    }
  });
  if (restored) return requireAnonymous(restored);

  const credential = await authMod.signInAnonymously(auth);
  return requireAnonymous((credential && credential.user) || auth.currentUser || null);
}

/*
 * A customer is an ANONYMOUS session, and only that.
 *
 * Esther's staff hold real Email/Password accounts in the same Firebase
 * project, and Firebase allows exactly one signed-in user per app instance.
 * So a staff member with the admin inbox open in another tab has a
 * non-anonymous currentUser sitting right where this code looks.
 *
 * Adopting it would send an Email/Password ID token to /api/chat/send, which
 * authenticateCustomer() refuses with 403 not_a_customer - forever, on every
 * message, with a "reload the page" that cannot possibly help. The Firestore
 * listener would fail too: isAnonymousCustomer() in firestore.rules tests the
 * same provider.
 *
 * The other tempting move - calling signInAnonymously() anyway - is worse. It
 * would succeed, and sign the staff member out of their own inbox mid-reply.
 *
 * So: refuse, and say something true. Rare, and a dead end either way; this
 * is the dead end that does not take somebody's session down with it.
 */
function requireAnonymous(user) {
  if (!user) return null;
  if (user.isAnonymous === false) {
    throw new ChatApiError(403, 'staff_session_active', null);
  }
  return user;
}

/* ------------------------------------------------------------------ API */

/*
 * One POST to the chat API, carrying BOTH credentials and keeping them apart.
 *
 *   Authorization: Bearer <Firebase ID token>   who
 *   X-Firebase-AppCheck: <App Check token>      what
 *
 * The App Check header is not set here at all - authorizedFetch() attaches
 * it. That is deliberate: there is exactly one place in this codebase that
 * knows how to obtain and attach an App Check token, and duplicating it here
 * is how the two would eventually disagree. The ID token is set here and
 * only here, and never goes anywhere near the App Check header.
 */
async function apiPost(deps, path, body, user) {
  let idToken;
  try {
    /* No forceRefresh. The SDK already refreshes a token that is close to
       expiry; forcing it on every send is a network round trip per message
       to solve a problem the SDK does not have. */
    idToken = await user.getIdToken();
  } catch (err) {
    throw new ChatApiError(401, 'invalid_token', null);
  }
  if (typeof idToken !== 'string' || !idToken) {
    throw new ChatApiError(401, 'invalid_token', null);
  }

  let res;
  try {
    res = await deps.authorizedFetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + idToken
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    /* fetch() rejects for a dropped connection, DNS, CORS - never for a 4xx.
       So this branch is genuinely "the request did not happen". */
    throw new ChatNetworkError();
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }

  if (res.ok && payload && payload.ok === true) return payload;

  const code = payload && typeof payload.code === 'string' ? payload.code : '';
  const retryAfter = payload && typeof payload.retryAfter === 'number'
    ? payload.retryAfter
    : null;
  throw new ChatApiError(res.status || 500, code, retryAfter);
}

/* ------------------------------------------------------------- listener */

/*
 * The transcript listener.
 *
 * THE QUERY IS EXACTLY WHAT THE RULES ALLOW, AND NO WIDER:
 *
 *   where('conversationId', '==', id)   confines it to one conversation
 *   orderBy('createdAt', 'asc')         oldest first, matching the index
 *   limit(200)                          MANDATORY - see below
 *
 * Firestore evaluates a query against the documents it COULD return, not the
 * ones that happen to exist, so a listener that is not confined to one
 * conversation is refused outright rather than quietly narrowed. Dropping
 * the where clause does not leak the database; it produces permission-denied.
 *
 * The limit is not a nicety either. firestore.rules requires
 * request.query.limit to be non-null and <= 200, so a listener without one
 * is denied. A direct listener bypasses the API and therefore every rate
 * limit that lives there, which is exactly why the ceiling is in the rules
 * and not merely here.
 *
 * The (conversationId ASC, createdAt ASC) composite index this needs is
 * already deployed - see firestore.indexes.json. Nothing here required an
 * index change.
 *
 * OWNERSHIP IS NOT CHECKED HERE, AND MUST NOT BE. The rules resolve it
 * server-side: ownsConversation() reads chatConversations/{id}.customerUid
 * and compares it to request.auth.uid. Nothing the browser sends can change
 * that answer, and a check in this file would be decoration - it would
 * reassure a reader while protecting nothing.
 */
function subscribeTranscript(fs, db, conversationId, handlers) {
  const q = fs.query(
    fs.collection(db, MESSAGES_COLLECTION),
    fs.where('conversationId', '==', conversationId),
    fs.orderBy('createdAt', 'asc'),
    fs.limit(TRANSCRIPT_LIMIT)
  );
  return fs.onSnapshot(q, handlers.next, handlers.error);
}

/* ------------------------------------------------------------ THE UI CONTRACT
 *
 * chat.js implements this; tests substitute a recorder. Every method is
 * optional - a caller that only wants the transport can pass {} - so a
 * missing one is a no-op rather than a crash halfway through a send.
 *
 *   showStartForm()               ask for name, email and first message
 *   showTranscript()              switch to the conversation view
 *   renderMessages(list)          [{id, senderType, body, createdAt, pending}]
 *   setStatus(text)               the line under the title in the header
 *   setNotice(text | null)        an inline sentence; null clears it
 *   setBusy(flag)                 a send is in flight
 *   setComposerEnabled(flag)      may the visitor type and send?
 *   setClosed(flag)               the conversation is finished
 *   setRetry(handler | null)      offer ONE user-triggered retry
 *   onStart(handler)              handler({name, email, message})
 *   onSend(handler)               handler({message})
 *
 * Text only. Nothing in this file hands the UI markup, a node, or anything
 * but a string - chat.js renders every one of them with textContent, and the
 * contract being "strings" is what keeps that true.
 * ---------------------------------------------------------------------- */

function callUi(ui, method, arg) {
  if (!ui || typeof ui[method] !== 'function') return undefined;
  try {
    return ui[method](arg);
  } catch (err) {
    /* A broken renderer must not take the transport down with it. */
    return undefined;
  }
}

/* ------------------------------------------------------------- the session */

/*
 * One live customer chat. There is at most one per page, held in `current`
 * below, and starting another stops the first - which is what makes a
 * duplicate listener impossible rather than merely unlikely.
 */
class CustomerChatSession {
  constructor(ui, deps) {
    this.ui = ui;
    this.deps = deps;
    this.store = new TranscriptStore();
    this.identity = null;
    this.db = null;
    this.fs = null;
    this.conversationId = null;
    this.unsubscribe = null;
    this.closed = false;
    this.stopped = false;
    this.sending = false;
    this.listenerFailed = false;
  }

  /* ---------------------------------------------------------- lifecycle */

  async begin() {
    callUi(this.ui, 'setStatus', 'Connecting...');
    callUi(this.ui, 'setComposerEnabled', false);

    this.identity = await establishIdentity(this.deps);
    if (this.stopped) return this;

    this.fs = await this.deps.loadFirestore();
    if (this.stopped) return this;
    this.db = this.fs.getFirestore(this.identity.app);

    /* Wire the UI only once identity exists. A Send button that works before
       there is anyone to send as is a race with a confusing failure at the
       end of it. */
    callUi(this.ui, 'onStart', (fields) => this.start(fields));
    callUi(this.ui, 'onSend', (fields) => this.send(fields));

    const recalled = this.deps.recallConversation(this.deps.storage(), this.identity.user.uid);
    if (recalled) {
      this.conversationId = recalled;
      this.openTranscript();
    } else {
      callUi(this.ui, 'setStatus', 'Send us a message');
      callUi(this.ui, 'showStartForm');
    }
    return this;
  }

  /*
   * Tear down completely. Called when the panel closes, when the module is
   * disposed, and before anything that would otherwise open a second
   * listener. Safe to call twice.
   */
  stop() {
    this.stopped = true;
    this.stopTranscript();
    this.store.clear();
    callUi(this.ui, 'setRetry', null);
  }

  /*
   * Stop listening, but stay alive.
   *
   * The panel closing is not the end of a conversation - it is the visitor
   * looking at something else for a minute. Tearing the whole session down
   * there was wrong twice over: it dropped the identity and conversation the
   * session had already established, and nothing re-established them, so the
   * next time the panel opened the composer looked fine and quietly discarded
   * every message typed into it.
   *
   * Suspending keeps the identity, the conversation and the transcript, and
   * stops only the thing that costs something while nobody is watching.
   */
  suspend() {
    if (this.stopped) return false;
    this.stopTranscript();
    return true;
  }

  resume() {
    if (this.stopped) return false;
    if (this.conversationId) this.openTranscript();
    return true;
  }

  stopTranscript() {
    if (typeof this.unsubscribe === 'function') {
      try {
        this.unsubscribe();
      } catch (err) {
        /* An SDK that throws on unsubscribe has already stopped. */
      }
    }
    this.unsubscribe = null;
  }

  /* ------------------------------------------------------------ reading */

  openTranscript() {
    /* Unconditionally, before every subscribe. Two listeners on one
       conversation is double the reads, double the renders, and a bug that
       only shows up after the fourth time somebody reopens the panel. */
    this.stopTranscript();
    if (this.stopped || !this.conversationId) return;

    this.listenerFailed = false;
    callUi(this.ui, 'showTranscript');
    callUi(this.ui, 'setNotice', null);
    callUi(this.ui, 'setRetry', null);
    callUi(this.ui, 'setStatus', 'Connected');
    callUi(this.ui, 'setComposerEnabled', !this.closed);
    callUi(this.ui, 'renderMessages', this.store.list());

    this.unsubscribe = subscribeTranscript(this.fs, this.db, this.conversationId, {
      next: (snapshot) => this.onSnapshot(snapshot),
      error: (err) => this.onListenerError(err)
    });
  }

  onSnapshot(snapshot) {
    if (this.stopped) return;
    const docs = snapshot && Array.isArray(snapshot.docs) ? snapshot.docs : [];
    const list = this.store.applySnapshot(docs.map(readDoc));
    callUi(this.ui, 'renderMessages', list);
  }

  /*
   * The listener stopped.
   *
   * onSnapshot's error callback means the subscription is DEAD, not
   * degraded, so there is nothing to wait for - the only question is
   * whether resubscribing could possibly help.
   *
   * permission-denied: no. The rules said no and they will say no again;
   * retrying is a loop that bills a read every time round. Stop, say so
   * plainly, offer no retry.
   *
   * anything else: maybe - a dropped connection, a token that expired
   * mid-listen. Offer the visitor a button. NOT a timer: an automatic
   * reconnect loop against a listener that is failing for a structural
   * reason is exactly the runaway this rule exists to prevent.
   */
  onListenerError(err) {
    if (this.stopped) return;
    this.stopTranscript();
    this.listenerFailed = true;

    const code = err && typeof err.code === 'string' ? err.code : '';
    if (code === 'permission-denied' || code === 'firestore/permission-denied') {
      /*
       * The rules said no and will say no again, so there is nothing to
       * retry. But the stored id is now known-bad, and leaving it in place
       * would make every future load of this tab land right back here. Drop
       * it and offer a fresh start - which is a recovery the visitor can
       * actually perform, unlike "reload the page".
       */
      callUi(this.ui, 'setStatus', 'Not connected');
      callUi(this.ui, 'setNotice',
        'We could not load that conversation. You can start a new one below.');
      this.discardConversation();
      return;
    }

    callUi(this.ui, 'setStatus', 'Not connected');
    callUi(this.ui, 'setNotice', 'The connection dropped. New replies may not appear.');
    callUi(this.ui, 'setRetry', () => this.openTranscript());
  }

  /* ------------------------------------------------------------ writing */

  /*
   * Open a conversation.
   *
   * fields.clientMessageId, when present, is a RETRY of an attempt that
   * already minted one.
   *
   * THIS KEY DECIDES THE CONVERSATION'S IDENTITY, not just the message's.
   * startConversationId() in service.js is
   * sha256(domain + uid + clientMessageId), so a fresh key is a fresh
   * conversation - which is exactly what peekStart() exists to prevent. A
   * visitor whose response was lost, pressing Start again, would open a
   * SECOND conversation and appear twice in Esther's inbox as two different
   * enquiries. Reusing the key makes the retry land on the same document,
   * where the server recognises it.
   */
  async start(fields) {
    if (this.stopped || this.sending) return null;
    const input = fields || {};
    this.sending = true;
    callUi(this.ui, 'setNotice', null);
    callUi(this.ui, 'setBusy', true);

    const clientMessageId = (input && typeof input.clientMessageId === 'string'
      && input.clientMessageId)
      ? input.clientMessageId
      : this.deps.newClientMessageId();
    try {
      const payload = await apiPost(this.deps, API_START, {
        name: String(input.name == null ? '' : input.name),
        email: String(input.email == null ? '' : input.email),
        message: String(input.message == null ? '' : input.message),
        clientMessageId: clientMessageId
      }, this.identity.user);

      if (this.stopped) return null;
      this.conversationId = payload.conversationId;
      this.closed = payload.status === 'closed';
      this.deps.rememberConversation(
        this.deps.storage(), this.identity.user.uid, this.conversationId);
      this.openTranscript();
      if (this.closed) this.applyClosed();
      return payload;
    } catch (err) {
      /* The key travels with the retry, so pressing Try again re-attempts THIS
         conversation rather than opening another one. */
      this.reportFailure(err, {
        start: {
          name: input.name,
          email: input.email,
          message: input.message,
          clientMessageId: clientMessageId
        }
      });
      return null;
    } finally {
      this.sending = false;
      callUi(this.ui, 'setBusy', false);
    }
  }

  /*
   * Send one message.
   *
   * fields.clientMessageId, when present, is a RETRY of an attempt that
   * already minted one - see the note on the idempotency key below.
   */
  async send(fields) {
    if (this.stopped || this.sending) return null;
    if (!this.conversationId) return null;
    if (this.closed) {
      callUi(this.ui, 'setNotice', messageForCode('conversation_closed'));
      return null;
    }

    const body = String((fields && fields.message) == null ? '' : fields.message).trim();
    if (!body) {
      callUi(this.ui, 'setNotice', messageForCode('empty_message'));
      return null;
    }

    /*
     * THE IDEMPOTENCY KEY IS PER MESSAGE, NOT PER ATTEMPT.
     *
     * This is the whole point of having one. When a send times out or the
     * connection drops, the request may well have reached the server and been
     * stored - it is the RESPONSE that was lost. Retrying with a fresh key
     * makes that message a different message, and peekMessage() in service.js
     * never fires: the customer's sentence is written twice and Esther's reads
     * it twice.
     *
     * So a retry carries the key its first attempt minted, and the server
     * recognises it and returns the original result instead of appending.
     * Only a genuinely new message mints a new one.
     */
    const clientMessageId = (fields && typeof fields.clientMessageId === 'string'
      && fields.clientMessageId)
      ? fields.clientMessageId
      : this.deps.newClientMessageId();

    this.sending = true;
    callUi(this.ui, 'setNotice', null);
    callUi(this.ui, 'setBusy', true);

    /*
     * EVERYTHING from here is inside try/finally, including deriving the echo
     * id. It was not, and that was a deadlock: newClientMessageId() throws on
     * a browser with no crypto, deriveMessageId() can reject, and the
     * stopped-check below returns early - each one left sending=true forever
     * and a composer that never re-enabled.
     */
    let echoId = null;
    try {
      echoId = await this.deps.deriveMessageId(this.conversationId, clientMessageId);
      if (this.stopped) return null;

      if (echoId) {
        callUi(this.ui, 'renderMessages', this.store.addPending({
          id: echoId,
          senderType: 'customer',
          body: body,
          createdAt: this.deps.now()
        }));
      }

      return await apiPost(this.deps, API_SEND, {
        conversationId: this.conversationId,
        message: body,
        clientMessageId: clientMessageId
      }, this.identity.user);
    } catch (err) {
      /* Take the echo back down. Leaving it would tell the visitor their
         message was sent when it was not, which is the one lie a chat must
         never tell. */
      if (echoId) callUi(this.ui, 'renderMessages', this.store.dropPending(echoId));
      /* The key travels with the retry, so pressing Try again re-sends THIS
         message rather than a copy of it. */
      this.reportFailure(err, { message: body, clientMessageId: clientMessageId });
      return null;
    } finally {
      this.sending = false;
      callUi(this.ui, 'setBusy', false);
    }
  }

  /* ------------------------------------------------------------ failures */

  /*
   * One place where a failure becomes something a person reads.
   *
   * NOTHING IS RETRIED AUTOMATICALLY, and 429 in particular is not. A retry
   * on rate_limited is by definition a request the server has just said is
   * too many; doing it on a timer turns one impatient visitor into a loop.
   * A retry is offered as a button - the visitor decides - and only for the
   * one kind where trying again could actually work.
   */
  reportFailure(err, retryContext) {
    const described = describeFailure(err);
    callUi(this.ui, 'setNotice', described.text);

    if (described.kind === 'closed') {
      this.applyClosed();
      return;
    }
    /*
     * The conversation is GONE, not merely unavailable: deleted, or an id this
     * uid does not own. Telling the visitor to "start a new one" while the
     * dead id stays in sessionStorage makes that impossible - every reload
     * recalls it and lands here again, and the tab is a permanent dead end.
     * Forget it, so the next load offers the start form.
     */
    if (described.code === 'conversation_not_found'
        || described.code === 'invalid_conversation_id') {
      this.discardConversation();
      return;
    }
    if (described.kind === 'auth' || described.kind === 'app_check') {
      /* Reloading is the fix, and this session cannot perform it. Stop
         rather than leave a composer that will fail on every press. */
      callUi(this.ui, 'setComposerEnabled', false);
      callUi(this.ui, 'setRetry', null);
      return;
    }
    if (described.kind === 'rate_limited') {
      /* Explicitly no retry handler. The wait is the point. */
      callUi(this.ui, 'setRetry', null);
      return;
    }
    if (described.kind === 'offline' && retryContext && retryContext.start) {
      /* Same key, so this re-attempts the conversation rather than opening a
         second one. */
      callUi(this.ui, 'setRetry', () => this.start(retryContext.start));
      return;
    }
    if (described.kind === 'offline' && retryContext && retryContext.message) {
      callUi(this.ui, 'setRetry', () => this.send({
        message: retryContext.message,
        /* The SAME key the failed attempt used. Without this the retry is a
           second message, not a second attempt at the first one. */
        clientMessageId: retryContext.clientMessageId
      }));
      return;
    }
    callUi(this.ui, 'setRetry', null);
  }

  /*
   * Let go of a conversation this session can no longer use, and offer a
   * fresh start rather than a dead transcript.
   */
  discardConversation() {
    this.stopTranscript();
    this.conversationId = null;
    this.closed = false;
    this.store.clear();
    this.deps.forgetConversation(this.deps.storage());
    callUi(this.ui, 'setRetry', null);
    callUi(this.ui, 'setStatus', 'Send us a message');
    callUi(this.ui, 'showStartForm');
  }

  applyClosed() {
    this.closed = true;
    /* The transcript stays readable - the rules still permit reading a
       closed conversation's messages, and taking somebody's history away
       the moment it ends would be gratuitous. Only writing stops. */
    callUi(this.ui, 'setClosed', true);
    callUi(this.ui, 'setComposerEnabled', false);
    callUi(this.ui, 'setStatus', 'Conversation closed');
  }
}

/* Firestore hands back a QueryDocumentSnapshot; normaliseMessage() wants a
   plain { id, data }. Kept separate so the store can be tested with plain
   objects and never needs to know the SDK exists. */
function readDoc(doc) {
  if (!doc) return null;
  const data = typeof doc.data === 'function' ? doc.data() : doc.data;
  return { id: doc.id, data: data };
}

/* --------------------------------------------------------- the entry points */

let current = null;

/*
 * The default wiring. Every one of these is overridable, which is what lets
 * the whole session be tested without a network, a browser or a clock.
 */
function defaultDeps(overrides) {
  const d = {
    initAppCheck: initAppCheck,
    getFirebaseApp: getFirebaseApp,
    loadAuth: () => import(SDK_AUTH),
    loadFirestore: () => import(SDK_FIRESTORE),
    authorizedFetch: authorizedFetch,
    newClientMessageId: newClientMessageId,
    deriveMessageId: deriveMessageId,
    rememberConversation: rememberConversation,
    recallConversation: recallConversation,
    forgetConversation: forgetConversation,
    storage: () => {
      try {
        return globalThis.sessionStorage || null;
      } catch (err) {
        return null;      /* blocked-storage settings throw on ACCESS */
      }
    },
    now: () => Date.now()
  };
  return Object.assign(d, overrides || {});
}

/*
 * Connect the customer chat.
 *
 * REFUSES WHILE THE GATE IS SHUT. This is the function ordinary page code
 * would call, and while CHAT_PUBLIC_ENABLED is false it returns null having
 * touched nothing: no auth, no attestation, no request, no listener. That
 * refusal is the gate - not a UI state, not a hidden panel, but the entry
 * point declining to do anything at all.
 */
export async function connect(ui, options) {
  if (!isPublicChatEnabled()) return null;
  return startSession(ui, options);
}

/*
 * The review harness. THE ONLY WAY IN WHILE THE GATE IS SHUT.
 *
 * Deliberately awkward to reach: it is an export of a module no page loads,
 * so using it means opening DevTools and typing an import. There is no query
 * parameter, no cookie, no storage key and no hidden control that reaches
 * it, and calling it changes nothing that outlives the page - reload and the
 * site is exactly as it was for everybody, including you.
 *
 *   const m = await import('/assets/js/chat-customer.js');
 *   const session = await m.openChatForReview();
 *
 * See docs/CHAT_CUSTOMER_FRONTEND.md for the full walkthrough.
 */
export async function openChatForReview(options) {
  const opts = options || {};
  const ui = opts.ui || resolvePageUi();
  if (!ui) {
    throw new Error(
      'No chat UI on this page. openChatForReview() needs the widget from ' +
      'chat.js, or an explicit { ui } to drive.');
  }
  if (typeof opts.openPanel === 'function') opts.openPanel();
  else openPageChatPanel();
  return startSession(ui, opts);
}

/* The widget's own driver, if chat.js is on the page. Reached through the
   documented namespace rather than by digging through the DOM, so the widget
   remains free to change how it is built. */
function resolvePageUi() {
  const CM = globalThis.CM;
  const chat = CM && CM.chat;
  return chat && typeof chat.transportSurface === 'function' ? chat.transportSurface() : null;
}

function openPageChatPanel() {
  const CM = globalThis.CM;
  const chat = CM && CM.chat;
  if (chat && typeof chat.open === 'function') chat.open();
}

async function startSession(ui, options) {
  /* At most one. Starting a second without stopping the first is how two
     listeners on one conversation happen. */
  if (current) {
    current.stop();
    current = null;
  }
  const session = new CustomerChatSession(ui, defaultDeps(options && options.deps));
  current = session;
  try {
    await session.begin();
  } catch (err) {
    const described = describeFailure(err);
    callUi(ui, 'setStatus', 'Not connected');
    callUi(ui, 'setNotice', described.kind === 'server' ? UNAVAILABLE : described.text);
    callUi(ui, 'setComposerEnabled', false);
    session.stop();
    if (current === session) current = null;
    return null;
  }
  return session;
}

/*
 * Stop listening while the panel is closed, and pick up again when it opens.
 *
 * This is what the widget calls, NOT disconnect(). A closed panel must not
 * hold a Firestore listener - it bills a read for every message arriving at a
 * widget nobody is looking at - but it must not lose the conversation either.
 */
export function suspend() {
  return current ? current.suspend() : false;
}

export function resume() {
  return current ? current.resume() : false;
}

/* Stop for good, and let the session go. A reviewer who is finished calls
   this; the panel closing does NOT - see suspend() above. */
export function disconnect() {
  if (!current) return false;
  current.stop();
  current = null;
  return true;
}

export function activeSession() {
  return current;
}

/* Tests need a clean module between cases. */
export function _reset() {
  if (current) current.stop();
  current = null;
}

/* Exported for the tests that prove the listener asks for exactly what the
   rules require, and for anyone reading firestore.rules alongside this. */
export const _internals = {
  MESSAGES_COLLECTION,
  TRANSCRIPT_LIMIT,
  API_START,
  API_SEND,
  CONVERSATION_KEY,
  MESSAGES_BY_CODE,
  NUL,
  subscribeTranscript,
  readDoc,
  CustomerChatSession,
  defaultDeps
};
