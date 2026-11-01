export function redact(text) {
  return String(text).replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{16,}|github_pat_[\w]{16,})\b/g,'[REDACTED]')
    .replace(/((?:api[_-]?key|authorization|password|access[_-]?token|secret)\s*["']?\s*[:=]\s*["']?)([^\s"',}]{4,})/gi,'$1[REDACTED]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[REDACTED PRIVATE KEY]');
}
export function errorText(error) {
  if (typeof error==='string') return redact(error);
  return redact(error?.data?.reason ?? error?.data?.message ?? error?.cause?.message ?? error?.message ?? error?.type ?? 'OpenCode RPC thất bại');
}

// Native tool outputs can be branded classes, not plain JSON (ReadTool.TextPage).
export function redactToolOutput(value) {
  if(typeof value==='string')return redact(value);
  if(Array.isArray(value))return value.map(redactToolOutput);
  if(!value||typeof value!=='object')return value;
  const descriptors=Object.getOwnPropertyDescriptors(value);
  for(const key of Reflect.ownKeys(descriptors))if('value' in descriptors[key])descriptors[key].value=redactToolOutput(descriptors[key].value);
  return Object.create(Object.getPrototypeOf(value),descriptors);
}
