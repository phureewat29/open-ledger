// A type, not a message shape, so rewording a message can't move the exit
// code; import-free so the CLI can `instanceof` it without loading libsql.
export class DBNotReadyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DBNotReadyError";
  }
}
