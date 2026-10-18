/**
 * A stand-in for WebSocket, for tests of the chat's socket (#349): records
 * the frames sent, lets the test open it, deliver frames and drop it. Jest's
 * own global is Node's real client, so a test that renders the socket
 * installs this first; `install()` stands in for the global until restoreAllMocks.
 */
export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  /** The frames sent, parsed. */
  sent: unknown[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  /** As React Native's: a send while connecting throws. */
  send = jest.fn((data: string) => {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("INVALID_STATE_ERR");
    this.sent.push(JSON.parse(data));
  });

  close = jest.fn(() => {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  });

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** What arrives as it is: not JSON, or not a string at all. */
  receiveRaw(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** The API or the network ends it: error and then close, as React Native reports a failure. */
  drop(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onerror?.();
    this.onclose?.({ code });
  }

  static latest(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error("FakeWebSocket: no socket was opened");
    return socket;
  }

  static install(): void {
    FakeWebSocket.instances = [];
    // Node's global is a getter: the spy answers in its place.
    jest
      .spyOn(globalThis, "WebSocket", "get")
      .mockReturnValue(FakeWebSocket as unknown as typeof WebSocket);
  }
}
