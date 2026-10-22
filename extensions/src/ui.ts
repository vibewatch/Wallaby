export function element<T extends Element>(selector: string, type: new (...args: never[]) => T): T {
  const node = document.querySelector(selector);
  if (!(node instanceof type)) throw new Error(`Missing interface element: ${selector}`);
  return node;
}

export function showStatus(message: string, error = false) {
  const status = element("#status", HTMLElement);
  status.textContent = message;
  status.classList.toggle("error", error);
  status.setAttribute("role", error ? "alert" : "status");
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}
