import { fireEvent, screen } from "@testing-library/react-native";
import * as React from "react";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { PasscodeField } from "./PasscodeField";

// The lock's six digits (#418): hidden as they are typed, digits only, named
// by its label to a screen reader, and handed on at the sixth digit with no
// button to reach for.

const LABEL = "Your Kuutti passcode";

/** The field as a screen holds it: its value in state, both calls seen. */
function Held({
  onChange,
  onComplete,
  autoFocus,
}: {
  onChange: jest.Mock;
  onComplete: jest.Mock;
  autoFocus?: boolean;
}) {
  const [value, setValue] = React.useState("");
  return (
    <PasscodeField
      label={LABEL}
      value={value}
      onChange={(digits) => {
        onChange(digits);
        setValue(digits);
      }}
      onComplete={onComplete}
      autoFocus={autoFocus}
    />
  );
}

async function show(props: { autoFocus?: boolean } = {}) {
  const onChange = jest.fn();
  const onComplete = jest.fn();
  await renderWithTheme(<Held onChange={onChange} onComplete={onComplete} {...props} />);
  return { onChange, onComplete, field: () => screen.getByLabelText(LABEL) };
}

describe("PasscodeField", () => {
  it("names the field by its label, shown above it too, with no accessibility problems", async () => {
    const { field } = await show();
    expect(screen.getByText(LABEL)).toBeTruthy();
    expect(field().props.accessibilityLabel).toBe(LABEL);
    const found = pressables(screen.toJSON() as HostNode);
    expect(found).toHaveLength(1);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
  });

  it("hides the digits, asks for a number pad, and offers nothing from autofill", async () => {
    const { field } = await show();
    expect(field().props).toMatchObject({
      secureTextEntry: true,
      maxLength: 6,
      inputMode: "numeric",
      keyboardType: "number-pad",
      textContentType: "none",
      autoComplete: "off",
      autoCorrect: false,
    });
  });

  it.each([
    [true, true],
    [false, false],
    [undefined, undefined],
  ])("takes the focus as it is told: %p", async (autoFocus, expected) => {
    const { field } = await show({ autoFocus });
    expect(field().props.autoFocus).toBe(expected);
  });

  it("hands on the code at the sixth digit, once", async () => {
    const { onChange, onComplete, field } = await show();
    for (const typed of ["1", "12", "123", "1234", "12345"]) {
      await fireEvent.changeText(field(), typed);
      expect(onChange).toHaveBeenLastCalledWith(typed);
    }
    expect(onComplete).not.toHaveBeenCalled();
    await fireEvent.changeText(field(), "123456");
    expect(onChange).toHaveBeenLastCalledWith("123456");
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("123456");
    expect(field().props.value).toBe("123456");
  });

  it.each([
    ["letters among the digits", "12a3", "123"],
    ["only letters", "abcdef", ""],
    ["a space and a dash", "12 3-4", "1234"],
    ["a decimal point", "1.5", "15"],
    ["a minus sign", "-12", "12"],
    ["nothing", "", ""],
  ])("drops %s and hands nothing on", async (_, typed, digits) => {
    const { onChange, onComplete, field } = await show();
    await fireEvent.changeText(field(), typed);
    expect(onChange).toHaveBeenLastCalledWith(digits);
    expect(field().props.value).toBe(digits);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it.each([
    ["six digits among other characters", "12-34-56", "123456"],
    ["a pasted code longer than six digits", "1234567890", "123456"],
    ["six digits with spaces around them", " 987654 ", "987654"],
  ])("keeps the first six digits of %s and hands them on", async (_, typed, digits) => {
    const { onChange, onComplete, field } = await show();
    await fireEvent.changeText(field(), typed);
    expect(onChange).toHaveBeenLastCalledWith(digits);
    expect(onComplete).toHaveBeenCalledWith(digits);
  });

  it("hands on nothing when a digit is taken away from six", async () => {
    const { onComplete, field } = await show();
    await fireEvent.changeText(field(), "123456");
    await fireEvent.changeText(field(), "12345");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
