import { AGE_MAX, AGE_MIN } from "@kuutti/schema";
import { fireEvent, screen } from "@testing-library/react-native";
import { noProblems } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { AgeWindowSteppers } from "./AgeWindowSteppers";

// The youngest and the oldest one seeks, as What you seek and onboarding ask them (#581).

const button = (name: string) => screen.getByRole("button", { name });
const off = (name: string) => button(name).props.accessibilityState?.disabled === true;

describe("AgeWindowSteppers", () => {
  it("moves the youngest and the oldest a year at a time, one above the other", async () => {
    const onChange = jest.fn();
    await renderWithTheme(<AgeWindowSteppers ages={{ min: 25, max: 35 }} onChange={onChange} />);
    expect(screen.getByText("Youngest")).toBeTruthy();
    expect(screen.getByText("Oldest")).toBeTruthy();
    await fireEvent.press(button("Youngest, one year older"));
    expect(onChange).toHaveBeenLastCalledWith({ min: 26, max: 35 });
    await fireEvent.press(button("Youngest, one year younger"));
    expect(onChange).toHaveBeenLastCalledWith({ min: 24, max: 35 });
    await fireEvent.press(button("Oldest, one year younger"));
    expect(onChange).toHaveBeenLastCalledWith({ min: 25, max: 34 });
    await fireEvent.press(button("Oldest, one year older"));
    expect(onChange).toHaveBeenLastCalledWith({ min: 25, max: 36 });
    noProblems();
  });

  it("never lets the youngest pass the oldest", async () => {
    await renderWithTheme(<AgeWindowSteppers ages={{ min: 30, max: 30 }} onChange={jest.fn()} />);
    expect(off("Youngest, one year older")).toBe(true);
    expect(off("Oldest, one year younger")).toBe(true);
    expect(off("Youngest, one year younger")).toBe(false);
    expect(off("Oldest, one year older")).toBe(false);
  });

  it("stops at the youngest and the oldest age Kuutti has", async () => {
    await renderWithTheme(
      <AgeWindowSteppers ages={{ min: AGE_MIN, max: AGE_MAX }} onChange={jest.fn()} />,
    );
    expect(off("Youngest, one year younger")).toBe(true);
    expect(off("Oldest, one year older")).toBe(true);
    expect(off("Youngest, one year older")).toBe(false);
    expect(off("Oldest, one year younger")).toBe(false);
  });
});
