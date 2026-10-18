import * as ImagePicker from "expo-image-picker";
import { setLocalCheck } from "./localCheck";
import { pickPhoto, pickPrepared, prepareForUpload, UPLOAD_LONG_EDGE } from "./pick";

const { ImageManipulator } = jest.requireMock("expo-image-manipulator") as {
  ImageManipulator: { manipulate: jest.Mock };
};
const launch = ImagePicker.launchImageLibraryAsync as jest.Mock;

beforeEach(() => {
  launch.mockReset();
  ImageManipulator.manipulate.mockClear();
});

describe("picking a photo", () => {
  it("asks for one still image without EXIF and reports a cancel as such", async () => {
    launch.mockResolvedValueOnce({ canceled: true, assets: null });
    expect(await pickPhoto()).toEqual({ kind: "cancelled" });
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaTypes: ["images"],
        allowsMultipleSelection: false,
        exif: false,
      }),
    );
  });

  it("returns the picked asset's uri and size", async () => {
    launch.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///a.heic", width: 4032, height: 3024 }],
    });
    expect(await pickPhoto()).toEqual({
      kind: "picked",
      asset: { uri: "file:///a.heic", width: 4032, height: 3024 },
    });
  });

  it("reads a finished pick that hands back no asset as a cancel", async () => {
    launch.mockResolvedValueOnce({ canceled: false, assets: [] });
    expect(await pickPhoto()).toEqual({ kind: "cancelled" });
  });

  it("reads a picker that throws as a denied permission", async () => {
    launch.mockRejectedValueOnce(new Error("Missing permission"));
    expect(await pickPhoto()).toEqual({ kind: "denied" });
  });
});

describe("preparing for upload", () => {
  it("resizes a landscape picture to 1600 px wide and saves a JPEG", async () => {
    const prepared = await prepareForUpload({ uri: "file:///a.heic", width: 4032, height: 3024 });
    const context = ImageManipulator.manipulate.mock.results[0]?.value as {
      resize: jest.Mock;
    };
    expect(context.resize).toHaveBeenCalledWith({ width: UPLOAD_LONG_EDGE });
    expect(prepared).toEqual({
      uri: "file:///a.heic#resized",
      width: 1600,
      height: 1067,
      mimeType: "image/jpeg",
    });
  });

  it("resizes a portrait picture by its height", async () => {
    await prepareForUpload({ uri: "file:///p.jpg", width: 3000, height: 4000 });
    const context = ImageManipulator.manipulate.mock.results[0]?.value as {
      resize: jest.Mock;
    };
    expect(context.resize).toHaveBeenCalledWith({ height: UPLOAD_LONG_EDGE });
  });

  it("re-saves a small picture without resizing, so its EXIF goes all the same", async () => {
    const prepared = await prepareForUpload({ uri: "file:///s.jpg", width: 800, height: 600 });
    const context = ImageManipulator.manipulate.mock.results[0]?.value as {
      resize: jest.Mock;
    };
    expect(context.resize).not.toHaveBeenCalled();
    expect(prepared.uri).toBe("file:///s.jpg#resized");
    expect(prepared.mimeType).toBe("image/jpeg");
  });
});

describe("the chain before an upload (#48, #350)", () => {
  afterEach(() => setLocalCheck(null));

  it("picks, checks and resizes, saying when the picture is being prepared", async () => {
    launch.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///a.heic", width: 4032, height: 3024 }],
    });
    const preparing = jest.fn();
    expect(await pickPrepared(preparing)).toEqual({
      kind: "picked",
      photo: { uri: "file:///a.heic#resized", width: 1600, height: 1067, mimeType: "image/jpeg" },
    });
    expect(preparing).toHaveBeenCalledTimes(1);
  });

  it("hands back a cancel and a denied library as they came, preparing nothing", async () => {
    const preparing = jest.fn();
    launch.mockResolvedValueOnce({ canceled: true, assets: null });
    expect(await pickPrepared(preparing)).toEqual({ kind: "cancelled" });
    launch.mockRejectedValueOnce(new Error("Missing permission"));
    expect(await pickPrepared()).toEqual({ kind: "denied" });
    expect(preparing).not.toHaveBeenCalled();
    expect(ImageManipulator.manipulate).not.toHaveBeenCalled();
  });

  it("stops at the on-device check's refusal, before the resize", async () => {
    launch.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///nude.jpg", width: 1200, height: 900 }],
    });
    const checked: string[] = [];
    setLocalCheck(async (uri) => {
      checked.push(uri);
      return "refuse";
    });
    expect(await pickPrepared()).toEqual({ kind: "refused_local" });
    expect(checked).toEqual(["file:///nude.jpg"]);
    expect(ImageManipulator.manipulate).not.toHaveBeenCalled();
  });
});
