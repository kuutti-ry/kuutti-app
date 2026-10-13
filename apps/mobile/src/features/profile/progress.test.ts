import { PHOTOS_FOR_COMPLETENESS, PROMPTS_MAX, type ProfileUpdate } from "@kuutti/schema";
import { answeredPrompts, isDone, type Progress, photoProgress, sectionProgress } from "./progress";
import { findSection, PROFILE_SECTIONS, type SectionId } from "./sections";
import { EMPTY_PROFILE } from "./useProfile";

// How far each part of the profile is filled, for the marks of the list (#239).

const profile = (patch: Partial<ProfileUpdate> = {}): ProfileUpdate => ({
  ...EMPTY_PROFILE,
  ...patch,
});
const of = (id: SectionId, p: ProfileUpdate): Progress => {
  const section = findSection(id);
  if (!section) throw new Error(id);
  return sectionProgress(section, p);
};

describe("sectionProgress", () => {
  it("counts nothing answered on an empty profile, with each section's total", () => {
    expect(Object.fromEntries(PROFILE_SECTIONS.map(({ id }) => [id, of(id, profile())]))).toEqual({
      basics: { answered: 0, total: 4 },
      prompts: { answered: 0, total: PROMPTS_MAX },
      relationship: { answered: 0, total: 4 },
      work: { answered: 0, total: 3 },
      lifestyle: { answered: 0, total: 5 },
      hobbies: { answered: 0, total: 1 },
      beliefs: { answered: 0, total: 3 },
    });
  });

  it("counts the name only when it holds more than blanks, and a bio or its placeholder alike", () => {
    expect(of("basics", profile({ displayName: "   " }))).toEqual({ answered: 0, total: 4 });
    expect(of("basics", profile({ displayName: "Aino" }))).toEqual({ answered: 1, total: 4 });
    expect(of("basics", profile({ bio: "Hello" }))).toEqual({ answered: 1, total: 4 });
    expect(of("basics", profile({ bioPreset: "photos_speak" }))).toEqual({ answered: 1, total: 4 });
    expect(
      of(
        "basics",
        profile({ displayName: "Aino", bio: "Hi", fields: { height: 170, languages: ["fi"] } }),
      ),
    ).toEqual({ answered: 4, total: 4 });
  });

  it("leaves the identity label out: shown only once given, it is no gap", () => {
    expect(
      of("basics", profile({ displayName: "Aino", fields: { identityLabel: "agender" } })),
    ).toEqual({ answered: 1, total: 4 });
  });

  it("leaves a setting and a companion out: hiding from one's field and the job title", () => {
    expect(
      of(
        "work",
        profile({ fields: { hideFromField: true, occupationTitle: "Nurse", education: "amk" } }),
      ),
    ).toEqual({ answered: 1, total: 3 });
    expect(
      of(
        "work",
        profile({ fields: { education: "amk", field: ["health"], occupation: ["student"] } }),
      ),
    ).toEqual({ answered: 3, total: 3 });
  });

  it("counts each prompt with an answer, never a blank one or more than three", () => {
    expect(
      of(
        "prompts",
        profile({
          prompts: [
            { key: "sunday", answer: "A long breakfast." },
            { key: "hidden_talent", answer: "  " },
          ],
        }),
      ),
    ).toEqual({ answered: 1, total: PROMPTS_MAX });
  });

  it("counts 'none of them' and a stance as answers like any other", () => {
    expect(
      of("beliefs", profile({ fields: { politics: ["none_of_them"], religion: "atheist" } })),
    ).toEqual({ answered: 2, total: 3 });
  });
});

describe("answeredPrompts", () => {
  it("counts the prompts that hold more than blanks", () => {
    expect(answeredPrompts([])).toBe(0);
    expect(
      answeredPrompts([
        { key: "sunday", answer: "x" },
        { key: "hidden_talent", answer: "" },
        { key: "teach_me", answer: " \n" },
      ]),
    ).toBe(1);
  });
});

describe("photoProgress", () => {
  it("counts approved photos up to what a card needs, and is done there", () => {
    expect(photoProgress(0)).toEqual({ answered: 0, total: PHOTOS_FOR_COMPLETENESS });
    expect(photoProgress(1)).toEqual({ answered: 1, total: PHOTOS_FOR_COMPLETENESS });
    expect(isDone(photoProgress(PHOTOS_FOR_COMPLETENESS - 1))).toBe(false);
    expect(isDone(photoProgress(PHOTOS_FOR_COMPLETENESS))).toBe(true);
    expect(photoProgress(6)).toEqual({
      answered: PHOTOS_FOR_COMPLETENESS,
      total: PHOTOS_FOR_COMPLETENESS,
    });
  });
});

describe("isDone", () => {
  it("is done when everything counted is answered", () => {
    expect(isDone({ answered: 0, total: 1 })).toBe(false);
    expect(isDone({ answered: 1, total: 1 })).toBe(true);
    expect(isDone({ answered: 0, total: 0 })).toBe(true);
  });
});
