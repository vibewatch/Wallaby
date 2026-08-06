export function sanitizeReaderCss(value: string): string | null {
  const input = value.trim();
  if (!input) return null;
  if (input.length > 20_000) throw new Error("Custom reader CSS is limited to 20,000 characters");
  if (/[{}<>@]/.test(input) || /(?:url|expression|image-set)\s*\(/i.test(input) || /javascript:|behavior\s*:|-moz-binding/i.test(input)) {
    throw new Error("Custom reader CSS may contain declarations only and cannot load external resources");
  }
  const declarations = input.split(";").map((part) => part.trim()).filter(Boolean);
  if (!declarations.length || declarations.some((declaration) => !/^[-a-zA-Z][\w-]*\s*:\s*[^:]+$/.test(declaration))) {
    throw new Error("Custom reader CSS must be a semicolon-separated declaration list");
  }
  return `${declarations.join("; ")};`;
}
