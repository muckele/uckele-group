import { createHash } from 'node:crypto';

function framedDigest(...parts) {
  const framed = parts.map((part) => {
    const value = JSON.stringify(part);
    return [Buffer.byteLength(value), value];
  });
  return createHash('sha256').update(JSON.stringify(framed)).digest('hex');
}

function recipients(value) {
  return (Array.isArray(value) ? value : [value]).filter(Boolean).map(String);
}

export function buildCimProviderPayloadDigest({
  message, touchIds, templateVersions, payloadVersion,
} = {}) {
  return framedDigest(
    'cim-payload:v1',
    String(message?.from || ''),
    recipients(message?.to),
    recipients(message?.cc),
    recipients(message?.bcc),
    String(message?.replyTo || ''),
    String(message?.subject || ''),
    String(message?.text || ''),
    String(message?.html || ''),
    Array.isArray(message?.tags) ? message.tags : [],
    [...(touchIds || [])].map(String).sort(),
    [...(templateVersions || [])].map(String),
    String(payloadVersion || ''),
  );
}
