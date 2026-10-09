/** Build failures. `exit` is the CLI exit code: 2 = grammar/unknown attribute/unsupported construct, 3 = patch guard failed. */
export class CompileError extends Error {
  constructor(
    message: string,
    readonly exit: 2 | 3 = 2,
  ) {
    super(message)
    this.name = 'CompileError'
  }
}
