# Bug-Audit Checklist

The categories below target the bugs that **type-checkers and linters do not
catch**. Walk every category against the code in scope. Each item is phrased as
"look for…". This checklist was distilled from real production bugs found and
fixed while shipping a React + TypeScript PWA.

## 1. Async & state lifecycle
- State updates after unmount (set state inside a resolved promise with no
  `isMounted` / `cancelled` guard).
- Stale closures in `useEffect`/`useCallback` (missing or wrong dependency
  arrays; a handler capturing an old value).
- Effects that fire before async prerequisites are ready (e.g. acting on a
  client/token that is still `null`).
- Double-fire: the same terminal action (submit, session-end) running twice;
  guard with a ref.
- Race between a fixed `setTimeout` and an async init that may take longer.

## 2. Cleanup & resource leaks
- Event listeners / intervals / timeouts added but never removed.
- Media streams (camera/mic) acquired but not `.stop()`-ed on every exit path.
- Subscriptions/observers left dangling on unmount.
- A resource attached to a DOM ref before the element has rendered.

## 3. Error handling & classification
- A broad `catch` that swallows or mislabels distinct errors (e.g. treating an
  HTTP-status error as "offline" because the message contains "fetch").
- Errors surfaced to the user as raw/garbled text, or truncated so the useful
  part (status code, reason) is hidden.
- Missing `console.error` on the real error, leaving failures undiagnosable.
- Streaming/iterator code where one bad chunk aborts the whole operation.
- Empty/blank success path (e.g. a response with no text) left unhandled,
  leaving the UI stuck on a loading state.

## 4. Auth, tokens & sessions
- ID token vs access token confusion (using the wrong one for an API).
- A required credential kept only in memory and lost on refresh, with no
  recovery path.
- Token expiry not handled (no reconnect / re-auth flow).
- Decryption keyed on an identity that may differ from the one used to encrypt.

## 5. Security
- Secrets committed or logged (`.env`, API keys, tokens) — verify `.gitignore`
  and the staged set.
- Plaintext storage of credentials that should be encrypted.
- Missing input validation / sanitisation before use or storage.
- Over-broad permissions or scopes; public vs private data not separated.
- A documented protection (PIN, gate) that the code does not actually enforce.

## 6. Storage & data integrity
- Unbounded writes (quota exceeded) without graceful handling.
- Schema changes without a migration / version bump where one is required.
- Stale defaults silently changing behaviour after an update (migrate once).
- Delete operations that remove too much (shared/global data) or too little
  (orphaned per-entity rows / cache keys left behind).
- JSON parse without a try/catch on persisted/remote strings.

## 7. Network & offline
- No offline fallback / no detection of connectivity loss.
- Assuming a remote call succeeds; no retry or user-visible failure state.
- CORS / referer / origin assumptions that break in production.

## 8. Edge cases & boundaries
- Empty states (no data yet) — does every list/grid/screen handle zero items?
- Off-by-one and "applied N times" bugs (e.g. a daily decay running on every
  mount instead of once per day).
- Boundary values (min/max, first run, last item removed).
- Duplicate or case-mismatched keys when de-duplicating.
- Locale/format assumptions (dates, numbers, RTL).

## 9. Concurrency & ordering
- Two flows mutating the same store/record without coordination.
- Order-dependent effects that React may run in a different order than assumed.
- Debounced/throttled handlers that drop or duplicate the final event.

## 10. Performance & UX
- Large single bundle (no code-splitting) inflating first load.
- Re-renders from unstable callback/object identities.
- Blocking the main thread on large synchronous work.
- Missing loading skeletons / the UI hanging with no feedback.

## 11. Accessibility & input
- Interactive elements without labels/roles; nested interactive elements
  (e.g. a `<button>` inside a `<button>`).
- Keyboard/`Enter` handling missing on custom inputs.
- Color-only state with no text/icon alternative.

## 12. Config, build & deploy
- Build-time vs runtime env var confusion.
- Platform-specific routing/asset config missing (SPA fallback, base path).
- Config files that conflict between two deploy targets.

---

**For each finding, capture:** `file:line · severity · failure scenario · fix`.
Severity = **Critical** (data loss, security, crash, broken core flow) /
**Medium** (degraded UX, edge-case break) / **Low** (polish, minor).
