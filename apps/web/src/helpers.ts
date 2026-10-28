export function resolveReceiver(body: string, selected: string, roles: string[]): string {
  const allowed = new Set(['team', ...roles]);
  for (const match of body.matchAll(/@([\p{L}\p{N}_-]+)/gu)) {
    if (allowed.has(match[1])) return match[1];
  }
  return selected;
}

export function dependencies(value: string): string[] {
  return [...new Set(value.split(',').map(id => id.trim()).filter(Boolean))];
}
