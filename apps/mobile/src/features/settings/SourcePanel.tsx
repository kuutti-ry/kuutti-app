import { useEffect, useState } from "react";
import { Text } from "@/components/ui/text";
import { fetchHealth } from "@/lib/api";
import { useT } from "@/lib/locale";
import { SourceOffer } from "./SourceOffer";

/**
 * The source-code offer of AGPL-3.0 section 13, visible to everybody (#16,
 * #287), under its row in Settings (#511): the address of the running
 * service's source, as /health names it, read as the row opens; the words
 * alone while the API cannot say where it is.
 */
export function SourcePanel() {
  const { t } = useT();
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchHealth()
      .then((health) => live && setSource(health.source))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return source ? <SourceOffer source={source} /> : <Text>{t("about.source.body")}</Text>;
}
