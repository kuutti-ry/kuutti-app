import { AGE_MAX, AGE_MIN, type AgeWindow } from "@kuutti/schema";
import { Stepper } from "@/components/ui/stepper";
import { useT } from "@/lib/locale";

/**
 * The youngest and the oldest one seeks, as What you seek and onboarding ask
 * them: one above the other, since side by side, with the minus and the plus
 * further from the number, they overflow a small phone (#581). The youngest
 * never passes the oldest.
 */
export function AgeWindowSteppers({
  ages,
  onChange,
}: {
  ages: AgeWindow;
  onChange: (ages: AgeWindow) => void;
}) {
  const { t } = useT();
  return (
    <>
      <Stepper
        label={t("onboarding.age.youngest")}
        value={ages.min}
        shown={t("onboarding.age.years", { years: ages.min })}
        downLabel={t("onboarding.age.youngestDown")}
        upLabel={t("onboarding.age.youngestUp")}
        canDown={ages.min > AGE_MIN}
        canUp={ages.min < ages.max}
        onChange={(min) => onChange({ ...ages, min })}
      />
      <Stepper
        label={t("onboarding.age.oldest")}
        value={ages.max}
        shown={t("onboarding.age.years", { years: ages.max })}
        downLabel={t("onboarding.age.oldestDown")}
        upLabel={t("onboarding.age.oldestUp")}
        canDown={ages.max > ages.min}
        canUp={ages.max < AGE_MAX}
        onChange={(max) => onChange({ ...ages, max })}
      />
    </>
  );
}
