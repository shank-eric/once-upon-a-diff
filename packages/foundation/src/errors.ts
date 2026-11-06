/**
 * A refusal the board gives for a request: the session or story is not there (404), the input is not valid (400), the
 * world is in a state that does not allow it (409), or a tool the board calls failed (502). The status is the answer the
 * server gives; the server's one catch turns a BoardError into it (server/index.ts), so board code never imports the server.
 */
export class BoardError extends Error {
  declare status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
