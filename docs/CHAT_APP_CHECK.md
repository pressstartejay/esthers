# Firebase App Check for the chat system

**Status: implemented, tested, and NOT enforced. Production enforcement is OFF
and stays off until it is explicitly approved.**

This document is internal. `docs/` is excluded from the deployment by
`.vercelignore`, so nothing here is served.

---

## Why App Check exists

Firebase Auth answers *who is calling*. App Check answers *what is calling*.

Esther's chat already proves who: a customer holds an anonymous Firebase ID
token, staff hold an email/password one, and the server checks both with
`verifyIdToken(token, true)`. None of that stops someone writing a script,
minting their own anonymous session — anonymous sign-in is open by
design — and talking to the API directly, forever, at whatever rate the rate
limiter allows.

App Check closes that. The browser passes a reCAPTCHA Enterprise challenge,
Firebase issues a short-lived attestation token, and a request without one is
not coming from the website.

**It is additive.** It replaces nothing. A request still has to survive the
same-origin check, a valid ID token, the anonymous-provider rule for
customers, the `staff/{uid}` + `isActive` + `role: admin` rule for staff,
payload validation and the rate limiter. A caller with a perfect App Check
token and nothing else gets a 401 from the very next gate.

## The provider

**reCAPTCHA Enterprise**, registered against the Firebase web app *Esther's
Website* in project `esther-s-chat`.

- Token TTL: 1 hour
- Risk threshold: Medium (0.5)
- The production site key is **restricted to esthers.ca**

## Public site key vs private credentials

This distinction matters and is easy to get wrong.

**Public — belongs in browser source, is not a secret:**

- the Firebase web config (`apiKey`, `authDomain`, `projectId`, `appId`)
- the reCAPTCHA Enterprise **site** key

Firebase publishes these in its own documentation. `apiKey` is a project
identifier, not an authorisation: it opens no door on its own. What protects
the project is App Check enforcement, the Firestore rules, the API's
authentication, and the domain restriction on the site key.

**Private — must never appear in the repository, in `assets/`, or in this
file:**

- `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL` (Vercel env only)
- the reCAPTCHA Enterprise **secret/private** key (never leaves Google Cloud)
- any App Check **debug token** (a developer's browser only)

## Two protection paths, protected differently

| Path | Who enforces | What we had to do |
|---|---|---|
| Customer reads Firestore directly | Google, once Firestore enforcement is on | Initialise App Check in the browser. The SDK attaches the token itself. |
| `/api/chat/*`, `/api/admin/chat/*` on Vercel | **Nobody, unless we do it** | Fetch the token, send a header, verify it with the Admin SDK. |

The second row is the one people miss. Turning on App Check in the Firebase
console does **nothing** for a Vercel function — Google is not in that request
path and never sees it.

## The header

```
X-Firebase-AppCheck: <token>
```

Firebase's own convention for custom backends. Worth being precise: this is a
*convention*, not an API. The Admin SDK never reads a header —
`verifyToken()` takes a raw string — so extracting it is entirely the
application's job and any name would work. Matching Firebase's spelling means
anyone who has read their docs already knows where to look.

Node lower-cases incoming header names, so the server reads
`req.headers['x-firebase-appcheck']`.

The token is read from **that header only**. Not from `Authorization`, not
from a query parameter, not from the body. An App Check token and an ID token
prove different things, and letting either arrive in the other's channel is
how they end up confused for each other. There are tests for both directions.

## Server verification flow

`api/_chat/app-check.js`, called from `createHandler` in
`api/_chat/handler.js`:

```
method → same-origin → body → Admin config → APP CHECK → rate secret
       → Firebase Auth → authorisation → rate limit → the work
```

App Check sits **after** configuration (it needs the initialised Admin app)
and **before** authentication (it is the cheaper question, so an unattested
caller never reaches ID-token verification).

It stays **after** the rate limiter's position in the file — the limiter still
runs after authentication, because it writes a Firestore document and must
never be reachable unauthenticated.

Verification is `getAppCheck(app).verifyToken(token)` from
`firebase-admin/app-check` (firebase-admin 14.3.0). The module is loaded by
literal dynamic `import()` alongside `app`, `firestore` and `auth`, for the
same ESM reason documented in `api/_chat/firebase-admin.js`.

**Replay protection (`{ consume: true }`) is deliberately NOT enabled.** It
adds a network round trip per request and forces a fresh attestation, which
Firebase recommends only for low-volume, security-critical or expensive
operations. Chat messages are none of those. It is worth reconsidering for
`admin/chat/close` if abuse ever appears.

### Outcomes

| Situation | Enforcement OFF | Enforcement ON |
|---|---|---|
| No token | request proceeds | `401 app_check_required` |
| Malformed token | proceeds, logged `malformed` | `401 app_check_invalid` |
| Token the verifier refuses | proceeds, logged `rejected` | `401 app_check_invalid` |
| Valid token | proceeds, logged `valid` | proceeds |
| App Check module failed to load | proceeds | `401 app_check_unavailable` |

That last row is the fail-closed case and is deliberate. If
`firebase-admin/app-check` cannot be imported, the choice is between serving
an unprotected API and refusing everything. It refuses. A chat outage is
recoverable; silently serving unverified traffic is not.

The mirror of it — App Check failing to load must **not** take chat down while
enforcement is off — is why `sdkAppCheckFailure` is tracked separately from
`sdkLoadFailure` in `firebase-admin.js`. An additive gate must not become a
new way for the core to fail.

## Is verification mandatory right now? No — and why

**Staged, gated by an environment variable, default OFF.**

```
CHAT_APP_CHECK_ENFORCED = 1 | true | on | yes | enforced   → enforced
anything else, including unset                             → not enforced
```

The switch is read **only** from the environment. There is no query
parameter, header or body field anywhere that can turn it off — a caller
cannot opt out of a gate they cannot address. There is a test asserting
`isEnforced` reads no request-shaped input at all.

It ships OFF because the public chat frontend is not connected. No browser is
sending App Check tokens today, so making verification mandatory on merge
would reject the production diagnostics probe and every one of the ~200
existing test call sites — breaking a backend that is already proven, in order
to protect a surface nobody can reach.

While OFF the server still *observes*: if a token is present it is verified
and the outcome logged as one allow-listed word. That is the rollout's
evidence that real clients have started attesting successfully, and it is what
makes step 3 below something you can check rather than assume.

**This is not a bypass.** A bypass is something a caller can reach. This is a
deployment setting, and the only way to exercise the unenforced path is to be
the person who owns the Vercel project.

## The customer architecture, now decided

This was open when App Check landed, and the doc hedged accordingly. It is
settled, and the hedge is withdrawn:

| | route | governed by |
|---|---|---|
| customer **write** | `POST /api/chat/{start,send}` | the Vercel API |
| customer **read** | `onSnapshot()` **direct on Firestore** | `firestore.rules` |
| customer write to Firestore | **impossible** | rules deny create/update/delete |
| staff | `/api/admin/chat/*` | the Vercel API |

**The customer WILL read Firestore directly.** The realtime transcript is a
listener on `chatMessages`, filtered to one conversation, ordered by
`createdAt`, limited to 200. That is not a possibility to plan around — it is
implemented, in `assets/js/chat-customer.js`.

So **Firestore App Check enforcement is definitely relevant**, and step 12
below is a real step with real consequences rather than a formality. Turning it
on without first proving that production browsers attest successfully will
break every customer's transcript — silently, because a denied listener looks
like an empty conversation.

The same goes for **Authentication** enforcement, step 13: customers sign in
anonymously, and a `signInAnonymously()` that Google refuses is a visitor who
cannot chat at all. This is why `chat-customer.js` initialises App Check
**before** auth today, while nothing enforces it — so that step 13 is a console
setting rather than a code change made under pressure.

## The launch sequence

Do these in order. The order is not a preference — several of these steps lock
real people out if they are done early.

**Where we are: 1 and 2 are done. 3 is next, and it is a manual walkthrough on
production.**

| # | step | state |
|---|---|---|
| 1 | Build the customer frontend | **done** — `assets/js/chat-customer.js` |
| 2 | Deploy with the public gate OFF | **done for the API half**; the frontend is written and unmerged |
| 3 | Manually invoke review mode on esthers.ca | next — see `docs/CHAT_CUSTOMER_FRONTEND.md` §9 |
| 4 | Verify anonymous auth (same uid across a reload) | |
| 5 | Verify `POST /api/chat/start` | |
| 6 | Verify `POST /api/chat/send` | |
| 7 | Verify the realtime Firestore listener | |
| 8 | Verify close behaviour | |
| 9 | Build and test the staff UI | |
| 10 | Verify the staff App Check / auth flow | |
| 11 | Inspect Firebase App Check metrics | |
| 12 | **Enable Firestore App Check enforcement** | Firebase console |
| 13 | **Enable Authentication App Check enforcement** | Firebase console |
| 14 | Run the full production E2E | |
| 15 | **Flip the public chat gate** | both constants, one commit |

Notes on the steps that bite:

- **Step 3 is the first real App Check token this project has ever minted.**
  Everything before it is proven by test; attestation itself cannot be, because
  the reCAPTCHA key is restricted to esthers.ca. A 200 from
  `POST /api/chat/start` — which already enforces App Check — is the proof.
- **Step 11 before 12 and 13.** Firebase shows verified vs unverified counts
  per service. Watch for `rejected`: that means a real visitor attested and was
  refused, and enforcing on top of it would lock them out.
- **Step 13 is the one most likely to lock customers out.** See the section
  below.
- **Step 15 is two constants**, `CHAT_PUBLIC_ENABLED` in `assets/js/chat.js`
  and in `assets/js/chat-customer.js`. Both `false` today; both flip in the
  same commit, or chat silently does not work.

Rolling back the API is one environment variable. Unset
`CHAT_APP_CHECK_ENFORCED`, redeploy, and the API returns to accepting
unattested requests — no data is touched and no conversation is lost. Rolling
back the public chat gate is a revert of one commit.

**Launch gate:** public chat must not go live with `CHAT_APP_CHECK_ENFORCED`
unset. Enforcement off is the right default while chat is dark and exactly the
wrong one once it is live, which is why it is written down here rather than
left to memory.

## Should Firebase Authentication have App Check enforcement enabled?

**Yes — but at step 6, not before, and it is the step most likely to lock
customers out if it is done early.**

The reasoning, against this project's actual architecture:

Customers sign in **anonymously**. Anonymous sign-in is open by definition:
anyone can call `signInAnonymously()` against the project and get a real,
valid uid. That is precisely the hole App Check is here to close, and
Authentication is where it closes — enforcing App Check on Firebase
Authentication means the project will not *mint* an anonymous session for a
caller that cannot attest. Without it, an attacker still gets a valid ID
token; they simply cannot spend it at the Vercel API. With it, they never get
one.

So it is worth enabling, and it is the piece that protects the front door
rather than the hallway.

The reason for care: **every** client that signs in must be attesting before
it is switched on, including staff. Staff use email/password against the same
project, so enforcement on Authentication affects the staff inbox too, and
`/admin/chat` must be initialising App Check as well — not just the customer
page. Enable it in the same window as step 6, verify a staff sign-in
immediately afterwards, and keep the console tab open to switch it back.

One caveat worth stating rather than glossing: exact console wording and
per-product availability for App Check enforcement change over time, and this
container has no network access to Firebase to confirm the current UI. The
architectural conclusion above is sound; check the console's own labelling
when you get there.

## Local development and debug tokens

reCAPTCHA Enterprise cannot issue a token on `localhost` — there is no
verifiable domain. Firebase's answer is a **debug token**.

```js
// Before initializeAppCheck(), in a LOCAL build only. Never committed.
self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
```

That prints a UUID to the browser console; register it under
**App Check → Apps → Manage debug tokens** in the Firebase console.

Rules for debug tokens:

- **Never commit one.** A registered debug token is a permanent App Check
  bypass for whoever holds it. It is a credential.
- Register them per developer, and delete them when they are no longer needed.
- Never enable the debug flag in a production build.

### Never add localhost to the production reCAPTCHA key

The production key is restricted to `esthers.ca`, and that restriction is
what makes publishing the site key safe. Adding `localhost` to the allowed
domains removes it for everybody: anyone can then use the key from a page they
control, which is the whole attack App Check is meant to prevent.

If a real (non-debug) key is wanted for local work, create a **separate**
reCAPTCHA Enterprise key restricted to localhost and select it by environment.
Do not widen the production one.

## Client configuration — supplied

`assets/js/chat-app-check.js` now carries the real public browser config for
the *Esther's Website* web app in project `esther-s-chat`: `apiKey`,
`authDomain`, `projectId`, `appId` and the reCAPTCHA Enterprise **site** key.
`isConfigured()` returns true.

All five are public client identifiers and are meant to be readable in page
source. Nothing private was added — no service-account key, no client email,
no debug token.

`isConfigured()` still guards them: emptying any one makes the module refuse to
initialise rather than start half-configured.

### What has NOT been proven yet, and cannot be from here

A real App Check token has never been issued. The production reCAPTCHA
Enterprise key is restricted to **esthers.ca**, and attestation is performed by
the browser against the page's own hostname — so no token can be minted from
this container, from `localhost`, or from any host that is not esthers.ca.
That is the domain restriction doing its job, and it was deliberately not
weakened.

Everything testable without a live challenge has been: configuration values,
`isConfigured()`, single initialisation, the provider receiving the exact site
key, auto-refresh, concurrent-call memoisation, `getAppCheckToken()` returning
null rather than throwing, and `authorizedFetch()` header behaviour.

**First real token issuance happens when the module is intentionally loaded on
a page served from esthers.ca** — i.e. rollout step 1, on production, with
enforcement still off. A normal Vercel branch preview will not do it: previews
are served from a `*.vercel.app` hostname, which a key restricted to
esthers.ca will refuse.

If a preview needs to attest before production, the options are, in order of
preference:

1. **Do it on production with enforcement off.** The module can be loaded
   without wiring any chat UI; nothing is enforced, so a failure costs nothing.
   This is the intended path and needs no key change.
2. Attach a real custom subdomain to the preview and add only that exact
   hostname to the key.
3. A separate reCAPTCHA key for preview, selected by hostname at runtime.

Do **not** add a broad wildcard such as `*.vercel.app` to the production key
without review: `*.vercel.app` is shared by every Vercel deployment on the
internet, so allowing it would let anyone's project attest as Esther's — which
removes the protection App Check exists to provide.

## Files

| File | Role |
|---|---|
| `api/_chat/app-check.js` | server verification, the enforcement switch |
| `api/_chat/handler.js` | calls the gate, in order, for every chat route |
| `api/_chat/firebase-admin.js` | loads `firebase-admin/app-check`, exposes `appCheck` |
| `assets/js/chat-app-check.js` | browser init + `authorizedFetch` — **not loaded by any page** |
| `assets/js/chat-customer.js` | the customer flow: App Check, anonymous auth, API writes, realtime reads — **gate off** |
| `assets/js/chat.js` | the widget, and the gate that decides whether the transport is ever loaded |
| `docs/CHAT_CUSTOMER_FRONTEND.md` | the customer architecture and the DevTools review walkthrough |
| `tests/chat-api/app-check.test.mjs` | 41 tests, the server gate |
| `tests/chat-api/app-check-client.test.mjs` | 24 tests, the browser App Check module |
| `tests/chat-api/chat-customer.test.mjs` | 104 tests, the customer frontend |
| `tests/chat-api/fixtures/firebase-sdk-stub.mjs` | stands in for the Firebase Web SDK so the client tests need no network |
| `tests/chat-api/fixtures/firebase-sdk-full-stub.mjs` | the same, plus Auth and Firestore, for the customer flow |
| `tests/chat-api/fixtures/source-view.mjs` | reads a module as code rather than as text, so a mention in a comment is not read as a use |
| `tests/chat-api/helpers.mjs` | injectable App Check verifier for tests |
