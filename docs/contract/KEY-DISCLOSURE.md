# Client credential disclosure

Routine key list, detail, update and device responses require an authenticated
operator and never return the stored credential. Their explicit public-field
allowlist prevents newly added private repository fields from becoming response
fields. Key previews disclose only the last four characters of sufficiently long
credentials. All successful responses use `Cache-Control: no-store`.

Creation returns the new credential once. A subsequent deliberate disclosure
uses `POST /api/keys/{id}/reveal` with operator authentication and the same local
administration policy as account changes. The response identifies exactly one
key. An inference credential is insufficient. Missing keys return 404 and refused
requests do not change stored keys. Clients that previously read `key` from list,
detail or update responses must use this explicit action instead.

The Keys interface confirms the selected key before requesting disclosure. It
clears its copy when the dialog closes, the tab becomes hidden or 60 seconds
elapse. A response arriving after closure is ignored. Copying intentionally puts
the value on the operator's clipboard; clearing the dialog cannot recall it.
The server response necessarily discloses the secret to the authenticated browser
and does not promise removal from developer tools or browser-managed memory.

`tests/unit/key-disclosure.test.js` exercises real key storage and API handlers,
including redaction, exact disclosure, authorization, missing keys and future
private fields. `tests/unit/key-reveal-ui.test.js` exercises confirmation, failed
requests, delayed responses, closure and hidden-tab cleanup in the actual page.
Compiled browser verification is recorded separately from these component tests.
