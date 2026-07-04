// Service-hop queue body: capnp-encoded ServiceMessage bytes (service.capnp)
// framing the EventEnvelope with the signed identity-context token (compact
// JWS) as a sibling Text field. The token is minted by the sending service
// and verified at the receiving boundary before Cedar runs; it binds a hash
// of the envelope bytes.
export type ServiceMessageBytes = Uint8Array;
