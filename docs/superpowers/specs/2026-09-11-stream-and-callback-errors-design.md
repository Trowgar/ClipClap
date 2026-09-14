# Stream and Callback Errors Design

## Goal

Remove the genuine SSE progress-stream error and reject forged Google OAuth
callbacks before they reach Auth.js, without weakening any authentication
check.

## Evidence

- The web log records `ERR_INVALID_STATE` from the stream route when a browser
  cancels its EventSource request. The route owns a repeating timer but has no
  `ReadableStream.cancel` handler, so the timer later enqueues into a closed
  controller.
- Every real Google callback today carried
  `iss=https://accounts.google.com` and completed successfully. The two
  `CallbackRouteError` entries used random issuer values and were rejected as
  intended by Auth.js.

## Design

### SSE lifecycle

Keep the existing two-second polling protocol. The route will own one stop
function that marks the stream closed and clears the timer. `cancel`, terminal
job states, missing jobs, and database failures all use that function. Sending
will be a no-op once closed and will stop the stream if `enqueue` reports it
was closed concurrently.

### Forged Google callbacks

In nginx's http-level maps, mark only requests to
`/api/auth/callback/google` that provide a non-empty `iss` other than
`https://accounts.google.com`. The server policy returns 400 for that marker
before proxying. A callback with the expected issuer, or an absent issuer,
continues to Auth.js, which retains its own OAuth state and issuer checks.

### Testing

Add a route regression test that cancels the response body, advances the
polling clock, and proves no job lookup or enqueue continues. Extend the nginx
config test to assert the issuer guard exists and retain `nginx -t` validation.
Run the focused tests, full test suite, lint, and a production build using Node
22. The pre-existing analytics-suite failure is reported separately.

## Out of scope

Do not accept arbitrary OAuth issuers, alter Google provider settings, or add
a broad block for POST/Server Action scanner traffic; those requests are
already rejected and a broad rule could break valid server actions.
