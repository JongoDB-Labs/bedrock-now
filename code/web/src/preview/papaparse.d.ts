// The part of papaparse 5.7.0's API this page uses (the package ships no types; string input, no workers of its own,
// no downloads, no dynamic typing).
declare module 'papaparse' {
  export interface ParseMeta {
    delimiter: string;
    linebreak: string;
    aborted: boolean;
    truncated: boolean;
    cursor: number;
  }
  export interface ParseError {
    type: string;
    code: string;
    message: string;
    row?: number;
  }
  export interface ParseResult<T> {
    data: T;
    errors: ParseError[];
    meta: ParseMeta;
  }
  export interface Parser {
    abort(): void;
  }
  export interface ParseConfig {
    delimiter?: string;
    newline?: '' | '\n' | '\r' | '\r\n';
    quoteChar?: string;
    escapeChar?: string;
    header?: false;
    dynamicTyping?: false;
    preview?: number;
    comments?: false;
    skipEmptyLines?: boolean | 'greedy';
    delimitersToGuess?: string[];
    step?: (results: ParseResult<string[]>, parser: Parser) => void;
    complete?: () => void;
  }
  const Papa: { parse(input: string, config: ParseConfig): ParseResult<string[][]> };
  export default Papa;
}
