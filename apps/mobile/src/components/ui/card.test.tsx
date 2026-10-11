import { screen } from "@testing-library/react-native";
import { renderWithTheme } from "@/test/render";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";
import { Text } from "./text";

// The card (#12, TD-9): a surface whose text takes the card's foreground, a
// title a screen reader announces as a heading, and its sections in order.

describe("Card", () => {
  it("lays out header, content and footer, and its title is a level-3 heading", async () => {
    await renderWithTheme(
      <Card>
        <CardHeader>
          <CardTitle>Your pond</CardTitle>
          <CardDescription>How it fills up</CardDescription>
        </CardHeader>
        <CardContent>
          <Text>Body</Text>
        </CardContent>
        <CardFooter>
          <Text>Footer</Text>
        </CardFooter>
      </Card>,
    );
    const title = screen.getByRole("heading", { name: "Your pond" });
    expect(title.props["aria-level"]).toBe(3);
    expect(screen.getByText("How it fills up").props.className).toMatch(/text-muted-foreground/);
    // Text inside the card takes the card's foreground token, never a colour of its own.
    expect(screen.getByText("Body").props.className).toMatch(/text-card-foreground/);
    expect(screen.getByText("Footer").props.className).toMatch(/text-card-foreground/);
  });

  it("lets a caller add to a section's classes", async () => {
    await renderWithTheme(
      <Card className="mt-2" testID="card">
        <CardFooter className="justify-end" testID="footer">
          <Text>Footer</Text>
        </CardFooter>
      </Card>,
    );
    expect(screen.getByTestId("card").props.className).toMatch(/\bbg-card\b.*\bmt-2\b/);
    expect(screen.getByTestId("footer").props.className).toMatch(/flex-row.*justify-end/);
  });
});
