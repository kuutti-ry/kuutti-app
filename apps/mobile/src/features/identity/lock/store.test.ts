import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import {
  clearLock,
  GRACE_MINUTES,
  type LockSettings,
  lockIsOn,
  readLock,
  readTries,
  writeLock,
  writeTries,
} from "./store";

// The lock as this phone keeps it (#418, ADR-045 §2): in the keychain or
// keystore of this phone only, deleted before every write, read back only in
// the shape this app writes, and the wrong tries counted beside it.

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const getItem = SecureStore.getItemAsync as jest.Mock;
const setItem = SecureStore.setItemAsync as jest.Mock;
const deleteItem = SecureStore.deleteItemAsync as jest.Mock;
const THIS_DEVICE = { keychainAccessible: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" };
const PASSCODE = { salt: "0a1b2c3d4e5f4a6b8c7d8e9f0a1b2c3d", hash: "f".repeat(64) };

const lock = (over: Partial<LockSettings> = {}): LockSettings => ({
  biometrics: false,
  passcode: PASSCODE,
  graceMinutes: 1,
  ...over,
});

/** Every call to the store, in order, as "verb key". */
function callsInOrder(): string[] {
  const calls = [
    ...getItem.mock.calls.map((args, i) => ({
      at: getItem.mock.invocationCallOrder[i],
      args,
      verb: "get",
    })),
    ...setItem.mock.calls.map((args, i) => ({
      at: setItem.mock.invocationCallOrder[i],
      args,
      verb: "set",
    })),
    ...deleteItem.mock.calls.map((args, i) => ({
      at: deleteItem.mock.invocationCallOrder[i],
      args,
      verb: "delete",
    })),
  ];
  return calls.sort((a, b) => Number(a.at) - Number(b.at)).map((c) => `${c.verb} ${c.args[0]}`);
}

/** Every call, whatever the verb, carried this phone's keychain option. */
function everyCallKeptOnThisDevice() {
  for (const fn of [getItem, deleteItem]) {
    for (const args of fn.mock.calls) expect(args[1]).toEqual(THIS_DEVICE);
  }
  for (const args of setItem.mock.calls) expect(args[2]).toEqual(THIS_DEVICE);
}

beforeEach(() => {
  store.clear();
  getItem.mockClear();
  setItem.mockClear();
  deleteItem.mockClear();
});
afterEach(() => jest.restoreAllMocks());

describe("lockIsOn", () => {
  it.each([
    ["no lock at all", null, false],
    ["neither way in", lock({ passcode: null }), false],
    ["a passcode alone", lock(), true],
    ["the face or fingerprint alone", lock({ biometrics: true, passcode: null }), true],
    ["both", lock({ biometrics: true }), true],
  ])("is %s: %p", (_, settings, on) => {
    expect(lockIsOn(settings)).toBe(on);
  });
});

describe("readLock", () => {
  it("answers null when nothing is stored", async () => {
    await expect(readLock()).resolves.toBeNull();
    expect(getItem).toHaveBeenCalledWith("kuutti.lock", THIS_DEVICE);
  });

  it.each(GRACE_MINUTES)("reads back a lock written with %p minutes of grace", async (minutes) => {
    const settings = lock({ biometrics: true, graceMinutes: minutes });
    await writeLock(settings);
    await expect(readLock()).resolves.toEqual(settings);
  });

  it("reads a lock with no passcode, the face or fingerprint alone", async () => {
    const settings = lock({ biometrics: true, passcode: null });
    await writeLock(settings);
    await expect(readLock()).resolves.toEqual(settings);
  });

  it("keeps only the fields it knows from what is stored", async () => {
    store.set(
      "kuutti.lock",
      JSON.stringify({
        biometrics: true,
        passcode: { ...PASSCODE, digits: "123456" },
        graceMinutes: 5,
        extra: "x",
      }),
    );
    const read = await readLock();
    expect(read).toEqual({ biometrics: true, passcode: PASSCODE, graceMinutes: 5 });
    expect(JSON.stringify(read)).not.toContain("123456");
  });

  it("has no lock on the web preview and never asks the store", async () => {
    jest.replaceProperty(Platform, "OS", "web");
    store.set("kuutti.lock", JSON.stringify(lock()));
    await expect(readLock()).resolves.toBeNull();
    expect(getItem).not.toHaveBeenCalled();
  });

  const good = { biometrics: false, passcode: PASSCODE, graceMinutes: 1 };
  it.each([
    ["is not JSON", "{"],
    ["is empty", ""],
    ["is JSON null", "null"],
    ["is a number", "5"],
    ["is an array", "[]"],
    ["has no biometrics", JSON.stringify({ ...good, biometrics: undefined })],
    ["has biometrics as a string", JSON.stringify({ ...good, biometrics: "true" })],
    ["has biometrics as a number", JSON.stringify({ ...good, biometrics: 1 })],
    ["has no grace", JSON.stringify({ ...good, graceMinutes: undefined })],
    ["has a grace that is not offered", JSON.stringify({ ...good, graceMinutes: 2 })],
    ["has a grace below the choices", JSON.stringify({ ...good, graceMinutes: -1 })],
    ["has a grace past the choices", JSON.stringify({ ...good, graceMinutes: 30 })],
    ["has the grace as a string", JSON.stringify({ ...good, graceMinutes: "1" })],
    ["has a null grace", JSON.stringify({ ...good, graceMinutes: null })],
    ["has no passcode field", JSON.stringify({ ...good, passcode: undefined })],
    ["has the passcode as a string", JSON.stringify({ ...good, passcode: "123456" })],
    ["has a passcode with no salt", JSON.stringify({ ...good, passcode: { hash: PASSCODE.hash } })],
    ["has a passcode with no hash", JSON.stringify({ ...good, passcode: { salt: PASSCODE.salt } })],
    ["has a numeric salt", JSON.stringify({ ...good, passcode: { ...PASSCODE, salt: 7 } })],
    ["has a null hash", JSON.stringify({ ...good, passcode: { ...PASSCODE, hash: null } })],
  ])("refuses a stored lock that %s", async (_, raw) => {
    store.set("kuutti.lock", raw);
    await expect(readLock()).rejects.toThrow();
  });

  it("refuses with the store's own error when the store cannot be read", async () => {
    getItem.mockRejectedValueOnce(new Error("keychain locked"));
    await expect(readLock()).rejects.toThrow("keychain locked");
  });
});

describe("writeLock", () => {
  it("writes the item in place, on this phone only, so a failed write leaves the lock as it was", async () => {
    await writeLock(lock({ biometrics: true, graceMinutes: 15 }));
    expect(callsInOrder()).toEqual(["set kuutti.lock"]);
    expect(setItem).toHaveBeenCalledWith(
      "kuutti.lock",
      JSON.stringify(lock({ biometrics: true, graceMinutes: 15 })),
      THIS_DEVICE,
    );
    everyCallKeptOnThisDevice();
  });

  it("removes the lock and its tries instead of writing a lock with neither way in", async () => {
    store.set("kuutti.lock", JSON.stringify(lock()));
    store.set("kuutti.lock.tries", "3");
    await writeLock(lock({ biometrics: false, passcode: null }));
    expect(setItem).not.toHaveBeenCalled();
    expect(store.has("kuutti.lock")).toBe(false);
    expect(store.has("kuutti.lock.tries")).toBe(false);
    everyCallKeptOnThisDevice();
  });

  it("passes on the store's error", async () => {
    setItem.mockRejectedValueOnce(new Error("disk full"));
    await expect(writeLock(lock())).rejects.toThrow("disk full");
  });
});

describe("clearLock", () => {
  it("deletes the lock and the tries, on this phone only", async () => {
    store.set("kuutti.lock", JSON.stringify(lock()));
    store.set("kuutti.lock.tries", "2");
    store.set("kuutti.session", "kept");
    await clearLock();
    expect(callsInOrder()).toEqual(["delete kuutti.lock", "delete kuutti.lock.tries"]);
    expect([...store.keys()]).toEqual(["kuutti.session"]);
    everyCallKeptOnThisDevice();
  });

  it("does nothing on the web preview, which has no lock", async () => {
    jest.replaceProperty(Platform, "OS", "web");
    await clearLock();
    expect(deleteItem).not.toHaveBeenCalled();
  });
});

describe("readTries", () => {
  it("is 0 when nothing is stored", async () => {
    await expect(readTries()).resolves.toBe(0);
    expect(getItem).toHaveBeenCalledWith("kuutti.lock.tries", THIS_DEVICE);
  });

  it.each([
    ["0", 0],
    ["1", 1],
    ["4", 4],
    ["5", 5],
    ["12", 12],
  ])("reads %p as %p", async (raw, tries) => {
    store.set("kuutti.lock.tries", raw);
    await expect(readTries()).resolves.toBe(tries);
  });

  it.each([
    ["a negative count", "-1"],
    ["a fraction", "1.5"],
    ["words", "three"],
    ["infinity", "Infinity"],
    ["not a number", "NaN"],
    ["an empty string", ""],
  ])("counts %s as no tries", async (_, raw) => {
    store.set("kuutti.lock.tries", raw);
    await expect(readTries()).resolves.toBe(0);
  });

  it("passes on the store's error", async () => {
    getItem.mockRejectedValueOnce(new Error("keychain locked"));
    await expect(readTries()).rejects.toThrow("keychain locked");
  });
});

describe("writeTries", () => {
  it("writes a count in place, on this phone only", async () => {
    await writeTries(3);
    expect(callsInOrder()).toEqual(["set kuutti.lock.tries"]);
    expect(store.get("kuutti.lock.tries")).toBe("3");
    everyCallKeptOnThisDevice();
  });

  it("writes one try as the first count", async () => {
    await writeTries(1);
    expect(store.get("kuutti.lock.tries")).toBe("1");
  });

  it("removes the count when it goes back to none", async () => {
    store.set("kuutti.lock.tries", "4");
    await writeTries(0);
    expect(callsInOrder()).toEqual(["delete kuutti.lock.tries"]);
    expect(store.has("kuutti.lock.tries")).toBe(false);
    everyCallKeptOnThisDevice();
  });

  it("reads back what it wrote", async () => {
    await writeTries(2);
    await expect(readTries()).resolves.toBe(2);
  });
});
