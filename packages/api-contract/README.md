# @hhcp/api-contract

The single, authoritative REST contract for HHCP: `api-types.d.ts`, generated
from the FastAPI reference app's OpenAPI schema.

Both backends must satisfy this contract byte-for-byte (paths, verbs, request
and response shapes, status codes). The frontend imports these types; the
migration's "zero frontend changes" guarantee (analysis §10.1) holds only while
the Node backend keeps producing responses that match this file. The parity gate
(analysis §16) is: regenerate the spec from the Node app and diff it against this
committed copy — any drift fails CI.
