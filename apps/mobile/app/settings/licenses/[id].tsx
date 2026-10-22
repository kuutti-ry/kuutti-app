import { useLocalSearchParams } from "expo-router";
import { PackageLicenseScreen } from "@/features/settings";

/** A package's place in this build's list from the link: a whole number, else -1, which no package has. */
function indexOf(value: string | string[] | undefined): number {
  const text = Array.isArray(value) ? value[0] : value;
  return text !== undefined && /^\d+$/.test(text) ? Number(text) : -1;
}

/** One package's licence texts (#416), by its place in the licences list, which opens it. */
export default function PackageLicenseRoute() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  return <PackageLicenseScreen index={indexOf(id)} />;
}
