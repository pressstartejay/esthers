# The customer chat frontend

**Public chat is OFF.** Two source constants say so, both `false`, and while
either is false an ordinary visitor gets the mascot and
*"Online messaging coming soon."* — no Firebase download, no reCAPTCHA
challenge, no anonymous sign-in, no request to `/api/chat/*`, no Firestore
listener.

This document is how to review the real thing anyway, and what it does when it
runs.

---

## 1. The shape of it

```
 ┌────────────────────┐
 │  chat.js           │   the widget: mascot, panel, drag, focus, CSS.
 │  (classic script,  │   On every page. Owns nothing about the network.
 │   every page)      │
 └─────────┬──────────┘
           │  transportSurface()   ← a small object of strings and booleans
           ▼
 ┌────────────────────┐
 │  chat-customer.js  │   identity, transport, transcript.
 │  (ES module,       │   Loaded by nobody. Dynamically imported only when
 │   loaded by none)  │   the gate opens, or by hand from DevTools.
 └─────────┬──────────┘
           │  imports
           ▼
 ┌────────────────────┐
 │  chat-app-check.js │   App Check, and THE one Firebase app instance.
 └────────────────────┘
```

Writes and reads go different ways, and the asymmetry is the design:

| | route | authority |
|---|---|---|
| customer **write** | `POST /api/chat/start`, `/api/chat/send` | the Vercel API — auth, validation, rate limits, idempotency |
| customer **read** | `onSnapshot()` direct on `chatMessages` | `firestore.rules` |
| customer write to Firestore | **impossible** | rules deny `create`, `update`, `delete` |
| staff | `/api/admin/chat/*` | the Vercel API |

Writes go through the API because a browser must never be able to write a
transcript. Reads go direct because a realtime transcript is what a chat *is*,
and polling would be slower and chattier for a worse result.

---

## 2. Initialisation order is a security property

```
1. App Check       initAppCheck()        attest that this is the real site
2. Firebase app    getFirebaseApp()      the one shared instance
3. anonymous auth  signInAnonymously()   or reuse the session already there
4. work            API calls, listener
```

**App Check comes first and the order is not negotiable.** Firebase
Authentication App Check enforcement is off today and will be turned on. On
that day a `signInAnonymously()` issued before attestation is a request Google
refuses. Writing the order correctly now makes that switch a console setting
rather than a code change made under pressure.

`establishIdentity()` in `chat-customer.js` is the whole of it, and a test
asserts the order by watching the SDK rather than by reading the source.

**It fails closed.** If App Check cannot initialise, the session stops there —
it does not sign anyone in. App Check enforcement is already on for
`/api/chat/*`, so a session without a token could not send anything anyway;
stopping early avoids minting an anonymous Firebase account that would sit in
the project forever attached to nothing.

**A staff session is refused, not adopted.** Esther's staff hold real
Email/Password accounts in the same Firebase project, and Firebase allows one
signed-in user per app instance — so a staff member with the admin inbox open
in another tab has a non-anonymous `currentUser` sitting exactly where this code
looks. Adopting it would send an Email/Password ID token to the customer API,
which `authenticateCustomer()` refuses `403 not_a_customer` forever; the
listener would fail too, since `isAnonymousCustomer()` tests the same provider.
Calling `signInAnonymously()` anyway would be worse — it would succeed, and sign
the staff member out of their own inbox mid-reply. So the session refuses, and
says so plainly. Another pre-commit review find.

**Reusing an existing session matters more than it looks.** `auth.currentUser`
is null for a moment after `getAuth()` even when the browser holds a perfectly
good persisted anonymous session — the SDK restores it asynchronously. Calling
`signInAnonymously()` during that moment does not fail; it *succeeds*, and
mints a **second** account. The visitor loses their conversation, Esther's
inbox gains a stranger, and the project accumulates an orphan account per
reload. `resolveUser()` waits for `onAuthStateChanged` to settle first.

---

## 3. The two credentials, kept apart

Every write carries both, in different headers, proving different things:

```
Authorization:        Bearer <Firebase ID token>     WHO is asking
X-Firebase-AppCheck:  <App Check token>              WHAT is asking
Content-Type:         application/json
```

`chat-customer.js` sets `Authorization` and never touches the App Check
header — `authorizedFetch()` in `chat-app-check.js` attaches that. One place in
the codebase knows how to obtain an App Check token, which is what stops the
two from ever disagreeing. Tests assert that neither credential appears in the
other's header.

### Request shapes — read from the server, not guessed

`POST /api/chat/start`

```json
{ "name": "Jordan Ellis",
  "email": "jordan@example.com",
  "message": "Do you make custom flashing?",
  "clientMessageId": "3f1c…-uuid" }
```
→ `{ "ok": true, "conversationId": "…", "messageId": "…", "status": "open" }`

`POST /api/chat/send`

```json
{ "conversationId": "…", "message": "…", "clientMessageId": "…uuid…" }
```
→ `{ "ok": true, "messageId": "…", "conversationId": "…" }`

**All three start fields are required**, `email` included. Limits: name 1–100,
email ≤254, message ≤2000, `clientMessageId` a UUID.

**Nothing else may be sent.** `validation.js` rejects a body containing
`customerUid`, `senderType`, `staffUserId`, `status` or any other
server-decided field with **400 `forbidden_field`** — rejected, not ignored. A
test asserts every outbound body against that exact list.

---

## 4. The realtime listener

```js
query(
  collection(db, 'chatMessages'),
  where('conversationId', '==', conversationId),
  orderBy('createdAt', 'asc'),
  limit(200)
)
```

Every clause is load-bearing:

- **`where`** confines the query to one conversation. Firestore evaluates a
  query against the documents it *could* return, not the ones that exist, so a
  listener that is not confined is refused outright rather than quietly
  narrowed. Dropping it does not leak the database — it produces
  `permission-denied`.
- **`limit`** is **mandatory**. `firestore.rules` requires
  `request.query.limit` to be non-null and `<= 200`. A direct listener bypasses
  the API and therefore every rate limit that lives there, which is why the
  ceiling is in the rules and not merely in the client.
- **`orderBy createdAt asc`** matches the deployed composite index
  `(conversationId ASC, createdAt ASC)`. **No index change was needed and none
  was made.**

**Ownership is enforced server-side and is not checked in the client.**
`ownsConversation()` in the rules reads `chatConversations/{id}.customerUid`
and compares it to `request.auth.uid`. Nothing the browser sends changes that
answer, so a check in the client would be decoration — it would reassure a
reader while protecting nothing.

**No duplicate listeners.** `stopTranscript()` runs unconditionally before
every subscribe, and starting a second session stops the first. Tests assert
the live listener count stays at one across repeated cycling.

**Closing the panel SUSPENDS; it does not disconnect.** A closed panel must not
hold a listener — it bills a read for every message arriving at a widget nobody
is looking at — but the session, the identity and the conversation all survive.
`chat.js` calls `suspend()` on close and `resume()` on open.

This was a bug found in pre-commit review and fixed: `close()` used to call
`disconnect()`, which stopped the session for good, and `open()` did nothing.
The widget stayed in live mode wired to a dead session, so after one close the
composer looked perfectly normal and silently discarded every message typed
into it. `disconnect()` is now only for a reviewer who is finished.

**Listener errors do not loop.** `onSnapshot`'s error callback means the
subscription is *dead*, not degraded. On `permission-denied` the client stops:
the rules said no and will say no again, and retrying bills a read each time
round. On anything else it offers the visitor a **button** — never a timer.

---

## 5. Rendering, and why a transcript is the input you do not trust

Message bodies are set with `textContent`. Never `innerHTML`, never a
node built from message text. The transport hands the widget **strings and
booleans only** and contains no DOM API at all — tests assert both halves.

The three `innerHTML` assignments in `chat.js` are fixed SVG icons that file
builds itself (`closeBtn`, `dismissBtn`, `restoreBtn`). No message reaches one,
and a test pins the count at three and checks each target by name.

`normaliseMessage()` is an **allow-list**, not a copy: `id`, `senderType`,
`body`, `createdAt`. The rules let a customer read the whole message document
and the schema promises only four fields — but a promise upstream is not a
reason to hand whatever arrives to a renderer. A field added to that collection
later stops here.

Malformed rows are dropped rather than rendered; one bad document must not
empty the transcript. An unreadable timestamp becomes `0` rather than `NaN`,
which would poison the comparator and shuffle everything.

### No duplicate messages, provably

When the visitor presses Send the message appears immediately as a dimmed
optimistic bubble. Its id is **derived exactly as the server derives it** —
`sha256(conversationId + NUL + clientMessageId)`, first 40 hex characters, the
same formula as `messageId()` in `api/_chat/service.js`. So when the listener
delivers the stored document it lands on the same key and *replaces* the echo
instead of joining it. A test computes both sides independently and asserts
they match; if the two ever drift, that test fails rather than a customer
seeing their own sentence twice.

A send that fails takes its echo back down. Leaving it would tell the visitor
their message was sent when it was not, which is the one lie a chat must never
tell.

---

## 6. What is stored, and what is never stored

`sessionStorage`, one key, `esthers.chat.conversation`:

```json
{ "uid": "…", "conversationId": "…" }
```

**Never stored:** the Firebase ID token, the App Check token, the visitor's
name, their email, or any message. Tokens are short-lived credentials that
belong in memory; the rest is the transcript's business and the transcript
lives in Firestore. A test dumps the store after a full round trip and asserts
none of those values appear in it.

The conversation id is **not a credential** — ownership is checked against the
verified uid on every read and write, by the API and again by the rules — so
this is convenience, not access. Per-tab is the honest lifetime for that
convenience: a reload keeps your thread, a shared machine does not hand it to
the next person.

It is **reconciled against auth state** before reuse. Firebase can hand a
browser a different anonymous uid — cleared storage, a new profile — and
reusing another uid's conversation id would produce a listener the rules deny
and a send the API 404s. A stored record whose `uid` does not match the session
is refused, as is a malformed or hostile id.

Every access is wrapped in `try/catch`: private modes and blocked-storage
settings throw on **read**, not only on write. A browser with no usable storage
still gets a working chat; it just starts a fresh conversation each tab.

---

## 7. Failures the visitor can see

Every customer-facing sentence comes from one allow-list keyed by the API's
error code. **The server's own `error` string is never displayed**, even though
it is written for a person — echoing a server-supplied string into the page is
a habit that works right up until some error path returns something it should
not have. An unknown code falls back to a generic sentence.

| condition | what happens | retry offered? |
|---|---|---|
| `401 app_check_*` | "could not verify this page… reload" | no |
| `401` / `403` auth | "session has expired… reload" | no, composer stops |
| `400` validation | the specific field message | no |
| `409 conversation_closed` | closed state, transcript stays readable | no |
| `429 rate_limited` | "wait a moment before sending another" | **no — deliberately** |
| network failure | "could not reach us… check your connection" | **yes, a button** |
| `5xx` / non-JSON | generic sentence | no |
| listener `permission-denied` | "could not load… reload" | no |
| listener transient | "connection dropped" | **yes, a button** |

**Nothing retries automatically, and 429 in particular does not.** A retry on
`rate_limited` is by definition a request the server has just called too many;
doing it on a timer turns one impatient visitor into a loop. Where a retry is
offered it is a button the visitor presses, and the handler is cleared before
it runs so one press is one attempt.

A retried send reuses the **same** `clientMessageId`, so the server recognises
it as the same message and returns the original result rather than appending a
duplicate. This is the whole reason the key exists: when a send fails, the
request may well have reached the server and been stored — it is the *response*
that was lost. Retrying with a fresh key would make it a different message, and
`peekMessage()` in `service.js` would never fire.

(It did mint a fresh key, until pre-commit review caught it. `send()` now
accepts an optional `clientMessageId` and the retry handler passes the failed
attempt's own key back in; a test asserts the two requests carry the identical
key, and that two *different* messages still get different ones.)

**`start()` reuses its key on retry too**, and for a sharper reason: that key
decides the *conversation's* identity, not just the message's —
`startConversationId()` is `sha256(domain + uid + clientMessageId)`. A fresh key
is a fresh conversation, so a visitor whose start response was lost would have
appeared in Esther's inbox twice, as two separate enquiries. (Also a
pre-commit review find; `send()` was fixed first and `start()` was missed.)

**A conversation the server says is gone is discarded.** On `404
conversation_not_found`, on `400 invalid_conversation_id`, and on a Firestore
`permission-denied`, the stored id is forgotten and the start form is offered.
Without that, "please start a new one" was advice the visitor could not act on:
every reload recalled the dead id, failed the same way, and landed back on the
same message. Per-tab dead end, permanently.

---

## 8. The rollout gate

Two constants, both `false`, both plain source:

| file | constant | what it stops |
|---|---|---|
| `assets/js/chat.js` | `var CHAT_PUBLIC_ENABLED = false;` | the widget never imports the transport |
| `assets/js/chat-customer.js` | `export const CHAT_PUBLIC_ENABLED = false;` | `connect()` returns `null` having touched nothing |

Neither can be flipped by a query string, a cookie, a storage key, or anything
else a visitor can reach. Turning chat on is a commit, a review and a deploy —
the right weight for the decision. Both are flipped in the same commit.

While they are false, on an ordinary page load:

- no Firebase SDK is downloaded
- no reCAPTCHA challenge is issued
- no anonymous sign-in happens
- no request reaches `/api/chat/*`
- no Firestore listener opens
- the widget is the demo it has always been, notice and all

Tests assert every one of those, and a mutation that flips either constant
fails the suite.

---

## 9. Reviewing it on esthers.ca — the manual walkthrough

The gate stays shut. The only way in is to type an import into DevTools, which
is deliberately awkward: no page leads to it, and calling it changes nothing
that outlives the page.

**Prerequisites.** A page served from `https://www.esthers.ca` — the
reCAPTCHA Enterprise key is restricted to that domain, so attestation cannot
succeed from `localhost` or a `*.vercel.app` preview. This is the first time a
real App Check token is minted for the chat flow.

### Open review mode

```js
const chat = await import('/assets/js/chat-customer.js');
const session = await chat.openChatForReview();
```

The panel opens and the start form appears. If a conversation is already
remembered for this tab, the transcript opens instead.

**What to watch in DevTools while that line runs:**

- **Network** — a request to `www.google.com/recaptcha/enterprise…`, then
  `firebaseinstallations.googleapis.com` and `firebaseappcheck.googleapis.com`.
  A 200 from the App Check endpoint is the real token issuance. **This is the
  step that has never been proven before.**
- **Console** — nothing. Any `Esther's: …` line means the module refused to
  start; read it, it says which half failed.
- `session` is `null` if it refused. `await chat.activeSession()` is the live
  one.

### Verify anonymous auth

```js
const app = await (await import('/assets/js/chat-app-check.js')).getFirebaseApp();
const { getAuth } = await import('https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js');
const u = getAuth(app).currentUser;
u.uid;            // an anonymous uid
u.isAnonymous;    // true
```

Reload the page and run `openChatForReview()` again: `u.uid` must be **the
same**. A different uid means the restore race regressed.

### Verify /api/chat/start

Fill the form in the panel and press **Start conversation**. In Network, on
`POST /api/chat/start`, check the request headers:

- `Authorization: Bearer eyJ…`
- `X-Firebase-AppCheck: eyJ…` ← **the App Check token, on a real request**
- response `200 {"ok":true,"conversationId":"…","status":"open"}`

App Check enforcement is already on for this endpoint, so a **200 here is
positive proof the whole attestation chain works end to end.** A
`401 app_check_required` means the token was not attached or not accepted.

### Verify /api/chat/send

Type in the composer and press Send.

- The bubble appears immediately, dimmed — that is the optimistic echo.
- `POST /api/chat/send` carries both headers again.
- The bubble un-dims when the listener delivers the stored copy. **It must not
  appear twice.** If it does, the derived id no longer matches the server's.

### Verify the realtime listener

```js
chat.activeSession().conversationId;
```

Then, from the Firebase console or a staff tool, add a `staff` message to that
conversation. It should appear in the panel **without a reload**, on the left.

To see a refusal behave correctly, point the listener at a conversation you do
not own:

```js
const s = chat.activeSession();
s.conversationId = 'not-mine-0000';
s.openTranscript();
```

Expected: `permission-denied` in the console from Firestore, the status line
reads *Not connected*, the notice asks you to reload, **and no retry loop** —
the Network panel must go quiet, not repeat.

### Verify close behaviour

Close the conversation server-side (`/api/admin/chat/close`), then send from
the panel. Expected: `409 conversation_closed`, the composer disables, the
transcript stays readable, and a further press produces **no request at all**.

### Clean up

```js
chat.disconnect();                 // stops the listener
sessionStorage.removeItem('esthers.chat.conversation');
location.reload();                 // back to the ordinary site
```

Closing the panel also disconnects. Nothing persists: a reload leaves the site
exactly as it is for everybody else.

---

## 10. What tests can and cannot prove

`tests/chat-api/chat-customer.test.mjs` — 104 tests — runs both real modules
with only the four gstatic SDK URLs swapped for a local stub, so the ordering
and the header separation are proven against the real `chat-app-check.js`
rather than a stand-in.

It **cannot** mint a real App Check token or reach a real Firestore. The
production key is restricted to `esthers.ca` and attestation happens in a
browser against the page's own hostname. That restriction is the protection;
weakening it to make a test pass would be exactly the wrong trade. Section 9 is
what closes the remaining gap, and it closes it on production.

---

## 11. Where this sits in the launch sequence

See `docs/CHAT_APP_CHECK.md` for the full checklist. This phase delivers
steps 1–2; step 3 is section 9 above.

Firestore and Authentication App Check enforcement are **still off**, and must
stay off until the customer flow and then the staff flow have both been proven
with App Check initialising before auth. Vercel API enforcement is **on** and
stays on.
