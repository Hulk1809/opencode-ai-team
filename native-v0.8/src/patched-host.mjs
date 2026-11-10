// Optional isolated-host extension. No official-API fallback or authority emulation.
export function patchedCanonical(ctx) {
  const canonical=ctx.canonical;
  if(!canonical||typeof canonical.register!=='function'||typeof canonical.invoke!=='function')return null;
  return canonical;
}

export function requirePatchedCanonical(ctx) {
  const canonical=patchedCanonical(ctx);
  if(!canonical)throw Error('PATCHED_CANONICAL_API_REQUIRED');
  return canonical;
}
