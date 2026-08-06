export function parseCliArgs(values = process.argv.slice(2)): { positionals: string[]; flags: Set<string>; options: Map<string, string> } {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const options = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const separator = value.indexOf("=");
    if (separator > 2) { options.set(value.slice(2, separator), value.slice(separator + 1)); continue; }
    const name = value.slice(2);
    const next = values[index + 1];
    if (next && !next.startsWith("--")) { options.set(name, next); index += 1; }
    else flags.add(name);
  }
  return { positionals, flags, options };
}

export function cliBoolean(args: ReturnType<typeof parseCliArgs>, ...names: string[]): boolean {
  for (const name of names) {
    if (args.flags.has(name)) return true;
    const value = args.options.get(name)?.trim().toLowerCase();
    if (value !== undefined) return ["1", "true", "yes", "on"].includes(value);
  }
  return false;
}
