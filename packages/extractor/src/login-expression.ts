import { JSDOM } from "jsdom";
import safeRegex from "safe-regex2";

type Expression = { kind: "string"; value: string } | { kind: "call"; name: string; arguments: Expression[] };

export async function evaluateLoginExpression(expression: string, context: {
  loginUri: string;
  requestHtml: (url: string) => Promise<string>;
}): Promise<string> {
  const parsed = new Parser(expression).parse();
  return evaluate(parsed, context);
}

async function evaluate(expression: Expression, context: { loginUri: string; requestHtml: (url: string) => Promise<string> }): Promise<string> {
  if (expression.kind === "string") return expression.value;
  if (expression.name === "config.getLoginUri") {
    if (expression.arguments.length) throw new Error("config.getLoginUri does not accept arguments");
    return context.loginUri;
  }
  if (expression.name === "request_html") {
    expectArguments(expression, 1);
    return context.requestHtml(await evaluate(expression.arguments[0], context));
  }
  if (expression.name === "xpath") {
    expectArguments(expression, 2);
    const [query, html] = await Promise.all(expression.arguments.map((value) => evaluate(value, context)));
    return xpath(query, html);
  }
  if (expression.name === "preg_match") {
    expectArguments(expression, 2);
    const [pattern, html] = await Promise.all(expression.arguments.map((value) => evaluate(value, context)));
    return pregMatch(pattern, html);
  }
  throw new Error(`Unsupported login expression function ${expression.name}`);
}

function xpath(query: string, html: string): string {
  try {
    const dom = new JSDOM(html);
    const result = dom.window.document.evaluate(query, dom.window.document, null, dom.window.XPathResult.ANY_TYPE, null);
    if (result.resultType === dom.window.XPathResult.STRING_TYPE) return result.stringValue;
    if (result.resultType === dom.window.XPathResult.NUMBER_TYPE) return String(result.numberValue);
    if (result.resultType === dom.window.XPathResult.BOOLEAN_TYPE) return String(result.booleanValue);
    const node = result.iterateNext();
    if (!node) return "";
    if (node.nodeType === dom.window.Node.ATTRIBUTE_NODE) return node.nodeValue ?? "";
    return node instanceof dom.window.Element ? node.getAttribute("value") ?? "" : "";
  } catch {
    return "";
  }
}

function pregMatch(pattern: string, html: string): string {
  try {
    const delimiter = pattern[0];
    if (!delimiter || /[\p{L}\p{N}\\\s]/u.test(delimiter)) return "";
    let end = -1;
    for (let index = pattern.length - 1; index > 0; index -= 1) {
      if (pattern[index] === delimiter && pattern[index - 1] !== "\\") { end = index; break; }
    }
    if (end < 1) return "";
    const source = pattern.slice(1, end).replaceAll(`\\${delimiter}`, delimiter);
    const phpFlags = pattern.slice(end + 1);
    const flags = [...new Set([...phpFlags].filter((flag) => "imsu".includes(flag)))].join("");
    const regex = new RegExp(source, flags);
    if (!safeRegex(regex)) return "";
    const match = regex.exec(html);
    return match?.length === 2 ? match[1] : "";
  } catch {
    return "";
  }
}

function expectArguments(expression: Extract<Expression, { kind: "call" }>, count: number): void {
  if (expression.arguments.length !== count) throw new Error(`${expression.name} expects ${count} arguments`);
}

class Parser {
  private position = 0;

  constructor(private readonly source: string) {}

  parse(): Expression {
    const expression = this.expression();
    this.space();
    if (this.position !== this.source.length) throw this.error("Unexpected login-expression input");
    return expression;
  }

  private expression(): Expression {
    this.space();
    const character = this.source[this.position];
    if (character === '"' || character === "'") return { kind: "string", value: this.string(character) };
    const name = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(this.source.slice(this.position))?.[0];
    if (!name) throw this.error("Expected a string or function call");
    this.position += name.length;
    this.space();
    if (this.source[this.position++] !== "(") throw this.error("Expected an opening parenthesis");
    const arguments_: Expression[] = [];
    this.space();
    while (this.source[this.position] !== ")") {
      arguments_.push(this.expression());
      this.space();
      if (this.source[this.position] === ",") { this.position += 1; continue; }
      if (this.source[this.position] !== ")") throw this.error("Expected a comma or closing parenthesis");
    }
    this.position += 1;
    return { kind: "call", name, arguments: arguments_ };
  }

  private string(quote: string): string {
    this.position += 1;
    let value = "";
    while (this.position < this.source.length && this.source[this.position] !== quote) {
      if (this.source[this.position] === "\\" && this.position + 1 < this.source.length) {
        value += this.source[this.position + 1];
        this.position += 2;
      } else {
        value += this.source[this.position++];
      }
    }
    if (this.source[this.position] !== quote) throw this.error("Unterminated login-expression string");
    this.position += 1;
    return value;
  }

  private space(): void {
    while (/\s/.test(this.source[this.position] ?? "")) this.position += 1;
  }

  private error(message: string): Error {
    return new Error(`${message} at character ${this.position + 1}`);
  }
}
